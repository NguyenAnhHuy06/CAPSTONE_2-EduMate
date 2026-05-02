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

const GENERATION_FAIL_MESSAGE = "Generation failed. Please try again.";

function normalizeGeneratedCards(rawCards) {
    if (!Array.isArray(rawCards)) return [];
    return rawCards
        .map((item) => {
            const front = String(item?.front ?? item?.question ?? item?.q ?? "").trim();
            const back = String(item?.back ?? item?.answer ?? item?.a ?? "").trim();
            return { front, back };
        })
        .filter((c) => c.front && c.back)
        .slice(0, 20);
}

function parseAiCardsFromText(answerText) {
    const text = String(answerText || "").trim();
    if (!text) return [];

    // Case 1: valid JSON array directly
    try {
        const parsed = JSON.parse(text);
        const cards = normalizeGeneratedCards(parsed);
        if (cards.length) return cards;
    } catch (_) {}

    // Case 2: response wrapped in code block or additional explanation text
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch?.[1]) {
        try {
            const parsed = JSON.parse(codeBlockMatch[1].trim());
            const cards = normalizeGeneratedCards(parsed);
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
            const cards = normalizeGeneratedCards(parsed);
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

    // 3) Last fallback: fetch object from S3 and extract text.
    if (!contextText.trim() && s3.isS3Configured()) {
        const candidateKeys = [...new Set([
            String(docRows?.[0]?.file_url || "").trim(),
            ...keyCandidates,
        ].filter(Boolean))];

        for (const candidate of candidateKeys) {
            try {
                const { buffer, contentType } = await s3.getObjectBuffer(candidate);
                const ext = path.extname(candidate || "").toLowerCase();
                const extracted = await extractDocumentText(buffer, ext, contentType || "");
                contextText = String(extracted || "").trim().slice(0, 10000);
                if (contextText) break;
            } catch (_) {
                // Try next candidate key quietly.
            }
        }
    }

    if (!contextText.trim()) throw new Error("No text extracted from document.");

    const prompt = `You are an AI study assistant. Generate exactly 5 flashcards from this text.
Return ONLY a valid JSON array of objects, with each object having "front" (question) and "back" (answer). Do not include any other text or markdown formatting.

Text:
${contextText}`;

    const fetch = global.fetch || require("node-fetch");
    const aRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${openRouterKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: process.env.OPENROUTER_MODEL || "openrouter/free",
            messages: [{ role: "user", content: prompt }]
        })
    });
    if (!aRes.ok) throw new Error("AI provider rejected flashcard generation.");

    const data = await aRes.json().catch(() => ({}));
    let answer = data.choices?.[0]?.message?.content || "[]";
    if (answer.startsWith("```json")) {
        answer = answer.replace(/```json/g, "").replace(/```/g, "").trim();
    } else if (answer.startsWith("```")) {
        answer = answer.replace(/```/g, "").trim();
    }

    const cards = parseAiCardsFromText(answer);
    if (!cards.length) throw new Error("AI returned empty flashcards.");
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

async function saveGeneratedFlashcardsForUser({ userId, s3Key, cards }) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error("Invalid user for saving flashcards.");
    if (!db.isConfigured()) throw new Error("MySQL chưa cấu hình.");

    const documentId = await resolveDocumentIdByS3KeyForFlashcards(s3Key, uid);
    if (!Number.isFinite(documentId) || documentId <= 0) {
        throw new Error("Cannot resolve document_id for flashcard saving.");
    }

    const records = (Array.isArray(cards) ? cards : [])
        .map((c) => ({
            user_id: uid,
            document_id: documentId,
            front_text: String(c?.front ?? c?.front_text ?? "").trim(),
            back_text: String(c?.back ?? c?.back_text ?? "").trim(),
        }))
        .filter((r) => r.front_text && r.back_text);

    if (!records.length) return { documentId, savedCount: 0 };

    // Replace old generated cards for this user+document to keep reusable set fresh.
    const transaction = await Flashcard.sequelize.transaction();
    try {
        await Flashcard.destroy({ where: { user_id: uid, document_id: documentId }, transaction });
        let savedCount = 0;
        for (const record of records) {
            const createdCard = await Flashcard.create(
                {
                    user_id: record.user_id,
                    document_id: record.document_id,
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
        return { documentId, savedCount };
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

async function generateFlashcardsHandler(req, res) {
    try {
        const cards = await buildGeneratedFlashcards(req);
        const userId = req.user?.id ?? req.user?.user_id;
        const saved = await saveGeneratedFlashcardsForUser({
            userId,
            s3Key: req.body?.s3Key,
            cards,
        });
        return res.json({
            success: true,
            data: cards,
            saved,
        });
    } catch (err) {
        console.error("[generateFlashcards]", err);
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
        runner: async () => {
            const cards = await buildGeneratedFlashcards(req);
            const saved = await saveGeneratedFlashcardsForUser({
                userId: req.user?.id ?? req.user?.user_id,
                s3Key: req.body?.s3Key,
                cards,
            });
            return { success: true, data: cards, saved };
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
router.post("/generate", auth, generateFlashcardsHandler);
router.post("/generate-async", auth, startGenerateFlashcardsAsync);
router.get("/generate-status/:jobId", getGenerateFlashcardsAsyncStatus);
// Defensive compatibility for accidental GET from legacy FE code.
router.get("/generate", (req, res) => {
    return res.status(200).json({
        success: false,
        message: "Use POST /api/flashcards/generate with s3Key."
    });
});

// Create flashcards (batch)
router.post("/", async (req, res) => {
    try {
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

        const records = flashcards.map((f) => ({
            user_id: effectiveUserId,
            document_id: Number(document_id),
            front_text: f.front_text || f.front || f.question || "",
            back_text: f.back_text || f.back || f.answer || "",
        })).filter((r) => String(r.front_text || "").trim() && String(r.back_text || "").trim());

        const transaction = await Flashcard.sequelize.transaction();
        const created = [];
        try {
            for (const record of records) {
                const createdCard = await Flashcard.create(
                    {
                        user_id: record.user_id,
                        document_id: record.document_id,
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
                created.push(createdCard);
            }
            await transaction.commit();
        } catch (innerErr) {
            await transaction.rollback();
            throw innerErr;
        }
        return res.status(201).json({
            success: true,
            data: created,
            count: created.length
        });
    } catch (err) {
        console.error("[flashcards/create]", err.message);
        return res.status(500).json({ success: false, message: "Save failed." });
    }
});

// List flashcards for a document (public-friendly so FE can reuse saved cards immediately)
router.get("/document/:documentId", async (req, res) => {
    try {
        const documentId = Number(req.params.documentId);

        if (!Number.isFinite(documentId)) {
            return res.status(400).json({ success: false, message: "Invalid document ID." });
        }

        const requestedUserId = Number(req.query.user_id ?? req.query.userId ?? req.body?.user_id ?? req.body?.userId);
        const where = { document_id: documentId };
        if (Number.isFinite(requestedUserId) && requestedUserId > 0) {
            where.user_id = requestedUserId;
        }

        const cards = await Flashcard.findAll({
            where,
            include: [
                {
                    model: FlashcardContent,
                    required: false,
                    attributes: ["content_id", "front_text", "back_text"],
                },
            ],
            order: [["created_at", "DESC"]],
        });
        const data = cards.map((card) => {
            const row = typeof card.toJSON === "function" ? card.toJSON() : card;
            const contents = Array.isArray(row?.FlashcardContents) ? row.FlashcardContents : [];
            const firstContent = contents[0] || null;
            return {
                ...row,
                front_text: String(firstContent?.front_text || ""),
                back_text: String(firstContent?.back_text || ""),
            };
        });

        return res.json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// List all personal flashcards
router.get("/mine", auth, async (req, res) => {
    try {
        if (!requireStudent(req, res)) return;

        const cards = await Flashcard.findAll({
            where: { user_id: req.user.id },
            order: [["created_at", "DESC"]],
            limit: 200,
        });
        return res.json({ success: true, data: cards });
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