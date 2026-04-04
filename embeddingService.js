const pLimit = require("p-limit");

const GEMINI_EMBED_BASE =
  process.env.GEMINI_EMBED_BASE ||
  "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_EMBED_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || "models/text-embedding-004";

/** Parallel embedding calls cap (Gemini quota / 429 safety). Range 3–5 typical. */
const EMBED_CONCURRENCY = Math.min(
  5,
  Math.max(1, Number(process.env.EMBED_CONCURRENCY) || 4)
);

const MAX_429_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const limit = pLimit(EMBED_CONCURRENCY);

function ensureEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Thiếu ${name}.`);
  }
  return String(v).trim();
}

function normalizeGeminiModel(model) {
  const m = String(model || "").trim();
  if (!m) return "models/text-embedding-004";
  return m.startsWith("models/") ? m : `models/${m}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitToSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function countWords(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Chunk 300-500 words, preserve sentence boundaries, with overlap.
 */
function splitIntoWordChunks(
  text,
  { targetWords = 380, minWords = 300, maxWords = 500, overlapWords = 40, maxChunks = 120 } = {}
) {
  const sentences = splitToSentences(text);
  const chunks = [];
  let i = 0;
  while (i < sentences.length && chunks.length < maxChunks) {
    let words = 0;
    const start = i;
    let end = i;
    while (end < sentences.length) {
      const w = countWords(sentences[end]);
      if (words + w > maxWords && words >= minWords) break;
      words += w;
      end++;
      if (words >= targetWords && words >= minWords) break;
    }
    if (end === start) end = Math.min(start + 1, sentences.length);

    const chunk = sentences.slice(start, end).join(" ").trim();
    if (chunk) chunks.push(chunk);

    if (end >= sentences.length) break;

    let backWords = 0;
    let backIdx = end;
    while (backIdx > start && backWords < overlapWords) {
      backIdx--;
      backWords += countWords(sentences[backIdx]);
    }
    i = Math.max(backIdx, start + 1);
  }
  return chunks;
}

/**
 * Single HTTP call to Gemini embedContent (no retry — use safeEmbedding).
 */
async function requestEmbeddingOnce(model, text, key) {
  const endpoint = `${String(GEMINI_EMBED_BASE).replace(/\/+$/, "")}/${model}:embedContent`;
  const resp = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      content: { parts: [{ text: String(text || "") }] },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    const err = new Error(`Gemini embedding lỗi HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }
  const data = await resp.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Gemini embedding không trả vector hợp lệ.");
  }
  return values;
}

/**
 * One embedding vector: model fallback + 429 handling.
 * - On 404 / NOT_FOUND: try next model.
 * - On 429: retry same model up to 3 attempts, 2s between tries; then fail.
 */
async function safeEmbedding(text) {
  const key = ensureEnv("GEMINI_API_KEY");
  const primary = normalizeGeminiModel(GEMINI_EMBED_MODEL);
  const fallbacks = [
    primary,
    "models/gemini-embedding-001",
    "models/gemini-embedding-2-preview",
  ];
  const models = [...new Set(fallbacks.map(normalizeGeminiModel))];

  let lastErr = null;
  for (const model of models) {
    for (let attempt = 0; attempt < MAX_429_ATTEMPTS; attempt++) {
      try {
        return await requestEmbeddingOnce(model, text, key);
      } catch (e) {
        lastErr = e;
        const st = Number(e.status);
        if (st === 429) {
          if (attempt < MAX_429_ATTEMPTS - 1) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          throw e;
        }
        const notFound = st === 404 || String(e.message).includes("NOT_FOUND");
        if (notFound) break;
        throw e;
      }
    }
  }
  throw lastErr || new Error("Không có model Gemini embedding khả dụng.");
}

/**
 * Public API — same behavior as safeEmbedding (retry + fallback).
 * Kept for backward compatibility with existing imports.
 */
async function createEmbedding(text) {
  return safeEmbedding(text);
}

/**
 * Embed many chunks with bounded parallelism (default 4) to avoid 429 storms.
 * Order of output matches order of input.
 */
async function embedAllChunks(chunkTexts) {
  const texts = Array.isArray(chunkTexts) ? chunkTexts : [];
  return Promise.all(texts.map((t) => limit(() => safeEmbedding(t))));
}

module.exports = {
  createEmbedding,
  safeEmbedding,
  embedAllChunks,
  splitIntoWordChunks,
  normalizeGeminiModel,
  EMBED_CONCURRENCY,
};
