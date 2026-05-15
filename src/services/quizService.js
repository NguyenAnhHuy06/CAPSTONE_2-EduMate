const { retrieveTopChunks } = require("./vectorSearch");
const crypto = require("crypto");
const {
  resolveQuizLanguage,
  languageLabel,
  languageRequirement,
} = require("../utils/quizLanguage");

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";

function computeQuizMaxTokens(qCount) {
  const cap = Math.min(8192, Math.max(700, Number(process.env.QUIZ_MAX_TOKENS || 1800)));
  const n = Math.ceil(Number(qCount) || 5);
  const need = 220 + n * 200;
  return Math.min(cap, Math.max(need, 500));
}

function ensureEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Thiếu ${name}.`);
  return String(v).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callOpenRouterWithRetry(payload, maxRetries = 3) {
  const key = ensureEnv("OPENROUTER_API_KEY");
  const timeoutMs = Math.max(8000, Number(process.env.OPENROUTER_TIMEOUT_MS || 25000));
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    let timeout = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`OpenRouter lỗi HTTP ${resp.status}${text ? `: ${text}` : ""}`);
        err.status = resp.status;
        throw err;
      }
      return await resp.json();
    } catch (e) {
      if (e?.name === "AbortError") {
        e.status = 408;
        e.message = `OpenRouter timeout sau ${timeoutMs}ms`;
      }
      lastErr = e;
      const retryable = Number(e.status) === 429 || Number(e.status) === 503 || Number(e.status) === 408;
      if (!retryable || i === maxRetries - 1) throw e;
      await sleep(1000 * (i + 1));
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw lastErr;
}

function getAssistantMessageText(choice) {
  const msg = choice?.message;
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => typeof p === "string" ? p : (p?.type === "text" ? p.text : "")).join("");
  return String(c ?? "");
}

function tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

function normalizeQuizJsonQuotes(s) { return String(s).replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"'); }

function sliceFirstBalancedJson(raw) {
  const t = normalizeQuizJsonQuotes(String(raw ?? "").replace(/^\uFEFF/, ""));
  const idx = t.search(/[\{\[]/);
  if (idx === -1) return null;
  const open = t[idx], close = open === "{" ? "}" : "]";
  let depth = 0, inString = false, escape = false;
  for (let i = idx; i < t.length; i++) {
    const c = t[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return t.slice(idx, i + 1); }
  }
  return null;
}

function tryParseQuizJsonObject(content) {
  let raw = String(content ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) return null;
  let direct = tryParseJson(normalizeQuizJsonQuotes(raw));
  if (direct != null) return direct;
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  direct = tryParseJson(normalizeQuizJsonQuotes(unfenced));
  if (direct != null) return direct;
  let slice = sliceFirstBalancedJson(raw);
  if (slice) { direct = tryParseJson(slice); if (direct != null) return direct; }
  slice = sliceFirstBalancedJson(unfenced);
  if (slice) { direct = tryParseJson(slice); if (direct != null) return direct; }
  return null;
}

function parseQuizResponse(content) {
  if (!content) throw new Error("AI không trả nội dung.");
  if (String(content).trim() === "Not enough information") return [];
  const parsed = tryParseQuizJsonObject(content);
  if (parsed == null || typeof parsed !== "object") {
    throw new Error("Không parse được JSON quiz (có thể output bị cắt — tăng QUIZ_MAX_TOKENS hoặc giảm số câu).");
  }
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.questions) ? parsed.questions : (Array.isArray(parsed.quiz) ? parsed.quiz : []));
  return arr.map(q => {
    const question = String(q.question || "").trim();
    if (!question) return null;
    let options = q.options;
    if (Array.isArray(options)) {
      const L = ["A", "B", "C", "D"]; const obj = {};
      for (let i = 0; i < 4 && i < options.length; i++) obj[L[i]] = String(options[i] ?? "").trim();
      options = obj;
    }
    const correct = String(q.correctAnswer || q.correct_answer || "").trim().toUpperCase();
    const stable = JSON.stringify({ question, options: options || {}, correctAnswer: correct || "A" });
    const id = crypto.createHash("sha1").update(stable).digest("hex").slice(0, 16);
    const explanation = String(q.explanation || q.rationale || "").trim().slice(0, 8000);
    return { id, question, options: options || {}, correct_answer: correct || "A", explanation };
  }).filter(Boolean);
}

function randomSample(list, k) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, k);
}

function getQuiz(questions, history, count = 5) {
  const hist = Array.isArray(history) ? history : [];
  const unseen = questions.filter(q => q && q.id && !hist.includes(q.id));
  const k = Math.min(Math.max(1, Number(count) || 5), 25);
  if (unseen.length >= k) return randomSample(unseen, k);
  return randomSample(questions, Math.min(k, questions.length));
}

function calculateQuestionCount(chunks) {
  const words = chunks.join(" ").split(/\s+/).filter(Boolean).length;
  const q = Math.floor(words / 90);
  if (q < 3) return 3;
  if (q > 25) return 25;
  return Math.min(q, 18);
}

async function generateQuiz({ s3Key, query, numQuestions, languageHint = "Auto" }) {
  const retrievalQuery = String(query || "core concept and key facts").trim();
  const { context, chunks } = await retrieveTopChunks({
    s3Key,
    query: retrievalQuery,
    topK: 3,
    maxContextChars: 5000,
  });
  const chunkTexts = (chunks || []).map(c => c.content);
  const autoQ = chunkTexts.length ? calculateQuestionCount(chunkTexts) : 3;
  const requested = Number(numQuestions);
  const qCount = Number.isFinite(requested) && requested > 0 ? Math.min(20, Math.max(1, Math.floor(requested))) : Math.min(autoQ, 20);
  if (!context.trim()) return { questions: [], targetCount: qCount };

  const lang = resolveQuizLanguage(languageHint, context);
  const system =
    `Generate multiple-choice questions based ONLY on the provided context.\n` +
    `Language of questions/options: ${languageLabel(lang)}.\n` +
    `${languageRequirement(lang)}\n` +
    `Do not use external knowledge.\n` +
    `If insufficient data, return exactly the JSON: {"questions":[]}.`;
  const user = [
    `Generate exactly ${qCount} questions in ${languageLabel(lang)}.`,
    "Return STRICT JSON only with this format:", "{", '  "questions": [', "    {",
    '      "question": "string",',
    '      "options": ["Option text 1", "Option text 2", "Option text 3", "Option text 4"],',
    '      "correctAnswer": "A",',
    '      "explanation": "1–3 sentences: why the correct option matches the context and why the others are wrong or less accurate."',
    "    }", "  ]", "}",
    "- For each question, include a non-empty explanation in the same language as the question.",
    "- Do NOT include text outside JSON.",
    "- Do NOT use markdown.",
    "", "Context:", context,
  ].join("\n");

  const useJsonSchema = String(process.env.QUIZ_OPENROUTER_JSON_MODE || "0").trim() !== "0";
  const payload = {
    model: OPENROUTER_MODEL, temperature: 0.2, max_tokens: computeQuizMaxTokens(qCount),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (useJsonSchema) payload.response_format = { type: "json_object" };

  const completion = await callOpenRouterWithRetry(payload);
  const choice0 = completion?.choices?.[0];
  const content = getAssistantMessageText(choice0);
  
  console.log("[generateQuiz] raw AI content length =", String(content || "").length);
  console.log("[generateQuiz] raw AI content preview =", String(content || "").slice(0, 500));

  const parsed = parseQuizResponse(content);
  const questions = parsed.length > qCount ? parsed.slice(0, qCount) : parsed;
  return { questions, targetCount: qCount };
}

async function generateQuizWithAI(params) { return generateQuiz(params); }

/**
 * Tạo quiz trực tiếp từ raw text (không cần embedding/MySQL).
 * Dùng cho luồng: tải file S3 → trích text → AI quiz.
 */
async function generateQuizFromText({ text, numQuestions = 5, languageHint = "Auto" }) {
  const MAX_CONTEXT = 15000;
  const context = String(text || "").trim().slice(0, MAX_CONTEXT);
  if (!context) throw new Error("Tài liệu trống, không thể tạo quiz.");
  const lang = resolveQuizLanguage(languageHint, context);

  const words = context.split(/\s+/).filter(Boolean).length;
  console.log(`[generateQuizFromText] words=${words}, requested=${numQuestions}`);

  // Tự động điều chỉnh số câu theo độ dài text (1 câu / ~40 từ)
  const maxByText = Math.min(100, Math.max(3, Math.floor(words / 40)));
  const qCount = Math.min(maxByText, Math.max(1, Number(numQuestions) || 10));
  console.log(`[generateQuizFromText] will generate ${qCount} questions (maxByText=${maxByText})`);

  const system =
    `You are an expert quiz generator. Generate multiple-choice questions based ONLY on the provided context.\n` +
    `Language of questions/options: ${languageLabel(lang)}.\n` +
    `${languageRequirement(lang)}\n` +
    `Do not use external knowledge.\n` +
    `Each question must have exactly 4 options and 1 correct answer.\n` +
    `If the document has insufficient content, generate as many questions as you can.\n` +
    `Return ONLY valid JSON, no markdown, no extra text.`;

  const user = [
    `Generate exactly ${qCount} questions in ${languageLabel(lang)}.`,
    "Return STRICT JSON only with this format:",
    "{",
    '  "questions": [',
    "    {",
    '      "question": "string",',
    '      "options": ["Option text 1", "Option text 2", "Option text 3", "Option text 4"],',
    '      "correctAnswer": "A",',
    '      "explanation": "1–3 sentences based only on the context; justify the correct answer."',
    "    }",
    "  ]",
    "}",
    "- Each question must include a non-empty explanation in the same language as the question.",
    "- Do NOT include text outside JSON.",
    "- Do NOT use markdown.",
    "- options must contain full answer text, not just letters.",
    "- Do NOT return options like ['A','B','C','D'].",
    "- Each option must be meaningful and based only on the context.",
    "- Wrong answers should be plausible distractors.",
    "",
    "Context:",
    context,
  ].join("\n");

  // Tính max_tokens: mỗi câu ~130 tokens, thêm overhead
  const maxTokensNeeded = Math.min(16000, 500 + qCount * 220);
  const payload = {
    model: OPENROUTER_MODEL,
    temperature: 0.3,
    max_tokens: maxTokensNeeded,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
  };

  console.log(`[generateQuizFromText] calling OpenRouter model=${OPENROUTER_MODEL} max_tokens=${maxTokensNeeded}`);
  const completion = await callOpenRouterWithRetry(payload);
  const choice0 = completion?.choices?.[0];
  const content = getAssistantMessageText(choice0);
  console.log(`[generateQuizFromText] raw AI response length=${content.length}`);

  if (!content || !content.trim()) {
    throw new Error("AI trả về phản hồi trống.");
  }

  const parsed = parseQuizResponse(content);
  console.log(`[generateQuizFromText] parsed ${parsed.length} questions`);

  if (!parsed.length) {
    // Log first 500 chars of AI response to diagnose
    console.error(`[generateQuizFromText] AI raw content (first 500): ${content.slice(0, 500)}`);
    throw new Error("AI không tạo được câu hỏi nào từ tài liệu này. Có thể nội dung tài liệu quá ngắn hoặc không có thông tin.");
  }

  const questions = parsed.length > qCount ? parsed.slice(0, qCount) : parsed;
  return { questions, targetCount: qCount };
}


module.exports = { generateQuiz, generateQuizWithAI, generateQuizFromText, getQuiz, calculateQuestionCount, callOpenRouterWithRetry };
