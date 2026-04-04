const { retrieveTopChunks } = require("./vectorSearch");
const crypto = require("crypto");

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";

/** Trần token cho quiz; mặc định cao hơn 600 để JSON nhiều câu không bị cắt giữa chừng. */
function computeQuizMaxTokens(qCount) {
  const cap = Math.min(
    8192,
    Math.max(800, Number(process.env.QUIZ_MAX_TOKENS || 2800))
  );
  const need = 220 + Math.ceil(Number(qCount) || 5) * 110;
  return Math.min(cap, Math.max(need, 600));
}

function ensureEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Thiếu ${name}.`);
  return String(v).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callOpenRouterWithRetry(payload, maxRetries = 3) {
  const key = ensureEnv("OPENROUTER_API_KEY");
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`OpenRouter lỗi HTTP ${resp.status}${text ? `: ${text}` : ""}`);
        err.status = resp.status;
        throw err;
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      const retryable = Number(e.status) === 429 || Number(e.status) === 503;
      if (!retryable || i === maxRetries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/** OpenRouter / một số model trả content là string hoặc mảng chunk { type, text }. */
function getAssistantMessageText(choice) {
  const msg = choice?.message;
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (typeof p?.content === "string") return p.content;
        return "";
      })
      .join("");
  }
  if (msg.refusal && typeof msg.refusal === "string") return msg.refusal;
  return String(c ?? "");
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Thay dấu ngoặc kép “thông minh” hay gặp trong output LLM. */
function normalizeQuizJsonQuotes(s) {
  return String(s).replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
}

/**
 * Cắt một giá trị JSON (object hoặc array) cân bằng từ vị trí mở đầu tiên { hoặc [.
 */
function sliceFirstBalancedJson(raw) {
  const t = normalizeQuizJsonQuotes(String(raw ?? "").replace(/^\uFEFF/, ""));
  const idx = t.search(/[\{\[]/);
  if (idx === -1) return null;
  const open = t[idx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = idx; i < t.length; i++) {
    const c = t[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return t.slice(idx, i + 1);
    }
  }
  return null;
}

/**
 * Model đôi khi trả JSON kèm markdown ```json ... ```, text trước/sau, hoặc array gốc [...].
 */
function tryParseQuizJsonObject(content) {
  let raw = String(content ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) return null;

  let direct = tryParseJson(normalizeQuizJsonQuotes(raw));
  if (direct != null) return direct;

  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  direct = tryParseJson(normalizeQuizJsonQuotes(unfenced));
  if (direct != null) return direct;

  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (block) {
    direct = tryParseJson(normalizeQuizJsonQuotes(block[1].trim()));
    if (direct != null) return direct;
  }

  let slice = sliceFirstBalancedJson(raw);
  if (slice) {
    direct = tryParseJson(slice);
    if (direct != null) return direct;
  }

  slice = sliceFirstBalancedJson(unfenced);
  if (slice) {
    direct = tryParseJson(slice);
    if (direct != null) return direct;
  }

  return null;
}

function parseQuizResponse(content) {
  if (!content) throw new Error("AI không trả nội dung.");
  if (String(content).trim() === "Not enough information") return [];

  const parsed = tryParseQuizJsonObject(content);
  if (parsed == null || typeof parsed !== "object") {
    const preview = String(content).replace(/\s+/g, " ").slice(0, 280);
    console.warn("[quiz] JSON parse failed, preview:", preview);
    throw new Error(
      "Không parse được JSON quiz (có thể output bị cắt — tăng QUIZ_MAX_TOKENS hoặc giảm số câu)."
    );
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.questions)
      ? parsed.questions
      : Array.isArray(parsed.quiz)
        ? parsed.quiz
        : [];

  return arr
    .map((q) => {
      const question = String(q.question || "").trim();
      if (!question) return null;

      let options = q.options;
      if (Array.isArray(options)) {
        const letters = ["A", "B", "C", "D"];
        const obj = {};
        for (let i = 0; i < 4 && i < options.length; i++) {
          obj[letters[i]] = String(options[i] ?? "").trim();
        }
        options = obj;
      }

      const correct =
        String(q.correctAnswer || q.correct_answer || "").trim().toUpperCase();

      const stable = JSON.stringify({
        question,
        options: options || {},
        correctAnswer: correct || "A",
      });
      const id = crypto.createHash("sha1").update(stable).digest("hex").slice(0, 16);

      return {
        id,
        question,
        options: options || {},
        correct_answer: correct || "A",
        explanation: "",
      };
    })
    .filter(Boolean);
}

function randomSample(list, k) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k);
}

function getQuiz(questions, history, count = 5) {
  const hist = Array.isArray(history) ? history : [];
  const unseen = questions.filter((q) => q && q.id && !hist.includes(q.id));
  const k = Math.min(Math.max(1, Number(count) || 5), 25);
  if (unseen.length >= k) return randomSample(unseen, k);
  return randomSample(questions, Math.min(k, questions.length));
}

function calculateQuestionCount(chunks) {
  const words = chunks.join(" ").split(/\s+/).filter(Boolean).length;

  const MIN = 3;
  const SOFT_MAX = 18;
  const HARD_MAX = 25;

  let q = Math.floor(words / 90);

  if (q < MIN) return MIN;
  if (q > HARD_MAX) return HARD_MAX;

  return Math.min(q, SOFT_MAX);
}

async function generateQuiz({ s3Key, query, numQuestions, languageHint = "Vietnamese" }) {
  const retrievalQuery = String(query || "core concept and key facts").trim();
  const { context, chunks } = await retrieveTopChunks({
    s3Key,
    query: retrievalQuery,
    topK: 3,
    maxContextChars: 2000,
  });

  const chunkTexts = (chunks || []).map((c) => c.content);
  const autoQ = chunkTexts.length ? calculateQuestionCount(chunkTexts) : 3;
  const requested = Number(numQuestions);
  const qCount =
    Number.isFinite(requested) && requested > 0
      ? Math.min(25, Math.max(1, Math.floor(requested)))
      : autoQ;

  if (!context.trim()) return { questions: [], targetCount: qCount };

  const system = `Generate multiple-choice questions based ONLY on the provided context.
Do not use external knowledge.
If insufficient data, return exactly the JSON: {"questions":[]}.`;

  const user = [
    `Language: ${languageHint}`,
    `Generate exactly ${qCount} questions.`,
    "Return STRICT JSON only with this format:",
    "{",
    '  "questions": [',
    "    {",
    '      "question": "string",',
    '      "options": ["A", "B", "C", "D"],',
    '      "correctAnswer": "A"',
    "    }",
    "  ]",
    "}",
    "- Do NOT include explanations.",
    "- Do NOT include text outside JSON.",
    "- Do NOT use markdown.",
    "",
    "Context:",
    context,
  ].join("\n");

  const useJsonSchema = String(process.env.QUIZ_OPENROUTER_JSON_MODE || "1").trim() !== "0";
  const payload = {
    model: OPENROUTER_MODEL,
    temperature: 0.2,
    max_tokens: computeQuizMaxTokens(qCount),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (useJsonSchema) {
    payload.response_format = { type: "json_object" };
  }

  const completion = await callOpenRouterWithRetry(payload);

  const choice0 = completion?.choices?.[0];
  const content = getAssistantMessageText(choice0);
  const parsed = parseQuizResponse(content);
  const questions = parsed.length > qCount ? parsed.slice(0, qCount) : parsed;
  return { questions, targetCount: qCount };
}

module.exports = {
  generateQuiz,
  calculateQuestionCount,
  getQuiz,
  callOpenRouterWithRetry,
};

