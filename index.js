// index.js - EduMate backend entry
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { fileTypeFromBuffer } = require("file-type");
const mammoth = require("mammoth");
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
/** Login — distinct messages (avoid generic “check credentials”). */
const MSG_LOGIN_NO_ACCOUNT =
  "No account found for this email. Check the address or register first.";
const MSG_LOGIN_WRONG_PASSWORD = "Incorrect password.";
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
    api: {
      documentComments: true,
      documentDownloadUrl: true,
      documentDownloadFile: true,
    },
  });
});

// --- NEW MODULAR FEATURES ---
const chatRoutes = require("./src/routes/chatRoutes");
const flashcardRoutes = require("./src/routes/flashcardRoutes");
const adminRoutes = require("./src/routes/adminRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");
const quizRoutes = require("./src/routes/quizRoutes"); // For Leaderboard and modular quiz controllers
const activityLog = require("./src/middleware/activityLog");
const teamDb = require("./src/config/teamDb");

// Mount modular features
app.use("/api/chat", chatRoutes);
app.use("/api/flashcards", flashcardRoutes);
// Backward-compatible aliases for older frontend paths.
app.use("/api/ai/flashcard", flashcardRoutes);
app.use("/api/ai/flashcards", flashcardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/quiz-v2", quizRoutes); // Modular version alongside legacy
// Compatibility endpoint used by older frontend builds.
app.get("/api/leaderboard", async (req, res) => {
  try {
    if (!teamDb.isConfigured()) {
      return res.status(200).json({ success: true, top: [], me: null, total: 0 });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const requestingUserId = req.query.userId ?? req.query.user_id ?? null;
    const result = await teamDb.getLeaderboard({ limit, requestingUserId });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("[api/leaderboard]", err);
    return res.status(200).json({ success: true, top: [], me: null, total: 0 });
  }
});
// --- END MODULAR FEATURES ---


function authJwtSecret() {
  const s = process.env.JWT_SECRET && String(process.env.JWT_SECRET).trim();
  return s || "dev-only-secret-change-me";
}

function isLecturerRole(role) {
  const allowed = String(
    process.env.LECTURER_ROLES || "lecturer,teacher,instructor,faculty,admin,lecture"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const r = String(role || "").trim().toLowerCase();
  if (!r) return false;
  if (allowed.includes(r)) return true;
  if (r === "student") return false;
  if (r.includes("lectur") || r.includes("instruct")) return true;
  return false;
}

function documentStatusLabel(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "verified") return "Verified";
  if (s === "rejected") return "Rejected";
  return "Pending review";
}

function resolveModerationStatus(rawStatus, { chunkCount = 0, highCredibility = false } = {}) {
  const s = String(rawStatus || "").trim().toLowerCase();
  if (s === "verified" || s === "rejected" || s === "pending") return s;
  // Legacy rows may have null status. If a document is already indexed (chunks > 0),
  // treat it as reviewed so FE can render the same badge style as verified items.
  if (Number(chunkCount) > 0 || highCredibility) return "verified";
  return "pending";
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
  const userId = Number(row.user_id ?? row.id);
  if (!Number.isFinite(userId)) return null;
  /** Display name: single source of truth is MySQL `users.name` (full name = name). */
  const display =
    String(row.name || row.display_name || "").trim() || "User";
  return {
    user_id: userId,
    id: userId,
    name: display,
    full_name: display,
    email: String(row.email || "").trim(),
    role: String(row.role || "STUDENT").trim().toUpperCase(),
    user_code:
      row.user_code != null && String(row.user_code).trim()
        ? String(row.user_code).trim()
        : null,
    department: row.department != null ? String(row.department) : "",
    bio: row.bio != null ? String(row.bio) : "",
    created_at: row.created_at || null,
  };
}

function getBearerUserId(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  if (!m) return null;
  try {
    const decoded = jwt.verify(String(m[1]).trim(), authJwtSecret());
    const sub = decoded?.sub;
    const n = Number(sub);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const fullName = String(req.body.name || req.body.full_name || "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "").trim();
    /** Public registration must not allow role escalation — always STUDENT in MySQL `users.role`. */
    const role = "STUDENT";
    const userCode = req.body.user_code ?? req.body.userCode ?? null;

    if (!fullName || !email || password.length < 8) {
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
    await db.createUser({ fullName, email, password: encryptedPassword, role, userCode });
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
    const code = String(req.body.otp ?? req.body.otp_code ?? req.body.code ?? "").trim();
    const purposeRaw = String(req.body.purpose || "").trim().toLowerCase();
    if (!email || !code) {
      return res.status(200).json({
        success: false,
        code: "INVALID_OTP_INPUT",
        message: "OTP is required.",
      });
    }
    const saved = otpStore.get(email);
    const purposeOk = !purposeRaw || saved?.purpose === purposeRaw;
    if (!saved || !purposeOk || Date.now() > saved.expiresAt || saved.code !== code) {
      return res.status(200).json({
        success: false,
        code: "INVALID_OR_EXPIRED_OTP",
        message: "Invalid or expired OTP.",
      });
    }
    const purpose = String(saved.purpose || "").trim().toLowerCase();
    otpStore.delete(email);
    if (purpose === "register" && db.isConfigured()) {
      const row = await db.findUserByEmail(email);
      if (row && row.user_id) {
        await db.markUserEmailVerified(row.user_id);
      }
    }
    return res.status(200).json({
      success: true,
      message: "Verification completed.",
      data: { verified: true, purpose: saved.purpose || "unknown" },
    });
  } catch (err) {
    console.error("[api/auth/verify-otp]", err);
    return res.status(200).json({
      success: false,
      code: "OTP_VERIFY_FAILED",
      message: MSG_TRY_AGAIN,
    });
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
      // 200 + success:false avoids browser "Failed to load resource: 401" on wrong email (same UX as wrong password).
      return res.status(200).json({
        success: false,
        code: "UNKNOWN_EMAIL",
        message: MSG_LOGIN_NO_ACCOUNT,
      });
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
      return res.status(200).json({
        success: false,
        code: "WRONG_PASSWORD",
        message: MSG_LOGIN_WRONG_PASSWORD,
      });
    }
    if (userRow.is_verified != null && !Number(userRow.is_verified)) {
      return res.status(403).json({
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email (OTP) before logging in.",
      });
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

app.get("/api/profile", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const tokenUid = getBearerUserId(req);
    const qUid = optionalBodyNumber(req.query.userId ?? req.query.user_id);
    if (qUid == null) {
      return res.status(400).json({ success: false, message: "Missing userId." });
    }
    if (tokenUid == null || tokenUid !== qUid) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const row = await db.getUserById(qUid);
    if (!row) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    const user = mapUserForClient(row);
    return res.status(200).json({ success: true, data: user });
  } catch (err) {
    console.error("[api/profile GET]", err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.patch("/api/profile", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const tokenUid = getBearerUserId(req);
    const bodyUid = optionalBodyNumber(req.body.userId ?? req.body.user_id);
    if (bodyUid == null) {
      return res.status(400).json({ success: false, message: "Missing userId." });
    }
    if (tokenUid == null || tokenUid !== bodyUid) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const fullName = String(req.body.fullName ?? req.body.name ?? "").trim();
    const department = String(req.body.department ?? "").trim();
    const bio = String(req.body.bio ?? "").trim() || null;
    await db.updateUserProfile(bodyUid, {
      name: fullName || null,
      department: department || null,
      bio,
    });
    const row = await db.getUserById(bodyUid);
    const user = mapUserForClient(row);
    return res.status(200).json({ success: true, data: user, message: "Profile updated." });
  } catch (err) {
    console.error("[api/profile PATCH]", err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
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

function normalizeLooseFilename(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "");
}

async function resolveS3KeyByFilenameLoose(inputKey) {
  const wantedBase = normalizeLooseFilename(path.basename(String(inputKey || "")));
  if (!wantedBase) return null;
  const candidates = await listS3DocsForQuiz();
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const exact = candidates.find((o) => normalizeLooseFilename(path.basename(o?.key || "")) === wantedBase);
  if (exact?.key) return String(exact.key);
  const partial = candidates.find((o) => normalizeLooseFilename(path.basename(o?.key || "")).includes(wantedBase));
  if (partial?.key) return String(partial.key);
  return null;
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

function publishedQuestionBankPrefix() {
  return `${publishedQuizPrefix()}question-bank/`;
}

function buildPublishedQuestionBankKey(quizId) {
  return `${publishedQuestionBankPrefix()}quiz-${Number(quizId)}.json`;
}

function mapQuizIndexingErrorMessage(err) {
  const msg = String(err?.message || "");
  const raw = msg.toLowerCase();
  const st = Number(err?.status);
  const detail = String(err?.detail || "").toLowerCase();

  /** embeddingService.js — Gemini embedContent failures surface as "Gemini embedding HTTP <status>: …" */
  if (msg.includes("Gemini embedding HTTP")) {
    if (st === 429) {
      return "Gemini embedding quota or rate limit exceeded. Wait and retry, or check usage at https://ai.dev/rate-limit";
    }
    if (st === 400 || st === 401 || st === 403) {
      if (
        detail.includes("api key") ||
        detail.includes("invalid") ||
        detail.includes("permission") ||
        st === 401
      ) {
        return "Gemini API key is missing, invalid, or lacks permission for embeddings. Use GEMINI_API_KEY from Google AI Studio (not OpenRouter), save .env, restart the Node server, then try again.";
      }
      return "Gemini rejected the embedding request (HTTP " + st + "). Verify GEMINI_API_KEY, billing, and that the Generative Language API is enabled; restart the server after changing .env.";
    }
  }
  if (raw.includes("missing gemini_api_key")) {
    return "Missing GEMINI_API_KEY in .env (required to index documents for AI quiz). Add the key and restart the server.";
  }

  const code = String(err?.Code || err?.code || "");
  if (code === "NoSuchKey") {
    return "The document could not be found in cloud storage.";
  }
  if (raw.includes("could not extract text")) {
    return "The selected document has no readable text. Please use a text-based PDF/Word file.";
  }
  if (raw.includes("pdf_has_no_text_layer") || raw.includes("no extractable text")) {
    return "This PDF has no text layer (common for scanned pages). Word files store text directly so they work more often. Try: export from Word to PDF with text, or OCR the scan, then upload again.";
  }
  if (raw.includes("unsupported file format")) {
    return "Unsupported document format. Please upload PDF or Word files.";
  }
  if (raw.includes("content is too short")) {
    return "The document content is too short to generate a quiz.";
  }
  if (raw.includes("s3 list timeout")) {
    return "Cloud storage is busy right now. Please try again in a moment.";
  }
  return MSG_TRY_AGAIN;
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

async function saveQuestionBankToS3(quizRow) {
  if (!s3.isS3Configured()) return null;
  const qid = Number(quizRow?.quiz_id ?? quizRow?.quizId);
  if (!Number.isFinite(qid) || qid <= 0) return null;
  const questions = Array.isArray(quizRow?.questions) ? quizRow.questions : [];
  const payload = {
    quizId: qid,
    title: String(quizRow?.title || "Quiz"),
    createdAt: quizRow?.created_at || quizRow?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    questionCount: questions.length,
    questions,
  };
  const key = buildPublishedQuestionBankKey(qid);
  await s3.putJsonObject({ key, value: payload });
  return key;
}

async function listPublishedQuizzesFromS3(limit = 20) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (!s3.isS3Configured()) return [];
  const objects = await s3.listDocuments({ prefix: publishedQuizPrefix(), maxKeys: lim * 5 });
  const prefix = publishedQuizPrefix();
  const quizJsonObjects = objects
    .filter((o) => {
      const k = String(o?.key || "");
      return (
        k.startsWith(prefix) &&
        !k.startsWith(publishedQuestionBankPrefix()) &&
        /\.json$/i.test(k)
      );
    })
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
 * Stable type id from upload "Document Type" (category). Used for list filtering — not course code.
 */
function normalizeUploadCategoryToType(categoryStr) {
  const s = String(categoryStr || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!s) return "";
  if (s === "general major" || s === "general") return "general_major";
  if (s === "specialized" || s === "specialised") return "specialized";
  return "other";
}

/** ?type= all | general_major | specialized (aliases: general, general major, specialised) */
function parseDocTypeFilterQuery(req) {
  const raw = String(req.query.type ?? req.query.docType ?? "").trim().toLowerCase();
  if (!raw || raw === "all" || raw === "*") return null;
  if (
    raw === "general_major" ||
    raw === "general-major" ||
    raw === "general major" ||
    raw === "general"
  ) {
    return "general_major";
  }
  if (raw === "specialized" || raw === "specialised") return "specialized";
  return null;
}

function documentMatchesDocTypeFilter(categoryStr, filter) {
  if (!filter) return true;
  const t = normalizeUploadCategoryToType(categoryStr);
  if (filter === "general_major") return t === "general_major";
  if (filter === "specialized") return t === "specialized";
  return false;
}

/** Resolve counts when map keys are full S3 URLs but `o.key` is a relative path (or vice versa). */
function countFromKeyMap(map, s3Key) {
  if (!map || !s3Key) return 0;
  const k = String(s3Key).trim();
  let n = map.get(k);
  if (n != null) return Number(n);
  const nk = db.normalizeDocumentKeyForLookup(k);
  n = map.get(nk);
  if (n != null) return Number(n);
  for (const [mk, mv] of map) {
    if (db.normalizeDocumentKeyForLookup(String(mk)) === nk) return Number(mv);
  }
  return 0;
}

/** Record a successful file download (presigned URL or streamed buffer). Best-effort; ignores failures. */
function recordDocumentDownload(rawDocumentId, s3Key) {
  if (!db.isConfigured()) return;
  void (async () => {
    try {
      const raw = rawDocumentId != null && String(rawDocumentId).trim() !== "" ? rawDocumentId : null;
      if (raw != null) {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          await db.incrementDocumentDownloadCountByDocumentId(n);
          return;
        }
      }
      await db.incrementDocumentDownloadCountByS3Key(s3Key);
    } catch (e) {
      console.warn("[documents] download count:", e.message);
    }
  })();
}

/**
 * All PDF/Word objects in the S3 bucket, merged with MySQL metadata and chunk counts.
 * @param {{ docTypeFilter?: "general_major" | "specialized" | null }} [options]
 */
async function buildDocumentsForQuizList(options = {}) {
  if (!s3.isS3Configured()) {
    throw new Error("S3 is not configured.");
  }
  const docTypeFilter = options.docTypeFilter || null;
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

  let commentByKey = new Map();
  if (db.isConfigured() && keys.length) {
    try {
      commentByKey = await db.countCommentsByDocumentFileUrls(keys);
    } catch (e) {
      console.warn("[for-quiz] comment counts:", e.message);
    }
  }

  let merged = filtered.map((o) => {
    let m = metaMap.get(o.key);
    if (m == null) m = metaMap.get(db.normalizeDocumentKeyForLookup(o.key));
    const ext = path.extname(o.key).replace(/^\./, "").toUpperCase() || "FILE";
    const chunks = m != null ? Number(m.chunk_count || 0) : 0;
    const estimatedQuestions = Math.min(
      30,
      Math.max(5, chunks > 0 ? 5 + Math.floor(chunks / 4) : 5)
    );
    const courseCode = (m?.course_code && String(m.course_code).trim()) || ext;
    const categoryRaw = m?.category != null ? String(m.category).trim() : "";
    const documentType = normalizeUploadCategoryToType(categoryRaw);
    const uploaderName =
      m?.uploader_name != null && String(m.uploader_name).trim()
        ? String(m.uploader_name).trim()
        : "";
    const uploaderRole = m?.uploader_role != null ? String(m.uploader_role).trim() : "";
    const moderationStatus = resolveModerationStatus(m?.status, {
      chunkCount: chunks,
      highCredibility: isLecturerRole(uploaderRole),
    });
    const highCredibility =
      isLecturerRole(uploaderRole) || moderationStatus === "verified";
    return {
      storage: "s3",
      s3Key: o.key,
      fileName: path.basename(o.key),
      title: m?.title || path.basename(o.key),
      description:
        m?.description != null && String(m.description).trim()
          ? String(m.description).trim()
          : "",
      subjectCode: courseCode,
      courseCode,
      subjectName: "",
      category: categoryRaw,
      documentType,
      courseId: m?.course_id ?? null,
      documentId: m?.document_id ?? null,
      uploaderId: m?.uploader_id ?? null,
      uploaderName,
      uploaderRole,
      highCredibility,
      status: moderationStatus,
      statusLabel: documentStatusLabel(moderationStatus),
      size: o.size,
      lastModified: o.lastModified || m?.created_at,
      fileUrl: s3.buildObjectPublicUrl(o.key),
      inDatabase: !!m,
      chunkCount: chunks,
      estimatedQuestions,
      downloadCount: Number(m?.download_count ?? 0),
      attemptsCount: countFromKeyMap(attemptByKey, o.key),
      commentsCount: countFromKeyMap(commentByKey, o.key),
    };
  });

  if (docTypeFilter) {
    merged = merged.filter((item) =>
      documentMatchesDocTypeFilter(item.category, docTypeFilter)
    );
  }

  merged.sort((a, b) => {
    const ta = new Date(a.lastModified || 0).getTime();
    const tb = new Date(b.lastModified || 0).getTime();
    return tb - ta;
  });
  return merged;
}

app.get("/api/documents/for-quiz", async (req, res) => {
  try {
    const docTypeFilter = parseDocTypeFilterQuery(req);
    const data = await buildDocumentsForQuizList({ docTypeFilter });
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

app.get("/api/documents/preview", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        data: { sections: [], previewText: "", description: "" },
        message: MSG_DATA_UNAVAILABLE,
      });
    }

    const rawDocumentId = req.query.documentId ?? req.query.document_id;
    const rawS3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();

    const previewLimit = Math.min(Math.max(Number(req.query.limit) || 4, 1), 8);
    const previewChars = Math.min(Math.max(Number(req.query.maxChars) || 3000, 500), 12000);
    let segments = [];
    let totalSegments = 0;
    let docMeta = null;
    let resolvedS3Key = rawS3Key;
    if (rawDocumentId != null && String(rawDocumentId).trim() !== "") {
      segments = await db.listPreviewSegmentsByDocumentId(rawDocumentId, previewLimit);
      totalSegments = await db.countSegmentsByDocumentId(rawDocumentId);
      docMeta = await db.getDocumentById(rawDocumentId);
      resolvedS3Key = docMeta?.file_url != null ? String(docMeta.file_url).trim() : "";
    } else if (rawS3Key) {
      segments = await db.listPreviewSegmentsByS3Key(rawS3Key, previewLimit);
      totalSegments = await db.countSegmentsByS3Key(rawS3Key);
      const did = await db.getDocumentIdByS3Key(rawS3Key);
      if (did != null) docMeta = await db.getDocumentById(did);
      if (!resolvedS3Key && docMeta?.file_url != null) {
        resolvedS3Key = String(docMeta.file_url).trim();
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "Missing documentId or s3Key.",
      });
    }

    const description =
      docMeta?.description != null && String(docMeta.description).trim()
        ? String(docMeta.description).trim()
        : "";

    const previewChunks = segments
      .map((s) => String(s?.content || "").trim())
      .filter(Boolean)
      .slice(0, previewLimit);
    const previewText = previewChunks.join("\n\n").slice(0, previewChars);
    const sections = previewChunks.map((text, i) => ({
      title: `Section ${i + 1}`,
      content: String(text).slice(0, Math.ceil(previewChars / Math.max(previewChunks.length, 1))),
    }));

    const previewFileUrl =
      rawDocumentId != null && String(rawDocumentId).trim() !== ""
        ? `/api/documents/preview-file?documentId=${encodeURIComponent(String(rawDocumentId).trim())}`
        : resolvedS3Key
        ? `/api/documents/preview-file?s3Key=${encodeURIComponent(resolvedS3Key)}`
        : null;
    const downloadFileUrl =
      rawDocumentId != null && String(rawDocumentId).trim() !== ""
        ? `/api/documents/download-file?documentId=${encodeURIComponent(String(rawDocumentId).trim())}`
        : resolvedS3Key
        ? `/api/documents/download-file?s3Key=${encodeURIComponent(resolvedS3Key)}`
        : null;
    const sourceFileUrl = resolvedS3Key ? s3.buildObjectPublicUrl(resolvedS3Key) : null;
    const fileExt = path.extname(resolvedS3Key || "").toLowerCase();
    const isWordFile =
      fileExt === ".doc" ||
      fileExt === ".docx" ||
      fileExt === ".docm" ||
      fileExt === ".dotx" ||
      fileExt === ".dotm";
    const wordPreviewUrl =
      isWordFile && resolvedS3Key
        ? `/api/documents/preview-word-file?s3Key=${encodeURIComponent(resolvedS3Key)}`
        : null;
    const effectivePreviewUrl = wordPreviewUrl || previewFileUrl;

    return res.status(200).json({
      success: true,
      data: {
        sections,
        previewText,
        description,
        totalSegments: Number(totalSegments || 0),
        returnedSegments: Number(sections.length || 0),
        hasMore: Number(totalSegments || 0) > Number(sections.length || 0),
        mode: "preview",
        s3Key: resolvedS3Key || null,
        sourceFileUrl: effectivePreviewUrl || sourceFileUrl,
        previewFileUrl: effectivePreviewUrl,
        downloadFileUrl,
        viewFullUrl: sourceFileUrl || effectivePreviewUrl,
        officeViewerUrl: null,
        previewProvider: wordPreviewUrl ? "word-html-render" : "native-inline",
        // Compatibility aliases for different FE implementations.
        previewUrl: effectivePreviewUrl,
        fileUrl: effectivePreviewUrl || sourceFileUrl,
        viewerUrl: effectivePreviewUrl,
        // Compatibility alias for FE components expecting `url`.
        url: effectivePreviewUrl,
      },
    });
  } catch (err) {
    console.error("[api/documents/preview]", err);
    return res.status(200).json({
      success: true,
      data: { sections: [], previewText: "", description: "" },
      message: "Document preview is temporarily unavailable.",
    });
  }
});

function mapDocumentCommentRow(row) {
  const roleRaw = String(row.author_role || "").trim();
  const role = isLecturerRole(roleRaw) ? "instructor" : "student";
  const author = String(row.author_name || "").trim() || "User";
  const date = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : "";
  return {
    id: row.comment_id,
    author,
    text: String(row.body || ""),
    date,
    role,
  };
}

app.get("/api/documents/comments", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: [] });
    }
    const documentId = req.query.documentId ?? req.query.document_id;
    const s3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();
    const rows = await db.listDocumentComments({ documentId, s3Key });
    const data = rows.map(mapDocumentCommentRow);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/documents/comments GET]", err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Comments are temporarily unavailable.",
    });
  }
});

app.post("/api/documents/comments", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const uid = getBearerUserId(req);
    if (uid == null) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const text = String(req.body.text ?? req.body.body ?? "").trim();
    const documentId = req.body.documentId ?? req.body.document_id;
    const s3Key = String(req.body.s3Key ?? req.body.s3_key ?? "").trim();
    if (!text) {
      return res.status(400).json({ success: false, message: "Comment cannot be empty." });
    }
    const hasDocId = documentId != null && String(documentId).trim() !== "";
    if (!hasDocId && !s3Key) {
      return res.status(400).json({ success: false, message: "Missing documentId or s3Key." });
    }
    await db.insertDocumentComment({
      documentId,
      s3Key,
      userId: uid,
      body: text,
    });
    return res.status(201).json({ success: true, message: "Posted." });
  } catch (err) {
    console.error("[api/documents/comments POST]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.get("/api/documents/download-url", async (req, res) => {
  try {
    const uid = getBearerUserId(req);
    if (uid == null) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    if (!s3.isS3Configured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const rawDocumentId = req.query.documentId ?? req.query.document_id;
    const rawS3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();
    let s3Key = rawS3Key;
    if (!s3Key && rawDocumentId != null && String(rawDocumentId).trim() !== "" && db.isConfigured()) {
      const doc = await db.getDocumentById(rawDocumentId);
      s3Key = doc?.file_url != null ? String(doc.file_url).trim() : "";
    }
    if (!s3Key) {
      return res.status(400).json({
        success: false,
        message: "Missing documentId or s3Key.",
      });
    }
    if (s3Key.includes("..")) {
      return res.status(400).json({ success: false, message: "Invalid file reference." });
    }
    const url = await s3.getPresignedDownloadUrl(s3Key, 300);
    const fileName = path.basename(s3Key) || "document";
    recordDocumentDownload(rawDocumentId, s3Key);
    return res.status(200).json({
      success: true,
      data: { url, fileName },
    });
  } catch (err) {
    console.error("[api/documents/download-url]", err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

async function streamDocumentFile(req, res, mode = "attachment", options = {}) {
  try {
    const { allowAnonymous = false } = options;
    const uid = getBearerUserId(req);
    if (!allowAnonymous && uid == null) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    if (!s3.isS3Configured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const rawDocumentId = req.query.documentId ?? req.query.document_id;
    const rawS3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();
    let s3Key = rawS3Key;
    if (!s3Key && rawDocumentId != null && String(rawDocumentId).trim() !== "" && db.isConfigured()) {
      const doc = await db.getDocumentById(rawDocumentId);
      s3Key = doc?.file_url != null ? String(doc.file_url).trim() : "";
    }
    if (!s3Key) {
      return res.status(400).json({
        success: false,
        message: "Missing documentId or s3Key.",
      });
    }
    if (s3Key.includes("..")) {
      return res.status(400).json({ success: false, message: "Invalid file reference." });
    }
    const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
    recordDocumentDownload(rawDocumentId, s3Key);
    const baseName = path.basename(s3Key) || "document";
    const safeBase = baseName.replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    const forceInline =
      mode === "inline" ||
      req.query.inline === "1" ||
      req.query.inline === "true" ||
      req.query.mode === "inline";
    res.setHeader(
      "Content-Disposition",
      `${forceInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(safeBase)}`
    );
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("[api/documents/download-file]", err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
  }
}

/** Stream file as attachment (download). Supports inline via query: ?inline=1 */
app.get("/api/documents/download-file", async (req, res) => streamDocumentFile(req, res, "attachment"));

/** Stream file for in-browser preview (inline). */
app.get("/api/documents/preview-file", async (req, res) =>
  streamDocumentFile(req, res, "inline", { allowAnonymous: true })
);

/** Convert Word (.doc/.docx/.docm/.dotx/.dotm) to HTML for in-app preview (avoids auto-download). */
app.get("/api/documents/preview-word", async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }

    const rawDocumentId = req.query.documentId ?? req.query.document_id;
    const rawS3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();
    let s3Key = rawS3Key;

    if (!s3Key && rawDocumentId != null && String(rawDocumentId).trim() !== "" && db.isConfigured()) {
      const doc = await db.getDocumentById(rawDocumentId);
      s3Key = doc?.file_url != null ? String(doc.file_url).trim() : "";
    }

    if (!s3Key) {
      return res.status(400).json({ success: false, message: "Missing documentId or s3Key." });
    }
    if (s3Key.includes("..")) {
      return res.status(400).json({ success: false, message: "Invalid file reference." });
    }

    const ext = path.extname(s3Key || "").toLowerCase();
    const isWord =
      ext === ".doc" || ext === ".docx" || ext === ".docm" || ext === ".dotx" || ext === ".dotm";
    if (!isWord) {
      return res.status(400).json({
        success: false,
        message: "preview-word only supports Word files (.doc/.docx/.docm/.dotx/.dotm).",
      });
    }

    const { buffer } = await s3.getObjectBuffer(s3Key);
    if (!buffer || !buffer.length) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    const converted = await mammoth.convertToHtml({ buffer });
    const html = String(converted?.value || "").trim();
    const text = String(converted?.value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const previewText = text.slice(0, 2000);

    return res.status(200).json({
      success: true,
      data: {
        s3Key,
        html,
        previewText,
        mode: "preview-word",
        sourceFileUrl: s3.buildObjectPublicUrl(s3Key),
        viewFullUrl: `/api/documents/preview-file?s3Key=${encodeURIComponent(s3Key)}`,
        downloadFileUrl: `/api/documents/download-file?s3Key=${encodeURIComponent(s3Key)}`,
      },
    });
  } catch (err) {
    console.error("[api/documents/preview-word]", err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

/** Rendered HTML page for Word preview iframe/object usage. */
app.get("/api/documents/preview-word-file", async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(503).send("Preview unavailable.");
    }

    const rawDocumentId = req.query.documentId ?? req.query.document_id;
    const rawS3Key = String(req.query.s3Key ?? req.query.s3_key ?? "").trim();
    let s3Key = rawS3Key;

    if (!s3Key && rawDocumentId != null && String(rawDocumentId).trim() !== "" && db.isConfigured()) {
      const doc = await db.getDocumentById(rawDocumentId);
      s3Key = doc?.file_url != null ? String(doc.file_url).trim() : "";
    }

    if (!s3Key || s3Key.includes("..")) {
      return res.status(400).send("Invalid file reference.");
    }

    const ext = path.extname(s3Key || "").toLowerCase();
    const isWord =
      ext === ".doc" || ext === ".docx" || ext === ".docm" || ext === ".dotx" || ext === ".dotm";
    if (!isWord) {
      return res.status(400).send("This preview endpoint supports only Word files.");
    }

    const { buffer } = await s3.getObjectBuffer(s3Key);
    const converted = await mammoth.convertToHtml({ buffer });
    const bodyHtml = String(converted?.value || "").trim() || "<p>No preview content.</p>";

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Word Preview</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #fff; color: #222; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 20px; line-height: 1.6; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ddd; padding: 8px; }
  </style>
</head>
<body>
  <div class="wrap">${bodyHtml}</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (err) {
    console.error("[api/documents/preview-word-file]", err);
    return res.status(500).send("Preview is temporarily unavailable.");
  }
});

async function verifyOrRejectDocument(req, res, targetStatus) {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const uid = getBearerUserId(req);
    if (uid == null) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const role = await db.getUserRole(uid);
    if (!isLecturerRole(role)) {
      return res.status(403).json({ success: false, message: "Only lecturers can verify/reject documents." });
    }
    const docId = Number(req.params.id);
    if (!Number.isFinite(docId) || docId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid document ID." });
    }
    // Business rule: Reject button should remove the document.
    if (targetStatus === "rejected") {
      const removed = await db.deleteDocumentById(docId);
      if (!removed) {
        return res.status(404).json({ success: false, message: "Document not found." });
      }
      if (s3.isS3Configured() && removed.fileUrl) {
        try {
          await s3.deleteObject(removed.fileUrl);
        } catch (e) {
          console.warn("[api/documents/:id/reject] S3 cleanup warning:", e.message);
        }
      }
      return res.status(200).json({
        success: true,
        message: "Document was rejected and removed.",
        data: {
          status: "rejected",
          statusLabel: "Rejected",
          removed: true,
        },
      });
    }

    const ok = await db.updateDocumentStatus(docId, targetStatus);
    if (!ok) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }
    return res.status(200).json({
      success: true,
      message: "Document verified.",
      data: {
        status: "verified",
        statusLabel: "Verified",
      },
    });
  } catch (err) {
    console.error(`[api/documents/${req.params.id}/${targetStatus}]`, err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
  }
}

app.patch("/api/documents/:id/verify", async (req, res) => verifyOrRejectDocument(req, res, "verified"));
app.post("/api/documents/:id/verify", async (req, res) => verifyOrRejectDocument(req, res, "verified"));
app.patch("/api/documents/:id/reject", async (req, res) => verifyOrRejectDocument(req, res, "rejected"));
app.post("/api/documents/:id/reject", async (req, res) => verifyOrRejectDocument(req, res, "rejected"));

async function deleteDocumentHandler(req, res) {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const uid = getBearerUserId(req);
    if (uid == null) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const role = await db.getUserRole(uid);
    if (!isLecturerRole(role)) {
      return res.status(403).json({ success: false, message: "Only lecturers can delete documents." });
    }
    const docId = Number(req.params.id);
    if (!Number.isFinite(docId) || docId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid document ID." });
    }
    const removed = await db.deleteDocumentById(docId);
    if (!removed) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }

    // Best-effort cleanup on S3 (ignore if object already gone).
    if (s3.isS3Configured() && removed.fileUrl) {
      try {
        await s3.deleteObject(removed.fileUrl);
      } catch (e) {
        console.warn("[api/documents/:id/delete] S3 cleanup warning:", e.message);
      }
    }

    return res.status(200).json({ success: true, message: "Document deleted successfully." });
  } catch (err) {
    console.error("[api/documents/:id DELETE]", err);
    return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
  }
}

app.delete("/api/documents/:id", deleteDocumentHandler);
app.post("/api/documents/:id/delete", deleteDocumentHandler);

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
    const ownerOnly =
      req.query.ownerOnly === true ||
      req.query.ownerOnly === "true" ||
      req.query.owner_only === "true" ||
      req.query.owner_only === 1;
    const data = await db.listQuizHistory(limit, userId, ownerOnly);
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

app.get("/api/questions/bank", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: [] });
    }
    const userId = req.query.userId ?? req.query.user_id;
    const limit = req.query.limit;
    const rows = await db.listQuestionBank(limit, userId);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error("[api/questions/bank GET]", err);
    return res.status(200).json({ success: true, data: [] });
  }
});

app.get("/api/quizzes/analytics", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        data: {
          summary: {
            totalQuizzes: 0,
            totalParticipants: 0,
            averageScorePercent: 0,
            completionRatePercent: 0,
          },
          performance: [],
          challengingQuestions: [],
        },
      });
    }
    const userId = req.query.userId ?? req.query.user_id;
    const topQuestions = req.query.topQuestions ?? req.query.top_questions;
    const data = await db.getLecturerQuizAnalytics(userId, { topQuestions });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[api/quizzes/analytics]", err);
    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalQuizzes: 0,
          totalParticipants: 0,
          averageScorePercent: 0,
          completionRatePercent: 0,
        },
        performance: [],
        challengingQuestions: [],
      },
      message: MSG_DATA_UNAVAILABLE,
    });
  }
});

app.post("/api/questions/bank", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const userId = req.body.userId ?? req.body.user_id;
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
    }
    const role = await db.getUserRole(uid);
    if (!isLecturerRole(role)) {
      return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
    }
    const norm = db.normalizeQuestionInput(req.body || {});
    if (!norm) {
      return res.status(400).json({ success: false, message: "Please provide a valid question." });
    }
    const id = await db.createQuestionBankItem(uid, { ...req.body, ...norm });
    return res.status(201).json({ success: true, id });
  } catch (err) {
    console.error("[api/questions/bank POST]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.patch("/api/questions/bank/:id", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const userId = req.body.userId ?? req.body.user_id;
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
    }
    const role = await db.getUserRole(uid);
    if (!isLecturerRole(role)) {
      return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
    }
    const norm = db.normalizeQuestionInput(req.body || {});
    if (!norm) {
      return res.status(400).json({ success: false, message: "Please provide a valid question." });
    }
    const ok = await db.updateQuestionBankItem(req.params.id, uid, { ...req.body, ...norm });
    if (!ok) {
      return res.status(404).json({ success: false, message: "Question not found." });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[api/questions/bank PATCH]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.delete("/api/questions/bank/:id", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const userId = req.body?.userId ?? req.query?.userId ?? req.query?.user_id;
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
    }
    const role = await db.getUserRole(uid);
    if (!isLecturerRole(role)) {
      return res.status(403).json({ success: false, message: "Only lecturers can manage question bank." });
    }
    const ok = await db.deleteQuestionBankItem(req.params.id, uid);
    if (!ok) {
      return res.status(404).json({ success: false, message: "Question not found." });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[api/questions/bank DELETE]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
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
  const uploaderRole =
    row.uploader_role != null ? String(row.uploader_role).trim() : "";
  const chunkCount = Number(row.chunk_count || 0);
  const moderationStatus = resolveModerationStatus(row.status, {
    chunkCount,
    highCredibility: isLecturerRole(uploaderRole),
  });
  const highCredibility =
    isLecturerRole(uploaderRole) || moderationStatus === "verified";
  return {
    id: row.document_id,
    title: row.title,
    description: row.description != null ? String(row.description) : "",
    category: row.category != null ? String(row.category) : "",
    documentType: normalizeUploadCategoryToType(
      row.category != null ? String(row.category) : ""
    ),
    s3Key: row.file_url,
    courseId: row.course_id,
    uploaderId: row.uploader_id,
    uploaderRole,
    highCredibility,
    status: moderationStatus,
    statusLabel: documentStatusLabel(moderationStatus),
    uploadedAt: row.created_at,
    chunkCount,
    downloads: 0,
  };
}

async function handleQuizGenerate(req, res) {
  try {
    let s3Key =
      req.body.s3Key != null && String(req.body.s3Key).trim()
        ? String(req.body.s3Key).trim()
        : "";
    const quizId = req.body.quizId ?? req.body.quiz_id ?? null;
    const documentId = req.body.documentId ?? req.body.document_id ?? null;

    if (!s3Key && quizId != null && db.isConfigured()) {
      const quizRow = await db.getQuizWithQuestions(quizId);
      const keyFromQuiz = String(quizRow?.source_file_url || "").trim();
      if (keyFromQuiz) {
        s3Key = keyFromQuiz;
      }
      if (!s3Key && quizRow?.document_id != null) {
        const docFromQuiz = await db.getDocumentById(quizRow.document_id);
        const keyFromDocByQuiz = String(docFromQuiz?.file_url || "").trim();
        if (keyFromDocByQuiz) s3Key = keyFromDocByQuiz;
      }
    }

    if (documentId != null && db.isConfigured()) {
      const doc = await db.getDocumentById(documentId);
      const keyFromDoc = String(doc?.file_url || "").trim();
      if (keyFromDoc) {
        s3Key = keyFromDoc;
      }
    }
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
      const code = String(e?.Code || e?.code || "");
      if (code === "NoSuchKey") {
        const recoveredKey = await resolveS3KeyByFilenameLoose(s3Key);
        if (recoveredKey && recoveredKey !== s3Key) {
          s3Key = recoveredKey;
          try {
            const idx = await ensureIndexedForQuiz(s3Key, { reindex });
            req._quizIndexMeta = idx;
          } catch (retryErr) {
            console.error("[ensureIndexedForQuiz:retry]", retryErr);
            return res.status(400).json({
              success: false,
              message: mapQuizIndexingErrorMessage(retryErr),
            });
          }
        } else {
          console.error("[ensureIndexedForQuiz]", e);
          return res.status(400).json({
            success: false,
            message: mapQuizIndexingErrorMessage(e),
          });
        }
      } else {
        console.error("[ensureIndexedForQuiz]", e);
        return res.status(400).json({
          success: false,
          message: mapQuizIndexingErrorMessage(e),
        });
      }
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
      const createdByRaw = req.body.createdBy ?? req.body.created_by ?? req.body.userId;
      const createdBy = Number(createdByRaw);
      if (!Number.isFinite(createdBy) || createdBy <= 0) {
        return res.status(403).json({
          success: false,
          message: "Only lecturers can save and edit AI-generated quizzes.",
        });
      }
      const creatorRole = await db.getUserRole(createdBy);
      if (!isLecturerRole(creatorRole)) {
        return res.status(403).json({
          success: false,
          message: "Only lecturers can save and edit AI-generated quizzes.",
        });
      }
      const requestedQuizId = Number(req.body.quizId ?? req.body.quiz_id);
      if (Number.isFinite(requestedQuizId) && requestedQuizId > 0) {
        const canManage = await db.canUserManageQuiz(requestedQuizId, createdBy);
        if (!canManage) {
          return res.status(403).json({
            success: false,
            message: "You do not have permission to edit this quiz.",
          });
        }
        await db.updateQuizTitle(requestedQuizId, quizTitle);
        await db.replaceQuizQuestions(requestedQuizId, quiz);
        if (s3.isS3Configured()) {
          try {
            const row = await db.getQuizWithQuestions(requestedQuizId);
            await saveQuestionBankToS3(row);
          } catch (e) {
            console.error("[question-bank->s3:update]", e);
          }
        }
        payload.quizId = requestedQuizId;
        return res.status(200).json({ success: true, data: payload });
      }

      const idxMeta = req._quizIndexMeta || {};
      const documentId =
        idxMeta.documentId != null
          ? idxMeta.documentId
          : await db.getDocumentIdByS3Key(s3Key);
      const newQuizId = await db.saveQuizWithQuestions({
        title: quizTitle,
        courseId,
        createdBy,
        questions: quiz,
        sourceFileUrl: s3Key,
        documentId,
      });
      if (s3.isS3Configured()) {
        try {
          const row = await db.getQuizWithQuestions(newQuizId);
          await saveQuestionBankToS3(row);
        } catch (e) {
          console.error("[question-bank->s3:create]", e);
        }
      }
      payload.quizId = newQuizId;
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
    let questionBankS3Key = null;
    if (s3.isS3Configured()) {
      try {
        questionBankS3Key = await saveQuestionBankToS3(row);
      } catch (e) {
        console.error("[question-bank->s3:patch]", e);
      }
    }
    return res.status(200).json({ success: true, data: row, questionBankS3Key });
  } catch (err) {
    console.error("[api/quizzes PATCH]", err);
    return res.status(400).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
});

app.post("/api/quizzes", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const userId = req.body.userId ?? req.body.user_id ?? req.body.createdBy ?? req.body.created_by;
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(403).json({ success: false, message: "Only lecturers can create quizzes." });
    }
    const role = await db.getUserRole(uid);
    if (!isLecturerRole(role)) {
      return res.status(403).json({ success: false, message: "Only lecturers can create quizzes." });
    }
    const title = String(req.body.title || "").trim() || "Quiz";
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    if (!questions.length) {
      return res.status(400).json({ success: false, message: "Please provide at least one question." });
    }
    const quizId = await db.saveQuizWithQuestions({
      title,
      courseId: req.body.courseId ?? req.body.course_id ?? null,
      createdBy: uid,
      questions,
      sourceFileUrl: req.body.s3Key ?? req.body.sourceFileUrl ?? null,
      documentId: req.body.documentId ?? req.body.document_id ?? null,
    });
    if (s3.isS3Configured()) {
      try {
        const row = await db.getQuizWithQuestions(quizId);
        await saveQuestionBankToS3(row);
      } catch (e) {
        console.error("[question-bank->s3:create]", e);
      }
    }
    const shouldPublish =
      req.body.status === "published" ||
      req.body.publish === true ||
      req.body.publish === "true" ||
      req.body.isPublished === true;
    if (shouldPublish) {
      if (!s3.isS3Configured()) {
        return res.status(503).json({
          success: false,
          message: "Cloud storage is unavailable right now.",
        });
      }
      await db.setQuizPublished(quizId, true);
      const publishedRow = await db.getQuizWithQuestions(quizId);
      try {
        await savePublishedQuizToS3(publishedRow);
      } catch (e) {
        try {
          await db.setQuizPublished(quizId, false);
        } catch (_) {}
        console.error("[create->publish->s3]", e);
        return res.status(500).json({ success: false, message: MSG_TRY_AGAIN });
      }
    }
    const row = await db.getQuizWithQuestions(quizId);
    return res.status(201).json({ success: true, data: row, quizId });
  } catch (err) {
    console.error("[api/quizzes POST]", err);
    return res.status(400).json({ success: false, message: MSG_TRY_AGAIN });
  }
});

app.post("/api/quizzes/:id/publish", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    if (!s3.isS3Configured()) {
      return res.status(503).json({
        success: false,
        message: "Cloud storage is unavailable right now.",
      });
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
    let publishedS3Key = null;
    let questionBankS3Key = null;
    try {
      publishedS3Key = await savePublishedQuizToS3(row);
      questionBankS3Key = await saveQuestionBankToS3(row);
    } catch (e) {
      // Keep DB/S3 state consistent: if cloud publish fails, revert published flag.
      try {
        await db.setQuizPublished(quizId, false);
      } catch (_) {
        // Ignore rollback failure here; primary error message remains generic.
      }
      console.error("[publish->s3]", e);
      return res.status(500).json({
        success: false,
        message: MSG_TRY_AGAIN,
      });
    }
    return res.status(200).json({
      success: true,
      data: row,
      s3Key: publishedS3Key,
      questionBankS3Key,
    });
  } catch (err) {
    console.error("[api/quizzes/:id/publish]", err);
    return res.status(400).json({
      success: false,
      message: MSG_TRY_AGAIN,
    });
  }
});

app.delete("/api/quizzes/:id", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: MSG_UNAVAILABLE });
    }
    const quizId = req.params.id;
    const userId = req.body?.userId ?? req.query?.userId ?? req.query?.user_id;
    const ok = await db.canUserManageQuiz(quizId, userId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to delete this quiz.",
      });
    }
    await db.deleteQuizById(quizId);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[api/quizzes/:id DELETE]", err);
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

      let resolvedCourseId = optionalBodyNumber(courseId);
      if (resolvedCourseId == null && db.isConfigured()) {
        try {
          resolvedCourseId = await db.findOrCreateCourseIdByCode(subjectCode, subjectName);
        } catch (err) {
          console.warn("[api/documents/upload] findOrCreateCourseIdByCode:", err.code || err.message);
        }
      }

      const tokenUserId = getBearerUserId(req);
      const resolvedUploaderId =
        optionalBodyNumber(uploaderId ?? req.body.user_id ?? req.body.userId) ?? tokenUserId;
      let uploaderRole = "";
      if (db.isConfigured() && resolvedUploaderId != null && Number.isFinite(Number(resolvedUploaderId))) {
        try {
          uploaderRole = String((await db.getUserRole(resolvedUploaderId)) || "").trim();
        } catch (_) {
          uploaderRole = "";
        }
      }
      const moderationStatus = isLecturerRole(uploaderRole) ? "verified" : "pending";

      const row = {
        s3Key: key,
        title: title.trim(),
        courseId: resolvedCourseId,
        uploaderId: resolvedUploaderId,
        description: String(description || "").trim(),
        category: String(category || "").trim(),
        status: moderationStatus,
      };

      let documentId = null;
      if (db.isConfigured()) {
        documentId = await db.upsertDocument(row);
      }

      const highCredibility = isLecturerRole(uploaderRole);

      const newDocument = {
        id: documentId != null ? documentId : key,
        title: row.title,
        category: category.trim(),
        subjectCode: subjectCode.trim(),
        subjectName: subjectName.trim(),
        tags: normalizeTags(tags),
        description: description.trim(),
        courseId: resolvedCourseId,
        uploaderId: resolvedUploaderId != null && Number.isFinite(Number(resolvedUploaderId))
          ? Number(resolvedUploaderId)
          : null,
        highCredibility,
        status: moderationStatus,
        statusLabel: documentStatusLabel(moderationStatus),
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
    console.log("Routes: GET /api/documents/download-file (save to disk), GET /api/documents/download-url (presigned JSON).");
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
