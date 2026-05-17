const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Flashcard = require("../models/Flashcard");
const FlashcardContent = require("../models/FlashcardContent");
const path = require("path");
const s3 = require("../services/s3Upload");
const { extractDocumentText } = require("../services/extractDocumentText");
const { runAsyncJob, getAsyncJob } = require("../services/asyncJobStore");
const db = require("../config/teamDb");
const { activityLogMiddleware } = require("../middleware/activityLog");

let flashcardSchemaReady = false;
async function ensureFlashcardSetIdColumn() {
    if (flashcardSchemaReady) return;
    if (!db.isConfigured()) {
        flashcardSchemaReady = true;
        return;
    }
    const p = db.getPool();
    try {
        await p.execute(
            "ALTER TABLE flashcards ADD COLUMN flashcard_set_id VARCHAR(128) NULL DEFAULT NULL"
        );
    } catch (e) {
        if (e.code !== "ER_DUP_FIELDNAME") {
            console.warn("ensureFlashcardSetIdColumn:", e.message);
        }
    }
    try {
        await p.execute(
            "CREATE INDEX idx_flashcards_doc_user_set ON flashcards (document_id, user_id, flashcard_set_id)"
        );
    } catch (e) {
        if (e.code !== "ER_DUP_KEYNAME" && !String(e.message || "").includes("Duplicate key name")) {
            console.warn("ensureFlashcardSetIdColumn index:", e.message);
        }
    }
    flashcardSchemaReady = true;
}

function normalizeSetId(raw, fallbackPrefix = "set") {
    const s = String(raw ?? "").trim();
    if (s) return s.slice(0, 128);
    return `${fallbackPrefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`.slice(0, 128);
}

function mapFlashcardRowsWithContent(cards, contents) {
    const byFlashcardId = new Map();
    for (const c of contents) {
        const row = typeof c.toJSON === "function" ? c.toJSON() : c;
        const fid = Number(row?.flashcard_id);
        if (!Number.isFinite(fid) || byFlashcardId.has(fid)) continue;
        byFlashcardId.set(fid, row);
    }
    return cards.map((card) => {
        const row = typeof card.toJSON === "function" ? card.toJSON() : card;
        const firstContent = byFlashcardId.get(Number(row?.flashcard_id)) || null;
        return {
            ...row,
            front_text: String(firstContent?.front_text || ""),
            back_text: String(firstContent?.back_text || ""),
            flashcard_set_id: row.flashcard_set_id != null ? String(row.flashcard_set_id) : null,
        };
    });
}

const GENERATION_FAIL_MESSAGE = "Generation failed. Please try again.";
const FLASHCARD_OPENROUTER_TIMEOUT_MS = Math.max(
    15000,
    Number(process.env.FLASHCARD_OPENROUTER_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS || 90000)
);
const FLASHCARD_S3_EXTRACT_TIMEOUT_MS = Math.max(
    10000,
    Number(process.env.FLASHCARD_S3_EXTRACT_TIMEOUT_MS || 45000)
);

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
    const lim = Math.max(1000, Number(ms) || 30000);
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => {
                const err = new Error(`${label} timed out after ${Math.round(lim / 1000)}s`);
                err.statusCode = 408;
                reject(err);
            }, lim);
        }),
    ]);
}

function resolveFlashcardOpenRouterModel() {
    return (
        process.env.FLASHCARD_OPENROUTER_MODEL ||
        process.env.OPENROUTER_MODEL ||
        process.env.DEEPSEEK_MODEL ||
        "openrouter/free"
    );
}

async function callOpenRouterForFlashcards({ apiKey, prompt }) {
    const fetchFn = global.fetch || require("node-fetch");
    const payload = {
        model: resolveFlashcardOpenRouterModel(),
        temperature: 0.2,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
    };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FLASHCARD_OPENROUTER_TIMEOUT_MS);
        try {
            const resp = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost",
                    "X-Title": "EduMate Flashcards",
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            if (!resp.ok) {
                const detail = await resp.text().catch(() => "");
                const err = new Error(
                    `OpenRouter HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
                );
                err.status = resp.status;
                throw err;
            }
            return await resp.json();
        } catch (e) {
            lastErr = e;
            if (e?.name === "AbortError") {
                lastErr = Object.assign(new Error(`OpenRouter timed out after ${FLASHCARD_OPENROUTER_TIMEOUT_MS}ms`), {
                    statusCode: 408,
                });
            }
            const st = Number(e?.status);
            const retryable = st === 429 || st === 503 || st === 408 || e?.name === "AbortError";
            if (!retryable || attempt >= 1) break;
            await sleep(1500);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new Error("OpenRouter flashcard generation failed.");
}

function normalizeGeneratedCards(rawCards) {
    if (!Array.isArray(rawCards)) return [];
    return rawCards
        .map((item) => {
            if (item == null || typeof item !== "object") return { front: "", back: "" };
            const front = String(
                item.front ??
                    item.question ??
                    item.q ??
                    item.term ??
                    item.title ??
                    item.prompt ??
                    item.heading ??
                    ""
            ).trim();
            const back = String(
                item.back ??
                    item.answer ??
                    item.a ??
                    item.definition ??
                    item.body ??
                    item.response ??
                    item.explanation ??
                    ""
            ).trim();
            return { front, back };
        })
        .filter((c) => c.front && c.back)
        .slice(0, 20);
}

/** AI sometimes returns { "front_1": "...", "back_1": "..." } instead of an array. */
function parseNumberedKeyFlashcards(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    const fronts = new Map();
    const backs = new Map();
    for (const [key, val] of Object.entries(obj)) {
        const text = String(val ?? "").trim();
        if (!text) continue;
        const fm = String(key).match(/^(?:front|question|q)[_\s-]?(\d+)$/i);
        const bm = String(key).match(/^(?:back|answer|a)[_\s-]?(\d+)$/i);
        if (fm) fronts.set(Number(fm[1]), text);
        if (bm) backs.set(Number(bm[1]), text);
    }
    const indices = new Set([...fronts.keys(), ...backs.keys()]);
    if (!indices.size) return [];

    const cards = [];
    for (const i of [...indices].sort((a, b) => a - b)) {
        const f = fronts.get(i) || "";
        const b = backs.get(i) || "";
        if (f && b) {
            cards.push({ front: f, back: b });
        } else if (f && !b) {
            // Model put answer text under front_N only — use it as the back side
            cards.push({ front: `Key point ${i}`, back: f });
        } else if (!f && b) {
            cards.push({ front: `Question ${i}`, back: b });
        }
    }
    return cards.slice(0, 20);
}

function parseParsedFlashcardPayload(parsed) {
    if (parsed == null) return [];
    if (Array.isArray(parsed)) {
        const cards = normalizeGeneratedCards(parsed);
        return cards.length ? cards : [];
    }
    if (typeof parsed === "object") {
        const numbered = parseNumberedKeyFlashcards(parsed);
        if (numbered.length) return numbered;
        const inner =
            parsed.flashcards ??
            parsed.cards ??
            parsed.items ??
            parsed.data ??
            parsed.results;
        if (inner != null) return parseParsedFlashcardPayload(inner);
    }
    return [];
}

function parseAiCardsFromText(answerText) {
    const text = String(answerText || "").trim();
    if (!text) return [];

    // Case 1: valid JSON array directly
    try {
        const parsed = JSON.parse(text);
        const cards = parseParsedFlashcardPayload(parsed);
        if (cards.length) return cards;
    } catch (_) {}

    // Case 2: response wrapped in code block or additional explanation text
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch?.[1]) {
        try {
            const parsed = JSON.parse(codeBlockMatch[1].trim());
            const cards = parseParsedFlashcardPayload(parsed);
            if (cards.length) return cards;
        } catch (_) {}
    }

    // Case 3: extract the largest JSON-array-like chunk
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
        const arraySlice = text.slice(start, end + 1);
        try {
            const parsed = JSON.parse(arraySlice);
            const cards = parseParsedFlashcardPayload(parsed);
            if (cards.length) return cards;
        } catch (_) {}
    }

    // Case 4: single JSON object (not array) with flashcards/cards at root — substring between first { and last }
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
        const objSlice = text.slice(objStart, objEnd + 1);
        try {
            const parsed = JSON.parse(objSlice);
            const cards = parseParsedFlashcardPayload(parsed);
            if (cards.length) return cards;
        } catch (_) {}
    }

    return [];
}

function requireStudent(req, res) {
    const role = String(req.user?.role || "").toUpperCase();
    if (role !== "STUDENT") {
        res.status(403).json({
            success: false,
            message: "Only students can use personal flashcards."
        });
        return false;
    }
    return true;
}

async function resolveExistingUserId({ requestedUserId, documentId }) {
    const db = require("../config/teamDb");
    const User = require("../models/User");

    const parsedRequested = Number(requestedUserId);
    if (Number.isFinite(parsedRequested) && parsedRequested > 0) {
        const existing = await User.findByPk(parsedRequested, { attributes: ["user_id"] });
        if (existing?.user_id) return Number(existing.user_id);
    }

    const parsedDocumentId = Number(documentId);
    if (Number.isFinite(parsedDocumentId) && parsedDocumentId > 0) {
        try {
            const [docRows] = await db.getPool().execute(
                "SELECT uploader_id FROM documents WHERE document_id = ? LIMIT 1",
                [parsedDocumentId]
            );
            const uploaderId = Number(docRows?.[0]?.uploader_id);
            if (Number.isFinite(uploaderId) && uploaderId > 0) {
                const existingUploader = await User.findByPk(uploaderId, { attributes: ["user_id"] });
                if (existingUploader?.user_id) return Number(existingUploader.user_id);
            }
        } catch (_) {
            // Ignore and continue fallback chain.
        }
    }

    const anyUser = await User.findOne({
        attributes: ["user_id"],
        order: [["user_id", "ASC"]],
    });
    if (anyUser?.user_id) return Number(anyUser.user_id);
    return null;
}

async function buildGeneratedFlashcards(reqLike) {
    const t0 = Date.now();
    const body = reqLike?.body || {};
    const { s3Key } = body;
    if (!s3Key) throw new Error("Missing s3Key.");

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is missing.");

    const db = require("../config/teamDb");
    const rawKey = String(s3Key || "").trim();
    const decodedKey = decodeURIComponent(rawKey);
    const normalizedKey = decodedKey.split("?")[0].split("#")[0];
    const baseName = path.basename(normalizedKey);

    let docRows = [];
    let contextText = "";

    // 1) Fast/robust path: try reading indexed segments directly by possible s3 keys.
    const keyCandidates = [...new Set([
        rawKey,
        normalizedKey,
        decodeURIComponent(normalizedKey),
        baseName,
    ].filter(Boolean))];
    for (const key of keyCandidates) {
        try {
            const concatenated = await db.getConcatenatedChunksByS3Key(key);
            const plain = String(concatenated || "").trim();
            if (plain) {
                contextText = plain.slice(0, 10000);
                break;
            }
        } catch (_) {
            // ignore and continue other candidates
        }
    }

    // 2) Fallback: resolve a document row then read its segment rows.
    if (!contextText.trim()) {
        [docRows] = await db.getPool().execute(
            `SELECT document_id, file_url
             FROM documents
             WHERE file_url = ?
                OR file_url = ?
                OR file_url LIKE ?
                OR file_url LIKE ?
             ORDER BY (file_url = ?) DESC, document_id DESC
             LIMIT 1`,
            [rawKey, normalizedKey, `%/${baseName}`, `%${baseName}`, normalizedKey]
        );
        const documentId = docRows?.[0]?.document_id;
        if (documentId) {
            const [segmentRows] = await db.getPool().execute(
                `SELECT content
                 FROM document_segments
                 WHERE document_id = ?
                 ORDER BY segment_id ASC
                 LIMIT 8`,
                [documentId]
            );
            const segments = segmentRows || [];
            contextText = segments.map((s) => s.content).join("\n\n").substring(0, 10000);
        }
    }

    // 3) Last fallback: fetch object from S3 and extract text (slow — time-boxed).
    if (!contextText.trim() && s3.isS3Configured()) {
        const candidateKeys = [...new Set([
            String(docRows?.[0]?.file_url || "").trim(),
            ...keyCandidates,
        ].filter(Boolean))];

        const extractFromS3 = async () => {
            for (const candidate of candidateKeys) {
                try {
                    const { buffer, contentType } = await s3.getObjectBuffer(candidate);
                    const ext = path.extname(candidate || "").toLowerCase();
                    const extracted = await extractDocumentText(buffer, ext, contentType || "");
                    const plain = String(extracted || "").trim().slice(0, 10000);
                    if (plain) return plain;
                } catch (_) {
                    // Try next candidate key quietly.
                }
            }
            return "";
        };

        try {
            contextText = await withTimeout(
                extractFromS3(),
                FLASHCARD_S3_EXTRACT_TIMEOUT_MS,
                "S3 document extract"
            );
        } catch (e) {
            console.warn("[generateFlashcards] S3 extract skipped:", e.message);
        }
    }

    console.log(
        `[generateFlashcards] context ready in ${Date.now() - t0}ms (${contextText.trim().length} chars)`
    );

    if (!contextText.trim()) throw new Error("No text extracted from document.");

    const prompt = `You are an AI study assistant. Generate exactly 5 flashcards from this text.
Return ONLY a valid JSON array (no markdown), each item: {"front":"short question","back":"short answer"}.
Example: [{"front":"What is X?","back":"X is ..."},{"front":"...","back":"..."}]
Do not use front_1/back_1 keys. Both front and back are required.

Text:
${contextText}`;

    const aiStart = Date.now();
    const data = await callOpenRouterForFlashcards({ apiKey: openRouterKey, prompt });
    console.log(`[generateFlashcards] OpenRouter done in ${Date.now() - aiStart}ms`);
    let answer = data.choices?.[0]?.message?.content || "[]";
    if (answer.startsWith("```json")) {
        answer = answer.replace(/```json/g, "").replace(/```/g, "").trim();
    } else if (answer.startsWith("```")) {
        answer = answer.replace(/```/g, "").trim();
    }

    const cards = parseAiCardsFromText(answer);
    if (!cards.length) {
        const preview = String(answer || "").replace(/\s+/g, " ").trim().slice(0, 400);
        console.warn(
            "[generateFlashcards] AI returned no parseable cards. Content preview:",
            preview || "(empty)"
        );
        throw new Error("AI returned empty flashcards.");
    }
    console.log(`[generateFlashcards] total ${Date.now() - t0}ms, ${cards.length} cards`);
    return cards;
}

async function resolveDocumentIdByS3KeyForFlashcards(s3Key, userId) {
    const rawKey = String(s3Key || "").trim();
    if (!rawKey) return null;
    const normalizedKey = decodeURIComponent(rawKey).split("?")[0].split("#")[0];
    const baseName = path.basename(normalizedKey);

    const candidates = [...new Set([rawKey, normalizedKey, baseName].filter(Boolean))];
    for (const key of candidates) {
        try {
            const existingId = await db.getDocumentIdByS3Key(key);
            if (Number.isFinite(Number(existingId)) && Number(existingId) > 0) {
                return Number(existingId);
            }
        } catch (_) {
            // continue trying
        }
    }

    // Ensure a stub document exists so flashcards can be tied to a document_id.
    const createdId = await db.ensureDocumentStub(normalizedKey || rawKey, {
        title: baseName || "Document",
        uploaderId: userId || null,
    });
    return Number(createdId);
}

async function saveGeneratedFlashcardsForUser({
    userId,
    s3Key,
    documentId,
    cards,
    flashcardSetId,
}) {
    await ensureFlashcardSetIdColumn();
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error("Invalid user for saving flashcards.");
    if (!db.isConfigured()) throw new Error("MySQL chưa cấu hình.");

    const providedDocumentId = Number(documentId);
    const resolvedDocumentId =
        Number.isFinite(providedDocumentId) && providedDocumentId > 0
            ? providedDocumentId
            : await resolveDocumentIdByS3KeyForFlashcards(s3Key, uid);
    if (!Number.isFinite(resolvedDocumentId) || resolvedDocumentId <= 0) {
        throw new Error("Cannot resolve document_id for flashcard saving.");
    }

    const setId = normalizeSetId(flashcardSetId, "gen");

    const records = (Array.isArray(cards) ? cards : [])
        .map((c) => ({
            user_id: uid,
            document_id: resolvedDocumentId,
            flashcard_set_id: setId,
            front_text: String(c?.front ?? c?.front_text ?? "").trim(),
            back_text: String(c?.back ?? c?.back_text ?? "").trim(),
        }))
        .filter((r) => r.front_text && r.back_text);

    if (!records.length) {
        return { documentId: resolvedDocumentId, savedCount: 0, flashcardSetId: setId };
    }

    // Replace only this set — keep other sets for the same document.
    const transaction = await Flashcard.sequelize.transaction();
    try {
        await Flashcard.destroy({
            where: { user_id: uid, document_id: resolvedDocumentId, flashcard_set_id: setId },
            transaction,
        });
        let savedCount = 0;
        for (const record of records) {
            const createdCard = await Flashcard.create(
                {
                    user_id: record.user_id,
                    document_id: record.document_id,
                    flashcard_set_id: record.flashcard_set_id,
                },
                { transaction }
            );
            await FlashcardContent.create(
                {
                    flashcard_id: createdCard.flashcard_id,
                    front_text: record.front_text,
                    back_text: record.back_text,
                },
                { transaction }
            );
            savedCount += 1;
        }
        await transaction.commit();
        return { documentId: resolvedDocumentId, savedCount, flashcardSetId: setId };
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

async function generateFlashcardsHandler(req, res) {
    try {
        await ensureFlashcardSetIdColumn();
        const cards = await buildGeneratedFlashcards(req);
        const userId = req.user?.id ?? req.user?.user_id;
        const setId = normalizeSetId(
            req.body?.flashcard_set_id ?? req.body?.flashcardSetId ?? req.body?.jobId,
            "gen"
        );
        const saved = await saveGeneratedFlashcardsForUser({
            userId,
            s3Key: req.body?.s3Key,
            documentId: req.body?.documentId ?? req.body?.document_id,
            cards,
            flashcardSetId: setId,
        });
        const data = cards.map((c, i) => ({
            ...c,
            flashcard_set_id: saved.flashcardSetId,
            setId: saved.flashcardSetId,
            id: String(i + 1),
        }));
        return res.json({
            success: true,
            data,
            saved,
            flashcardSetId: saved.flashcardSetId,
        });
    } catch (err) {
        console.error("[generateFlashcards]", err);
        const isTimeout =
            err?.statusCode === 408 ||
            err?.name === "AbortError" ||
            String(err?.message || "").toLowerCase().includes("timed out");
        if (isTimeout) {
            return res.status(408).json({
                success: false,
                message:
                    "Tạo flashcard quá lâu (timeout). Hãy dùng POST /api/flashcards/generate-async rồi poll jobId, hoặc index tài liệu trước khi generate.",
            });
        }
        return res.status(200).json({ success: false, message: GENERATION_FAIL_MESSAGE });
    }
}

async function startGenerateFlashcardsAsync(req, res) {
    const job = runAsyncJob({
        type: "flashcards-generate",
        metadata: {
            s3Key: String(req.body?.s3Key || "").trim(),
            userId: req.user?.id ?? req.user?.user_id ?? null,
        },
        runner: async ({ jobId: asyncJobId }) => {
            const cards = await buildGeneratedFlashcards(req);
            const setId = normalizeSetId(
                req.body?.flashcard_set_id ?? req.body?.flashcardSetId ?? asyncJobId,
                "gen"
            );
            const saved = await saveGeneratedFlashcardsForUser({
                userId: req.user?.id ?? req.user?.user_id,
                s3Key: req.body?.s3Key,
                documentId: req.body?.documentId ?? req.body?.document_id,
                cards,
                flashcardSetId: setId,
            });
            const data = cards.map((c, i) => ({
                ...c,
                flashcard_set_id: saved.flashcardSetId,
                setId: saved.flashcardSetId,
                id: String(i + 1),
            }));
            return { success: true, data, saved, flashcardSetId: saved.flashcardSetId };
        },
    });
    return res.status(202).json({
        success: true,
        data: {
            jobId: job.jobId,
            status: job.status,
            message: "Flashcard generation started",
            pollUrl: `/api/flashcards/generate-status/${job.jobId}`,
        },
    });
}

async function getGenerateFlashcardsAsyncStatus(req, res) {
    const jobId = String(req.params.jobId || "").trim();
    if (!jobId) return res.status(400).json({ success: false, message: "Missing jobId." });
    const job = getAsyncJob(jobId);
    if (!job) return res.status(404).json({ success: false, message: "Job not found or expired." });
    return res.status(200).json({
        success: true,
        data: {
            jobId: job.jobId,
            type: job.type,
            status: job.status,
            progress: job.progress,
            message: job.message,
            result: job.result,
            error: job.error,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
        },
    });
}

// Generate flashcards using AI
// Public endpoint by design: FE can request generation before auth state is fully ready.
router.post("/generate", auth, activityLogMiddleware("generate_flashcards"), generateFlashcardsHandler);
router.post("/generate-async", auth, activityLogMiddleware("generate_flashcards_async"), startGenerateFlashcardsAsync);
router.get("/generate-status/:jobId", getGenerateFlashcardsAsyncStatus);
// Defensive compatibility for accidental GET from legacy FE code.
router.get("/generate", (req, res) => {
    return res.status(200).json({
        success: false,
        message: "Use POST /api/flashcards/generate with s3Key."
    });
});

// Create flashcards (batch)
router.post("/", auth, async (req, res) => {
    try {
        await ensureFlashcardSetIdColumn();
        const { document_id, flashcards, user_id, userId } = req.body;

        if (!document_id || !Array.isArray(flashcards) || !flashcards.length) {
            return res.status(400).json({
                success: false,
                message: "document_id and flashcards[] are required."
            });
        }

        const requestedUserId =
            user_id ??
            userId ??
            req.body?.id ??
            req.body?.currentUserId ??
            req.query?.user_id ??
            req.query?.userId ??
            req.user?.id ??
            req.user?.user_id ??
            process.env.DEFAULT_FLASHCARD_USER_ID;
        const effectiveUserId = await resolveExistingUserId({
            requestedUserId,
            documentId: document_id,
        });
        if (!Number.isFinite(effectiveUserId) || effectiveUserId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot resolve a valid user to save flashcards."
            });
        }

        const setId = normalizeSetId(
            req.body?.flashcard_set_id ?? req.body?.flashcardSetId,
            "save"
        );
        const docId = Number(document_id);

        const records = flashcards
            .map((f) => ({
                user_id: effectiveUserId,
                document_id: docId,
                flashcard_set_id: setId,
                front_text: String(f.front_text || f.front || f.question || "").trim(),
                back_text: String(f.back_text || f.back || f.answer || "").trim(),
            }))
            .filter((r) => r.front_text && r.back_text);

        const transaction = await Flashcard.sequelize.transaction();
        const createdPayload = [];
        try {
            await Flashcard.destroy({
                where: {
                    user_id: effectiveUserId,
                    document_id: docId,
                    flashcard_set_id: setId,
                },
                transaction,
            });
            for (const record of records) {
                const createdCard = await Flashcard.create(
                    {
                        user_id: record.user_id,
                        document_id: record.document_id,
                        flashcard_set_id: record.flashcard_set_id,
                    },
                    { transaction }
                );
                const contentRow = await FlashcardContent.create(
                    {
                        flashcard_id: createdCard.flashcard_id,
                        front_text: record.front_text,
                        back_text: record.back_text,
                    },
                    { transaction }
                );
                const cardJson =
                    typeof createdCard.toJSON === "function" ? createdCard.toJSON() : createdCard;
                const contentJson =
                    typeof contentRow.toJSON === "function" ? contentRow.toJSON() : contentRow;
                createdPayload.push({
                    ...cardJson,
                    front_text: contentJson.front_text,
                    back_text: contentJson.back_text,
                    flashcard_set_id: setId,
                });
            }
            await transaction.commit();
        } catch (innerErr) {
            await transaction.rollback();
            throw innerErr;
        }
        return res.status(201).json({
            success: true,
            data: createdPayload,
            count: createdPayload.length,
            flashcardSetId: setId,
        });
    } catch (err) {
        console.error("[flashcards/create]", err.message);
        return res.status(500).json({ success: false, message: "Save failed." });
    }
});

// List flashcards for a document (public-friendly so FE can reuse saved cards immediately)
router.get("/document/:documentId", async (req, res) => {
    try {
        await ensureFlashcardSetIdColumn();
        const documentId = Number(req.params.documentId);

        if (!Number.isFinite(documentId)) {
            return res.status(400).json({ success: false, message: "Invalid document ID." });
        }

        const requestedUserId = Number(req.query.user_id ?? req.query.userId ?? req.body?.user_id ?? req.body?.userId);
        const where = { document_id: documentId };
        if (Number.isFinite(requestedUserId) && requestedUserId > 0) {
            where.user_id = requestedUserId;
        }

        const cards = await Flashcard.findAll({ where, order: [["created_at", "DESC"]] });
        const cardIds = cards
            .map((card) => Number(card?.flashcard_id))
            .filter((id) => Number.isFinite(id) && id > 0);
        const contents = cardIds.length
            ? await FlashcardContent.findAll({
                  where: { flashcard_id: cardIds },
                  attributes: ["content_id", "flashcard_id", "front_text", "back_text"],
                  order: [["content_id", "ASC"]],
              })
            : [];
        const data = mapFlashcardRowsWithContent(cards, contents);

        return res.json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// List all personal flashcards
router.get("/mine", auth, async (req, res) => {
    try {
        await ensureFlashcardSetIdColumn();
        if (!requireStudent(req, res)) return;

        const cards = await Flashcard.findAll({
            where: { user_id: req.user.id },
            order: [["created_at", "DESC"]],
            limit: 200,
        });
        const cardIds = cards
            .map((card) => Number(card?.flashcard_id))
            .filter((id) => Number.isFinite(id) && id > 0);
        const contents = cardIds.length
            ? await FlashcardContent.findAll({
                  where: { flashcard_id: cardIds },
                  attributes: ["content_id", "flashcard_id", "front_text", "back_text"],
              })
            : [];
        const data = mapFlashcardRowsWithContent(cards, contents);
        return res.json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Delete a personal flashcard
router.delete("/:id", auth, async (req, res) => {
    try {
        if (!requireStudent(req, res)) return;

        const card = await Flashcard.findByPk(req.params.id);

        if (!card) {
            return res.status(404).json({ success: false, message: "Flashcard not found." });
        }

        if (card.user_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "Forbidden." });
        }

        await card.destroy();
        return res.json({ success: true, message: "Flashcard deleted." });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;