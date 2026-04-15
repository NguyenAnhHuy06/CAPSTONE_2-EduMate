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

function resolveChatUserId(req) {
    const fromAuth = req.user?.id ?? req.user?.user_id;
    if (Number.isFinite(Number(fromAuth)) && Number(fromAuth) > 0) return Number(fromAuth);
    const fromBody = req.body?.userId ?? req.body?.user_id;
    if (Number.isFinite(Number(fromBody)) && Number(fromBody) > 0) return Number(fromBody);
    const fromQuery = req.query?.userId ?? req.query?.user_id;
    if (Number.isFinite(Number(fromQuery)) && Number(fromQuery) > 0) return Number(fromQuery);
    const fallback =
        process.env.DEFAULT_CHAT_USER_ID ||
        process.env.DEFAULT_QUIZ_USER_ID ||
        "14";
    if (Number.isFinite(Number(fallback)) && Number(fallback) > 0) return Number(fallback);
    return null;
}

function getChatProviderConfigs() {
    const configs = [];
    const openaiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (openaiKey) {
        configs.push({
            provider: "openai",
            apiKey: openaiKey,
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: process.env.OPENAI_MODEL || process.env.CHAT_MODEL || "gpt-4o-mini",
        });
    }

    const openrouterKey = String(process.env.OPENROUTER_API_KEY || "").trim();
    if (openrouterKey) {
        configs.push({
            provider: "openrouter",
            apiKey: openrouterKey,
            endpoint: "https://openrouter.ai/api/v1/chat/completions",
            model: process.env.OPENROUTER_MODEL || process.env.CHAT_MODEL || "google/gemini-2.0-flash-001",
        });
    }

    if (!configs.length) {
        throw new Error("Missing AI API key. Set OPENAI_API_KEY or OPENROUTER_API_KEY.");
    }
    return configs;
}

function buildSystemPrompt(hasContext) {
    return [
        "You are EduMate AI Assistant for academic study support.",
        "Always answer in the same language as the user's question.",
        hasContext
            ? "Use only the provided document context; if information is missing, explicitly say it is not in the documents."
            : "No document context is available; provide a general best-effort answer and clearly mention it is not document-grounded.",
        "Be concise, accurate, and avoid hallucinations.",
        "When possible, provide actionable steps or examples for students.",
    ].join("\n");
}

async function callLLM({ hasContext, context, question }) {
    const configs = getChatProviderConfigs();
    const userMessage = hasContext
        ? `Document context:\n---\n${context}\n---\n\nQuestion: ${question}`
        : `Question: ${question}`;
    let lastErr = null;

    for (const cfg of configs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const headers = {
                Authorization: `Bearer ${cfg.apiKey}`,
                "Content-Type": "application/json",
            };

            if (cfg.provider === "openrouter") {
                headers["HTTP-Referer"] = "http://localhost";
                headers["X-Title"] = "EduMate BE Chat";
            }

            const resp = await fetch(cfg.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: cfg.model,
                    temperature: 0.2,
                    max_tokens: 1000,
                    messages: [
                        { role: "system", content: buildSystemPrompt(hasContext) },
                        { role: "user", content: userMessage },
                    ],
                }),
                signal: controller.signal,
            });

            if (!resp.ok) {
                const detail = await resp.text().catch(() => "");
                const err = new Error(`LLM Error: ${resp.status} ${resp.statusText}${detail ? ` - ${detail.slice(0, 300)}` : ""}`);
                err.status = resp.status;
                throw err;
            }

            const data = await resp.json();
            const text = data?.choices?.[0]?.message?.content || "";
            if (text && String(text).trim()) return text;
            throw new Error("LLM returned empty content.");
        } catch (err) {
            lastErr = err;
            const status = Number(err?.status);
            const msg = String(err?.message || "").toLowerCase();
            const shouldTryNext =
                status === 401 || status === 402 || status === 403 || status === 429 ||
                msg.includes("insufficient_quota") || msg.includes("rate limit");
            if (!shouldTryNext) throw err;
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastErr || new Error("All AI providers failed.");
}

/**
 * POST /api/chat/ask
 * Body: { question, s3Key?, sessionId? }
 * Returns: { answer, citations[], sessionId }
 */
const askQuestion = async (req, res) => {
    try {
        const userId = resolveChatUserId(req);
        const { question, s3Key, sessionId } = req.body;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Missing user identity. Provide token or userId.",
            });
        }

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
        const hasContext = context.trim().length > 0;
        answer = await callLLM({
            hasContext,
            context,
            question: question.trim(),
        });
        if (!answer || !answer.trim()) {
            answer = hasContext
                ? "I found document context but could not generate an answer at this time. Please try again."
                : "I could not generate a response right now. Please try again.";
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
