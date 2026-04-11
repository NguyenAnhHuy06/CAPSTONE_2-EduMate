const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const rbac = require("../middleware/rbac");
const Notification = require("../models/Notification");
const { uploadDocument, getRecentDocuments, getDocumentsForQuiz, getS3Documents } = require("../controllers/documentController");

// Upload — any authenticated user can upload (design: students upload, lecturers upload)
router.post("/upload", auth, ...uploadDocument);

// Listing — authenticated users
router.get("/recent", auth, getRecentDocuments);
router.get("/for-quiz", auth, getDocumentsForQuiz);
router.get("/s3-list", auth, getS3Documents);

// Document verification — Lecturer/Admin only (Design: UC04)
router.patch("/:id/verify", auth, rbac("LECTURER", "ADMIN"), async (req, res) => {
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
});

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

// Download — authenticated
router.get("/download", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");
    const key = req.query.key;
    if (!key) return res.status(400).json({ success: false, message: "Missing S3 Key." });
    const url = await s3.buildSignedUrl(key, 3600);
    return res.redirect(url);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Preview — authenticated
router.get("/preview", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");
    const key = req.query.key;
    if (!key) return res.status(400).json({ success: false, message: "Missing S3 Key." });
    const url = await s3.buildInlineSignedUrl(key, 3600);
    if (!url) return res.status(500).json({ success: false, message: "Could not generate preview URL." });
    return res.json({ success: true, url });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/preview-word", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");
    const mammoth = require("mammoth");
    const key = req.query.key;
    if (!key) return res.status(400).json({ success: false, message: "Missing S3 Key." });

    const { buffer } = await s3.getObjectBuffer(key);
    if (!buffer) return res.status(404).json({ success: false, message: "File not found on S3." });

    const result = await mammoth.convertToHtml({ buffer });
    return res.json({ success: true, html: result.value });
  } catch (err) {
    console.error("[preview-word] error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
