const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = 3001;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MEDIA_MAX_FILE_SIZE = 50 * 1024 * 1024;
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
const AWS_REGION = process.env.AWS_REGION || "";
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || "";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";

/** Frontend route for lecturer quiz editor; returned as `navigateTo` when AI generation completes. */
const QUIZ_LECTURER_NAVIGATE_PATH_TEMPLATE =
  process.env.QUIZ_LECTURER_NAVIGATE_PATH_TEMPLATE ||
  "/quiz/:id?tab=edit&selectedId=:id";

function buildLecturerQuizNavigateTo(quizId) {
  const id = Number(quizId);
  if (!Number.isFinite(id) || id <= 0) return "";
  return String(QUIZ_LECTURER_NAVIGATE_PATH_TEMPLATE)
    .replace(/:id\b/g, String(id))
    .replace(/:quizId\b/g, String(id));
}

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

const mediaAllowedExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
]);

function mediaFileFilter(req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = String(file.mimetype || "").toLowerCase();
  const okExt = mediaAllowedExtensions.has(extension);
  const okMime = mimeType.startsWith("image/") || mimeType.startsWith("video/");
  if (!okExt || !okMime) {
    return cb(new Error("Only image/video files are allowed (.jpg, .png, .gif, .webp, .mp4, .webm, .mov)."));
  }
  cb(null, true);
}

const uploadMedia = multer({
  storage: storage,
  limits: { fileSize: MEDIA_MAX_FILE_SIZE },
  fileFilter: mediaFileFilter,
});

const s3Client =
  AWS_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
    ? new S3Client({
        region: AWS_REGION,
        credentials: {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
        },
      })
    : null;

const recentUploads = [];
const quizzes = [];
const quizAttempts = [];
/** All completed attempts for a quiz (any student). Used for lecturer dashboard counts — do not filter by lecturer userId. */
function completedAttemptsForQuizId(quizId) {
  return quizAttempts.filter(
    (a) => Number(a.quizId) === Number(quizId) && String(a.status || "") === "completed"
  );
}
function attemptsCountForQuiz(quizId) {
  return completedAttemptsForQuizId(quizId).length;
}
function averageScorePercentForQuiz(quizId) {
  const list = completedAttemptsForQuizId(quizId).filter((a) => a.scorePercent != null);
  if (!list.length) return 0;
  return Math.round(list.reduce((s, a) => s + Number(a.scorePercent || 0), 0) / list.length);
}
const manualGradesByAttemptId = new Map();
/** PATCH /quiz/attempts/:id/grade — lecturer marks each question đúng/sai (Map: questionId -> boolean). */
const lecturerCorrectMarksByAttemptId = new Map();
const quizCommentsByQuizId = new Map();
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
        media_url TEXT NULL,
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
  await questionBankTableReady;
  // Backward compatibility for existing local DBs created before `media_url` existed.
  const pool = getMysqlPool();
  await pool.query("ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS media_url TEXT NULL");
  await pool.query("ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS explanation TEXT NULL");
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
  const mediaUrl = String(payload?.mediaUrl ?? payload?.media_url ?? "").trim();
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

  const explanation =
    payload?.explanation != null
      ? String(payload.explanation).trim()
      : payload?.question_explanation != null
        ? String(payload.question_explanation).trim()
        : "";
  return {
    question,
    mediaUrl,
    type,
    topic,
    difficulty,
    options,
    correctAnswer,
    explanation,
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

function isGenericDisplayName(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return !s || s === "student" || s === "unknown" || s === "unknown student";
}

function resolveUserDisplayName(userRow, fallback = "Unknown") {
  if (!userRow || typeof userRow !== "object") return fallback;
  const fullName = String(userRow.full_name || "").trim();
  if (fullName) return fullName;
  const name = String(userRow.name || "").trim();
  if (name) return name;
  const userCode = String(userRow.user_code || "").trim();
  if (userCode) return userCode;
  const email = String(userRow.email || "").trim();
  if (email) {
    const localPart = email.split("@")[0].trim();
    if (localPart) return localPart;
  }
  const uid = Number(userRow.user_id || 0);
  if (Number.isFinite(uid) && uid > 0) return `User #${uid}`;
  return fallback;
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

function normalizeAnswerText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseExpectedShortAnswers(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const parts = text
    .split(/[\n;|]+/)
    .map((s) => normalizeAnswerText(s))
    .filter(Boolean);
  return Array.from(new Set(parts));
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
    /** Moderation: pending until PATCH …/verify — must stay in memory for for-quiz (do not cap too low). */
    verificationStatus: "pending",
    uploaderRole: "lecturer",
    chunkCount: 2,
    inDatabase: true,
    commentsCount: 0,
  };

  recentUploads.unshift(newDocument);

  const MAX_RECENT_UPLOADS = 500;
  while (recentUploads.length > MAX_RECENT_UPLOADS) {
    recentUploads.pop();
  }

  return res.status(201).json({
    success: true,
    message: "Tải tài liệu lên thành công.",
    data: newDocument,
  });
});

app.post("/api/questions/media/upload", uploadMedia.single("mediaFile"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Please choose an image/video file.",
    });
  }
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  return res.status(201).json({
    success: true,
    data: {
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileUrl: `${baseUrl}/uploads/${req.file.filename}`,
    },
  });
});

app.post("/api/questions/media/upload-s3", uploadMedia.single("mediaFile"), async (req, res) => {
  if (!s3Client) {
    if (req.file?.path) deleteFileIfExists(req.file.path);
    return res.status(500).json({
      success: false,
      message: "S3 is not configured. Set AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.",
    });
  }
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Please choose an image/video file.",
    });
  }
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const safeBase = path
      .basename(req.file.originalname, ext)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const key = `question-media/${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeBase || "media"}${ext}`;
    const body = fs.readFileSync(req.file.path);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: req.file.mimetype || "application/octet-stream",
      })
    );
    const publicUrl = `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const proxyUrl = `${baseUrl}/api/questions/media/file?s3Key=${encodeURIComponent(key)}`;
    return res.status(201).json({
      success: true,
      data: {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        // Use backend proxy URL so preview works even when bucket objects are private.
        fileUrl: proxyUrl,
        publicUrl,
        s3Key: key,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "S3 upload failed.",
      error: err?.message || "Unknown S3 error.",
    });
  } finally {
    if (req.file?.path) deleteFileIfExists(req.file.path);
  }
});

app.get("/api/questions/media/file", async (req, res) => {
  if (!s3Client) {
    return res.status(500).json({
      success: false,
      message: "S3 is not configured.",
    });
  }
  const s3Key = String(req.query?.s3Key || "").trim();
  if (!s3Key) {
    return res.status(400).json({
      success: false,
      message: "Missing s3Key.",
    });
  }
  try {
    const out = await s3Client.send(
      new GetObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: s3Key,
      })
    );
    if (out.ContentType) res.setHeader("Content-Type", out.ContentType);
    if (out.ContentLength != null) res.setHeader("Content-Length", String(out.ContentLength));
    res.setHeader("Cache-Control", "public, max-age=300");
    const body = out.Body;
    if (!body) {
      return res.status(404).json({
        success: false,
        message: "Media body not found.",
      });
    }
    body.pipe(res);
  } catch (err) {
    return res.status(404).json({
      success: false,
      message: "Media file not found on S3.",
      error: err?.message || "Unknown S3 error.",
    });
  }
});

app.get("/api/documents/recent", (req, res) => {
  res.status(200).json({
    success: true,
    total: recentUploads.length,
    data: recentUploads,
  });
});

function findRecentUploadByRef(documentIdRaw, s3KeyRaw) {
  const s3Key = String(s3KeyRaw || "").trim();
  if (documentIdRaw != null && String(documentIdRaw).trim() !== "") {
    const id = Number(documentIdRaw);
    if (Number.isFinite(id)) {
      const byId = recentUploads.find((d) => Number(d.id) === id);
      if (byId) return byId;
    }
  }
  if (s3Key) {
    const base = path.basename(s3Key);
    const byKey = recentUploads.find(
      (d) =>
        String(d.storedFileName || "") === s3Key ||
        String(d.storedFileName || "") === base
    );
    if (byKey) return byKey;
  }
  return null;
}

/**
 * Preview metadata for FE. `url` is intended for inline rendering.
 * - pdf: open directly in iframe
 * - doc/docx: FE should render via Google Docs Viewer wrapper to avoid browser auto-download.
 */
app.get("/api/documents/preview", (req, res) => {
  const documentId = req.query.documentId ?? req.query.document_id;
  const s3Key = req.query.s3Key ?? req.query.s3_key ?? req.query.key;
  const doc = findRecentUploadByRef(documentId, s3Key);
  if (!doc) {
    return res.status(404).json({ success: false, message: "Document not found." });
  }

  const safeName = path.basename(String(doc.storedFileName || ""));
  const filePath = path.join(uploadDir, safeName);
  if (!safeName || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: "File not found on server." });
  }

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const url = `${baseUrl}/uploads/${encodeURIComponent(safeName)}`;
  const ext = path.extname(safeName).toLowerCase();
  const isWord = ext === ".doc" || ext === ".docx";

  return res.status(200).json({
    success: true,
    data: {
      documentId: doc.id,
      s3Key: doc.storedFileName,
      originalFileName: doc.originalFileName,
      mimeType: doc.fileType || null,
      extension: ext.replace(".", ""),
      isWord,
      url,
      // Keep FE description fallback behavior intact.
      description: String(doc.description || ""),
    },
  });
});

app.get("/api/documents/download-file", (req, res) => {
  const documentId = req.query.documentId ?? req.query.document_id;
  const s3Key = req.query.s3Key ?? req.query.s3_key;
  const doc = findRecentUploadByRef(documentId, s3Key);
  if (!doc) {
    return res.status(404).json({ success: false, message: "Document not found." });
  }

  const safeName = path.basename(String(doc.storedFileName || ""));
  const filePath = path.join(uploadDir, safeName);
  if (!safeName || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: "File not found on server." });
  }

  doc.downloads = toNum(doc.downloads, 0) + 1;
  const downloadName = String(doc.originalFileName || safeName).trim() || safeName;
  return res.download(filePath, downloadName);
});

function parseTruthyBool(v, defaultTrue = true) {
  if (v === undefined || v === null || v === "") return defaultTrue;
  const s = String(v).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(s)) return false;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  return defaultTrue;
}

/**
 * Documents list for the Quiz screen.
 * FE expects `s3Key` and uses it when calling /api/quiz/generate.
 * Query: includeVerified (default true) — when false, excludes moderation-verified rows (legacy behaviour).
 * Production backends should treat audience=student + includeVerified=true as “show verified materials to learners”.
 */
app.get("/api/documents/for-quiz", (req, res) => {
  const includeVerified = parseTruthyBool(req.query.includeVerified, true);
  let filtered = recentUploads.filter(
    (d) => String(d.verificationStatus || "").toLowerCase() !== "rejected"
  );
  if (!includeVerified) {
    filtered = filtered.filter((d) => String(d.verificationStatus || "").toLowerCase() !== "verified");
  }

  const data = filtered.map((d) => {
    const v = String(d.verificationStatus || "").toLowerCase();
    const role = String(d.uploaderRole || "lecturer").toLowerCase();
    const chunkCount = Number(d.chunkCount || 0);
    const highCredibility =
      v === "verified" ||
      role.includes("lectur") ||
      role.includes("instruct") ||
      role === "admin";
    return {
      documentId: d.id,
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
      status: d.verificationStatus || "pending",
      uploaderRole: d.uploaderRole || "lecturer",
      uploaderName: d.uploaderName || "",
      chunkCount,
      commentsCount: Number(d.commentsCount || 0),
      inDatabase: d.inDatabase !== false,
      highCredibility,
    };
  });

  return res.status(200).json({
    success: true,
    total: data.length,
    data,
  });
});

/** Lecturer/admin marks document verified — students should then see it in for-quiz when includeVerified=true (default). */
app.patch("/api/documents/:documentId/verify", (req, res) => {
  const id = Number(req.params.documentId);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, message: "Invalid document id." });
  }
  const doc = recentUploads.find((d) => Number(d.id) === id);
  if (!doc) {
    return res.status(404).json({ success: false, message: "Document not found." });
  }
  doc.verificationStatus = "verified";
  return res.status(200).json({
    success: true,
    message: "Verified.",
    data: { documentId: id, status: "verified" },
  });
});

app.patch("/api/documents/:documentId/reject", (req, res) => {
  const id = Number(req.params.documentId);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, message: "Invalid document id." });
  }
  const doc = recentUploads.find((d) => Number(d.id) === id);
  if (!doc) {
    return res.status(404).json({ success: false, message: "Document not found." });
  }
  doc.verificationStatus = "rejected";
  return res.status(200).json({
    success: true,
    message: "Rejected.",
    data: { documentId: id, status: "rejected" },
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
  const { content, numQuestions, language, persist, quizTitle, s3Key, createdBy } =
    req.body || {};
  const uidFromBearer = getBearerUserIdMock(req);
  const ownerId = Number.isFinite(Number(uidFromBearer))
    ? Number(uidFromBearer)
    : Number.isFinite(Number(createdBy))
      ? Number(createdBy)
      : null;
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

  const quiz = Array.from({ length: n }, (_, i) => {
    const correctLetter = LETTERS[i % LETTERS.length];
    return {
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
      correct_answer: correctLetter,
      explanation: `Sample explanation from the local mock server. Correct option is ${correctLetter}.`,
    };
  });

  let quizId = null;
  if (persist) {
    const now = new Date().toISOString();
    quizId = Date.now();
    quizzes.unshift({
      id: quizId,
      title: String(quizTitle || fromDoc?.title || "Quiz").trim() || "Quiz",
      sourceKey: s3Key || null,
      createdBy: ownerId,
      createdAt: now,
      lastAttemptAt: null,
      scorePercent: null,
      questionsCount: quiz.length,
      questions: quiz,
      attemptsCount: 0,
      courseCode: fromDoc?.subjectCode || "DOC",
      isPublished: false,
      publishedAt: null,
      sharedForReview: false,
      sharedAt: null,
      sharedByUserId: null,
      sharedByName: null,
      sharedByUserCode: null,
      sharedAttemptId: null,
      lecturerEdited: false,
      lecturerEditedAt: null,
    });
  }

  const navigateTo = quizId != null ? buildLecturerQuizNavigateTo(quizId) : "";
  return res.status(200).json({
    success: true,
    message: "OK",
    data: { quiz, quizId },
    autoOpen: Boolean(navigateTo),
    navigateTo: navigateTo || undefined,
    navigateReplace: true,
  });
});

/**
 * Quiz history list (in-memory).
 * Shape matches FE usage in Generate-Quizz.html.
 */
app.get("/api/quizzes/history", (req, res) => {
  const uid = req.query?.userId != null ? String(req.query.userId) : null;
  const ownerOnly =
    String(req.query?.ownerOnly ?? "false").toLowerCase() === "true" ||
    String(req.query?.onlyMine ?? "false").toLowerCase() === "true";
  const attemptsByQuiz = new Map();
  for (const a of quizAttempts) {
    if (String(a.status || "") !== "completed") continue;
    const list = attemptsByQuiz.get(a.quizId) || [];
    list.push(a);
    attemptsByQuiz.set(a.quizId, list);
  }

  const historyRows = quizzes
    .filter((q) => {
      if (!ownerOnly || !uid) return true;
      // Keep published list behavior as before (shared/global),
      // only restrict non-published rows to owner.
      if (Boolean(q.isPublished)) return true;
      return String(q.createdBy ?? "") === uid;
    })
    .map((q) => {
      const sharedByUserId = Number(q.sharedByUserId ?? 0) || null;
      const sharedUser =
        sharedByUserId != null
          ? users.find((u) => Number(u?.user_id) === Number(sharedByUserId))
          : null;
      const rawSharedByName = String(q.sharedByName || "").trim();
      const resolvedSharedName =
        !isGenericDisplayName(rawSharedByName)
          ? rawSharedByName
          : resolveUserDisplayName(sharedUser, null);
      const resolvedSharedCode =
        String(q.sharedByUserCode || "").trim() ||
        String(sharedUser?.user_code || "").trim() ||
        null;
      return {
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
        createdBy: q.createdBy ?? null,
        sharedForReview: Boolean(q.sharedForReview),
        sharedFromStudent: Boolean(q.sharedForReview),
        sharedAt: q.sharedAt || null,
        sharedByUserId,
        sharedByName: resolvedSharedName,
        sharedByUserCode: resolvedSharedCode,
        lecturerEdited: Boolean(q.lecturerEdited),
        lecturerEditedAt: q.lecturerEditedAt || null,
      };
    });

  return res.status(200).json({
    success: true,
    total: historyRows.length,
    data: historyRows,
  });
});

app.get("/api/quizzes/edited-by-lecturer", (req, res) => {
  const uid = req.query?.userId != null ? String(req.query.userId) : null;
  const attemptsByQuiz = new Map();
  for (const a of quizAttempts) {
    if (String(a.status || "") !== "completed") continue;
    const list = attemptsByQuiz.get(a.quizId) || [];
    list.push(a);
    attemptsByQuiz.set(a.quizId, list);
  }
  const rows = quizzes
    .filter((q) => Boolean(q.lecturerEdited) && (!uid || String(q.sharedByUserId ?? "") === uid))
    .map((q) => {
      const sharedByUserId = Number(q.sharedByUserId ?? 0) || null;
      const sharedUser =
        sharedByUserId != null
          ? users.find((u) => Number(u?.user_id) === Number(sharedByUserId))
          : null;
      return {
        id: q.id,
        quizId: q.id,
        title: q.title,
        courseCode: q.courseCode || "DOC",
        questionCount: Number(q.questionsCount || 0),
        attemptsCount: (attemptsByQuiz.get(q.id) || []).length,
        lastAttemptId: ((attemptsByQuiz.get(q.id) || [])[0] || {}).id || null,
        scorePercent: Number(q.scorePercent || 0),
        sharedForReview: true,
        sharedFromStudent: true,
        sharedAt: q.sharedAt || null,
        sharedByUserId,
        sharedByName:
          String(q.sharedByName || "").trim() || String(sharedUser?.full_name || "").trim() || null,
        sharedByUserCode:
          String(q.sharedByUserCode || "").trim() || String(sharedUser?.user_code || "").trim() || null,
        lecturerEdited: true,
        lecturerEditedAt: q.lecturerEditedAt || null,
        createdAt: q.createdAt || null,
        lastAttemptAt: q.lastAttemptAt || null,
      };
    });
  return res.status(200).json({
    success: true,
    total: rows.length,
    data: rows,
  });
});

app.get("/api/quizzes/published", (req, res) => {
  const uid = req.query?.userId != null ? String(req.query.userId) : null;
  const ownerOnly =
    String(req.query?.ownerOnly ?? "false").toLowerCase() === "true" ||
    String(req.query?.onlyMine ?? "false").toLowerCase() === "true";
  const publishedRows = quizzes.filter((q) => {
    if (!Boolean(q.isPublished)) return false;
    if (!ownerOnly || !uid) return true;
    return String(q.createdBy ?? "") === uid;
  });
  return res.status(200).json({
    success: true,
    total: publishedRows.length,
    data: publishedRows.map((q) => {
      const publisherId = Number(q.publishedByUserId ?? q.createdBy ?? 0) || null;
      const publisher = users.find((u) => Number(u?.user_id) === Number(publisherId));
      return {
        id: q.id,
        quizId: q.id,
        title: q.title,
        questionCount: q.questionsCount,
        courseCode: q.courseCode || "DOC",
        creatorName: publisher?.full_name || "Lecturer",
        createdAt: q.createdAt,
        publishedAt: q.publishedAt || q.createdAt,
        publishedByUserId: publisherId,
        publishedByUserCode: publisher?.user_code || null,
        attemptsCount: attemptsCountForQuiz(q.id),
        scorePercent: averageScorePercentForQuiz(q.id),
      };
    }),
  });
});

/**
 * Lecturer: list completed attempts for a quiz they own.
 * MUST be registered before `GET /api/quizzes/:id` (Express 5 / path-to-regexp).
 * GET /api/quizzes/:quizId/attempts?userId=<lecturerUserId>
 */
app.get("/api/quizzes/:quizId/attempts", (req, res) => {
  const qid = toNum(req.params.quizId, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const lecturerId = req.query?.userId != null ? String(req.query.userId) : null;
  const quizRow = quizzes.find((q) => Number(q.id) === qid);
  if (!quizRow) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  const ownsQuiz =
    lecturerId == null ||
    String(quizRow.createdBy ?? "") === lecturerId ||
    String(quizRow.publishedByUserId ?? "") === lecturerId;
  if (lecturerId != null && !ownsQuiz) {
    return res.status(403).json({ success: false, message: "You do not have access to this quiz's attempts." });
  }
  const rows = quizAttempts
    .filter((a) => Number(a.quizId) === qid && String(a.status || "") === "completed")
    .map((a) => {
      const u = users.find((x) => String(x.user_id) === String(a.userId));
      return {
        attemptId: a.id,
        userId: a.userId,
        studentName: u?.full_name || u?.name || `User ${a.userId}`,
        studentEmail: u?.email || null,
        scorePercent: a.scorePercent,
        correctCount: a.correctCount,
        totalQuestions: a.totalQuestions,
        completedAt: a.completedAt || a.createdAt,
      };
    })
    .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  return res.status(200).json({ success: true, data: rows });
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
  const uidFromBearer = getBearerUserIdMock(req);
  const uidFromBody = toNum(req.body?.userId, NaN);
  const now = new Date().toISOString();
  quizzes[idx] = {
    ...quizzes[idx],
    isPublished: true,
    publishedAt: now,
    publishedByUserId:
      uidFromBearer != null
        ? Number(uidFromBearer)
        : Number.isFinite(uidFromBody)
          ? uidFromBody
          : quizzes[idx]?.createdBy ?? null,
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

app.delete("/api/quizzes/:id", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const uidFromBearer = getBearerUserIdMock(req);
  if (uidFromBearer == null) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  if (!isLecturerUserId(uidFromBearer)) {
    return res.status(403).json({ success: false, message: "Only lecturers can delete quizzes." });
  }
  const idx = quizzes.findIndex((q) => Number(q.id) === Number(qid));
  if (idx < 0) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  const quizRow = quizzes[idx];
  if (String(quizRow?.createdBy ?? "") !== String(uidFromBearer)) {
    return res.status(403).json({ success: false, message: "You do not have permission to delete this quiz." });
  }

  quizzes.splice(idx, 1);

  // Remove related attempts and in-memory grading/comments for this quiz.
  const deletedAttemptIds = [];
  for (let i = quizAttempts.length - 1; i >= 0; i -= 1) {
    if (Number(quizAttempts[i]?.quizId) === Number(qid)) {
      deletedAttemptIds.push(Number(quizAttempts[i]?.id));
      quizAttempts.splice(i, 1);
    }
  }
  deletedAttemptIds.forEach((attemptId) => {
    manualGradesByAttemptId.delete(Number(attemptId));
    lecturerCorrectMarksByAttemptId.delete(Number(attemptId));
  });
  quizCommentsByQuizId.delete(Number(qid));

  return res.status(200).json({
    success: true,
    message: "Quiz deleted successfully.",
    data: { quizId: Number(qid) },
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
  const dm = Number(quizRow.durationMinutes ?? quizRow.duration_minutes ?? quizRow.duration);
  const pp = Number(quizRow.passPercentage ?? quizRow.pass_percentage);
  return res.status(200).json({
    success: true,
    data: {
      quiz_id: quizRow.id,
      title: quizRow.title,
      duration_minutes: Number.isFinite(dm) && dm > 0 ? dm : 10,
      pass_percentage: Number.isFinite(pp) && pp > 0 ? pp : 70,
      questions: Array.isArray(quizRow.questions) ? quizRow.questions : [],
      attemptsCount: attemptsCountForQuiz(qid),
      scorePercent: averageScorePercentForQuiz(qid),
    },
  });
});

app.post("/api/quizzes/:id/share", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const idx = quizzes.findIndex((q) => q.id === qid);
  if (idx < 0) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  if (Boolean(quizzes[idx]?.sharedForReview)) {
    return res.status(409).json({
      success: false,
      message: "This quiz has already been shared.",
      data: {
        quizId: qid,
        sharedForReview: true,
        sharedAt: quizzes[idx]?.sharedAt || null,
      },
    });
  }
  const uidFromBearer = getBearerUserIdMock(req);
  const uidFromBody = toNum(req.body?.userId, NaN);
  const sharedByUserId =
    uidFromBearer != null ? Number(uidFromBearer) : Number.isFinite(uidFromBody) ? uidFromBody : null;
  if (!Number.isFinite(Number(sharedByUserId))) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  const latestCompletedAttempt = quizAttempts.find(
    (a) =>
      Number(a.quizId) === qid &&
      String(a.status || "") === "completed" &&
      String(a.userId ?? "") === String(sharedByUserId)
  );
  if (!latestCompletedAttempt) {
    return res.status(400).json({
      success: false,
      message: "No completed attempt found to share for this quiz.",
    });
  }
  const u = users.find((x) => String(x.user_id) === String(sharedByUserId));
  const now = new Date().toISOString();
  const sharedByName = resolveUserDisplayName(u, "Unknown student");
  quizzes[idx] = {
    ...quizzes[idx],
    sharedForReview: true,
    sharedAt: now,
    sharedByUserId,
    sharedByName,
    sharedByUserCode: u?.user_code || null,
    sharedAttemptId: latestCompletedAttempt.id,
  };
  return res.status(200).json({
    success: true,
    message: "Quiz shared successfully.",
    data: {
      quizId: qid,
      sharedForReview: true,
      sharedAt: now,
      sharedByUserId,
      sharedAttemptId: latestCompletedAttempt.id,
    },
  });
});

app.get("/api/quizzes/:id/shared-student-result", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const quizRow = quizzes.find((q) => q.id === qid);
  if (!quizRow) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  const preferredAttemptId = toNum(quizRow.sharedAttemptId, NaN);
  let attempt = Number.isFinite(preferredAttemptId)
    ? quizAttempts.find((a) => Number(a.id) === preferredAttemptId)
    : null;
  if (!attempt) {
    const sharedUid = quizRow.sharedByUserId != null ? String(quizRow.sharedByUserId) : null;
    attempt = quizAttempts.find(
      (a) =>
        Number(a.quizId) === qid &&
        String(a.status || "") === "completed" &&
        (!sharedUid || String(a.userId ?? "") === sharedUid)
    );
  }
  if (!attempt) {
    return res.status(404).json({
      success: false,
      message: "Shared student result not found.",
    });
  }
  return res.status(200).json({
    success: true,
    data: {
      quizId: qid,
      attemptId: attempt.id,
      sharedByUserId: quizRow.sharedByUserId ?? attempt.userId ?? null,
      sharedAt: quizRow.sharedAt || attempt.completedAt || attempt.createdAt || null,
      answers: Array.isArray(attempt.answers) ? attempt.answers : [],
      manualGrades: Array.isArray(manualGradesByAttemptId.get(Number(attempt.id)))
        ? manualGradesByAttemptId.get(Number(attempt.id))
        : [],
    },
  });
});

app.get("/api/quiz/attempts/:attemptId/manual-grading", (req, res) => {
  const attemptId = toNum(req.params.attemptId, NaN);
  if (!Number.isFinite(attemptId)) {
    return res.status(400).json({ success: false, message: "Invalid attempt id." });
  }
  const rows = manualGradesByAttemptId.get(Number(attemptId)) || [];
  return res.status(200).json({
    success: true,
    data: rows,
  });
});

app.post("/api/quiz/attempts/:attemptId/manual-grading", (req, res) => {
  const attemptId = toNum(req.params.attemptId, NaN);
  if (!Number.isFinite(attemptId)) {
    return res.status(400).json({ success: false, message: "Invalid attempt id." });
  }
  const grades = Array.isArray(req.body?.grades) ? req.body.grades : [];
  if (!grades.length) {
    return res.status(400).json({ success: false, message: "grades is required." });
  }
  const prev = Array.isArray(manualGradesByAttemptId.get(Number(attemptId)))
    ? manualGradesByAttemptId.get(Number(attemptId))
    : [];
  const byQid = new Map(prev.map((g) => [String(g?.questionId || ""), g]));
  grades.forEach((g) => {
    const qid = String(g?.questionId ?? "").trim();
    if (!qid) return;
    const scoreNum = Number(g?.score);
    byQid.set(qid, {
      questionId: qid,
      score: Number.isFinite(scoreNum) ? scoreNum : 0,
      feedback: String(g?.feedback ?? "").trim(),
      gradedAt: new Date().toISOString(),
    });
  });
  const rows = Array.from(byQid.values());
  manualGradesByAttemptId.set(Number(attemptId), rows);
  return res.status(200).json({
    success: true,
    data: rows,
  });
});

/**
 * Alias for local dev — matches production GET /api/quiz/result/:attemptId/lecturer (redirect to mock route).
 */
app.get("/api/quiz/result/:attemptId/lecturer", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(307, `/api/quiz/attempts/${req.params.attemptId}/lecturer-review${qs}`);
});

/**
 * Lecturer: full attempt + quiz questions + manual grades for grading UI.
 * GET /api/quiz/attempts/:attemptId/lecturer-review?userId=<lecturerUserId>
 */
app.get("/api/quiz/attempts/:attemptId/lecturer-review", (req, res) => {
  const attemptId = toNum(req.params.attemptId, NaN);
  if (!Number.isFinite(attemptId)) {
    return res.status(400).json({ success: false, message: "Invalid attempt id." });
  }
  const lecturerId = req.query?.userId != null ? String(req.query.userId) : null;
  const attempt = quizAttempts.find((a) => Number(a.id) === attemptId);
  if (!attempt) {
    return res.status(404).json({ success: false, message: "Attempt not found." });
  }
  const quizRow = quizzes.find((q) => Number(q.id) === Number(attempt.quizId));
  if (!quizRow) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  if (lecturerId != null && String(quizRow.createdBy ?? "") !== lecturerId) {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  const questions = Array.isArray(quizRow.questions) ? quizRow.questions : [];
  const manualGrades = Array.isArray(manualGradesByAttemptId.get(Number(attemptId)))
    ? manualGradesByAttemptId.get(Number(attemptId))
    : [];
  const markMap = lecturerCorrectMarksByAttemptId.get(Number(attemptId)) || new Map();
  const questionMarks = Object.fromEntries(markMap);
  return res.status(200).json({
    success: true,
    data: {
      attempt: {
        id: attempt.id,
        quizId: attempt.quizId,
        userId: attempt.userId,
        scorePercent: attempt.scorePercent,
        correctCount: attempt.correctCount,
        totalQuestions: attempt.totalQuestions,
        answers: Array.isArray(attempt.answers) ? attempt.answers : [],
        completedAt: attempt.completedAt || attempt.createdAt,
      },
      quizTitle: quizRow.title || "Quiz",
      questions,
      manualGrades,
      questionMarks,
    },
  });
});

/**
 * Lecturer: set đúng/sai per question (manual override).
 * PATCH /api/quiz/attempts/:attemptId/grade?userId=<lecturerId>
 * Body: { items: [ { questionId, markedCorrect: boolean } ] }
 */
app.patch("/api/quiz/attempts/:attemptId/grade", (req, res) => {
  const attemptId = toNum(req.params.attemptId, NaN);
  if (!Number.isFinite(attemptId)) {
    return res.status(400).json({ success: false, message: "Invalid attempt id." });
  }
  const lecturerId = req.query?.userId != null ? String(req.query.userId) : null;
  const attempt = quizAttempts.find((a) => Number(a.id) === attemptId);
  if (!attempt) {
    return res.status(404).json({ success: false, message: "Attempt not found." });
  }
  const quizRow = quizzes.find((q) => Number(q.id) === Number(attempt.quizId));
  if (!quizRow) {
    return res.status(404).json({ success: false, message: "Quiz not found." });
  }
  if (lecturerId != null && String(quizRow.createdBy ?? "") !== lecturerId) {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  const fromGrades = Array.isArray(req.body?.grades)
    ? req.body.grades.map((g) => ({
        questionId: g?.questionId ?? g?.question_id,
        markedCorrect: g?.isCorrect ?? g?.markedCorrect,
      }))
    : [];
  const items = Array.isArray(req.body?.items) ? req.body.items : fromGrades;
  if (!items.length) {
    return res.status(400).json({ success: false, message: "items or grades array is required." });
  }
  const sub = lecturerCorrectMarksByAttemptId.get(Number(attemptId)) || new Map();
  items.forEach((it) => {
    const qid = String(it?.questionId ?? "").trim();
    if (!qid) return;
    if (Object.prototype.hasOwnProperty.call(it, "markedCorrect")) {
      sub.set(qid, Boolean(it.markedCorrect));
    }
  });
  lecturerCorrectMarksByAttemptId.set(Number(attemptId), sub);
  return res.status(200).json({
    success: true,
    data: {
      attemptId,
      questionMarks: Object.fromEntries(sub),
    },
  });
});

app.get("/api/quizzes/:id/comments", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const rows = quizCommentsByQuizId.get(qid) || [];
  return res.status(200).json({
    success: true,
    data: rows,
  });
});

app.post("/api/quizzes/:id/comments", (req, res) => {
  const qid = toNum(req.params.id, NaN);
  if (!Number.isFinite(qid)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const uid = getBearerUserIdMock(req);
  if (uid == null) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  const text = String(req.body?.text ?? req.body?.body ?? "").trim();
  if (!text) {
    return res.status(400).json({ success: false, message: "Comment cannot be empty." });
  }
  const u = users.find((x) => Number(x.user_id) === Number(uid));
  const comment = {
    id: Date.now(),
    quizId: qid,
    userId: uid,
    author: u?.full_name || "Lecturer",
    role: String(u?.role || "").toUpperCase() === "LECTURER" ? "lecturer" : "student",
    text,
    createdAt: new Date().toISOString(),
  };
  const prev = quizCommentsByQuizId.get(qid) || [];
  prev.push(comment);
  quizCommentsByQuizId.set(qid, prev);
  return res.status(201).json({
    success: true,
    data: comment,
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
       , media_url, explanation
       FROM question_bank
       WHERE lecturer_user_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [uid]
    );

    const data = rows.map((r) => ({
      id: Number(r.id),
      question: String(r.question_text || ""),
      mediaUrl: r.media_url != null ? String(r.media_url) : "",
      type: String(r.question_type || "multiple-choice"),
      topic: String(r.topic || "General"),
      difficulty: String(r.difficulty || "medium"),
      options: parseOptionsJson(r.options_json),
      correctAnswer: r.correct_answer != null ? String(r.correct_answer) : "",
      quizId: r.quiz_id != null ? Number(r.quiz_id) : undefined,
      quizTitle: r.quiz_title != null ? String(r.quiz_title) : undefined,
      explanation: r.explanation != null && String(r.explanation).trim() ? String(r.explanation).trim() : undefined,
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
       (lecturer_user_id, question_text, media_url, question_type, topic, difficulty, options_json, correct_answer, quiz_id, quiz_title, explanation)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, NULL, NULL, ?)`,
      [
        uid,
        payload.question,
        payload.mediaUrl || null,
        payload.type,
        payload.topic,
        payload.difficulty,
        JSON.stringify(payload.options),
        payload.correctAnswer || null,
        payload.explanation && String(payload.explanation).trim() ? String(payload.explanation).trim() : null,
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
       SET question_text = ?, media_url = ?, question_type = ?, topic = ?, difficulty = ?, options_json = CAST(? AS JSON), correct_answer = ?, explanation = ?
       WHERE id = ? AND lecturer_user_id = ?`,
      [
        payload.question,
        payload.mediaUrl || null,
        payload.type,
        payload.topic,
        payload.difficulty,
        JSON.stringify(payload.options),
        payload.correctAnswer || null,
        payload.explanation && String(payload.explanation).trim() ? String(payload.explanation).trim() : null,
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
  const answersLen = Array.isArray(answers) ? answers.length : 0;
  console.log("[QUIZ_ATTEMPT]", {
    phase: String(phase || "complete"),
    quizId: qid,
    userId: userId ?? null,
    answersLen,
  });

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

  const questions = Array.isArray(quizRow.questions) ? quizRow.questions : [];
  const questionsCount = Number(quizRow.questionsCount) || questions.length || 0;

  const normalizedAnswers = Array.isArray(answers)
    ? answers.map((a, idx) => {
        const qidRaw = a?.questionId ?? a?.question_id ?? `q-${idx + 1}`;
        const qidStr = String(qidRaw);
        const questionRow =
          questions.find((q, qIdx) => String(q?.id || `q-${qIdx + 1}`) === qidStr) ||
          questions[idx] ||
          null;

        const selectedRaw =
          a?.selectedAnswer ?? a?.selected_answer ?? a?.userAnswer ?? a?.user_answer;
        const selectedTextRaw =
          typeof selectedRaw === "string"
            ? selectedRaw.trim()
            : selectedRaw != null
              ? String(selectedRaw)
              : "";
        const questionType = String(questionRow?.type || questionRow?.question_type || "").trim().toLowerCase();
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

        const expectedAnswerRaw =
          String(questionRow?.correct_answer ?? questionRow?.correctAnswer ?? correctRaw ?? "").trim();
        const isShortAnswer = questionType === "short-answer";
        const expectedShortAnswers = isShortAnswer ? parseExpectedShortAnswers(expectedAnswerRaw) : [];
        const normalizedSelectedText = normalizeAnswerText(selectedTextRaw);
        const shortAnswerCorrect =
          isShortAnswer &&
          normalizedSelectedText.length > 0 &&
          expectedShortAnswers.some((ans) => ans === normalizedSelectedText);
        const objectiveCorrect = selectedLetter && correctLetter ? selectedLetter === correctLetter : false;

        return {
          questionId: qidStr,
          question_type: questionType || "multiple-choice",
          question_text: String(questionRow?.question || `Question ${idx + 1}`),
          selectedAnswer: selectedLetter,
          selected_answer:
            optionTextFromQuestion(questionRow, selectedLetter) || selectedTextRaw,
          correctAnswer: correctLetter,
          correct_answer:
            optionTextFromQuestion(questionRow, correctLetter) || expectedAnswerRaw,
          options: questionRow?.options
            ? [questionRow.options.A, questionRow.options.B, questionRow.options.C, questionRow.options.D].filter(Boolean)
            : [],
          is_correct: isShortAnswer ? shortAnswerCorrect : objectiveCorrect,
        };
      })
    : [];

  const correctCount = normalizedAnswers.filter((a) => Boolean(a?.is_correct)).length;
  const scorePercent = questionsCount > 0 ? Math.round((correctCount / questionsCount) * 100) : 0;
  const finalScore = correctCount;

  const attemptId = Date.now();
  quizAttempts.unshift({
    id: attemptId,
    quizId: qid,
    userId: userId ?? null,
    score: finalScore,
    scorePercent,
    totalQuestions: questionsCount,
    correctCount,
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
    data: {
      attemptId,
      score: finalScore,
      scorePercent,
      correctCount,
      totalQuestions: questionsCount,
    },
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
      /** Full quiz question snapshots (includes explanation, correct options, etc.). */
      questions: Array.isArray(quizRow?.questions) ? quizRow.questions : [],
      completed_at: attempt.completedAt || attempt.createdAt,
    },
  });
});

app.get("/api/quiz/result/latest/:quizId", (req, res) => {
  const quizId = toNum(req.params.quizId, NaN);
  if (!Number.isFinite(quizId)) {
    return res.status(400).json({ success: false, message: "Invalid quiz id." });
  }
  const uid = req.query?.userId != null ? String(req.query.userId) : null;
  const attempt = quizAttempts.find((a) => {
    if (Number(a.quizId) !== quizId) return false;
    if (String(a.status || "") !== "completed") return false;
    if (uid && String(a.userId ?? "") !== uid) return false;
    return true;
  });
  if (!attempt) {
    return res.status(404).json({ success: false, message: "Latest result not found." });
  }
  const quizRow = quizzes.find((q) => q.id === Number(attempt.quizId));
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
      questions: Array.isArray(quizRow?.questions) ? quizRow.questions : [],
      completed_at: attempt.completedAt || attempt.createdAt,
    },
  });
});

/**
 * GET /api/leaderboard
 * Aggregate quizAttempts by userId and return ranked list.
 * Query params: limit (default 50), userId (optional – to identify current user)
 */
app.get("/api/leaderboard", (req, res) => {
  const limit = Math.min(Math.max(toNum(req.query.limit, 50), 1), 200);
  const requestingUserId = req.query.userId != null ? String(req.query.userId) : null;

  // Aggregate completed attempts by userId
  const map = new Map();
  for (const a of quizAttempts) {
    if (a.status !== "completed" || a.scorePercent == null) continue;
    const uid = String(a.userId ?? "__anon__");
    const g = map.get(uid) || { userId: uid, scores: [], completedAt: [] };
    g.scores.push(Number(a.scorePercent));
    if (a.completedAt) g.completedAt.push(a.completedAt);
    map.set(uid, g);
  }

  // Build ranked array
  const rows = Array.from(map.values())
    .map((g) => {
      const avg = Math.round(g.scores.reduce((s, x) => s + x, 0) / g.scores.length);
      const best = Math.max(...g.scores);
      // Lookup user name
      const userRecord = users.find((u) => String(u.user_id) === g.userId);
      return {
        userId: g.userId,
        name: userRecord?.full_name || userRecord?.name || "Anonymous",
        email: userRecord?.email || null,
        avgScore: avg,
        totalAttempts: g.scores.length,
        bestScore: best,
      };
    })
    .sort((a, b) => b.avgScore - a.avgScore || b.totalAttempts - a.totalAttempts);

  // Assign rank
  rows.forEach((r, i) => { r.rank = i + 1; });

  const limited = rows.slice(0, limit);

  // myRank for requesting user
  let myRank = null;
  if (requestingUserId) {
    const found = rows.find((r) => String(r.userId) === requestingUserId);
    if (found) {
      myRank = {
        rank: found.rank,
        avgScore: found.avgScore,
        totalAttempts: found.totalAttempts,
        bestScore: found.bestScore,
      };
    }
  }

  return res.status(200).json({
    success: true,
    total: rows.length,
    data: limited,
    myRank,
  });
});

/** In-memory chat sessions for mock `/api/chat/ask` (dev only). */
const chatSessions = new Map();
let chatSessionSeq = 1;
let chatMessageSeq = 1;

/**
 * POST /api/chat/ask
 * Body: question, s3Key?, documentId?, sessionId?, pdfPage?, pdfTotalPages?
 * Real backend should load chunks for s3Key/documentId and bias retrieval toward pdfPage when set.
 */
app.post("/api/chat/ask", (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    return res.status(400).json({
      success: false,
      message: "Missing question.",
    });
  }

  const s3Key = String(req.body?.s3Key ?? req.body?.s3_key ?? "").trim();
  const documentIdRaw = req.body?.documentId ?? req.body?.document_id;
  const documentId =
    documentIdRaw != null && String(documentIdRaw).trim() !== ""
      ? Number(documentIdRaw)
      : null;
  const sessionIdIn =
    req.body?.sessionId != null ? Number(req.body.sessionId) : null;
  const pdfPage = req.body?.pdfPage != null ? Number(req.body.pdfPage) : null;
  const pdfTotalPages =
    req.body?.pdfTotalPages != null ? Number(req.body.pdfTotalPages) : null;

  let sessionId = sessionIdIn;
  if (!sessionId || !chatSessions.has(sessionId)) {
    sessionId = chatSessionSeq++;
    chatSessions.set(sessionId, { createdAt: Date.now(), turns: 0 });
  }
  const sess = chatSessions.get(sessionId);
  sess.turns = (sess.turns || 0) + 1;

  const docHint =
    documentId != null && Number.isFinite(documentId)
      ? `document #${documentId}`
      : s3Key
        ? `file “${s3Key.split("/").pop() || s3Key}”`
        : "the attached material";
  const pageHint =
    pdfPage != null &&
    pdfTotalPages != null &&
    Number.isFinite(pdfPage) &&
    Number.isFinite(pdfTotalPages) &&
    pdfTotalPages > 0 &&
    pdfPage >= 1 &&
    pdfPage <= pdfTotalPages
      ? ` You indicated you are viewing **page ${pdfPage} of ${pdfTotalPages}** — a production backend would prioritize snippets from that section.`
      : "";

  const answer = `[Mock server] I received your question about ${docHint}.${pageHint}

This dev server does not call a real model or load file text from storage. Wire \`POST /api/chat/ask\` on your API to RAG/indexed chunks using \`s3Key\` / \`documentId\`, and optionally \`pdfPage\` + \`pdfTotalPages\` for page-aware retrieval.

Your question: “${question.slice(0, 500)}${question.length > 500 ? "…" : ""}”`;

  const messageId = chatMessageSeq++;

  return res.status(200).json({
    success: true,
    data: {
      sessionId,
      messageId,
      answer,
      citations: s3Key
        ? [
            {
              citation_id: 1,
              excerpt: `Context key: ${s3Key}`,
              segment_id: 0,
            },
          ]
        : [],
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