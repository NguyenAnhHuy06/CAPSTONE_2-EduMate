require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const { generateQuizWithAI } = require("./generateQuizWithAI");
const { getQuiz } = require("./quizService");
const { extractDocumentText } = require("./extractDocumentText");
const s3 = require("./s3Upload");
const db = require("./db");
const { ensureIndexedForQuiz } = require("./documentPipeline");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
  "application/octet-stream", // Một số máy/trình duyệt có thể gửi MIME chung kiểu này
]);

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = (file.mimetype || "").toLowerCase();

  const isExtensionAllowed = allowedExtensions.has(extension);

  const isMimeAllowed = allowedMimeTypes.has(mimeType);

  if (!isExtensionAllowed || !isMimeAllowed) {
    return cb(new Error("Chỉ chấp nhận file PDF hoặc Word (.doc, .docx, .docm, .dotx, .dotm)"));
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

function optionalBodyNumber(value) {
  if (value == null || !String(value).trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTags(tagsText) {
  return String(tagsText).split(",").map((tag) => tag.trim()).filter(Boolean);
}

app.get("/", (req, res) => {
  res.status(200).json({
    sucess: true,
    message: "Edumate backend is running.",
  });
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
    // Luôn lấy toàn bộ bucket cloud theo yêu cầu (prefix rỗng).
    const rows = await withTimeout(s3.listDocuments({ prefix: "", maxKeys }));
    const filtered = rows.filter((o) => isAllowedQuizExt(o.key));
    return filtered;
  } catch (err) {
    console.warn("[S3 LIST] fallback empty:", err.message);
    return [];
  }
}

/**
 * Tất cả file PDF/Word trên toàn bucket S3, ghép metadata + số chunk từ MySQL.
 */
async function buildDocumentsForQuizList() {
  if (!s3.isS3Configured()) {
    throw new Error("S3 chưa cấu hình.");
  }
  const filtered = await listS3DocsForQuiz();
  const keys = filtered.map((o) => o.key);

  let metaMap = new Map();
  if (db.isConfigured()) {
    metaMap = await db.getMetaMapForS3Keys(keys);
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
    // Không phơi lỗi nội bộ ra FE khi load danh sách.
    console.error(err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Danh sách tài liệu đang tạm thời chưa sẵn sàng.",
    });
  }
});

app.get("/api/quizzes/history", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        data: [],
        message: "MySQL chưa cấu hình.",
      });
    }
    const limit = req.query.limit;
    const userId = req.query.userId ?? req.query.user_id;
    const data = await db.listQuizHistory(limit, userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: err.message || "Không đọc được lịch sử quiz.",
    });
  }
});

app.post("/api/quiz/attempts", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: "MySQL chưa cấu hình.",
      });
    }
    const quizId = req.body.quizId ?? req.body.quiz_id;
    const userId =
      req.body.userId ??
      req.body.user_id ??
      (process.env.DEFAULT_QUIZ_USER_ID
        ? Number(process.env.DEFAULT_QUIZ_USER_ID)
        : null);
    const phase = String(req.body.phase ?? req.body.stage ?? "").toLowerCase();

    if (phase === "start") {
      await db.startQuizAttempt({ quizId, userId });
      return res.status(201).json({ success: true, message: "Đã ghi lượt bắt đầu làm bài." });
    }

    const score = req.body.score ?? req.body.correctCount ?? req.body.correct;
    await db.finishQuizAttempt({
      quizId,
      userId,
      score,
      completedAt: req.body.completedAt,
    });
    return res.status(201).json({ success: true, message: "Đã lưu kết quả lượt làm bài." });
  } catch (err) {
    console.error(err);
    return res.status(400).json({
      success: false,
      message: err.message || "Không lưu được kết quả.",
    });
  }
});

app.get("/api/s3/documents", async (req, res) => {
  try {
    if (!s3.isS3Configured()) {
      return res.status(503).json({
        success: false,
        message: "S3 chưa cấu hình (.env: AWS_REGION, keys, S3_BUCKET).",
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
    // Không phơi lỗi nội bộ ra FE khi load danh sách.
    console.error(err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Danh sách S3 đang tạm thời chưa sẵn sàng.",
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
        message: "Thiếu s3Key. RAG pipeline yêu cầu truy xuất từ vector DB trước khi tạo quiz.",
      });
    }
    if (!s3.isS3Configured()) {
      return res.status(503).json({
        success: false,
        message: "S3 chưa cấu hình.",
      });
    }
    if (!db.isConfigured()) {
      return res.status(503).json({
        success: false,
        message:
          "MySQL chưa cấu hình — cần database để lưu embedding rồi mới tạo quiz.",
      });
    }

    try {
      const idx = await ensureIndexedForQuiz(s3Key, { reindex });
      req._quizIndexMeta = idx;
    } catch (e) {
      console.error(e);
      return res.status(400).json({
        success: false,
        message: e.message || "Lỗi tải S3 / embedding / MySQL.",
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
          message: "MySQL chưa cấu hình — không lưu được quiz.",
        });
      }
      const quizTitle =
        String(req.body.quizTitle || req.body.title || "").trim() || "Quiz từ AI";
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
        message: "API key AI không hợp lệ hoặc hết hạn.",
      });
    }
    if (msg.includes("insufficient_quota") || msg.includes("quota")) {
      return res.status(402).json({
        success: false,
        message: "AI provider báo hết quota. Vui lòng kiểm tra billing.",
      });
    }
    if (status === 429 || code === "rate_limit_exceeded" || msg.includes("rate limit")) {
      return res.status(429).json({
        success: false,
        message: "AI provider rate limit — vui lòng thử lại sau.",
      });
    }
    return res.status(500).json({
      success: false,
      message: err.message || "Không tạo được quiz.",
    });
  }
}

app.post("/api/quizzes/generate", handleQuizGenerate);
app.post("/api/quiz/generate", handleQuizGenerate);

app.get("/api/quizzes/published", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({
        success: true,
        data: [],
        message: "MySQL chưa cấu hình.",
      });
    }
    const limit = req.query.limit;
    const data = await db.listPublishedQuizzes(limit);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      success: true,
      data: [],
      message: "Danh sách quiz công bố tạm thời chưa sẵn sàng.",
    });
  }
});

app.patch("/api/quizzes/:id", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const quizId = req.params.id;
    const userId = req.body.userId ?? req.body.user_id;
    const ok = await db.canUserManageQuiz(quizId, userId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Chỉ giảng viên (chủ sở hữu quiz) mới chỉnh sửa được.",
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
    console.error(err);
    return res.status(400).json({
      success: false,
      message: err.message || "Không cập nhật được quiz.",
    });
  }
});

app.post("/api/quizzes/:id/publish", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const quizId = req.params.id;
    const userId = req.body.userId ?? req.body.user_id;
    const ok = await db.canUserManageQuiz(quizId, userId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Chỉ giảng viên (chủ sở hữu quiz) mới công bố được.",
      });
    }
    await db.setQuizPublished(quizId, true);
    const row = await db.getQuizWithQuestions(quizId);
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(400).json({
      success: false,
      message: err.message || "Không công bố được quiz.",
    });
  }
});

app.get("/api/quizzes/:id", async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: "MySQL chưa cấu hình.",
      });
    }
    const row = await db.getQuizWithQuestions(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Không tìm thấy quiz." });
    }
    const viewerId =
      req.query.userId ?? req.query.user_id ?? req.query.viewerUserId ?? req.query.viewer_user_id;
    const canManage = await db.canUserManageQuiz(req.params.id, viewerId);
    if (!db.quizRowIsPublished(row) && !canManage) {
      return res.status(404).json({
        success: false,
        message: "Quiz chưa được công bố hoặc không tồn tại.",
      });
    }
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: err.message || "Lỗi đọc quiz.",
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
          message:
            "Bắt buộc cấu hình S3 (AWS_*, S3_BUCKET). Hệ thống không lưu file local.",
        });
      }

      if (!req.file || !req.file.buffer) {
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
        return res.status(400).json({
          success: false,
          message: "Vui lòng nhập đầy đủ các trường bắt buộc.",
        });
      }

      const key = s3.buildDocumentKey(req.file.originalname);
      const up = await s3.uploadDocumentBuffer({
        buffer: req.file.buffer,
        key,
        contentType: req.file.mimetype,
      });

      const row = {
        s3Key: key,
        title: title.trim(),
        courseId,
        uploaderId,
      };

      let dbNote = "";
      let documentId = null;
      if (db.isConfigured()) {
        documentId = await db.upsertDocument(row);
        dbNote = " Đã ghi vào bảng documents (MySQL).";
      } else {
        dbNote = " (MySQL chưa cấu hình — bật MYSQL_* để lưu documents + segment khi tạo quiz.)";
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
        message: `Đã upload lên S3.${dbNote}`,
        data: newDocument,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({
        success: false,
        message: err.message || "Lỗi khi upload file.",
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
        message: "MySQL chưa cấu hình — chưa có danh sách từ database.",
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
    console.error(err);
    return res.status(500).json({
      success: false,
      message: err.message || "Lỗi đọc MySQL.",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Không tìm thấy API bạn yêu cầu."
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Kích cỡ file vượt quá 10MB. Vui lòng chọn file nhỏ hơn (< 10MB)."
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message || "Lỗi upload file."
    });
  }
  return res.status(400).json({
    success: false,
    message: err.message || "Lỗi upload file."
  });
});

async function start() {
  if (!s3.isS3Configured()) {
    console.warn("S3 chưa cấu hình — upload và quiz từ S3 sẽ không chạy.");
  } else {
    console.log(`S3: bucket "${s3.getBucket()}" (${process.env.AWS_REGION}).`);
  }
  if (db.isConfigured()) {
    await db.initDb();
    console.log("MySQL: dùng schema documents + document_segments (+ quizzes nếu lưu quiz).");
  } else {
    console.warn("MySQL chưa cấu hình — quiz từ s3Key + embedding sẽ không chạy.");
  }
  app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
