const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3001;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
]);

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroenabled.12",
  "application/octet-stream",
]);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();

    const originalBaseName = path.basename(file.originalname, extension);

    const safeBaseName = originalBaseName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    cb(null, `${uniqueSuffix}-${safeBaseName || "document"}${extension}`);
  },
});

function fileFilter(req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();

  const mimeType = (file.mimetype || "").toLowerCase();

  const isExtensionAllowed = allowedExtensions.has(extension);

  const isMimeAllowed = allowedMimeTypes.has(mimeType);

  if (!isExtensionAllowed || !isMimeAllowed) {
    return cb(
      new Error(
        "Chỉ chấp nhận file PDF hoặc Word (.doc, .docx, .docm, .dotx, .dotm)."
      )
    );
  }

  cb(null, true);
}

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter: fileFilter,
});

const recentUploads = [];
const quizzes = [];
const quizAttempts = [];

function isEmpty(value) {
  return !value || !String(value).trim();
}

function normalizeTags(tagsText) {
  return String(tagsText)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function deleteFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Edumate backend is running.",
  });
});

app.post("/api/documents/upload", upload.single("documentFile"), (req, res) => {
  const {
    title,
    category,
    subjectCode,
    subjectName,
    tags,
    description = "",
  } = req.body;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Bạn chưa chọn file tài liệu.",
    });
  }

  if (
    isEmpty(title) ||
    isEmpty(category) ||
    isEmpty(subjectCode) ||
    isEmpty(subjectName) ||
    isEmpty(tags)
  ) {
    deleteFileIfExists(req.file.path);

    return res.status(400).json({
      success: false,
      message: "Vui lòng nhập đầy đủ các trường bắt buộc.",
    });
  }

  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const newDocument = {
    id: Date.now(),
    title: title.trim(),
    category: category.trim(),
    subjectCode: subjectCode.trim(),
    subjectName: subjectName.trim(),
    tags: normalizeTags(tags),
    description: description.trim(),
    originalFileName: req.file.originalname,
    storedFileName: req.file.filename,
    fileSize: req.file.size,
    fileType: req.file.mimetype,
    fileUrl: `${baseUrl}/uploads/${req.file.filename}`,
    downloads: 0,
    uploadedAt: new Date().toISOString(),
  };

  recentUploads.unshift(newDocument);

  if (recentUploads.length > 10) {
    recentUploads.pop();
  }

  return res.status(201).json({
    success: true,
    message: "Tải tài liệu lên thành công.",
    data: newDocument,
  });
});

app.get("/api/documents/recent", (req, res) => {
  res.status(200).json({
    success: true,
    total: recentUploads.length,
    data: recentUploads,
  });
});

/**
 * Documents list for the Quiz screen.
 * FE expects `s3Key` and uses it when calling /api/quiz/generate.
 * This repo doesn't wire S3 yet, so we reuse the stored filename as `s3Key`.
 */
app.get("/api/documents/for-quiz", (req, res) => {
  const data = recentUploads.map((d) => ({
    s3Key: d.storedFileName,
    title: d.title,
    fileName: d.originalFileName,
    subjectCode: d.subjectCode,
    subjectName: d.subjectName,
    courseCode: d.subjectCode,
    estimatedQuestions: 5,
    uploadedAt: d.uploadedAt,
    fileSize: d.fileSize,
    fileType: d.fileType,
    fileUrl: d.fileUrl,
    tags: d.tags,
  }));

  return res.status(200).json({
    success: true,
    total: data.length,
    data,
  });
});

/**
 * Quiz generate — mock handler for local FE (no external AI).
 */
app.post("/api/quiz/generate", (req, res) => {
  const { content, numQuestions, language, persist, quizTitle, s3Key } =
    req.body || {};
  const rawN = Number(numQuestions);
  const n = Math.min(Math.max(Number.isFinite(rawN) ? rawN : 5, 1), 20);
  const lang = String(language || "English").trim() || "English";

  const fromDoc = s3Key
    ? recentUploads.find((d) => d.storedFileName === s3Key)
    : null;

  const baseText =
    String(content || "").trim() || String(fromDoc?.title || "").trim();

  const snippet = String(baseText || "")
    .trim()
    .slice(0, 200)
    .replace(/\s+/g, " ");

  const quiz = Array.from({ length: n }, (_, i) => ({
    question: `[${lang}] (Demo) Question ${
      i + 1
    }: Choose the best option related to your study material.${
      snippet ? ` Topic hint: "${snippet}"…` : ""
    }`,
    options: {
      A: "Option A (sample)",
      B: "Option B (sample)",
      C: "Option C (sample)",
      D: "Option D (sample)",
    },
    correct_answer: "A",
    explanation: "Sample explanation from the local mock server.",
  }));

  let quizId = null;
  if (persist) {
    const now = new Date().toISOString();
    quizId = Date.now();
    quizzes.unshift({
      id: quizId,
      title: String(quizTitle || fromDoc?.title || "Quiz").trim() || "Quiz",
      sourceKey: s3Key || null,
      createdAt: now,
      lastAttemptAt: null,
      scorePercent: null,
      questionsCount: quiz.length,
    });
  }

  return res.status(200).json({
    success: true,
    message: "OK",
    data: { quiz, quizId },
  });
});

/**
 * Quiz history list (in-memory).
 * Shape matches FE usage in Generate-Quizz.html.
 */
app.get("/api/quizzes/history", (req, res) => {
  return res.status(200).json({
    success: true,
    total: quizzes.length,
    data: quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      createdAt: q.createdAt,
      lastAttemptAt: q.lastAttemptAt,
      scorePercent: q.scorePercent,
    })),
  });
});

/**
 * Record a quiz attempt (in-memory).
 * FE sends { quizId, userId, score }.
 */
app.post("/api/quiz/attempts", (req, res) => {
  const { quizId, userId, score } = req.body || {};
  const qid = Number(quizId);
  const s = Number(score);

  if (!Number.isFinite(qid) || !Number.isFinite(s)) {
    return res.status(400).json({
      success: false,
      message: "Invalid request.",
    });
  }

  const quizRow = quizzes.find((q) => q.id === qid);
  if (!quizRow) {
    return res.status(404).json({
      success: false,
      message: "Quiz not found.",
    });
  }

  const now = new Date().toISOString();
  const questionsCount = Number(quizRow.questionsCount) || 0;
  const scorePercent =
    questionsCount > 0 ? Math.round((s / questionsCount) * 100) : null;

  quizAttempts.unshift({
    id: Date.now(),
    quizId: qid,
    userId: userId ?? null,
    score: s,
    createdAt: now,
  });

  quizRow.lastAttemptAt = now;
  quizRow.scorePercent = scorePercent;

  return res.status(201).json({
    success: true,
    message: "OK",
  });
});

app.use("/uploads", express.static(uploadDir));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Không tìm thấy API bạn yêu cầu.",
  });
});

app.use((err, req, res, next) => {
  if (req.file && req.file.path) {
    deleteFileIfExists(req.file.path);
  }

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message:
          "File vượt quá 10MB. Vui lòng chọn file nhỏ hơn hoặc bằng 10MB.",
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message || "Lỗi upload file.",
    });
  }

  return res.status(400).json({
    success: false,
    message: err.message || "Đã xảy ra lỗi ở server.",
  });
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});