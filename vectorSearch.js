const db = require("./db");
const { safeEmbedding } = require("./embeddingService");

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueByContent(chunks) {
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    const key = normalizeText(c.content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function extractKeywords(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-zA-Z0-9_\u00C0-\u1EF9]+/)
    .filter((w) => w.length >= 4);
}

function keywordFilter(chunks, query) {
  const kws = extractKeywords(query);
  if (!kws.length) return chunks;
  const filtered = chunks.filter((c) => {
    const t = normalizeText(c.content);
    return kws.some((k) => t.includes(k));
  });
  return filtered.length ? filtered : chunks;
}

function capContext(chunks, maxChars = 2000) {
  let used = 0;
  const out = [];
  for (const c of chunks) {
    const prefix = `[Section ${c.section}] `;
    const remain = maxChars - used;
    if (remain <= 0) break;
    const payload = prefix + String(c.content || "");
    const take = payload.slice(0, remain);
    if (take.trim()) {
      out.push(take);
      used += take.length + 2;
    }
  }
  return out.join("\n\n");
}

async function retrieveTopChunks({ s3Key, query, topK = 3, maxContextChars = 2000 }) {
  const segments = await db.listSegmentsByS3Key(s3Key);
  if (!segments.length) return { context: "", chunks: [] };

  const queryEmbedding = await safeEmbedding(query);
  const pre = keywordFilter(uniqueByContent(segments), query);
  const scored = pre
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .filter((c) => Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    chunks: scored,
    context: capContext(scored, maxContextChars),
  };
}

module.exports = {
  retrieveTopChunks,
  cosineSimilarity,
};

