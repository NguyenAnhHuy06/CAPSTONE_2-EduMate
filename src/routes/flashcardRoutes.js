const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Flashcard = require("../models/Flashcard");
const path = require("path");
const s3 = require("../services/s3Upload");
const { extractDocumentText } = require("../services/extractDocumentText");

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

async function generateFlashcardsHandler(req, res) {
    try {
        const { s3Key } = req.body;
        if (!s3Key) {
            return res.status(200).json({ success: false, message: GENERATION_FAIL_MESSAGE });
        }

        const openRouterKey = process.env.OPENROUTER_API_KEY;
        if (!openRouterKey) {
            return res.status(200).json({ success: false, message: GENERATION_FAIL_MESSAGE });
        }

        const db = require("../config/teamDb");
        const rawKey = String(s3Key || "").trim();
        const decodedKey = decodeURIComponent(rawKey);
        const normalizedKey = decodedKey.split("?")[0].split("#")[0];
        const baseName = path.basename(normalizedKey);

        // Resolve document by exact match first, then loose filename/url-end matching.
        const [docRows] = await db.getPool().execute(
            `SELECT document_id, file_url
             FROM documents
             WHERE file_url = ?
                OR file_url = ?
                OR file_url LIKE ?
                OR file_url LIKE ?
             ORDER BY (file_url = ?) DESC, document_id DESC
             LIMIT 1`,
            [
                rawKey,
                normalizedKey,
                `%/${baseName}`,
                `%${baseName}`,
                normalizedKey,
            ]
        );
        const documentId = docRows?.[0]?.document_id;
        let contextText = "";

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

        // Fallback: if DB segments are missing, try extracting text directly from the source file on S3.
        if (!contextText.trim() && s3.isS3Configured()) {
            const candidateKeys = [
                String(docRows?.[0]?.file_url || "").trim(),
                normalizedKey,
                rawKey,
                baseName,
            ].filter(Boolean);

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

        if (!contextText.trim()) {
            return res.status(200).json({
                success: false,
                message: GENERATION_FAIL_MESSAGE
            });
        }

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

        if (!aRes.ok) {
            return res.status(200).json({
                success: false,
                message: GENERATION_FAIL_MESSAGE
            });
        }

        const data = await aRes.json().catch(() => ({}));
        let answer = data.choices?.[0]?.message?.content || "[]";

        if (answer.startsWith("```json")) {
            answer = answer.replace(/```json/g, "").replace(/```/g, "").trim();
        } else if (answer.startsWith("```")) {
            answer = answer.replace(/```/g, "").trim();
        }

        const cards = parseAiCardsFromText(answer);
        if (!cards.length) {
            return res.status(200).json({
                success: false,
                message: GENERATION_FAIL_MESSAGE
            });
        }
        return res.json({ success: true, data: cards });
    } catch (err) {
        console.error("[generateFlashcards]", err);
        return res.status(200).json({ success: false, message: GENERATION_FAIL_MESSAGE });
    }
}

// Generate flashcards using AI
// Public endpoint by design: FE can request generation before auth state is fully ready.
router.post("/generate", generateFlashcardsHandler);
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
        }));

        const created = await Flashcard.bulkCreate(records);
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
            order: [["created_at", "DESC"]],
        });

        return res.json({ success: true, data: cards });
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