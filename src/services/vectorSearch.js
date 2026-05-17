const teamDb = require("../config/teamDb");
const rootDb = require("../../db");
const { safeEmbedding } = require("./embeddingService");

function dbLayer() {
  return {
    async listSegmentsByDocumentId(id) {
      if (rootDb.isConfigured()) {
        const segs = await rootDb.listSegmentsByDocumentId(id);
        if (segs.length) return segs;
      }
      if (teamDb.isConfigured()) {
        return teamDb.listSegmentsByDocumentId(id);
      }
      return [];
    },
    async listSegmentsByS3Key(key) {
      if (rootDb.isConfigured()) {
        const segs = await rootDb.listSegmentsByS3Key(key);
        if (segs.length) return segs;
      }
      if (teamDb.isConfigured()) {
        return teamDb.listSegmentsByS3Key(key);
      }
      return [];
    },
    async getDocumentIdByS3Key(key) {
      if (rootDb.isConfigured()) {
        const id = await rootDb.getDocumentIdByS3Key(key);
        if (id) return id;
      }
      if (teamDb.isConfigured()) {
        return teamDb.getDocumentIdByS3Key(key);
      }
      return null;
    },
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; normA += x * x; normB += y * y;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeText(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

function uniqueByContent(chunks) {
  const seen = new Set();
  return chunks.filter(c => { const k = normalizeText(c.content); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

function extractKeywords(query) {
  return String(query || "").toLowerCase().split(/[^a-zA-Z0-9_\u00C0-\u1EF9]+/).filter(w => w.length >= 4);
}

function keywordFilter(chunks, query) {
  const kws = extractKeywords(query);
  if (!kws.length) return chunks;
  const filtered = chunks.filter(c => { const t = normalizeText(c.content); return kws.some(k => t.includes(k)); });
  return filtered.length ? filtered : chunks;
}

function sectionOrder(c) {
  const s = c.section ?? c.chunk_index ?? c.chunkIndex ?? 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function estimateChunksCharSize(chunks) {
  return chunks.reduce((sum, c) => sum + String(c.content || "").length + 24, 0);
}

function buildContextFromChunks(chunks, maxChars = 2000) {
  let used = 0;
  const out = [];
  for (const c of chunks) {
    const prefix = `[Section ${sectionOrder(c)}] `;
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

/** Pick chunks by relevance until char/chunk limits; optionally include every section when the file fits. */
function selectChunksForContext(scored, allUnique, { maxContextChars, maxChunks, preferFullDocument }) {
  const bySection = [...allUnique].sort((a, b) => sectionOrder(a) - sectionOrder(b));

  if (preferFullDocument && estimateChunksCharSize(bySection) <= maxContextChars) {
    const scoreById = new Map(
      scored.map((c) => [String(c.segmentId ?? c.segment_id), c.score ?? 0])
    );
    return bySection.map((c) => {
      const id = String(c.segmentId ?? c.segment_id);
      return mapChunkForRag(c, scoreById.get(id) ?? 0);
    });
  }

  const selected = [];
  let charCount = 0;
  for (const c of scored) {
    if (selected.length >= maxChunks) break;
    const addLen = String(c.content || "").length + 24;
    if (charCount + addLen > maxContextChars && selected.length > 0) break;
    selected.push(c);
    charCount += addLen;
  }
  return selected;
}

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

async function loadSegmentsForDocument({ s3Key, documentId }) {
  const db = dbLayer();
  const docId = Number(documentId);
  if (Number.isFinite(docId) && docId > 0) {
    const byDoc = await db.listSegmentsByDocumentId(docId);
    if (byDoc.length) return byDoc;
  }

  const key = normalizeS3KeyInput(s3Key);
  if (!key) return [];

  let segments = await db.listSegmentsByS3Key(key);
  if (!segments.length) {
    const resolvedId = await db.getDocumentIdByS3Key(key);
    if (resolvedId) {
      segments = await db.listSegmentsByDocumentId(resolvedId);
    }
  }
  return segments;
}

function mapChunkForRag(c, score = 0) {
  const segmentId = c.segmentId ?? c.segment_id;
  return {
    ...c,
    segmentId,
    segment_id: segmentId,
    score,
    similarity: score,
  };
}

/**
 * Heuristic: is the question plausibly about the retrieved document text?
 * Prevents the LLM from answering unrelated general-knowledge questions when a file is open.
 */
function isQueryRelevantToDocument(query, chunks) {
  if (!chunks?.length) return false;

  const minSim = Number(process.env.CHAT_RAG_MIN_SIMILARITY) || 0.28;
  const topScore = Math.max(...chunks.map((c) => Number(c.score ?? c.similarity) || 0));
  const kws = extractKeywords(query);
  const corpus = normalizeText(chunks.map((c) => c.content).join(" "));
  const keywordHits = kws.filter((k) => corpus.includes(k)).length;

  const q = String(query || "").trim();
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const looksLikeDocMetaQuestion =
    wordCount <= 10 &&
    /(t[oó]m t[aắ]t|summary|summarize|overview|n[oộ]i dung|document|t[aà]i li[eệ]u|file|chapter|m[uụ]c|section|gi[aả]i th[ií]ch t[aà]i li[eệ]u)/i.test(
      q
    );

  if (looksLikeDocMetaQuestion && topScore >= minSim * 0.72) return true;
  if (kws.length >= 2) {
    return keywordHits >= 1 && topScore >= minSim * 0.65;
  }
  if (kws.length === 1) {
    return keywordHits >= 1 || topScore >= minSim;
  }
  return topScore >= minSim;
}

async function retrieveTopChunks({
  s3Key,
  documentId,
  query,
  topK = 3,
  maxContextChars = 2000,
  /** When true, include every indexed section if total text fits maxContextChars. */
  preferFullDocument = false,
}) {
  const segments = await loadSegmentsForDocument({ s3Key, documentId });
  if (!segments.length) return { context: "", chunks: [] };

  const unique = uniqueByContent(segments);
  const pre = keywordFilter(unique, query);
  const maxChunks = Math.max(1, Number(topK) || 3);

  let scored = [];
  try {
    const queryEmbedding = await safeEmbedding(query);
    scored = pre
      .map((c) => mapChunkForRag(c, cosineSimilarity(queryEmbedding, c.embedding)))
      .filter((c) => Number.isFinite(c.score))
      .sort((a, b) => b.score - a.score);
  } catch (embedErr) {
    console.warn("[vectorSearch] query embedding failed, using keyword order:", embedErr.message);
    scored = pre.map((c) => mapChunkForRag(c, 0));
  }

  if (!scored.length) {
    scored = pre.map((c) => mapChunkForRag(c, 0));
  }
  if (!scored.length) {
    scored = unique.map((c) => mapChunkForRag(c, 0));
  }

  const selected = selectChunksForContext(scored, unique, {
    maxContextChars,
    maxChunks,
    preferFullDocument,
  });

  const topSimilarity = selected.length
    ? Math.max(...selected.map((c) => Number(c.score ?? c.similarity) || 0))
    : -1;

  return {
    chunks: selected,
    context: buildContextFromChunks(selected, maxContextChars),
    usedFullDocument:
      preferFullDocument && selected.length === unique.length && unique.length > 0,
    relevantToDocument: isQueryRelevantToDocument(query, selected),
    topSimilarity,
  };
}

module.exports = {
  retrieveTopChunks,
  cosineSimilarity,
  isQueryRelevantToDocument,
};
