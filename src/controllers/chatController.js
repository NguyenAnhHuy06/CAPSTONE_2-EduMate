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
const teamDb = require("../config/teamDb");
const rootDb = require("../../db");
const { ensureIndexedForQuiz } = require("../../documentPipeline");

function normalizeS3KeyInput(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) {
        try {
            return decodeURIComponent(new URL(s).pathname.replace(/^\/+/, ""));
        } catch {
            return s;
        }
    }
    return s;
}

/** Resolve canonical file_url + document_id for RAG on the open document. */
async function resolveChatDocumentRef({ s3Key, documentId }) {
    let key = normalizeS3KeyInput(s3Key);
    let docId = Number(documentId);
    if (!Number.isFinite(docId) || docId <= 0) docId = null;

    if (teamDb.isConfigured()) {
        if (!key && docId) {
            const doc = await teamDb.getDocumentById(docId);
            key = normalizeS3KeyInput(doc?.file_url);
        }
        if (key && !docId) {
            const resolved = await teamDb.getDocumentIdByS3Key(key);
            if (resolved) docId = Number(resolved);
        }
        if (docId) {
            const doc = await teamDb.getDocumentById(docId);
            const canonical = normalizeS3KeyInput(doc?.file_url);
            if (canonical) key = canonical;
        }
    }

    return { s3Key: key || null, documentId: docId };
}

async function listSegmentsForDocRef(docRef) {
    if (docRef.documentId) {
        if (rootDb.isConfigured()) {
            const segs = await rootDb.listSegmentsByDocumentId(docRef.documentId);
            if (segs.length) return segs;
        }
        if (teamDb.isConfigured()) {
            return teamDb.listSegmentsByDocumentId(docRef.documentId);
        }
    }
    if (docRef.s3Key) {
        if (rootDb.isConfigured()) {
            const segs = await rootDb.listSegmentsByS3Key(docRef.s3Key);
            if (segs.length) return segs;
        }
        if (teamDb.isConfigured()) {
            return teamDb.listSegmentsByS3Key(docRef.s3Key);
        }
    }
    return [];
}

/** Fast check: document_segments exist with non-empty embeddings. */
async function documentHasReadyEmbeddings(docRef) {
    const dbReady = rootDb.isConfigured() || teamDb.isConfigured();
    if (!dbReady) return false;

    if (docRef.s3Key && rootDb.isConfigured()) {
        const n = await rootDb.countChunksByS3Key(docRef.s3Key);
        if (n > 0 && (await rootDb.hasCompleteEmbeddingsForS3Key(docRef.s3Key))) {
            return true;
        }
    }

    const segs = await listSegmentsForDocRef(docRef);
    return (
        segs.length > 0 &&
        segs.every((s) => Array.isArray(s.embedding) && s.embedding.length > 0)
    );
}

/**
 * Ensure embeddings exist before RAG/LLM.
 * First chat on a file may take longer (S3 + chunk + embed); later chats reuse segments.
 */
async function ensureDocumentReadyForChat(docRef) {
    if (!docRef.s3Key && !docRef.documentId) {
        return {
            ready: false,
            indexedNow: false,
            skipped: true,
            chunkCount: 0,
            message: "No document reference.",
        };
    }

    if (await documentHasReadyEmbeddings(docRef)) {
        const segs = await listSegmentsForDocRef(docRef);
        const chunkCount = segs.length;
        return {
            ready: true,
            indexedNow: false,
            skipped: true,
            chunkCount,
            documentId: docRef.documentId,
            s3Key: docRef.s3Key,
        };
    }

    let key = docRef.s3Key;
    if (!key && docRef.documentId) {
        const doc = await teamDb.getDocumentById(docRef.documentId);
        key = normalizeS3KeyInput(doc?.file_url);
    }
    if (!key) {
        return {
            ready: false,
            indexedNow: false,
            skipped: false,
            chunkCount: 0,
            message: "Cannot index: missing S3 file key.",
        };
    }

    if (!rootDb.isConfigured()) {
        return {
            ready: false,
            indexedNow: false,
            skipped: false,
            chunkCount: 0,
            message: "MySQL is not configured — cannot index document for chat.",
        };
    }

    console.log(`[chat] Indexing document for AI: ${key}`);
    const r = await ensureIndexedForQuiz(key);
    return {
        ready: true,
        indexedNow: !r.skipped,
        skipped: !!r.skipped,
        chunkCount: Number(r.chunkCount || 0),
        documentId: r.documentId ?? docRef.documentId,
        s3Key: key,
    };
}

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

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Chat uses GPT only — default gpt-4o-mini (OpenAI API). */
function resolveOpenAiChatModel() {
    const m = String(
        process.env.CHAT_MODEL ||
        process.env.OPENAI_CHAT_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-4o-mini"
    ).trim();
    return m || "gpt-4o-mini";
}

/** OpenRouter route to OpenAI GPT when OPENAI_API_KEY is not set. */
function resolveOpenRouterGptChatModels() {
    const listRaw =
        process.env.OPENROUTER_CHAT_MODELS ||
        process.env.OPENROUTER_CHAT_MODEL ||
        "";
    const fromList = String(listRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (fromList.length) {
        return fromList.filter((m) => !String(m).toLowerCase().includes("gemini"));
    }
    const single = String(process.env.CHAT_MODEL || "openai/gpt-4o-mini").trim();
    if (single.toLowerCase().includes("gemini")) return ["openai/gpt-4o-mini"];
    if (single.includes("/")) return [single];
    return [`openai/${single}`];
}

function getChatProviderConfigs() {
    const configs = [];
    const prefer = String(process.env.CHAT_PROVIDER || "openai").trim().toLowerCase();
    const openaiKey = String(process.env.OPENAI_API_KEY || "").trim();
    const openrouterKey = String(process.env.OPENROUTER_API_KEY || "").trim();

    const pushOpenAi = () => {
        if (!openaiKey) return;
        configs.push({
            provider: "openai",
            apiKey: openaiKey,
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: resolveOpenAiChatModel(),
        });
    };

    const pushOpenRouterGpt = () => {
        if (!openrouterKey) return;
        for (const model of resolveOpenRouterGptChatModels()) {
            configs.push({
                provider: "openrouter",
                apiKey: openrouterKey,
                endpoint: "https://openrouter.ai/api/v1/chat/completions",
                model,
            });
        }
    };

    if (prefer === "openrouter") {
        pushOpenRouterGpt();
        pushOpenAi();
    } else if (prefer === "openai") {
        pushOpenAi();
        // If OpenAI quota/billing is exhausted, try GPT via OpenRouter (openai/gpt-4o-mini), not Gemini
        if (openrouterKey) pushOpenRouterGpt();
        else if (!openaiKey) pushOpenRouterGpt();
    } else {
        pushOpenAi();
        const allowOrFallback =
            process.env.CHAT_OPENROUTER_FALLBACK === "1" ||
            process.env.CHAT_OPENROUTER_FALLBACK === "true" ||
            !openaiKey;
        if (allowOrFallback) pushOpenRouterGpt();
    }

    if (!configs.length) {
        throw new Error(
            "Chat requires GPT. Set OPENAI_API_KEY (recommended) or OPENROUTER_API_KEY with openai/gpt-4o-mini."
        );
    }
    return configs;
}

function logChatProviderSetup() {
    try {
        const cfgs = getChatProviderConfigs();
        console.log(
            "[chat] Active providers:",
            cfgs.map((c) => `${c.provider}:${c.model}`).join(", ")
        );
    } catch (e) {
        console.warn("[chat] Provider setup:", e.message);
    }
}
logChatProviderSetup();

function buildSystemPrompt(hasContext, documentOnly = false) {
    const lines = [
        "You are EduMate AI Assistant for academic study support.",
        "Always answer in the same language as the user's question.",
    ];
    if (documentOnly && hasContext) {
        lines.push(
            "CRITICAL: Answer ONLY using the document context below. Do NOT use outside or general textbook knowledge.",
            "If the question is not answered by this document, say clearly that the open document does not cover that topic and stop — do not fill in with general explanations."
        );
    } else if (hasContext) {
        lines.push(
            "Use only the provided document context. If information is missing, say it is not in the document."
        );
    } else if (documentOnly) {
        lines.push(
            "A document is open but its text could not be loaded. Do not invent answers; tell the user the file may need indexing or has no extractable text."
        );
    } else {
        lines.push(
            "No document context is available; provide a general best-effort answer and clearly mention it is not document-grounded."
        );
    }
    lines.push("Be concise, accurate, and avoid hallucinations.");
    return lines.join("\n");
}

function isVietnameseQuestion(text) {
    return /[\u00C0-\u1EF9]/i.test(String(text || ""));
}

function buildOffTopicDocumentAnswer(question) {
    if (isVietnameseQuestion(question)) {
        return (
            "Câu hỏi này không nằm trong tài liệu bạn đang mở. " +
            "EduMate AI chỉ trả lời dựa trên nội dung file hiện tại — vui lòng hỏi về chủ đề có trong tài liệu " +
            "(ví dụ: thiết kế CSDL, yêu cầu hệ thống, bảng dữ liệu, v.v.)."
        );
    }
    return (
        "This question is not covered by the document you have open. " +
        "EduMate AI only answers from the current file — please ask about topics that appear in it."
    );
}

function buildNoDocumentContextAnswer(question) {
    if (isVietnameseQuestion(question)) {
        return (
            "Không đọc được nội dung tài liệu đang mở (chưa index hoặc file không có text trích xuất được). " +
            "Vui lòng thử lại sau vài giây hoặc mở lại file; EduMate AI không trả lời kiến thức chung khi bạn đang xem một tài liệu cụ thể."
        );
    }
    return (
        "Could not load text from the open document (not indexed or no extractable text). " +
        "Please retry in a moment; EduMate AI will not use general knowledge while a specific document is open."
    );
}

async function callLLM({ hasContext, context, question, documentOnly = false }) {
    const configs = getChatProviderConfigs();
    const userMessage = hasContext
        ? `Document context:\n---\n${context}\n---\n\nQuestion: ${question}\n\n` +
          "Remember: answer ONLY from the document context above. If the document does not contain the answer, say so and do not use outside knowledge."
        : `Question: ${question}`;
    const maxRetries = Math.min(Math.max(Number(process.env.CHAT_MAX_RETRIES) || 3, 1), 6);
    let lastErr = null;

    for (const cfg of configs) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            if (attempt === 0) {
                console.log(`[chat/ask] Using ${cfg.provider} model=${cfg.model}`);
            }
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
                            {
                                role: "system",
                                content: buildSystemPrompt(hasContext, documentOnly),
                            },
                            { role: "user", content: userMessage },
                        ],
                    }),
                    signal: controller.signal,
                });

                if (!resp.ok) {
                    const detail = await resp.text().catch(() => "");
                    const err = new Error(
                        `LLM Error: ${resp.status} ${resp.statusText}${detail ? ` - ${detail.slice(0, 300)}` : ""}`
                    );
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
                const isQuotaExhausted =
                    status === 402 ||
                    msg.includes("insufficient_quota") ||
                    msg.includes("exceeded your current quota") ||
                    msg.includes("check your plan and billing");
                const isRateLimit =
                    !isQuotaExhausted &&
                    (status === 429 ||
                        msg.includes("rate limit") ||
                        msg.includes("rate-limited") ||
                        msg.includes("too many requests"));
                const isRetryableSameModel =
                    isRateLimit || status === 503 || status === 408 || err?.name === "AbortError";
                if (isRetryableSameModel && attempt < maxRetries - 1) {
                    await sleep(1200 * (attempt + 1));
                    continue;
                }
                const shouldTryNextProvider =
                    status === 401 ||
                    status === 402 ||
                    status === 403 ||
                    isRateLimit ||
                    isQuotaExhausted ||
                    msg.includes("insufficient_quota");
                if (!shouldTryNextProvider) throw err;
                break;
            } finally {
                clearTimeout(timeout);
            }
        }
    }

    throw lastErr || new Error("All AI providers failed.");
}

function mapChatErrorToClient(err) {
    const status = Number(err?.status);
    const msg = String(err?.message || "").toLowerCase();
    if (
        status === 402 ||
        msg.includes("insufficient_quota") ||
        msg.includes("exceeded your current quota") ||
        msg.includes("check your plan and billing")
    ) {
        return {
            httpStatus: 402,
            message:
                "Tài khoản OpenAI đã hết quota/credit (không phải do gọi quá nhanh). Nạp billing tại platform.openai.com hoặc dùng OPENROUTER_API_KEY để chat qua OpenRouter.",
        };
    }
    if (
        status === 429 ||
        msg.includes("rate limit") ||
        msg.includes("rate-limited") ||
        msg.includes("too many requests")
    ) {
        return {
            httpStatus: 429,
            message:
                "GPT đang bị giới hạn tần suất (rate limit). Vui lòng thử lại sau 1–2 phút.",
        };
    }
    if (status === 401 || status === 403 || msg.includes("api key")) {
        return { httpStatus: 502, message: "Cấu hình API key AI không hợp lệ." };
    }
    return { httpStatus: 500, message: err?.message || "AI query failed." };
}

async function saveCitationsForMessage(messageId, chunks) {
    const records = [];
    for (const chunk of chunks || []) {
        const segmentId = Number(chunk.segmentId ?? chunk.segment_id);
        if (!Number.isFinite(segmentId) || segmentId <= 0) continue;
        try {
            const citation = await Citation.create({
                message_id: messageId,
                segment_id: segmentId,
                excerpt: String(chunk.content || "").substring(0, 500),
            });
            records.push({
                citation_id: citation.citation_id,
                segment_id: segmentId,
                excerpt: citation.excerpt,
                similarity: chunk.similarity ?? chunk.score ?? null,
            });
        } catch (err) {
            console.warn(
                `[chat/ask] Citation insert failed (message=${messageId}, segment=${segmentId}):`,
                err.message
            );
        }
    }
    if (records.length) {
        console.log(`[chat/ask] Saved ${records.length} citation(s) for message ${messageId}`);
    }
    return records;
}

/**
 * POST /api/chat/ask
 * Body: { question, s3Key?, sessionId? }
 * Returns: { answer, citations[], sessionId }
 */
const askQuestion = async (req, res) => {
    try {
        const userId = resolveChatUserId(req);
        const { question, s3Key: rawS3Key, documentId: rawDocumentId, sessionId } = req.body;
        const docRef = await resolveChatDocumentRef({
            s3Key: rawS3Key,
            documentId: rawDocumentId,
        });

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

        // 3. Embed/index first if needed, then vector search (reuse segments on later messages)
        let context = "";
        let matchedChunks = [];
        let indexMeta = { indexedNow: false, skipped: true, chunkCount: 0 };
        let relevantToDocument = true;
        const hasDocumentRef = !!(docRef.s3Key || docRef.documentId);

        if (hasDocumentRef) {
            try {
                indexMeta = await ensureDocumentReadyForChat(docRef);
                if (indexMeta.documentId && !docRef.documentId) {
                    docRef.documentId = indexMeta.documentId;
                }
                if (indexMeta.s3Key && !docRef.s3Key) {
                    docRef.s3Key = indexMeta.s3Key;
                }

                const maxChunks = Math.min(
                    120,
                    Math.max(1, Number(process.env.CHAT_RAG_MAX_CHUNKS) || 80)
                );
                const maxContextChars = Math.min(
                    120000,
                    Math.max(4000, Number(process.env.CHAT_RAG_MAX_CONTEXT_CHARS) || 32000)
                );
                const preferFullDocument =
                    String(process.env.CHAT_RAG_FULL_DOCUMENT || "1").trim() !== "0";

                const result = await retrieveTopChunks({
                    s3Key: docRef.s3Key,
                    documentId: docRef.documentId,
                    query: question.trim(),
                    topK: maxChunks,
                    maxContextChars,
                    preferFullDocument,
                });
                context = result.context || "";
                matchedChunks = result.chunks || [];
                relevantToDocument = result.relevantToDocument !== false;

                if (!context.trim()) {
                    console.warn(
                        `[chat/ask] No document context after index (docId=${docRef.documentId}, key=${docRef.s3Key}, chunks=${indexMeta.chunkCount})`
                    );
                }
            } catch (searchErr) {
                console.warn("[chat/ask] RAG failed:", searchErr.message);
                indexMeta = {
                    ...indexMeta,
                    ready: false,
                    message: searchErr.message,
                };
            }
        }

        // 4. Answer: document-open mode never uses general knowledge for off-topic / empty context
        let answer;
        const hasContext = context.trim().length > 0;

        if (hasDocumentRef && hasContext && !relevantToDocument) {
            answer = buildOffTopicDocumentAnswer(question.trim());
            console.log(
                `[chat/ask] Off-topic for open document (docId=${docRef.documentId}, key=${docRef.s3Key})`
            );
        } else if (hasDocumentRef && !hasContext) {
            answer = buildNoDocumentContextAnswer(question.trim());
        } else {
            answer = await callLLM({
                hasContext,
                context,
                question: question.trim(),
                documentOnly: hasDocumentRef,
            });
            if (!answer || !answer.trim()) {
                answer = hasContext
                    ? "I found document context but could not generate an answer at this time. Please try again."
                    : "I could not generate a response right now. Please try again.";
            }
        }

        // 5. Save assistant message
        const aiMessage = await ChatMessage.create({
            session_id: session.session_id,
            role: "assistant",
            message_text: answer,
        });

        // 6. Save citations (matched chunks, or fallback to first segments if RAG had context)
        let citationChunks = matchedChunks;
        if (!citationChunks.length && context.trim()) {
            citationChunks = (await listSegmentsForDocRef(docRef)).slice(0, 5);
        }
        if (!citationChunks.length && (indexMeta.chunkCount ?? 0) > 0) {
            citationChunks = (await listSegmentsForDocRef(docRef)).slice(0, 5);
        }
        const citationRecords = await saveCitationsForMessage(
            aiMessage.message_id,
            citationChunks
        );

        return res.json({
            success: true,
            data: {
                answer,
                sessionId: session.session_id,
                messageId: aiMessage.message_id,
                citations: citationRecords,
                contextFound: context.trim().length > 0,
                relevantToDocument: hasDocumentRef ? relevantToDocument : null,
                documentId: docRef.documentId,
                s3Key: docRef.s3Key,
                indexedNow: !!indexMeta.indexedNow,
                indexSkipped: !!indexMeta.skipped,
                chunkCount: indexMeta.chunkCount ?? 0,
            },
        });
    } catch (err) {
        console.error("[chat/ask] Error:", err.message);
        const mapped = mapChatErrorToClient(err);
        return res.status(mapped.httpStatus).json({ success: false, message: mapped.message });
    }
};

/**
 * POST /api/chat/prepare
 * Index/embed the open document before the user asks (faster first answer).
 * Body: { s3Key?, documentId? }
 */
const prepareDocumentForChat = async (req, res) => {
    try {
        const userId = resolveChatUserId(req);
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Missing user identity. Provide token or userId.",
            });
        }

        const docRef = await resolveChatDocumentRef({
            s3Key: req.body?.s3Key,
            documentId: req.body?.documentId,
        });

        if (!docRef.s3Key && !docRef.documentId) {
            return res.status(400).json({
                success: false,
                message: "Missing documentId or s3Key.",
            });
        }

        const result = await ensureDocumentReadyForChat(docRef);
        return res.json({
            success: true,
            data: {
                ready: result.ready,
                indexedNow: result.indexedNow,
                skipped: result.skipped,
                chunkCount: result.chunkCount ?? 0,
                documentId: result.documentId ?? docRef.documentId,
                s3Key: result.s3Key ?? docRef.s3Key,
                message: result.message || null,
            },
        });
    } catch (err) {
        console.error("[chat/prepare] Error:", err.message);
        return res.status(500).json({
            success: false,
            message: err.message || "Could not prepare document for chat.",
        });
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

module.exports = {
    askQuestion,
    prepareDocumentForChat,
    getSessions,
    getSessionMessages,
    ensureDocumentReadyForChat,
    resolveChatDocumentRef,
};
