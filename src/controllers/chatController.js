/**
 * Chat Controller — AI-Powered Academic Q&A (RAG)
 * Design ref: UC02 — "Student asks a course-related question;
 * the system retrieves verified document context and uses the LLM
 * to generate an accurate answer with citations."
 */
const ChatSession = require("../models/ChatSession");
const ChatMessage = require("../models/ChatMessage");
const Citation = require("../models/Citation");
const { retrieveTopChunks } = require("../services/vectorSearch");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";

async function callLLM(systemPrompt, userMessage) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0.2,
            max_tokens: 2000,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
            ]
        })
    });

    if (!resp.ok) {
        throw new Error(`LLM Error: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || "";
}

/**
 * POST /api/chat/ask
 * Body: { question, s3Key?, sessionId? }
 * Returns: { answer, citations[], sessionId }
 */
const askQuestion = async (req, res) => {
    try {
        const userId = req.user.id;
        const { question, s3Key, sessionId } = req.body;

        if (!question || !question.trim()) {
            return res.status(400).json({ success: false, message: "Question is required." });
        }

        // 1. Get or create session
        let session;
        if (sessionId) {
            session = await ChatSession.findByPk(sessionId);
            if (!session || session.user_id !== userId) {
                session = null; // Invalid session, create new
            }
        }
        if (!session) {
            session = await ChatSession.create({ user_id: userId });
        }

        // 2. Save user message
        await ChatMessage.create({
            session_id: session.session_id,
            role: "user",
            message_text: question.trim(),
        });

        // 3. Vector search for relevant context
        let context = "";
        let matchedChunks = [];

        if (s3Key) {
            // Search within a specific document
            try {
                const result = await retrieveTopChunks({
                    s3Key,
                    query: question.trim(),
                    topK: 5,
                    maxContextChars: 6000,
                });
                context = result.context || "";
                matchedChunks = result.chunks || [];
            } catch (searchErr) {
                console.warn("[chat/ask] Vector search failed:", searchErr.message);
            }
        }

        // 4. Call LLM with RAG context
        let answer;
        if (context.trim()) {
            const systemPrompt = [
                "You are EduMate AI Assistant, an academic Q&A system.",
                "Answer the user's question based ONLY on the provided document context.",
                "If the context does not contain enough information, clearly state that you cannot answer based on the available documents.",
                "Provide exact references to the source material when possible.",
                "Answer in the same language as the user's question.",
                "Do NOT make up information. Zero hallucination tolerance.",
            ].join("\n");

            const userMsg = `Context from verified documents:\n---\n${context}\n---\n\nQuestion: ${question.trim()}`;
            answer = await callLLM(systemPrompt, userMsg);
        } else {
            // No context found
            answer = "I could not find relevant information in the verified documents to answer your question. " +
                "Please try rephrasing your question or ensure the relevant document has been uploaded and verified.";
        }

        // 5. Save assistant message
        const aiMessage = await ChatMessage.create({
            session_id: session.session_id,
            role: "assistant",
            message_text: answer,
        });

        // 6. Save citations
        const citationRecords = [];
        for (const chunk of matchedChunks) {
            if (chunk.segment_id) {
                const citation = await Citation.create({
                    message_id: aiMessage.message_id,
                    segment_id: chunk.segment_id,
                    excerpt: (chunk.content || "").substring(0, 500),
                });
                citationRecords.push({
                    citation_id: citation.citation_id,
                    segment_id: chunk.segment_id,
                    excerpt: citation.excerpt,
                    similarity: chunk.similarity,
                });
            }
        }

        return res.json({
            success: true,
            data: {
                answer,
                sessionId: session.session_id,
                messageId: aiMessage.message_id,
                citations: citationRecords,
                contextFound: context.trim().length > 0,
            },
        });
    } catch (err) {
        console.error("[chat/ask] Error:", err.message);
        return res.status(500).json({ success: false, message: err.message || "AI query failed." });
    }
};

/**
 * GET /api/chat/sessions
 * Returns user's chat sessions
 */
const getSessions = async (req, res) => {
    try {
        const sessions = await ChatSession.findAll({
            where: { user_id: req.user.id },
            order: [["created_at", "DESC"]],
            limit: 50,
        });
        return res.json({ success: true, data: sessions });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /api/chat/sessions/:id/messages
 * Returns messages for a specific session
 */
const getSessionMessages = async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        const session = await ChatSession.findByPk(sessionId);
        if (!session || session.user_id !== req.user.id) {
            return res.status(404).json({ success: false, message: "Session not found." });
        }

        const messages = await ChatMessage.findAll({
            where: { session_id: sessionId },
            order: [["created_at", "ASC"]],
        });

        // Get citations for assistant messages
        const assistantMsgIds = messages.filter(m => m.role === "assistant").map(m => m.message_id);
        let citations = [];
        if (assistantMsgIds.length > 0) {
            const { Op } = require("sequelize");
            citations = await Citation.findAll({
                where: { message_id: { [Op.in]: assistantMsgIds } },
            });
        }

        return res.json({
            success: true,
            data: {
                messages,
                citations,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { askQuestion, getSessions, getSessionMessages };
