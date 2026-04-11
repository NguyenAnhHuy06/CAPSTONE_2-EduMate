const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Flashcard = require("../models/Flashcard");

// Generate flashcards using AI
router.post("/generate", auth, async (req, res) => {
    try {
        const { s3Key } = req.body;
        if (!s3Key) return res.status(400).json({ success: false, message: "s3Key required." });

        const openRouterKey = process.env.OPENROUTER_API_KEY;
        if (!openRouterKey) return res.status(503).json({ success: false, message: "AI API Key missing." });

        const db = require("../config/teamDb");
        const results = await db.getPool().execute(
            "SELECT content_text FROM document_segments d JOIN documents doc ON d.document_id = doc.document_id WHERE doc.file_url = ? LIMIT 5",
            [s3Key]
        );
        const segments = results[0] || [];
        const contextText = segments.map(s => s.content_text).join("\n\n").substring(0, 10000);

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
                model: "google/gemini-2.0-flash-001",
                messages: [{ role: "user", content: prompt }]
            })
        });

        const data = await aRes.json();
        let answer = data.choices?.[0]?.message?.content || "[]";
        // Clean markdown JSON block
        if (answer.startsWith("\`\`\`json")) {
            answer = answer.replace(/\`\`\`json/g, "").replace(/\`\`\`/g, "").trim();
        } else if (answer.startsWith("\`\`\`")) {
            answer = answer.replace(/\`\`\`/g, "").trim();
        }

        const cards = JSON.parse(answer);
        return res.json({ success: true, data: cards });

    } catch (err) {
        console.error("[generateFlashcards]", err);
        return res.status(500).json({ success: false, message: "AI processing error" });
    }
});

// Create flashcards (batch) — Design: Database Design "flashcards" table
router.post("/", auth, async (req, res) => {
    try {
        const { document_id, flashcards } = req.body;
        if (!document_id || !Array.isArray(flashcards) || !flashcards.length) {
            return res.status(400).json({ success: false, message: "document_id and flashcards[] are required." });
        }

        const records = flashcards.map(f => ({
            user_id: req.user.id,
            document_id,
            front_text: f.front_text || f.front || f.question || "",
            back_text: f.back_text || f.back || f.answer || "",
        }));

        const created = await Flashcard.bulkCreate(records);
        return res.status(201).json({ success: true, data: created, count: created.length });
    } catch (err) {
        console.error("[flashcards/create]", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// List flashcards for a document — authenticated
router.get("/document/:documentId", auth, async (req, res) => {
    try {
        const documentId = Number(req.params.documentId);
        const cards = await Flashcard.findAll({
            where: { document_id: documentId, user_id: req.user.id },
            order: [["created_at", "DESC"]],
        });
        return res.json({ success: true, data: cards });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// List all flashcards for current user
router.get("/mine", auth, async (req, res) => {
    try {
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

// Delete a flashcard
router.delete("/:id", auth, async (req, res) => {
    try {
        const card = await Flashcard.findByPk(req.params.id);
        if (!card || card.user_id !== req.user.id) {
            return res.status(404).json({ success: false, message: "Flashcard not found." });
        }
        await card.destroy();
        return res.json({ success: true, message: "Flashcard deleted." });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
