const path = require("path");
const multer = require("multer");
const s3 = require("../services/s3Upload");
const db = require("../config/teamDb");
const Notification = require("../models/Notification");

// ===== Multer setup =====
const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".docm", ".dotx", ".dotm"]);
const allowedMimeTypes = new Set([
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroenabled.12",
  "application/octet-stream",
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();
  if (!allowedExtensions.has(ext) || !allowedMimeTypes.has(mime)) {
    return cb(new Error("Chỉ chấp nhận file PDF hoặc Word (.doc, .docx, .docm, .dotx, .dotm)."));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter,
});

function isEmpty(value) { return !value || !String(value).trim(); }
function normalizeTags(tagsText) { return String(tagsText).split(",").map(tag => tag.trim()).filter(Boolean); }
function optionalBodyNumber(value) {
  if (value == null || !String(value).trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ===== Controllers =====

const uploadDocument = [
  upload.single("documentFile"),
  async (req, res) => {
    const { title, category, subjectCode, subjectName, tags, description = "", courseId, uploaderId } = req.body;
    try {
      if (!s3.isS3Configured()) {
        return res.status(503).json({ success: false, message: "S3 chưa cấu hình (AWS_*, S3_BUCKET)." });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: "Bạn chưa chọn file tài liệu." });
      }
      if (isEmpty(title) || isEmpty(category) || isEmpty(subjectCode) || isEmpty(subjectName) || isEmpty(tags)) {
        return res.status(400).json({ success: false, message: "Vui lòng nhập đầy đủ các trường bắt buộc." });
      }

      const key = s3.buildDocumentKey(req.file.originalname);
      const up = await s3.uploadDocumentBuffer({ buffer: req.file.buffer, key, contentType: req.file.mimetype });

      // Auto-verify for LECTURER and ADMIN
      const uploaderRole = req.user?.role || 'STUDENT';
      const status = (uploaderRole === 'LECTURER' || uploaderRole === 'ADMIN') ? 'verified' : 'pending';

      let documentId = null, dbNote = "";
      if (db.isConfigured()) {
        documentId = await db.upsertDocument({ 
          s3Key: key, 
          title: title.trim(), 
          courseId, 
          uploaderId: req.user.id,
          status 
        });
        dbNote = ` Đã ghi vào bảng documents (MySQL) với trạng thái: ${status}.`;
      } else {
        dbNote = " (MySQL chưa cấu hình.)";
      }

      // If auto-verified, trigger indexing immediately
      if (status === 'verified') {
        try {
          const { ensureIndexedForQuiz } = require("../services/documentPipeline");
          ensureIndexedForQuiz(key).catch(e => console.warn("Auto-index failed:", e.message));

          // Notification for Lecturer/Admin
          await Notification.create({
              user_id: req.user.id,
              type: 'success',
              title: 'Auto-Verified',
              content: `Your document "${title}" has been automatically verified and indexed for AI study.`
          });
        } catch (e) { /* ignore if service not ready */ }
      }

      return res.status(201).json({
        success: true,
        message: `Đã upload lên S3.${dbNote}`,
        data: {
          id: documentId != null ? documentId : key,
          title: title.trim(), category: category.trim(),
          subjectCode: subjectCode.trim(), subjectName: subjectName.trim(),
          tags: normalizeTags(tags), description: description.trim(),
          courseId: optionalBodyNumber(courseId), uploaderId: optionalBodyNumber(uploaderId),
          storage: "s3", s3Key: key,
          originalFileName: req.file.originalname,
          storedFileName: path.basename(key),
          fileSize: req.file.size, fileType: req.file.mimetype,
          fileUrl: up.url, downloads: 0, uploadedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: err.message || "Lỗi khi upload file." });
    }
  },
];

const getRecentDocuments = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, total: 0, data: [], message: "MySQL chưa cấu hình." });
    }
    const rows = await db.listDocumentsRecent(limit);
    const data = rows.map(row => ({
      id: row.document_id, title: row.title, s3Key: row.file_url,
      courseId: row.course_id, uploaderId: row.uploader_id,
      uploadedAt: row.created_at, chunkCount: Number(row.chunk_count || 0), downloads: 0,
    }));
    return res.status(200).json({ success: true, total: data.length, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Lỗi đọc MySQL." });
  }
};

const S3_LIST_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".docm", ".dotx", ".dotm"]);

const getDocumentsForQuiz = async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(200).json({ success: true, data: [], message: "S3 chưa cấu hình." });
    }
    const rows = await s3.listDocuments({ prefix: "", maxKeys: 5000 });
    const filtered = rows.filter(o => S3_LIST_EXTENSIONS.has(path.extname(o.key || "").toLowerCase()));

    let metaMap = new Map();
    if (db.isConfigured()) {
      try { metaMap = await db.getMetaMapForS3Keys(filtered.map(o => o.key)); } catch (_) { /* ignore */ }
    }

    const data = filtered.map(o => {
      const m = metaMap.get(o.key);
      if (m && m.status !== 'verified') return null; // Skip unverified docs
      
      const ext = path.extname(o.key).replace(/^\./, "").toUpperCase() || "FILE";
      const chunks = m != null ? Number(m.chunk_count || 0) : 0;
      const estimatedQuestions = Math.min(30, Math.max(5, chunks > 0 ? 5 + Math.floor(chunks / 4) : 5));
      return {
        storage: "s3", s3Key: o.key, fileName: path.basename(o.key),
        title: m?.title || path.basename(o.key),
        subjectCode: m?.course_code || ext, courseCode: m?.course_code || ext,
        courseId: m?.course_id ?? null, documentId: m?.document_id ?? null,
        size: o.size, lastModified: o.lastModified || m?.created_at,
        fileUrl: s3.buildObjectPublicUrl(o.key), inDatabase: !!m,
        chunkCount: chunks, estimatedQuestions,
      };
    }).filter(Boolean); // Filter out nulls (unverified)

    data.sort((a, b) => new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime());
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ success: true, data: [], message: "Danh sách tài liệu đang tạm thời chưa sẵn sàng." });
  }
};

const getS3Documents = async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(503).json({ success: false, message: "S3 chưa cấu hình." });
    }
    const rows = await s3.listDocuments({ prefix: "DATA/", maxKeys: 5000 });
    const filteredRows = rows.filter(o => S3_LIST_EXTENSIONS.has(path.extname(o.key || "").toLowerCase()));

    let metaMap = new Map();
    if (db.isConfigured()) {
      try { metaMap = await db.getMetaMapForS3Keys(filteredRows.map(o => o.key)); } catch (_) { /* ignore */ }
    }

    const data = filteredRows
      .map(o => {
        const m = metaMap.get(o.key);
        const parts = o.key.split('/');
        // expected: ["DATA", "NĂM 1 (...", "HỌC KÌ 1", "1. CS 201", "file.pdf"]
        const fileName = path.basename(o.key);
        let subject = "General";
        let year = "";
        let semester = "";
        if (parts.length >= 5) {
          year = parts[1];
          semester = parts[2];
          subject = parts[parts.length - 2].replace(/ \u2713|\u2714/g, '').trim(); // Remove checkmarks that might be in folder names
        } else if (parts.length >= 2) {
          subject = parts[parts.length - 2];
        }
        
        return {
          id: m?.document_id,
          key: o.key,
          fileName,
          title: path.parse(fileName).name,
          subject,
          year,
          semester,
          size: o.size,
          lastModified: o.lastModified,
          url: s3.buildObjectPublicUrl(o.key),
          status: m?.status || 'pending',
          inDatabase: !!m
        };
      })
      .sort((a, b) => new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime());
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ success: true, data: [], message: "Danh sách S3 đang tạm thời chưa sẵn sàng." });
  }
};

module.exports = { uploadDocument, getRecentDocuments, getDocumentsForQuiz, getS3Documents };
