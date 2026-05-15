const { retrieveTopChunks } = require("./vectorSearch");
const crypto = require("crypto");
const path = require("path");
const s3 = require("./s3Upload");
const { extractDocumentText } = require("./extractDocumentText");
const {
  resolveQuizLanguage,
  languageLabel,
  languageRequirement,
} = require("./src/utils/quizLanguage");

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";

/** Quiz output token cap; default above 600 so multi-question JSON is not truncated mid-stream. */
function computeQuizMaxTokens(qCount) {
  const cap = Math.min(
    8192,
    Math.max(800, Number(process.env.QUIZ_MAX_TOKENS || 2800))
  );
  const need = 220 + Math.ceil(Number(qCount) || 5) * 200;
  return Math.min(cap, Math.max(need, 600));
}

function ensureEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing ${name}.`);
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
        const err = new Error(`OpenRouter HTTP ${resp.status}${text ? `: ${text}` : ""}`);
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

/** OpenRouter / some models return content as a string or chunk array { type, text }. */
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

/** Replace smart quotes often seen in LLM output. */
function normalizeQuizJsonQuotes(s) {
  return String(s).replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
}

/**
 * Slice one balanced JSON value (object or array) from the first { or [.
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
 * Models may return JSON with markdown ```json ... ```, surrounding text, or a root [...] array.
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

/**
 * Recover complete question objects from truncated JSON output.
 * Example: {"questions":[{...},{...},{"quest...
 */
function recoverQuestionsFromTruncatedOutput(content) {
  const raw = normalizeQuizJsonQuotes(String(content ?? "").replace(/^\uFEFF/, ""));
  if (!raw.trim()) return null;

  const candidates = [];
  const qIdx = raw.search(/"questions"\s*:\s*\[/i);
  if (qIdx !== -1) {
    const arrStart = raw.indexOf("[", qIdx);
    if (arrStart !== -1) candidates.push(arrStart);
  }
  const firstArray = raw.indexOf("[");
  if (firstArray !== -1) candidates.push(firstArray);

  for (const arrStart of candidates) {
    const questions = [];
    let inString = false;
    let escape = false;
    let objDepth = 0;
    let objStart = -1;

    for (let i = arrStart + 1; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        if (objDepth === 0) objStart = i;
        objDepth++;
        continue;
      }
      if (ch === "}") {
        if (objDepth > 0) objDepth--;
        if (objDepth === 0 && objStart !== -1) {
          const snippet = raw.slice(objStart, i + 1);
          const parsedObj = tryParseJson(snippet);
          if (parsedObj && typeof parsedObj === "object") questions.push(parsedObj);
          objStart = -1;
        }
        continue;
      }
      if (ch === "]" && objDepth === 0) break;
    }

    if (questions.length) return { questions };
  }

  return null;
}

function parseQuizResponse(content) {
  if (!content) throw new Error("AI returned no content.");
  if (String(content).trim() === "Not enough information") return [];

  const parsed =
    tryParseQuizJsonObject(content) ||
    recoverQuestionsFromTruncatedOutput(content);
  if (parsed == null || typeof parsed !== "object") {
    const preview = String(content).replace(/\s+/g, " ").slice(0, 280);
    console.warn("[quiz] JSON parse failed, preview:", preview);
    throw new Error(
      "Could not parse quiz JSON (output may be truncated — increase QUIZ_MAX_TOKENS or reduce question count)."
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

      const explanation = String(q.explanation || q.rationale || "").trim().slice(0, 8000);
      return {
        id,
        question,
        options: options || {},
        correct_answer: correct || "A",
        explanation,
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

async function fallbackContextFromSourceFile(s3Key, maxContextChars = 6000) {
  if (!s3Key || !s3.isS3Configured()) return { context: "", chunks: [] };
  try {
    const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
    const ext = path.extname(String(s3Key || "")).toLowerCase();
    const plain = await extractDocumentText(buffer, ext, contentType || "");
    const normalized = String(plain || "").replace(/\s+/g, " ").trim();
    if (!normalized) return { context: "", chunks: [] };
    const context = normalized.slice(0, Math.max(1000, Number(maxContextChars) || 6000));
    return {
      context,
      chunks: [{ section: 1, content: context, score: 1 }],
    };
  } catch (e) {
    console.warn("[quiz] source-file fallback context failed:", e.message);
    return { context: "", chunks: [] };
  }
}

async function generateQuiz({ s3Key, query, numQuestions, languageHint = "Auto" }) {
  const retrievalQuery = String(query || "core concept and key facts").trim();
  let { context, chunks } = await retrieveTopChunks({
    s3Key,
    query: retrievalQuery,
    topK: 5,
    maxContextChars: 8000,
  });
  if (!String(context || "").trim()) {
    const fb = await fallbackContextFromSourceFile(s3Key, 6000);
    context = fb.context;
    chunks = fb.chunks;
  }

  const chunkTexts = (chunks || []).map((c) => c.content);
  const autoQ = chunkTexts.length ? calculateQuestionCount(chunkTexts) : 3;
  const requested = Number(numQuestions);
  const qCount =
    Number.isFinite(requested) && requested > 0
      ? Math.min(25, Math.max(1, Math.floor(requested)))
      : autoQ;

  if (!context.trim()) return { questions: [], targetCount: qCount };

  const lang = resolveQuizLanguage(languageHint, context);
  const strictSystem = `Generate multiple-choice questions based ONLY on the provided context.
Language of questions/options: ${languageLabel(lang)}.
${languageRequirement(lang)}
Do not use external knowledge.
If insufficient data, return exactly the JSON: {"questions":[]}.`;
  const relaxedSystem = `Generate multiple-choice questions based ONLY on the provided context.
Language of questions/options: ${languageLabel(lang)}.
${languageRequirement(lang)}
Do not use external knowledge.
Try your best to produce at least 3 meaningful questions when context has usable content.`;

  const user = [
    `Generate exactly ${qCount} questions in ${languageLabel(lang)}.`,
    "Return STRICT JSON only with this format:",
    "{",
    '  "questions": [',
    "    {",
    '      "question": "string",',
    '      "options": ["Option text 1", "Option text 2", "Option text 3", "Option text 4"],',
    '      "correctAnswer": "A",',
    '      "explanation": "1–3 sentences: why the correct option is supported by the context."',
    "    }",
    "  ]",
    "}",
    "- For each question, include a non-empty explanation in the same language as the question.",
    "- Do NOT include text outside JSON.",
    "- Do NOT use markdown.",
    "- options must be full sentences or phrases in the same language as the document, not single letters.",
    "",
    "Context:",
    context,
  ].join("\n");

  const useJsonSchema = String(process.env.QUIZ_OPENROUTER_JSON_MODE || "1").trim() !== "0";
  async function askOnce(systemPrompt) {
    const payload = {
      model: OPENROUTER_MODEL,
      temperature: 0.2,
      max_tokens: computeQuizMaxTokens(qCount),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: user },
      ],
    };
    if (useJsonSchema) payload.response_format = { type: "json_object" };
    const completion = await callOpenRouterWithRetry(payload);
    const choice0 = completion?.choices?.[0];
    const content = getAssistantMessageText(choice0);
    const parsed = parseQuizResponse(content);
    return parsed.length > qCount ? parsed.slice(0, qCount) : parsed;
  }

  let questions = await askOnce(strictSystem);
  if (!questions.length && String(context || "").trim()) {
    questions = await askOnce(relaxedSystem);
  }
  return { questions, targetCount: qCount };
}

module.exports = {
  generateQuiz,
  calculateQuestionCount,
  getQuiz,
  callOpenRouterWithRetry,
};

