const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const rbac = require("../middleware/rbac");
const Notification = require("../models/Notification");
const { uploadDocument, getRecentDocuments, getDocumentsForQuiz, getS3Documents } = require("../controllers/documentController");
async function resolveS3KeyFromRequest(req) {
  const directKey =
    req.query.key ||
    req.query.s3Key ||
    req.query.fileUrl ||
    req.body?.key ||
    req.body?.s3Key;

  if (directKey && String(directKey).trim()) {
    return String(directKey).trim();
  }

  const rawDocumentId =
    req.query.documentId ||
    req.query.document_id ||
    req.body?.documentId ||
    req.body?.document_id;

  const documentId = Number(rawDocumentId);

  if (!Number.isFinite(documentId) || documentId <= 0) {
    return null;
  }

  const Document = require("../models/Document");
  const doc = await Document.findByPk(documentId);

  if (!doc || !doc.file_url) {
    return null;
  }

  return String(doc.file_url).trim();
}

function safeDownloadFileName(key, fallback = "document") {
  const path = require("path");
  const fileName = path.basename(String(key || "").trim());
  return fileName || fallback;
}

// Upload — any authenticated user can upload (design: students upload, lecturers upload)
router.post("/upload", auth, ...uploadDocument);

// Listing — authenticated users
router.get("/recent", auth, getRecentDocuments);
router.get("/for-quiz", auth, getDocumentsForQuiz);
router.get("/s3-list", auth, getS3Documents);

// Document verification — Lecturer/Admin only (Design: UC04)
const verifyDocumentHandler = async (req, res) => {
  try {
    const Document = require("../models/Document");
    const docId = Number(req.params.id);
    if (!Number.isFinite(docId)) return res.status(400).json({ success: false, message: "Invalid document ID." });
    
    const doc = await Document.findByPk(docId);
    if (!doc) return res.status(404).json({ success: false, message: "Document not found." });

    doc.status = 'verified';
    await doc.save();

    // Trigger embedding after verification
    if (doc.file_url) {
      try {
        const { ensureIndexedForQuiz } = require("../services/documentPipeline");
        await ensureIndexedForQuiz(doc.file_url, { reindex: true });
        console.log(`[verify] Document ${docId} verified and indexed.`);
      } catch (indexErr) {
        console.warn(`[verify] Document ${docId} verified but indexing failed:`, indexErr.message);
      }
    }

    // Create notification for uploader
    if (doc.uploader_id) {
        await Notification.create({
            user_id: doc.uploader_id,
            type: 'success',
            title: 'Document Verified',
            content: `Your document "${doc.title}" has been verified and is now available for AI study.`
        });
    }

    return res.json({ success: true, message: "Document verified and indexed for AI." });
  } catch (err) {
    console.error("[verify]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

router.patch("/:id/verify", auth, rbac("LECTURER", "ADMIN"), verifyDocumentHandler);
// FE compatibility: some clients send POST for this action.
router.post("/:id/verify", auth, rbac("LECTURER", "ADMIN"), verifyDocumentHandler);

router.patch("/:id/reject", auth, rbac("LECTURER", "ADMIN"), async (req, res) => {
  try {
    const Document = require("../models/Document");
    const docId = Number(req.params.id);
    if (!Number.isFinite(docId)) return res.status(400).json({ success: false, message: "Invalid document ID." });
    
    const doc = await Document.findByPk(docId);
    if (!doc) return res.status(404).json({ success: false, message: "Document not found." });

    doc.status = 'rejected';
    await doc.save();

    // Create notification for uploader
    if (doc.uploader_id) {
        await Notification.create({
            user_id: doc.uploader_id,
            type: 'error',
            title: 'Document Rejected',
            content: `Your document "${doc.title}" was rejected by a moderator.`
        });
    }

    return res.json({ success: true, message: "Document rejected." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/download-file", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");

    const key = await resolveS3KeyFromRequest(req);

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Missing S3 Key or valid documentId."
      });
    }

    const { buffer, contentType } = await s3.getObjectBuffer(key);

    if (!buffer || buffer.length === 0) {
      return res.status(404).json({
        success: false,
        message: "File not found on S3."
      });
    }

    try {
      const db = require("../config/teamDb");
      if (db.isConfigured()) {
        const pool = db.getPool();
        await pool.execute(
          "UPDATE documents SET download_count = IFNULL(download_count, 0) + 1 WHERE file_url = ?",
          [key]
        );
      }
    } catch (countErr) {
      console.warn("[download-file] could not update download count:", countErr.message);
    }

    const fileName = safeDownloadFileName(key);

    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.setHeader("Content-Length", buffer.length);

    return res.send(buffer);
  } catch (err) {
    console.error("[download-file] error:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Could not download file."
    });
  }
});

// Download — authenticated
router.get("/download", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");

    const key = await resolveS3KeyFromRequest(req);

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Missing S3 Key or valid documentId."
      });
    }

    const url = await s3.buildSignedUrl(key, 3600);

    try {
      const db = require("../config/teamDb");
      if (db.isConfigured()) {
        const pool = db.getPool();
        await pool.execute(
          "UPDATE documents SET download_count = IFNULL(download_count, 0) + 1 WHERE file_url = ?",
          [key]
        );
      }
    } catch (countErr) {
      console.warn("[download] could not update download count:", countErr.message);
    }

    return res.redirect(url);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Preview — authenticated
router.get("/preview", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");

    const key = await resolveS3KeyFromRequest(req);

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Missing S3 Key or valid documentId."
      });
    }

    const url = await s3.buildInlineSignedUrl(key, 3600);

    if (!url) {
      return res.status(500).json({
        success: false,
        message: "Could not generate preview URL."
      });
    }

    return res.json({
      success: true,
      url,
      s3Key: key
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/preview-word", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");
    const mammoth = require("mammoth");
    const key = await resolveS3KeyFromRequest(req);

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Missing S3 Key or valid documentId."
      });
    }

    const { buffer } = await s3.getObjectBuffer(key);
    if (!buffer) return res.status(404).json({ success: false, message: "File not found on S3." });

    const result = await mammoth.convertToHtml({ buffer });
    return res.json({ success: true, html: result.value });
  } catch (err) {
    console.error("[preview-word] error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/comments", auth, async (req, res) => {
  try {
    const db = require("../config/teamDb");
    const pool = db.getPool();

    const rawDocumentId = req.query.documentId || req.query.document_id;
    const documentId = Number(rawDocumentId);
    const s3Key = String(req.query.s3Key || req.query.key || "").trim();

    if ((!Number.isFinite(documentId) || documentId <= 0) && !s3Key) {
      return res.status(400).json({
        success: false,
        message: "Missing documentId or s3Key."
      });
    }

    let rows = [];

    if (Number.isFinite(documentId) && documentId > 0) {
      [rows] = await pool.execute(
        `SELECT
           dc.comment_id,
           dc.document_id,
           dc.file_url,
           dc.body,
           dc.created_at,
           u.full_name,
           u.email,
           u.role
         FROM document_comments dc
         LEFT JOIN users u ON u.user_id = dc.user_id
         WHERE dc.document_id = ?
         ORDER BY dc.created_at ASC, dc.comment_id ASC`,
        [documentId]
      );
    } else {
      [rows] = await pool.execute(
        `SELECT
           dc.comment_id,
           dc.document_id,
           dc.file_url,
           dc.body,
           dc.created_at,
           u.full_name,
           u.email,
           u.role
         FROM document_comments dc
         LEFT JOIN users u ON u.user_id = dc.user_id
         WHERE dc.file_url = ?
         ORDER BY dc.created_at ASC, dc.comment_id ASC`,
        [s3Key]
      );
    }

    const data = rows.map((r) => ({
      id: r.comment_id,
      commentId: r.comment_id,
      documentId: r.document_id,
      s3Key: r.file_url,
      text: r.body,
      body: r.body,
      author: r.full_name || r.email || "Unknown user",
      authorName: r.full_name || r.email || "Unknown user",
      role: String(r.role || "").toUpperCase() === "STUDENT" ? "student" : "instructor",
      date: r.created_at,
      createdAt: r.created_at
    }));

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error("[comments:get]", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Could not load comments."
    });
  }
});

router.post("/comments", auth, async (req, res) => {
  try {
    const db = require("../config/teamDb");
    const pool = db.getPool();

    const text = String(req.body.text || req.body.body || "").trim();

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Comment cannot be empty."
      });
    }

    const rawDocumentId = req.body.documentId || req.body.document_id;
    const documentId = Number(rawDocumentId);
    const s3Key = String(req.body.s3Key || req.body.key || "").trim();

    if ((!Number.isFinite(documentId) || documentId <= 0) && !s3Key) {
      return res.status(400).json({
        success: false,
        message: "Missing documentId or s3Key."
      });
    }

    const finalDocumentId =
      Number.isFinite(documentId) && documentId > 0 ? documentId : null;

    const finalS3Key = s3Key || null;

    const [result] = await pool.execute(
      `INSERT INTO document_comments (document_id, file_url, user_id, body)
       VALUES (?, ?, ?, ?)`,
      [finalDocumentId, finalS3Key, req.user.id, text]
    );

    return res.status(201).json({
      success: true,
      message: "Comment added.",
      data: {
        id: result.insertId,
        commentId: result.insertId,
        documentId: finalDocumentId,
        s3Key: finalS3Key,
        text,
        body: text,
        author: req.user.full_name || req.user.email || "Unknown user",
        authorName: req.user.full_name || req.user.email || "Unknown user",
        role: String(req.user.role || "").toUpperCase() === "STUDENT" ? "student" : "instructor",
        date: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error("[comments:post]", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Could not add comment."
    });
  }
});

module.exports = router;
