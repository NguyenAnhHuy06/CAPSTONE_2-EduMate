// server.js - EduMate backend
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { fileTypeFromBuffer } = require("file-type");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { generateQuizWithAI } = require("./generateQuizWithAI");
const { getQuiz } = require("./quizService");
const s3 = require("./s3Upload");
const db = require("./db");
const { ensureIndexedForQuiz } = require("./documentPipeline");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Client-facing copy only — never include stack traces, SQL, or infra names. */
const MSG_UNAVAILABLE = "This feature is temporarily unavailable.";
const MSG_TRY_AGAIN = "This action could not be completed. Please try again later.";
const MSG_DATA_UNAVAILABLE = "Data is temporarily unavailable.";
const S3_LECTURE_QUIZ_PREFIX =
  (process.env.S3_LECTURE_QUIZ_PREFIX && String(process.env.S3_LECTURE_QUIZ_PREFIX).trim()) ||
  "lecture quiz/";

app.use(helmet());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: MSG_TRY_AGAIN },
  })
);

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

const allowedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
]);

const allowedMimeTypes = new Set([
  "application/pdf", // PDF
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-word.document.macroenabled.12", // .docm
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template", // .dotx
  "application/vnd.ms-word.template.macroenabled.12", // .dotm
  "application/octet-stream", // Some clients send a generic binary MIME type
]);

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = (file.mimetype || "").toLowerCase();

  const isExtensionAllowed = allowedExtensions.has(extension);

  const isMimeAllowed = allowedMimeTypes.has(mimeType);


  if (!isExtensionAllowed || !isMimeAllowed) {
    return cb(
      new Error("Only PDF or Word files are allowed (.doc, .docx, .docm, .dotx, .dotm)")
    );
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

function isEmpty(value) {
  return !value || !String(value).trim();
}

function normalizeTags(tagsText) {
  if (!tagsText) {
    return [];
  }

  return tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function optionalBodyNumber(value) {
  if (value == null || !String(value).trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Edumate backend is running.",
  });
});

// --- NEW MODULAR FEATURES ---
const chatRoutes = require("./src/routes/chatRoutes");
const flashcardRoutes = require("./src/routes/flashcardRoutes");
const adminRoutes = require("./src/routes/adminRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");
const quizRoutes = require("./src/routes/quizRoutes"); // For Leaderboard and modular quiz controllers
const activityLog = require("./src/middleware/activityLog");

// Mount modular features
app.use("/api/chat", chatRoutes);
app.use("/api/flashcards", flashcardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/quiz-v2", quizRoutes); // Modular version alongside legacy
// --- END MODULAR FEATURES ---


function authJwtSecret() {
  const s = process.env.JWT_SECRET && String(process.env.JWT_SECRET).trim();
  return s || "dev-only-secret-change-me";
}

const otpStore = new Map();
const execFileAsync = promisify(execFile);

function normalizeEmail(emailLike) {
  return String(emailLike || "").trim().toLowerCase();
}

function isAllowedStudentEmail(email) {
  return /@dtu\.edu\.vn$/i.test(String(email || "").trim());
}

function otpExpiryMs() {
  const mins = Number(process.env.OTP_EXPIRES_MINUTES || 5);
  if (!Number.isFinite(mins) || mins <= 0) return 5 * 60 * 1000;
  return mins * 60 * 1000;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail({ toEmail, code, purpose }) {
  const scriptPath =
    (process.env.OTP_PYTHON_SCRIPT && String(process.env.OTP_PYTHON_SCRIPT).trim()) ||
    path.join(__dirname, "otp_email_service.py");
  const ttl = Math.max(60, Math.floor(otpExpiryMs() / 1000));
  const purposeValue = String(purpose || "login").trim().toLowerCase();
  const bins = [
    (process.env.OTP_PYTHON_BIN && String(process.env.OTP_PYTHON_BIN).trim()) || "python",
    "py",
  ].filter(Boolean);

  let lastErr = null;
  for (const bin of bins) {
    try {
      const args =
        bin === "py"
          ? [scriptPath, "--email", toEmail, "--code", code, "--ttl", String(ttl), "--purpose", purposeValue]
          : [scriptPath, "--email", toEmail, "--code", code, "--ttl", String(ttl), "--purpose", purposeValue];
      const { stdout } = await execFileAsync(bin, args, {
        cwd: __dirname,
        timeout: 30000,
      });
      const out = String(stdout || "").trim();
      if (out) {
        const parsed = JSON.parse(out);
        if (parsed.status !== "success") {
          throw new Error(parsed.error || "OTP send failed.");
        }
      }
      return true;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("OTP delivery failed.");
}

function mapUserForClient(row) {
  if (!row) return null;
  const userId = Number(row.user_id);
  return {
    user_id: userId,
    name: String(row.display_name || row.name || "").trim() || "User",
    email: String(row.email || "").trim(),
    role: String(row.role || "STUDENT").trim().toUpperCase(),
  };
}

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const name = String(req.body.name || req.body.full_name || "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "").trim();
    const role = String(req.body.role ?? "STUDENT").trim().toUpperCase();
    const userCode = req.body.user_code ?? req.body.userCode ?? null;

    if (!name || !email || password.length < 8) {
      return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
    }
    if (!isAllowedStudentEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Registration email must end with @dtu.edu.vn.",
      });
    }

    const existing = await db.findUserByEmail(email);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Email has already been used.",
      });
    }

    const encryptedPassword = await bcrypt.hash(password, 10);
    await db.createUser({ name, email, password: encryptedPassword, role, userCode });
    const code = generateOtpCode();
    const expiresAt = Date.now() + otpExpiryMs();
    otpStore.set(email, { code, expiresAt, purpose: "register" });
    await sendOtpEmail({ toEmail: email, code, purpose: "register" });

    return res.status(201).json({
      success: true,
      data: { otpRequired: true, purpose: "register" },
      message: "Registration completed. OTP has been sent to your email.",
    });
  } catch (err) {
    console.error("[api/auth/register]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const purpose = String(req.body.purpose || "login").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
    }
    if (!isAllowedStudentEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "OTP email must end with @dtu.edu.vn.",
      });
    }
    const code = generateOtpCode();
    const expiresAt = Date.now() + otpExpiryMs();
    otpStore.set(email, { code, expiresAt, purpose });
    await sendOtpEmail({ toEmail: email, code, purpose });
    return res.status(200).json({
      success: true,
      message: "OTP has been sent.",
      data: { expiresInSeconds: Math.floor((expiresAt - Date.now()) / 1000) },
    });
  } catch (err) {
    console.error("[api/auth/send-otp]", err);
    return res.status(400).json({
      success: false,
      message: "Could not send OTP email. Please verify SMTP configuration.",
    });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.otp ?? req.body.code ?? "").trim();
    const purposeRaw = String(req.body.purpose || "").trim().toLowerCase();
    if (!email || !code) {
      return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
    }
    const saved = otpStore.get(email);
    const purposeOk = !purposeRaw || saved?.purpose === purposeRaw;
    if (!saved || !purposeOk || Date.now() > saved.expiresAt || saved.code !== code) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
    }
    otpStore.delete(email);
    return res.status(200).json({
      success: true,
      message: "Verification completed.",
      data: { verified: true, purpose: saved.purpose || "unknown" },
    });
  } catch (err) {
    console.error("[api/auth/verify-otp]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "").trim();
    if (!email || !password) {
      return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
    }
    const userRow = await db.findUserByEmail(email);
    if (!userRow) {
      return res.status(401).json({ success: false, message: MSG_TRY_AGAIN });
    }
    const stored = String(userRow.password || "");
    let ok = false;
    if (stored) {
      if (stored.startsWith("$2a$") || stored.startsWith("$2b$") || stored.startsWith("$2y$")) {
        ok = await bcrypt.compare(password, stored).catch(() => false);
      } else {
        // Legacy plaintext: allow once, then upgrade to bcrypt.
        ok = stored === password;
        if (ok) {
          const upgraded = await bcrypt.hash(password, 10);
          await db.updateUserPassword(userRow.user_id, upgraded);
        }
      }
    }
    if (!ok) {
      return res.status(401).json({ success: false, message: "Incorrect password." });
    }
    const user = mapUserForClient(userRow);
    const token = jwt.sign({ sub: user.user_id, role: user.role }, authJwtSecret(), {
      expiresIn: "7d",
    });
    return res.status(200).json({ success: true, token, user });
  } catch (err) {
    console.error("[api/auth/login]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

function pickDocumentTextFromBody(body) {
  if (!body || typeof body !== "object") return "";
  const candidates = [
    body.content,
    body.documentText,
    body.text,
    body.studyMaterial,
    body.material,
    body.documentContent,
    body.document,
    body.body,
    body.prompt,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c);
  }
  return "";
}

const S3_LIST_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
]);

function isAllowedQuizExt(filename) {
  return S3_LIST_EXTENSIONS.has(path.extname(filename || "").toLowerCase());
}

function publishedQuizPrefix() {
  const p = process.env.S3_PUBLISHED_QUIZ_PREFIX;
  if (p && String(p).trim()) {
    const s = String(p).trim();
    return s.endsWith("/") ? s : `${s}/`;
  }
  return "lecture-quiz/";
}

function buildPublishedQuizKey(quizId) {
  return `${publishedQuizPrefix()}quiz-${Number(quizId)}.json`;
}

async function savePublishedQuizToS3(quizRow) {
  if (!s3.isS3Configured()) return null;
  const qid = Number(quizRow?.quiz_id ?? quizRow?.quizId);
  if (!Number.isFinite(qid) || qid <= 0) return null;
  const qs = Array.isArray(quizRow?.questions) ? quizRow.questions : [];
  const payload = {
    quizId: qid,
    title: String(quizRow?.title || "Published Quiz"),
    courseCode: String(quizRow?.course_code || quizRow?.courseCode || "DOC"),
    questionCount: qs.length,
    attemptsCount: Number(quizRow?.attempts_count || 0),
    creatorName: String(quizRow?.creator_name || quizRow?.creatorName || "Lecturer"),
    publishedAt: quizRow?.published_at || quizRow?.publishedAt || new Date().toISOString(),
    createdAt: quizRow?.created_at || quizRow?.createdAt || new Date().toISOString(),
    // Keep quiz payload for future consumption if needed by FE.
    questions: qs,
  };
  const key = buildPublishedQuizKey(qid);
  await s3.putJsonObject({ key, value: payload });
  return key;
}

async function listPublishedQuizzesFromS3(limit = 20) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (!s3.isS3Configured()) return [];
  const objects = await s3.listDocuments({ prefix: publishedQuizPrefix(), maxKeys: lim * 5 });
  const prefix = publishedQuizPrefix();
  const quizJsonObjects = objects
    .filter((o) => String(o?.key || "").startsWith(prefix) && /\.json$/i.test(String(o?.key || "")))
    .sort((a, b) => {
      const ta = new Date(a?.lastModified || 0).getTime();
      const tb = new Date(b?.lastModified || 0).getTime();
      return tb - ta;
    })
    .slice(0, lim);

  const out = [];
  for (const obj of quizJsonObjects) {
    try {
      const got = await s3.getObjectBuffer(obj.key);
      const raw = String(got?.buffer || "").trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      out.push({
        quizId: Number(parsed?.quizId || 0),
        title: String(parsed?.title || "Published Quiz"),
        courseCode: String(parsed?.courseCode || "DOC"),
        questionCount: Number(parsed?.questionCount || 0),
        attemptsCount: Number(parsed?.attemptsCount || 0),
        creatorName: String(parsed?.creatorName || "Lecturer"),
        publishedAt: parsed?.publishedAt || obj?.lastModified || null,
        createdAt: parsed?.createdAt || obj?.lastModified || null,
      });
    } catch (e) {
      console.warn("[published-quiz] skip invalid object:", obj?.key, e?.message || "");
    }
  }
  return out.filter((q) => Number.isFinite(q.quizId) && q.quizId > 0);
}

async function getPublishedQuizDetailFromS3(quizId) {
  const qid = Number(quizId);
  if (!Number.isFinite(qid) || qid <= 0 || !s3.isS3Configured()) return null;
  const key = buildPublishedQuizKey(qid);
  try {
    const got = await s3.getObjectBuffer(key);
    const raw = String(got?.buffer || "").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    return {
      quiz_id: qid,
      title: String(parsed?.title || "Published Quiz"),
      is_published: 1,
      course_code: String(parsed?.courseCode || "DOC"),
      creator_name: String(parsed?.creatorName || "Lecturer"),
      created_at: parsed?.createdAt || parsed?.publishedAt || null,
      published_at: parsed?.publishedAt || parsed?.createdAt || null,
      questions: questions.map((q, idx) => ({
        question_id: Number(q?.question_id || q?.id || idx + 1),
        question_text: String(q?.question_text || q?.question || ""),
        options: Array.isArray(q?.options) ? q.options : [],
        correct_answer: q?.correct_answer ?? q?.answer ?? "",
      })),
    };
  } catch (_) {
    return null;
  }
}

async function listS3DocsForQuiz() {
  const timeoutMs = Number(process.env.S3_LIST_TIMEOUT_MS || 4500);
  const maxKeys = Math.min(
    Math.max(Number(process.env.S3_LIST_MAX_KEYS || 5000), 100),
    50000
  );
  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("S3 list timeout")), timeoutMs)
      ),
    ]);

  try {
    // List entire bucket (empty prefix).
    const rows = await withTimeout(s3.listDocuments({ prefix: "", maxKeys }));
    if (!Array.isArray(rows)) return [];
    const filtered = rows.filter((o) => isAllowedQuizExt(o.key));
    return filtered;
  } catch (err) {
    console.warn("[S3 LIST] fallback empty:", err.message);
    return [];
  }
}

/**
 * All PDF/Word objects in the S3 bucket, merged with MySQL metadata and chunk counts.
 */
async function buildDocumentsForQuizList() {
  if (!s3.isS3Configured()) {
    throw new Error("S3 is not configured.");
  }
  const filtered = await listS3DocsForQuiz();
  const keys = filtered.map((o) => o.key);

  let metaMap = new Map();
  if (db.isConfigured()) {
    if (keys.length) metaMap = await db.getMetaMapForS3Keys(keys);
  }

  let attemptByKey = new Map();
  if (db.isConfigured() && keys.length) {
    try {
      attemptByKey = await db.countAttemptsBySourceFileUrls(keys);
    } catch (e) {
      console.warn("[for-quiz] attempt counts:", e.message);
    }
  }

  const merged = filtered.map((o) => {
    const m = metaMap.get(o.key);
    const ext = path.extname(o.key).replace(/^\./, "").toUpperCase() || "FILE";
    const chunks = m != null ? Number(m.chunk_count || 0) : 0;
    const estimatedQuestions = Math.min(
      30,
      Math.max(5, chunks > 0 ? 5 + Math.floor(chunks / 4) : 5)
    );
    const courseCode = (m?.course_code && String(m.course_code).trim()) || ext;
    return {
      storage: "s3",
      s3Key: o.key,
      fileName: path.basename(o.key),
      title: m?.title || path.basename(o.key),
      subjectCode: courseCode,
      courseCode,
      subjectName: "",
      category: "",
      courseId: m?.course_id ?? null,
      documentId: m?.document_id ?? null,
      size: o.size,
      lastModified: o.lastModified || m?.created_at,
      fileUrl: s3.buildObjectPublicUrl(o.key),
      inDatabase: !!m,
      chunkCount: chunks,
      estimatedQuestions,
      attemptsCount: Number(attemptByKey.get(o.key) || 0),
    };
  });

  merged.sort((a, b) => {
    const ta = new Date(a.lastModified || 0).getTime();
    const tb = new Date(b.lastModified || 0).getTime();
    return tb - ta;
  });
  return merged;
}

app.get("/api/documents/for-quiz", async (req, res) => {
  try {
    const data = await buildDocumentsForQuizList();
    return res.status(200).json({ success: true, data });
  } catch (err) {
    // Do not expose internal errors to the client when loading the list.
    console.error(err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Document list is temporarily unavailable.",
    });
  }
});

app.get("/api/progress/summary", async (req, res) => {
  try {
    const emptyProgressPayload = () => ({
      overall: {
        progressPercent: 0,
        completedMaterials: 0,
        totalMaterials: 0,
        averageScorePercent: null,
        studyHoursLabel: null,
      },
      courses: [],
      streak: { currentDays: 0, longestDays: 0 },
    });

    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        data: emptyProgressPayload(),
        message: "Learning progress is temporarily unavailable.",
      });
    }
    const rawUid =
      req.query.userId ??
      req.query.user_id ??
      (process.env.DEFAULT_QUIZ_USER_ID != null && String(process.env.DEFAULT_QUIZ_USER_ID).trim() !== ""
        ? process.env.DEFAULT_QUIZ_USER_ID
        : null);
    const userId = rawUid != null ? String(rawUid).trim() : "";
    if (!userId) {
      return res.status(200).json({
        success: true,
        data: emptyProgressPayload(),
        message: "Learning progress is temporarily unavailable.",
      });
    }
    const data = await db.getLearningProgressSummary(userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/progress/summary]", err);
    return res.status(200).json({
      success: true,
      data: {
        overall: {
          progressPercent: 0,
          completedMaterials: 0,
          totalMaterials: 0,
          averageScorePercent: null,
          studyHoursLabel: null,
        },
        courses: [],
        streak: { currentDays: 0, longestDays: 0 },
      },
      message: "Learning progress is temporarily unavailable.",
    });
  }
});

app.get("/api/quizzes/history", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        data: [],
        message: MSG_DATA_UNAVAILABLE,
      });
    }
    const limit = req.query.limit;
    const userId = req.query.userId ?? req.query.user_id;
    const data = await db.listQuizHistory(limit, userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/quizzes/history]", err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Quiz history is temporarily unavailable.",
    });
  }
});

app.get("/api/quiz/completed", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: [], message: MSG_DATA_UNAVAILABLE });
    }
    const limit = req.query.limit;
    const userId = req.query.userId ?? req.query.user_id;
    const data = await db.listCompletedAttempts(limit, userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/quiz/completed]", err);
    return res.status(200).json({ success: true, data: [], message: MSG_DATA_UNAVAILABLE });
  }
});

app.get("/api/quiz/result/:attemptId", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: null, message: MSG_DATA_UNAVAILABLE });
    }
    const userId = req.query.userId ?? req.query.user_id;
    const data = await db.getAttemptResultDetail(req.params.attemptId, userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/quiz/result/:attemptId]", err);
    return res.status(200).json({ success: true, data: null, message: MSG_DATA_UNAVAILABLE });
  }
});

app.post("/api/quiz/attempts", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: MSG_UNAVAILABLE,
      });
    }
    const quizId = req.body.quizId ?? req.body.quiz_id;

    const defaultUserIdRaw = process.env.DEFAULT_QUIZ_USER_ID;
    const defaultUserId = defaultUserIdRaw ? Number(defaultUserIdRaw) : null;

    const userId =
      req.body.userId ??
      req.body.user_id ??
      (Number.isFinite(defaultUserId) ? defaultUserId : null);
    const phase = String(req.body.phase ?? req.body.stage ?? "").toLowerCase();

    if (phase === "start") {
      await db.startQuizAttempt({ quizId, userId });
      return res.status(201).json({ success: true, message: "Attempt start recorded." });
    }

    const score = req.body.score ?? req.body.correctCount ?? req.body.correct;
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
    const timeTakenSeconds = req.body.timeTaken ?? req.body.time_taken_seconds ?? null;
    if (answers.length) {
      await db.finishQuizAttemptWithAnswers({
        quizId,
        userId,
        score,
        answers,
        timeTakenSeconds,
        completedAt: req.body.completedAt,
      });
    } else {
      await db.finishQuizAttempt({
        quizId,
        userId,
        score,
        timeTakenSeconds,
        completedAt: req.body.completedAt,
      });
    }
    return res.status(201).json({ success: true, message: "Attempt result saved." });
  } catch (err) {
    console.error("[api/quiz/attempts]", err);
    return res.status(400).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
});

app.get("/api/s3/documents", async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(503).json({
        success: false,
        message: MSG_UNAVAILABLE,
      });
    }
    const rows = await listS3DocsForQuiz();
    const data = rows
      .map((o) => ({
        key: o.key,
        fileName: path.basename(o.key),
        size: o.size,
        lastModified: o.lastModified,
        url: s3.buildObjectPublicUrl(o.key),
      }))
      .sort((a, b) => {
        const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return tb - ta;
      });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    // Do not expose internal errors to the client when loading the list.
    console.error(err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "S3 list is temporarily unavailable.",
    });
  }
});

function mapMysqlDocToRecent(row) {
  return {
    id: row.document_id,
    title: row.title,
    s3Key: row.file_url,
    courseId: row.course_id,
    uploaderId: row.uploader_id,
    uploadedAt: row.created_at,
    chunkCount: Number(row.chunk_count || 0),
    downloads: 0,
  };
}

async function handleQuizGenerate(req, res) {
  try {
    const s3Key =
      req.body.s3Key != null && String(req.body.s3Key).trim()
        ? String(req.body.s3Key).trim()
        : "";
    const reindex =
      req.body.reindex === true ||
      req.body.reindex === "true" ||
      req.body.reindex === 1;

    if (!s3Key) {
      return res.status(400).json({
        success: false,
        message: "Please provide a document reference.",
      });
    }
    if (!s3.isS3Configured()) {
      return res.status(503).json({
        success: false,
        message: MSG_UNAVAILABLE,
      });
    }
    if (!db.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: MSG_UNAVAILABLE,
      });
    }

    try {
      const idx = await ensureIndexedForQuiz(s3Key, { reindex });
      req._quizIndexMeta = idx;
    } catch (e) {
      console.error("[ensureIndexedForQuiz]", e);
      return res.status(400).json({
        success: false,
        message: MSG_TRY_AGAIN,
      });
    }

    const language = req.body.language ?? "Vietnamese";
    const { questions: rawQuiz, targetCount } = await generateQuizWithAI({
      s3Key,
      query: req.body.query ?? req.body.topic ?? req.body.keyword,
      numQuestions: req.body.numQuestions ?? req.body.num_questions,
      languageHint: language,
    });
    const history = req.body.history ?? req.body.userHistory ?? [];
    const quiz = getQuiz(rawQuiz, history, targetCount);

    const payload = { quiz };
    if (req._quizIndexMeta) {
      payload.indexMeta = {
        reindexed: !req._quizIndexMeta.skipped,
        chunkCount: req._quizIndexMeta.chunkCount,
      };
    }

    const wantPersist =
      req.body.persist === true ||
      req.body.persist === "true" ||
      req.body.persist === 1 ||
      req.body.save === true ||
      req.body.save === "true";
    if (wantPersist) {
      if (!db.isConfigured()) {
        return res.status(503).json({
          success: false,
          message: MSG_TRY_AGAIN,
        });
      }
      const quizTitle =
        String(req.body.quizTitle || req.body.title || "").trim() || "AI-generated quiz";
      const courseId = req.body.courseId ?? req.body.course_id;
      const createdBy = req.body.createdBy ?? req.body.created_by ?? req.body.userId;
      const idxMeta = req._quizIndexMeta || {};
      const documentId =
        idxMeta.documentId != null
          ? idxMeta.documentId
          : await db.getDocumentIdByS3Key(s3Key);
      const quizId = await db.saveQuizWithQuestions({
        title: quizTitle,
        courseId,
        createdBy,
        questions: quiz,
        sourceFileUrl: s3Key,
        documentId,
      });
      payload.quizId = quizId;
      return res.status(201).json({ success: true, data: payload });
    }

    return res.status(200).json({ success: true, data: payload });
  } catch (err) {
    const status = err.status ?? err.statusCode;
    const code = err.code ?? err.error?.code;
    const msg = String(err.message || "").toLowerCase();
    console.error(err);

    if (status === 401 || code === "invalid_api_key" || msg.includes("api key")) {
      return res.status(502).json({
        success: false,
        message: MSG_TRY_AGAIN,
      });
    }
    if (msg.includes("insufficient_quota") || msg.includes("quota")) {
      return res.status(402).json({
        success: false,
        message: MSG_TRY_AGAIN,
      });
    }
    if (status === 429 || code === "rate_limit_exceeded" || msg.includes("rate limit")) {
      return res.status(429).json({
        success: false,
        message: MSG_TRY_AGAIN,
      });
    }
    return res.status(500).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
}

app.post("/api/quizzes/generate", handleQuizGenerate);
app.post("/api/quiz/generate", handleQuizGenerate);

app.get("/api/quizzes/published", async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(200).json({
        success: true,
        data: [],
        message: MSG_DATA_UNAVAILABLE,
      });
    }
    const limit = req.query.limit;
    const data = await listPublishedQuizzesFromS3(limit);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/quizzes/published]", err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Published quiz list is temporarily unavailable.",
    });
  }
});

app.patch("/api/quizzes/:id", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const quizId = req.params.id;
    const userId = req.body.userId ?? req.body.user_id;
    const ok = await db.canUserManageQuiz(quizId, userId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to edit this quiz.",
      });
    }
    if (req.body.title != null && String(req.body.title).trim()) {
      await db.updateQuizTitle(quizId, req.body.title);
    }
    if (Array.isArray(req.body.questions)) {
      await db.replaceQuizQuestions(quizId, req.body.questions);
    }
    const row = await db.getQuizWithQuestions(quizId);
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error("[api/quizzes PATCH]", err);
    return res.status(400).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
});

app.post("/api/quizzes/:id/publish", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const quizId = req.params.id;
    const userId = req.body.userId ?? req.body.user_id;
    const ok = await db.canUserManageQuiz(quizId, userId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to publish this quiz.",
      });
    }
    await db.setQuizPublished(quizId, true);
    const row = await db.getQuizWithQuestions(quizId);
    try {
      await savePublishedQuizToS3(row);
    } catch (e) {
      console.error("[publish->s3]", e);
    }
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error("[api/quizzes/:id/publish]", err);
    return res.status(400).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
});

app.get("/api/quizzes/:id", async (req, res) => {
  try {
    let row = null;
    if (db.isConfigured()) {
      row = await db.getQuizWithQuestions(req.params.id);
    }
    // Fallback to S3-published quiz for student consumption.
    if (!row) {
      row = await getPublishedQuizDetailFromS3(req.params.id);
    }
    if (!row) {
      return res.status(404).json({ success: false, message: "Quiz not found." });
    }
    const viewerId =
      req.query.userId ?? req.query.user_id ?? req.query.viewerUserId ?? req.query.viewer_user_id;
    const canManage = db.isConfigured()
      ? await db.canUserManageQuiz(req.params.id, viewerId)
      : false;
    if (!db.quizRowIsPublished(row) && !canManage) {
      return res.status(404).json({
        success: false,
        message: "Quiz is not published or does not exist.",
      });
    }
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error("[api/quizzes/:id]", err);
    return res.status(500).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
});

app.post(
  "/api/documents/upload",
  upload.single("documentFile"),
  async (req, res) => {
    const {
      title,
      category,
      subjectCode,
      subjectName,
      tags,
      description = "",
      courseId,
      uploaderId,
    } = req.body;

    try {
      if (!s3.isS3Configured()) {
        return res.status(503).json({
          success: false,
          message: MSG_UNAVAILABLE,
        });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          message: "No document file was selected.",
        });
      }
      const detectedType = await fileTypeFromBuffer(req.file.buffer);

      if (!detectedType || !allowedMimeTypes.has(detectedType.mime)) {
        return res.status(400).json({
          success: false,
          message: "File không hợp lệ (fake định dạng)."
        });
      }

      if (
        isEmpty(title) ||
        isEmpty(category) ||
        isEmpty(subjectCode) ||
        isEmpty(subjectName) ||
        isEmpty(tags)
      ) {
        return res.status(400).json({
          success: false,
          message: "Please fill in all required fields.",
        });
      }

      const key = s3.buildDocumentKey(req.file.originalname);
      const up = await s3.uploadDocumentBuffer({
        buffer: req.file.buffer,
        key,
        contentType: detectedType.mime
      });

      const row = {
        s3Key: key,
        title: title.trim(),
        courseId,
        uploaderId,
      };

      let documentId = null;
      if (db.isConfigured()) {
        documentId = await db.upsertDocument(row);
      }

      const newDocument = {
        id: documentId != null ? documentId : key,
        title: row.title,
        category: category.trim(),
        subjectCode: subjectCode.trim(),
        subjectName: subjectName.trim(),
        tags: normalizeTags(tags),
        description: description.trim(),
        courseId: optionalBodyNumber(courseId),
        uploaderId: optionalBodyNumber(uploaderId),
        storage: "s3",
        s3Key: key,
        originalFileName: req.file.originalname,
        storedFileName: path.basename(key),
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        fileUrl: up.url,
        downloads: 0,
        uploadedAt: new Date().toISOString(),
      };

      return res.status(201).json({
        success: true,
        message: "Upload completed successfully.",
        data: newDocument,
      });
    } catch (err) {
      console.error("[api/documents/upload]", err);
      return res.status(500).json({
        success: false,
        message: MSG_TRY_AGAIN,
      });
    }
  }
);

app.get("/api/documents/recent", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      50
    );

    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        total: 0,
        data: [],
        message: MSG_DATA_UNAVAILABLE,
      });
    }

    const rows = await db.listDocumentsRecent(limit);
    const data = rows.map(mapMysqlDocToRecent);

    return res.status(200).json({
      success: true,
      total: data.length,
      data,
    });
  } catch (err) {
    console.error("[api/documents/recent]", err);
    return res.status(200).json({
      success: true,
      total: 0,
      data: [],
      message: "Document list is temporarily unavailable.",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File exceeds 10MB. Please choose a smaller file.",
      });
    }
    return res.status(400).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }

  const status = err.status || 500;

  return res.status(status).json({
    success: false,
    message: MSG_TRY_AGAIN,
  });
});

async function start() {
  if (!s3.isS3Configured()) {
    console.warn("S3 is not configured — upload and S3-based quiz will not run.");
  } else {
    console.log(`S3: bucket "${s3.getBucket()}" (${process.env.AWS_REGION}).`);
  }
  if (db.isConfigured()) {
    await db.initDb();
    console.log("MySQL: using documents + document_segments (+ quizzes when persisted).");
  } else {
    console.warn("MySQL is not configured — s3Key + embedding quiz flow will not run.");
  }
  const server = app.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Another backend instance is running.`);
      console.error("Stop the existing process or change PORT in .env before starting a new one.");
      process.exit(0);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
