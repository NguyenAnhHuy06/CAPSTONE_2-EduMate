const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise");

const app = express();
const PORT = 3001;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const JWT_SECRET = process.env.JWT_SECRET || "edumate-dev-secret";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "";
const MYSQL_HOST = process.env.MYSQL_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || "edumate";

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
/** In-memory discussion thread for mock server (key: id:123 or key:s3filename). */
const documentCommentsByKey = new Map();
const users = [];
const pendingRegs = new Map();
const LETTERS = ["A", "B", "C", "D"];
// Seed lecturer account for local development/testing.
users.push({
  user_id: 1001,
  full_name: "Demo Lecturer",
  email: "lecturer.demo@edumate.local",
  user_code: "LEC_DEMO_001",
  role: "LECTURER",
  password_hash: bcrypt.hashSync("123456", 10),
});
const mailer =
  SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;

let mysqlPool = null;
let questionBankTableReady = null;

function getMysqlPool() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: "utf8mb4",
    });
  }
  return mysqlPool;
}

async function ensureQuestionBankTable() {
  if (!questionBankTableReady) {
    const pool = getMysqlPool();
    questionBankTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS question_bank (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        lecturer_user_id BIGINT NOT NULL,
        question_text TEXT NOT NULL,
        question_type VARCHAR(32) NOT NULL DEFAULT 'multiple-choice',
        topic VARCHAR(255) NOT NULL DEFAULT 'General',
        difficulty VARCHAR(32) NOT NULL DEFAULT 'medium',
        options_json JSON NULL,
        correct_answer VARCHAR(255) NULL,
        quiz_id BIGINT NULL,
        quiz_title VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_qb_lecturer (lecturer_user_id),
        KEY idx_qb_topic (topic),
        KEY idx_qb_difficulty (difficulty)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }
  return questionBankTableReady;
}

function parseOptionsJson(raw) {
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return undefined;
    const cleaned = parsed
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

function isLecturerUserId(userId) {
  if (userId == null || userId === "") return false;
  const uid = String(userId);
  const userRow = users.find((u) => String(u?.user_id) === uid);
  return String(userRow?.role || "").toUpperCase() === "LECTURER";
}

function normalizeQuestionInput(payload) {
  const question = String(payload?.question || "").trim();
  const typeRaw = String(payload?.type || "multiple-choice").trim().toLowerCase();
  const topic = String(payload?.topic || "General").trim() || "General";
  const difficultyRaw = String(payload?.difficulty || "medium").trim().toLowerCase();
  const correctAnswer = payload?.correctAnswer != null ? String(payload.correctAnswer).trim() : "";
  const type = ["multiple-choice", "true-false", "short-answer"].includes(typeRaw)
    ? typeRaw
    : "multiple-choice";
  const difficulty = ["easy", "medium", "hard"].includes(difficultyRaw)
    ? difficultyRaw
    : "medium";
  const options = Array.isArray(payload?.options)
    ? payload.options.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  return {
    question,
    type,
    topic,
    difficulty,
    options,
    correctAnswer,
  };
}

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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optionTextFromQuestion(questionRow, keyOrIdx) {
  if (!questionRow) return "";
  const optionsObj = questionRow.options || {};
  const arr = [
    optionsObj.A || "",
    optionsObj.B || "",
    optionsObj.C || "",
    optionsObj.D || "",
  ];
  if (typeof keyOrIdx === "number") {
    return arr[keyOrIdx] || "";
  }
  const key = String(keyOrIdx || "").toUpperCase();
  const idx = LETTERS.indexOf(key);
  if (idx >= 0) return arr[idx] || "";
  return "";
}

async function sendOtpEmail(toEmail, otp) {
  if (!mailer) return false;
  await mailer.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: "EduMate OTP Verification",
    text: `Your OTP code is: ${otp}. This code expires in 5 minutes.`,
    html: `<p>Your OTP code is: <b>${otp}</b></p><p>This code expires in 5 minutes.</p>`,
  });
  return true;
}

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Edumate backend is running.",
  });
});

app.post("/api/auth/register", async (req, res) => {
  const { full_name, email, password, role, user_code } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  const pw = String(password || "");
  const name = String(full_name || "").trim();
  const code = String(user_code || "").trim();
  const roleNorm = String(role || "STUDENT").toUpperCase();
  if (!name || !em || !pw || !code) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }
  if (pw.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }
  const existed = users.find((u) => u.email === em);
  if (existed) {
    return res.status(409).json({ success: false, message: "Email already registered." });
  }
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const password_hash = await bcrypt.hash(pw, 10);
  pendingRegs.set(em, {
    full_name: name,
    email: em,
    password_hash,
    role: roleNorm === "LECTURER" ? "LECTURER" : "STUDENT",
    user_code: code,
    otp,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  let emailSent = false;
  try {
    emailSent = await sendOtpEmail(em, otp);
  } catch (mailErr) {
    console.error("[OTP][MAIL_ERROR]", mailErr?.message || mailErr);
  }
  // Dev fallback visibility.
  console.log(`[OTP][${em}] ${otp}`);
  return res.status(200).json({
    success: true,
    message: emailSent
      ? "OTP sent to your email."
      : "OTP created. Email is not configured, check server log for OTP in dev.",
    data: { expiresInSec: 300 },
  });
});

app.post("/api/auth/verify-otp", (req, res) => {
  const { email, otp_code } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  const otp = String(otp_code || "").trim();
  const pending = pendingRegs.get(em);
  if (!pending) {
    return res.status(400).json({ success: false, message: "No pending registration." });
  }
  if (Date.now() > Number(pending.expiresAt || 0)) {
    pendingRegs.delete(em);
    return res.status(400).json({ success: false, message: "OTP expired." });
  }
  if (otp !== String(pending.otp)) {
    return res.status(400).json({ success: false, message: "Invalid OTP." });
  }
  const newUser = {
    user_id: Date.now(),
    full_name: pending.full_name,
    email: pending.email,
    password_hash: pending.password_hash,
    role: pending.role,
    user_code: pending.user_code,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  pendingRegs.delete(em);
  return res.status(201).json({
    success: true,
    message: "Registration completed.",
    data: {
      user: {
        user_id: newUser.user_id,
        full_name: newUser.full_name,
        email: newUser.email,
        role: newUser.role,
        user_code: newUser.user_code,
      },
    },
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  const pw = String(password || "");
  const u = users.find((x) => x.email === em);
  if (!u) return res.status(401).json({ success: false, message: "Invalid credentials." });
  const ok = await bcrypt.compare(pw, String(u.password_hash || ""));
  if (!ok) return res.status(401).json({ success: false, message: "Invalid credentials." });
  const token = jwt.sign(
    { user_id: u.user_id, email: u.email, role: u.role },
    JWT_SECRET,
    { expiresIn: "1d" }
  );
  return res.status(200).json({
    success: true,
    message: "Login successful.",
    data: {
      token,
      user: {
        user_id: u.user_id,
        full_name: u.full_name,
        email: u.email,
        role: u.role,
        user_code: u.user_code,
      },
    },
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

function commentsStorageKey(documentId, s3Key) {
  const raw = documentId != null && String(documentId).trim() !== "" ? Number(documentId) : NaN;
  if (Number.isFinite(raw)) return `id:${raw}`;
  const k = String(s3Key || "").trim();
  return k ? `key:${k}` : "";
}

function getBearerUserIdMock(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  if (!m) return null;
  try {
    const decoded = jwt.verify(String(m[1]).trim(), JWT_SECRET);
    const id = decoded.user_id != null ? Number(decoded.user_id) : null;
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

app.get("/api/documents/comments", (req, res) => {
  const documentId = req.query.documentId ?? req.query.document_id;
  const s3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();
  const key = commentsStorageKey(documentId, s3Key);
  if (!key) {
    return res.status(400).json({ success: false, message: "Missing documentId or s3Key." });
  }
  const data = documentCommentsByKey.get(key) || [];
  return res.status(200).json({ success: true, data });
});

app.post("/api/documents/comments", (req, res) => {
  const uid = getBearerUserIdMock(req);
  if (uid == null) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  const text = String(req.body.text ?? req.body.body ?? "").trim();
  const documentId = req.body.documentId ?? req.body.document_id;
  const s3Key = String(req.body.s3Key ?? req.body.s3_key ?? "").trim();
  if (!text) {
    return res.status(400).json({ success: false, message: "Comment cannot be empty." });
  }
  const key = commentsStorageKey(documentId, s3Key);
  if (!key) {
    return res.status(400).json({ success: false, message: "Missing documentId or s3Key." });
  }
  const u = users.find((x) => x.user_id === uid);
  const author = u?.full_name || "User";
  const role =
    u && String(u.role || "").toUpperCase() === "LECTURER" ? "instructor" : "student";
  const row = {
    id: Date.now(),
    author,
    text,
    date: new Date().toISOString().slice(0, 10),
    role,
  };
  const arr = documentCommentsByKey.get(key) || [];
  arr.push(row);
  documentCommentsByKey.set(key, arr);
  return res.status(201).json({ success: true, message: "Posted." });
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
      questions: quiz,
      attemptsCount: 0,
      courseCode: fromDoc?.subjectCode || "DOC",
      isPublished: false,
      publishedAt: null,
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
  const uid = req.query?.userId != null ? String(req.query.userId) : null;
  const attemptsByQuiz = new Map();
  for (const a of quizAttempts) {
    if (uid && String(a.userId ?? "") !== uid) continue;
    const list = attemptsByQuiz.get(a.quizId) || [];
    list.push(a);
    attemptsByQuiz.set(a.quizId, list);
  }

  return res.status(200).json({
    success: true,
    total: quizzes.length,
    data: quizzes.map((q) => ({
      id: q.id,
      quizId: q.id,
      title: q.title,
      createdAt: q.createdAt,
      publishedAt: q.publishedAt || null,
      isPublished: Boolean(q.isPublished),
      lastAttemptAt: q.lastAttemptAt,
      scorePercent: q.scorePercent,
      questionCount: q.questionsCount,
      attemptsCount: (attemptsByQuiz.get(q.id) || []).length,
      lastAttemptId: ((attemptsByQuiz.get(q.id) || [])[0] || {}).id || null,
      courseCode: q.courseCode || "DOC",
    })),
  });
});

app.get("/api/quizzes/published", (req, res) => {
  const publishedRows = quizzes.filter((q) => Boolean(q.isPublished));
  return res.status(200).json({
    success: true,
    total: publishedRows.length,
    data: publishedRows.map((q) => ({
      id: q.id,
      quizId: q.id,
      title: q.title,
      questionCount: q.questionsCount,
      courseCode: q.courseCode || "DOC",
      creatorName: "Lecturer",
      createdAt: q.createdAt,
      publishedAt: q.publishedAt || q.createdAt,
    })),
  });
});

app.post("/api/quizzes/:id/publish", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const idx = quizzes.findIndex((q) => q.id === qid);
  if (idx < 0) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  const now = new Date().toISOString();
  quizzes[idx] = {
    ...quizzes[idx],
    isPublished: true,
    publishedAt: now,
  };
  return res.status(200).json({
    success: true,
    message: "Quiz published successfully.",
    data: {
      quizId: quizzes[idx].id,
      isPublished: true,
      publishedAt: now,
    },
  });
});

app.get("/api/quizzes/:id", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const quizRow = quizzes.find((q) => q.id === qid);
  if (!quizRow) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  return res.status(200).json({
    success: true,
    data: {
      quiz_id: quizRow.id,
      title: quizRow.title,
      questions: Array.isArray(quizRow.questions) ? quizRow.questions : [],
    },
  });
});

app.get("/api/questions/bank", async (req, res) => {
  const userId = req.query?.userId;
  const uid = toNum(userId, NaN);
  if (!Number.isFinite(uid)) {
    return res.status(400).json({ success: false, message: "Invalid userId." });
  }

  try {
    await ensureQuestionBankTable();
    const pool = getMysqlPool();
    const [rows] = await pool.query(
      `SELECT id, lecturer_user_id, question_text, question_type, topic, difficulty, options_json, correct_answer, quiz_id, quiz_title
       FROM question_bank
       WHERE lecturer_user_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [uid]
    );

    const data = rows.map((r) => ({
      id: Number(r.id),
      question: String(r.question_text || ""),
      type: String(r.question_type || "multiple-choice"),
      topic: String(r.topic || "General"),
      difficulty: String(r.difficulty || "medium"),
      options: parseOptionsJson(r.options_json),
      correctAnswer: r.correct_answer != null ? String(r.correct_answer) : "",
      quizId: r.quiz_id != null ? Number(r.quiz_id) : undefined,
      quizTitle: r.quiz_title != null ? String(r.quiz_title) : undefined,
    }));

    return res.status(200).json({
      success: true,
      total: data.length,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Question bank MySQL error.",
      error: err?.message || "Unknown database error.",
    });
  }
});

app.post("/api/questions/bank", async (req, res) => {
  const userId = req.body?.userId;
  const uid = toNum(userId, NaN);
  if (!Number.isFinite(uid)) {
    return res.status(400).json({ success: false, message: "Invalid userId." });
  }
  if (!isLecturerUserId(uid)) {
    return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
  }

  const payload = normalizeQuestionInput(req.body || {});
  if (!payload.question) {
    return res.status(400).json({ success: false, message: "Question is required." });
  }
  if (payload.type === "multiple-choice" && payload.options.length < 2) {
    return res.status(400).json({
      success: false,
      message: "Multiple-choice questions need at least 2 options.",
    });
  }

  try {
    await ensureQuestionBankTable();
    const pool = getMysqlPool();
    const [result] = await pool.query(
      `INSERT INTO question_bank
       (lecturer_user_id, question_text, question_type, topic, difficulty, options_json, correct_answer, quiz_id, quiz_title)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, NULL, NULL)`,
      [
        uid,
        payload.question,
        payload.type,
        payload.topic,
        payload.difficulty,
        JSON.stringify(payload.options),
        payload.correctAnswer || null,
      ]
    );
    return res.status(201).json({
      success: true,
      message: "Question added successfully.",
      data: { id: Number(result.insertId) },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Question bank MySQL error.",
      error: err?.message || "Unknown database error.",
    });
  }
});

app.patch("/api/questions/bank/:id", async (req, res) => {
  const qid = toNum(req.params.id, NaN);
  const uid = toNum(req.body?.userId, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid question id." });
  }
  if (!Number.isFinite(uid)) {
    return res.status(400).json({ success: false, message: "Invalid userId." });
  }
  if (!isLecturerUserId(uid)) {
    return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
  }

  const payload = normalizeQuestionInput(req.body || {});
  if (!payload.question) {
    return res.status(400).json({ success: false, message: "Question is required." });
  }

  try {
    await ensureQuestionBankTable();
    const pool = getMysqlPool();
    const [result] = await pool.query(
      `UPDATE question_bank
       SET question_text = ?, question_type = ?, topic = ?, difficulty = ?, options_json = CAST(? AS JSON), correct_answer = ?
       WHERE id = ? AND lecturer_user_id = ?`,
      [
        payload.question,
        payload.type,
        payload.topic,
        payload.difficulty,
        JSON.stringify(payload.options),
        payload.correctAnswer || null,
        qid,
        uid,
      ]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: "Question not found." });
    }
    return res.status(200).json({ success: true, message: "Question updated successfully." });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Question bank MySQL error.",
      error: err?.message || "Unknown database error.",
    });
  }
});

app.delete("/api/questions/bank/:id", async (req, res) => {
  const qid = toNum(req.params.id, NaN);
  const uid = toNum(req.query?.userId, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid question id." });
  }
  if (!Number.isFinite(uid)) {
    return res.status(400).json({ success: false, message: "Invalid userId." });
  }
  if (!isLecturerUserId(uid)) {
    return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
  }

  try {
    await ensureQuestionBankTable();
    const pool = getMysqlPool();
    const [result] = await pool.query(
      "DELETE FROM question_bank WHERE id = ? AND lecturer_user_id = ?",
      [qid, uid]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: "Question not found." });
    }
    return res.status(200).json({ success: true, message: "Question deleted successfully." });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Question bank MySQL error.",
      error: err?.message || "Unknown database error.",
    });
  }
});

/**
 * Record a quiz attempt (in-memory).
 * FE sends { quizId, userId, score }.
 */
app.post("/api/quiz/attempts", (req, res) => {
  const { quizId, userId, score, phase, answers, timeTaken } = req.body || {};
  const qid = Number(quizId);

  if (!Number.isFinite(qid)) {
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
  if (String(phase || "").toLowerCase() === "start") {
    quizAttempts.unshift({
      id: Date.now(),
      quizId: qid,
      userId: userId ?? null,
      score: null,
      scorePercent: null,
      totalQuestions: Number(quizRow.questionsCount) || 0,
      correctCount: null,
      createdAt: now,
      completedAt: null,
      status: "started",
      answers: [],
      time_taken_seconds: 0,
    });
    quizRow.attemptsCount = toNum(quizRow.attemptsCount) + 1;
    return res.status(201).json({
      success: true,
      message: "OK",
      data: { attemptId: quizAttempts[0].id },
    });
  }

  const s = Number(score);
  if (!Number.isFinite(s)) {
    return res.status(400).json({
      success: false,
      message: "Invalid score.",
    });
  }

  const questions = Array.isArray(quizRow.questions) ? quizRow.questions : [];
  const questionsCount = Number(quizRow.questionsCount) || questions.length || 0;
  const scorePercent = questionsCount > 0 ? Math.round((s / questionsCount) * 100) : 0;

  const normalizedAnswers = Array.isArray(answers)
    ? answers.map((a, idx) => {
        const qidRaw = a?.questionId ?? a?.question_id ?? `q-${idx + 1}`;
        const qidStr = String(qidRaw);
        const questionRow =
          questions.find((q, qIdx) => String(q?.id || `q-${qIdx + 1}`) === qidStr) ||
          questions[idx] ||
          null;

        const selectedRaw = a?.selectedAnswer ?? a?.selected_answer ?? a?.userAnswer;
        let selectedLetter = null;
        if (typeof selectedRaw === "number" && selectedRaw >= 0 && selectedRaw < LETTERS.length) {
          selectedLetter = LETTERS[selectedRaw];
        } else if (typeof selectedRaw === "string") {
          const up = selectedRaw.toUpperCase();
          if (LETTERS.includes(up)) selectedLetter = up;
        }

        const correctRaw = a?.correctAnswer ?? a?.correct_answer ?? questionRow?.correct_answer;
        let correctLetter = null;
        if (typeof correctRaw === "number" && correctRaw >= 0 && correctRaw < LETTERS.length) {
          correctLetter = LETTERS[correctRaw];
        } else if (typeof correctRaw === "string") {
          const up = correctRaw.toUpperCase();
          if (LETTERS.includes(up)) correctLetter = up;
        }

        return {
          questionId: qidStr,
          question_text: String(questionRow?.question || `Question ${idx + 1}`),
          selectedAnswer: selectedLetter,
          selected_answer: optionTextFromQuestion(questionRow, selectedLetter),
          correctAnswer: correctLetter,
          correct_answer: optionTextFromQuestion(questionRow, correctLetter),
          options: questionRow?.options
            ? [questionRow.options.A, questionRow.options.B, questionRow.options.C, questionRow.options.D].filter(Boolean)
            : [],
          is_correct:
            selectedLetter && correctLetter ? selectedLetter === correctLetter : false,
        };
      })
    : [];

  const attemptId = Date.now();
  quizAttempts.unshift({
    id: attemptId,
    quizId: qid,
    userId: userId ?? null,
    score: s,
    scorePercent,
    totalQuestions: questionsCount,
    correctCount: s,
    createdAt: now,
    completedAt: now,
    status: "completed",
    answers: normalizedAnswers,
    time_taken_seconds: toNum(timeTaken, 0),
  });

  quizRow.lastAttemptAt = now;
  quizRow.scorePercent = scorePercent;
  quizRow.attemptsCount = toNum(quizRow.attemptsCount) + 1;

  return res.status(201).json({
    success: true,
    message: "OK",
    data: { attemptId },
  });
});

app.get("/api/quiz/result/:attemptId", (req, res) => {
  const attemptId = toNum(req.params.attemptId, NaN);
  if (!Number.isFinite(attemptId)) {
    return res.status(400).json({ success: false, message: "Invalid attempt id." });
  }

  const uid = req.query?.userId != null ? String(req.query.userId) : null;
  const attempt = quizAttempts.find((a) => {
    if (a.id !== attemptId) return false;
    if (uid && String(a.userId ?? "") !== uid) return false;
    return true;
  });
  if (!attempt) {
    return res.status(404).json({ success: false, message: "Attempt not found." });
  }

  const quizRow = quizzes.find((q) => q.id === attempt.quizId);
  return res.status(200).json({
    success: true,
    data: {
      attemptId: attempt.id,
      quizId: attempt.quizId,
      title: quizRow?.title || "Quiz",
      score: attempt.scorePercent ?? 0,
      correct_count: attempt.correctCount ?? 0,
      total_questions: attempt.totalQuestions ?? 0,
      time_taken_seconds: attempt.time_taken_seconds ?? 0,
      answers: Array.isArray(attempt.answers) ? attempt.answers : [],
      completed_at: attempt.completedAt || attempt.createdAt,
    },
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