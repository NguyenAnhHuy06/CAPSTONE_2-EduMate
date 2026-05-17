const Notification = require("../models/Notification");
const db = require("../../db");

async function resolveDocumentForComment({ documentId, s3Key }) {
  if (!db.isConfigured()) return null;

  let docId = Number(documentId);
  if (!Number.isFinite(docId) || docId <= 0) docId = null;

  const key = String(s3Key || "").trim();
  if (docId == null && key) {
    docId = await db.getDocumentIdByS3Key(key);
  }
  if (docId == null) return null;

  return db.getDocumentById(docId);
}

/**
 * Notify the document uploader when another user comments on their file.
 * Skips self-comments and missing uploader; failures are logged only.
 */
async function notifyDocumentOwnerOnNewComment({
  documentId,
  s3Key,
  commentId,
  commenterUserId,
  commenterName,
  commentPreview,
}) {
  try {
    const commenterId = Number(commenterUserId);
    if (!Number.isFinite(commenterId) || commenterId <= 0) return;

    const doc = await resolveDocumentForComment({ documentId, s3Key });
    if (!doc) return;

    const ownerId = Number(doc.uploader_id);
    if (!Number.isFinite(ownerId) || ownerId <= 0) return;
    if (ownerId === commenterId) return;

    const docTitle = String(doc.title || "your document").trim() || "your document";
    const who = String(commenterName || "Someone").trim() || "Someone";
    const raw = String(commentPreview || "").trim();
    const snippet = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;

    const resolvedDocId = Number(doc.document_id);
    const fileKey = String(doc.file_url || s3Key || "").trim() || null;
    const resolvedCommentId = Number(commentId);

    await Notification.create({
      user_id: ownerId,
      type: "info",
      title: "New comment on your document",
      content: snippet
        ? `${who} commented on "${docTitle}": "${snippet}"`
        : `${who} commented on "${docTitle}".`,
      action_payload: JSON.stringify({
        kind: "document_comment",
        documentId:
          Number.isFinite(resolvedDocId) && resolvedDocId > 0 ? resolvedDocId : null,
        commentId:
          Number.isFinite(resolvedCommentId) && resolvedCommentId > 0
            ? resolvedCommentId
            : null,
        s3Key: fileKey,
      }),
    });
  } catch (err) {
    console.warn("[documentCommentNotify]", err.message);
  }
}

module.exports = {
  notifyDocumentOwnerOnNewComment,
  resolveDocumentForComment,
};
