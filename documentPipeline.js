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

// Lock tránh trường hợp FE gọi generate nhiều lần → cùng lúc index cùng 1 s3Key.
const indexingLocks = new Map();

/**
 * Kiểm tra DB: đã có đủ segment + embedding hợp lệ cho document_id hay chưa.
 * Dùng trước khi tải S3 / gọi Gemini lại.
 */
async function ensureDocumentEmbedded(documentId) {
  if (!db.isConfigured()) {
    throw new Error("Cần MySQL để lưu embedding.");
  }
  const doc = await db.getDocumentById(documentId);
  if (!doc) {
    throw new Error("Không tìm thấy document.");
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
 * Tải S3 → trích text → chunk → embedding (có giới hạn song song) → ghi MySQL.
 * @param {string} s3Key
 * @param {{ fileSize?: number, mimeType?: string }} hint
 */
async function indexDocumentFromS3(s3Key, hint = {}) {
  if (!s3.isS3Configured()) {
    throw new Error("S3 chưa cấu hình.");
  }
  if (!db.isConfigured()) {
    throw new Error("MySQL chưa cấu hình.");
  }

  const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
  const ext = path.extname(s3Key).toLowerCase();
  const plain = await extractDocumentText(buffer, ext, contentType || hint.mimeType || "");

  if (!plain.trim()) {
    throw new Error("Không trích được văn bản từ file S3.");
  }

  const chunkTexts = splitIntoWordChunks(plain, { maxChunks: MAX_CHUNKS });
  if (!chunkTexts.length) {
    throw new Error("Nội dung quá ngắn để chunk.");
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
    if (!emb) throw new Error(`Thiếu embedding cho chunk ${i}.`);
    await db.insertChunk(documentId, i, chunkTexts[i], emb);
  }

  return {
    documentId,
    chunkCount: chunkTexts.length,
    charCount: plain.length,
  };
}

/**
 * Nếu đã có chunk + embedding đầy đủ và không reindex → bỏ qua (không gọi Gemini, không tải S3).
 */
async function ensureIndexedForQuiz(s3Key, { reindex = false } = {}) {
  if (!db.isConfigured()) {
    throw new Error("Cần MySQL để lưu embedding.");
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
