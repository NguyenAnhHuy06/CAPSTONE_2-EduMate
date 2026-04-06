const path = require("path");
const s3 = require("./s3Upload");
const { extractDocumentText } = require("./extractDocumentText");
const db = require("./db");
const {
  embedAllChunks,
  splitIntoWordChunks,
  createEmbedding,
  safeEmbedding,
} = require("./embeddingService");

const MAX_CHUNKS = Number(process.env.EMBED_MAX_CHUNKS || 80);

// Lock: prevent concurrent indexing of the same s3Key when generate is called repeatedly.
const indexingLocks = new Map();

/**
 * Check whether document_id already has valid segments + embeddings.
 * Used before re-downloading S3 or calling Gemini again.
 */
async function ensureDocumentEmbedded(documentId) {
  if (!db.isConfigured()) {
    throw new Error("MySQL is required to store embeddings.");
  }
  const doc = await db.getDocumentById(documentId);
  if (!doc) {
    throw new Error("Document not found.");
  }
  const segments = await db.listSegmentsByDocumentId(documentId);
  if (!segments.length) {
    return {
      embedded: false,
      skipped: false,
      documentId: Number(documentId),
      chunkCount: 0,
    };
  }
  const allValid = segments.every(
    (s) => Array.isArray(s.embedding) && s.embedding.length > 0
  );
  if (allValid) {
    return {
      embedded: true,
      skipped: true,
      documentId: Number(documentId),
      chunkCount: segments.length,
    };
  }
  return {
    embedded: false,
    skipped: false,
    documentId: Number(documentId),
    chunkCount: segments.length,
  };
}

/**
 * S3 download → extract text → chunk → embed (bounded concurrency) → write MySQL.
 * @param {string} s3Key
 * @param {{ fileSize?: number, mimeType?: string }} hint
 */
async function indexDocumentFromS3(s3Key, hint = {}) {
  if (!s3.isS3Configured()) {
    throw new Error("S3 is not configured.");
  }
  if (!db.isConfigured()) {
    throw new Error("MySQL is not configured.");
  }

  const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
  const ext = path.extname(s3Key).toLowerCase();
  const plain = await extractDocumentText(buffer, ext, contentType || hint.mimeType || "");

  if (!plain.trim()) {
    throw new Error("Could not extract text from the S3 file.");
  }

  const chunkTexts = splitIntoWordChunks(plain, { maxChunks: MAX_CHUNKS });
  if (!chunkTexts.length) {
    throw new Error("Content is too short to chunk.");
  }

  const embeddings = await embedAllChunks(chunkTexts);

  const documentId = await db.ensureDocumentStub(s3Key, {
    title: path.basename(s3Key),
    originalFilename: path.basename(s3Key),
    mimeType: contentType || hint.mimeType || null,
    fileSize: buffer.length,
  });

  await db.deleteChunksByDocumentId(documentId);

  for (let i = 0; i < chunkTexts.length; i++) {
    const emb = embeddings[i];
    if (!emb) throw new Error(`Missing embedding for chunk ${i}.`);
    await db.insertChunk(documentId, i, chunkTexts[i], emb);
  }

  return {
    documentId,
    chunkCount: chunkTexts.length,
    charCount: plain.length,
  };
}

/**
 * If chunks + embeddings are complete and reindex is false → skip (no Gemini, no S3 download).
 */
async function ensureIndexedForQuiz(s3Key, { reindex = false } = {}) {
  if (!db.isConfigured()) {
    throw new Error("MySQL is required to store embeddings.");
  }
  if (!reindex && indexingLocks.has(s3Key)) {
    return indexingLocks.get(s3Key);
  }

  const existing = await db.countChunksByS3Key(s3Key);
  if (!reindex && existing > 0) {
    const complete = await db.hasCompleteEmbeddingsForS3Key(s3Key);
    if (complete) {
      let documentId = null;
      try {
        documentId = await db.getDocumentIdByS3Key(s3Key);
      } catch (_) {
        /* ignore */
      }
      return { skipped: true, chunkCount: existing, documentId };
    }
  }

  const task = (async () => {
    const r = await indexDocumentFromS3(s3Key);
    return { skipped: false, ...r };
  })();

  if (!reindex) indexingLocks.set(s3Key, task);
  try {
    return await task;
  } finally {
    if (!reindex) indexingLocks.delete(s3Key);
  }
}

module.exports = {
  splitTextIntoChunks: splitIntoWordChunks,
  createEmbedding,
  safeEmbedding,
  embedAllChunks,
  indexDocumentFromS3,
  ensureIndexedForQuiz,
  ensureDocumentEmbedded,
  MAX_CHUNKS,
};
