const db = require("../config/teamDb");
const { generateQuizWithAI, generateQuizFromText } = require("../services/quizService");
const { ensureIndexedForQuiz } = require("../services/documentPipeline");
const { extractDocumentText } = require("../services/extractDocumentText");
const s3 = require("../services/s3Upload");
const path = require("path");
const { runAsyncJob, getAsyncJob } = require("../services/asyncJobStore");
const {
  quizNavigatePath,
  QUIZ_NAVIGATE_REPLACE_DEFAULT,
} = require("../utils/quizNavigatePath");
const { normalizeQuestionsForClient } = require("../utils/normalizeQuizClientPayload");

async function buildQuizGenerationResult(reqLike, onProgress = () => {}) {
  const body = reqLike?.body || {};
  const user = reqLike?.user || {};
  const s3Key = body.s3Key != null && String(body.s3Key).trim() ? String(body.s3Key).trim() : "";
  const reindex = body.reindex === true || body.reindex === "true";

  if (!s3Key) {
    const err = new Error("Thiếu s3Key.");
    err.status = 400;
    throw err;
  }
  if (!s3.isS3Configured()) {
    const err = new Error("S3 chưa cấu hình.");
    err.status = 503;
    throw err;
  }
  if (!db.isConfigured()) {
    const err = new Error("MySQL chưa cấu hình — cần để lưu embedding.");
    err.status = 503;
    throw err;
  }

  onProgress({ progress: 15, message: "Checking existing quiz..." });
  if (!reindex) {
    try {
      const existingQuizId = await db.findQuizByS3Key(s3Key);
      if (existingQuizId) {
        const existingQuestions = await db.getQuizQuestionsById(existingQuizId);
        if (existingQuestions.length > 0) {
          const shuffled = existingQuestions.slice().sort(() => Math.random() - 0.5);
          return {
            quiz: shuffled,
            quizId: existingQuizId,
            reused: true,
            navigateTo: quizNavigatePath(existingQuizId, { role: user?.role }),
            autoOpen: true,
            navigateReplace: QUIZ_NAVIGATE_REPLACE_DEFAULT,
          };
        }
      }
    } catch (reuseErr) {
      console.warn("[quiz/generate] Reuse check failed, proceeding to generate:", reuseErr.message);
    }
  }

  const numQuestions = Number(body.numQuestions) || 20;
  let rawQuiz = [];
  let idxMeta = null;

  // Fast path: generate directly from extracted text first to avoid
  // expensive indexing/embedding on every request.
  if (!reindex) {
    onProgress({ progress: 35, message: "Generating from document text (fast mode)..." });
    try {
      const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
      const ext = path.extname(s3Key).toLowerCase();
      const text = await extractDocumentText(buffer, ext, contentType);
      const directResult = await generateQuizFromText({
        text,
        numQuestions,
        languageHint: body.language || "Auto",
      });
      rawQuiz = Array.isArray(directResult?.questions) ? directResult.questions : [];
    } catch (fastErr) {
      console.warn("[quiz/generate] fast direct-text path failed:", fastErr.message);
    }
  }

  if (!rawQuiz.length) {
    onProgress({ progress: 50, message: "Indexing document..." });
    idxMeta = await ensureIndexedForQuiz(s3Key, { reindex });

    onProgress({ progress: 65, message: "Generating questions with vector AI..." });
    try {
      const aiResult = await generateQuizWithAI({
        s3Key,
        query: body.query ?? body.topic ?? body.keyword ?? "core concepts and key facts",
        numQuestions,
        languageHint: body.language || "Auto",
      });
      rawQuiz = Array.isArray(aiResult?.questions) ? aiResult.questions : [];
    } catch (aiErr) {
      console.warn("[quiz/generate] generateQuizWithAI failed, fallback to direct text:", aiErr.message);
    }
  }

  if (!rawQuiz.length) {
    onProgress({ progress: 75, message: "Fallback to direct document text..." });
    try {
      const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
      const ext = path.extname(s3Key).toLowerCase();
      const text = await extractDocumentText(buffer, ext, contentType);
      const directResult = await generateQuizFromText({
        text,
        numQuestions,
        languageHint: body.language || "Auto",
      });
      rawQuiz = Array.isArray(directResult?.questions) ? directResult.questions : [];
    } catch (directErr) {
      console.error("[quiz/generate] direct fallback failed:", directErr.message);
    }
  }

  if (!rawQuiz.length) {
    const err = new Error("AI không tạo được câu hỏi từ tài liệu này. Vui lòng thử lại.");
    err.status = 422;
    throw err;
  }

  onProgress({ progress: 85, message: "Saving quiz..." });
  let quizId = null;
  try {
    const quizTitle = String(body.quizTitle || body.title || "").trim() || "AI Quiz";
    const courseId = body.courseId ?? body.course_id;
    const createdBy = user?.id ?? user?.user_id ?? body.createdBy ?? body.created_by ?? body.userId;
    const documentId = idxMeta?.documentId != null ? idxMeta.documentId : await db.getDocumentIdByS3Key(s3Key);
    quizId = await db.saveQuizWithQuestions({
      title: quizTitle, courseId, createdBy,
      questions: rawQuiz, sourceFileUrl: s3Key, documentId,
    });
  } catch (saveErr) {
    console.error("[quiz/generate] Failed to persist quiz:", saveErr.message);
  }

  const shuffled = rawQuiz.slice().sort(() => Math.random() - 0.5);
  const payload = {
    quiz: shuffled,
    quizId,
    reused: false,
    navigateTo: quizId != null ? quizNavigatePath(quizId, { role: user?.role }) : null,
    autoOpen: quizId != null,
    navigateReplace: quizId != null ? QUIZ_NAVIGATE_REPLACE_DEFAULT : false,
  };
  if (idxMeta) payload.indexMeta = { reindexed: !idxMeta.skipped, chunkCount: idxMeta.chunkCount };
  return payload;
}

const generateQuiz = async (req, res) => {
  try {
    const payload = await buildQuizGenerationResult(req);
    return res.status(201).json({
      success: true,
      data: payload,
      quizId: payload.quizId ?? null,
      navigateTo: payload.navigateTo ?? null,
      autoOpen: payload.autoOpen === true,
      navigateReplace: payload.navigateReplace !== false,
    });
  } catch (err) {
    const status = err.status ?? err.statusCode;
    const msg = String(err.message || "").toLowerCase();
    console.error(err);
    if (status === 401 || msg.includes("api key")) return res.status(502).json({ success: false, message: "API key AI không hợp lệ." });
    if (msg.includes("quota")) return res.status(402).json({ success: false, message: "AI provider báo hết quota." });
    if (status === 429 || msg.includes("rate limit")) return res.status(429).json({ success: false, message: "AI provider rate limit — thử lại sau." });
    return res.status(500).json({ success: false, message: err.message || "Không tạo được quiz." });
  }
};

const generateQuizAsyncStart = async (req, res) => {
  try {
    const job = runAsyncJob({
      type: "quiz-generate",
      metadata: {
        s3Key: String(req.body?.s3Key || "").trim(),
        userId: req.user?.id ?? req.user?.user_id ?? null,
        role: req.user?.role ?? null,
      },
      runner: async ({ update }) => {
        const payload = await buildQuizGenerationResult(req, (patch) => update(patch));
        return { success: true, data: payload };
      },
    });
    return res.status(202).json({
      success: true,
      data: {
        jobId: job.jobId,
        status: job.status,
        message: "Quiz generation started",
        pollUrl: `/api/quizzes/generate-status/${job.jobId}`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Không khởi chạy được tác vụ tạo quiz." });
  }
};

const getGenerateQuizAsyncStatus = async (req, res) => {
  const jobId = String(req.params.jobId || "").trim();
  if (!jobId) return res.status(400).json({ success: false, message: "Missing jobId." });
  const job = getAsyncJob(jobId);
  if (!job) return res.status(404).json({ success: false, message: "Job not found or expired." });
  const row = {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === "completed" && job.result?.data) {
    const d = job.result.data;
    if (d.quizId != null) row.quizId = d.quizId;
    if (d.navigateTo) row.navigateTo = d.navigateTo;
    if (d.autoOpen != null) row.autoOpen = d.autoOpen;
    row.navigateReplace = d.navigateReplace !== false;
  }
  return res.status(200).json({
    success: true,
    data: row,
  });
};

const getQuizHistory = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: [], message: "MySQL chưa cấu hình." });
    }

    const limit = req.query.limit;
    const userId =
      req.query.userId ??
      req.query.user_id ??
      req.user?.id ??
      req.user?.user_id;
    const ownerOnlyParam = String(
      req.query.ownerOnly ?? req.query.owner_only ?? ""
    )
      .trim()
      .toLowerCase();
    const role = String(req.user?.role || "").trim().toUpperCase();
    const isLecturerOrAdmin = role === "LECTURER" || role === "TEACHER" || role === "ADMIN";
    // Lecturer/Admin portal should default to owner-only history,
    // so each account sees its own draft list by default.
    const ownerOnly = ownerOnlyParam
      ? ownerOnlyParam === "true" || ownerOnlyParam === "1"
      : isLecturerOrAdmin;

    const data = ownerOnly
      ? await db.listOwnedQuizzesHistory(limit, userId)
      : await db.listQuizHistory(limit, userId);

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Không đọc được lịch sử quiz." });
  }
};

const getEditedSharedQuizzes = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: [], message: "MySQL chưa cấu hình." });
    }
    const limit = req.query.limit;
    const userId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const data = await db.listEditedSharedQuizzesByStudent(limit, userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Không đọc được danh sách quiz đã được giảng viên sửa." });
  }
};

const getPublishedQuizzes = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(200).json({ success: true, data: [], message: "MySQL chưa cấu hình." });
    const data = await db.listPublishedQuizzes(req.query.limit);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ success: true, data: [], message: "Danh sách quiz công bố tạm thời chưa sẵn sàng." });
  }
};

const recordQuizAttempt = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }

    const quizId = req.body.quizId ?? req.body.quiz_id;
    const userId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }

    const phase = String(req.body.phase ?? req.body.stage ?? "").toLowerCase();

    console.log("[recordQuizAttempt] quizId =", quizId);
    console.log("[recordQuizAttempt] userId =", userId);
    console.log("[recordQuizAttempt] phase =", phase);
    console.log("[recordQuizAttempt] req.user =", req.user);
    console.log("[recordQuizAttempt] body =", req.body);

    if (phase === "start") {
      await db.startQuizAttempt({ quizId, userId });
      return res.status(201).json({ success: true, message: "Đã ghi lượt bắt đầu làm bài." });
    }

    const score = req.body.score ?? req.body.correctCount ?? req.body.correct;
    const attemptId = await db.finishQuizAttempt({
      quizId,
      userId,
      score,
      completedAt: req.body.completedAt,
      answers: req.body.answers,
      timeTaken: req.body.timeTaken,
    });

    let result = null;
    try {
      result = await db.getQuizAttemptResult(attemptId, userId);
    } catch (_) {
      // Best-effort: submission already persisted.
    }

    return res.status(201).json({
      success: true,
      message: "Đã lưu kết quả lượt làm bài.",
      data: {
        attemptId: Number(attemptId || 0) || null,
        result,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không lưu được kết quả." });
  }
};

const getQuizAttemptResult = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const attemptId = req.params.attemptId;
    const userId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const data = await db.getQuizAttemptResult(attemptId, userId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Không tìm thấy kết quả lượt làm bài." });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không đọc được kết quả lượt làm bài." });
  }
};

/** Student attempt result for lecturer/staff (same shape + manual_override); requires manage permission on quiz. */
const getQuizAttemptResultLecturer = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const staffId = req.user?.id ?? req.user?.user_id;
    const data = await db.getQuizAttemptResultForStaff(req.params.attemptId, staffId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Không tìm thấy lượt làm hoặc không có quyền xem." });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không đọc được kết quả." });
  }
};

/** PATCH body: { grades: [{ questionId, isCorrect }] } — chấm điểm lại từng câu, cập nhật score (đếm đúng). */
const manualRegradeAttempt = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const staffId = req.user?.id ?? req.user?.user_id;
    const raw = req.body.grades ?? req.body.items ?? req.body.answers;
    const list = Array.isArray(raw) ? raw : [];
    const grades = list.map((g) => ({
      questionId: g?.questionId ?? g?.question_id,
      isCorrect: !!(g?.isCorrect ?? g?.is_correct ?? g?.markedCorrect),
    }));
    const data = await db.manualRegradeQuizAttempt({
      attemptId: req.params.attemptId,
      staffUserId: staffId,
      grades,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const code = Number(err.statusCode) || 400;
    if (code === 403) {
      return res.status(403).json({ success: false, message: err.message || "Forbidden." });
    }
    if (code === 404) {
      return res.status(404).json({ success: false, message: err.message || "Not found." });
    }
    console.error(err);
    return res.status(code >= 400 && code < 600 ? code : 400).json({
      success: false,
      message: err.message || "Không cập nhật được điểm.",
    });
  }
};

const getLatestQuizAttemptResult = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const quizId = req.params.quizId;
    const userId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const data = await db.getLatestQuizAttemptResultByQuizAndUser(quizId, userId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Không tìm thấy lượt làm bài đã hoàn thành." });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không đọc được kết quả lượt làm bài mới nhất." });
  }
};

const getSharedQuizStudentResult = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const quizId = req.params.id;
    const viewerId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const canManage = await db.canUserManageQuiz(quizId, viewerId);
    if (!canManage) {
      return res.status(403).json({ success: false, message: "Bạn không có quyền xem kết quả chia sẻ này." });
    }
    const quizRow = await db.getQuizWithQuestions(quizId);
    if (!quizRow) return res.status(404).json({ success: false, message: "Không tìm thấy quiz." });
    const sharedStudentId = quizRow?.shared_by_user_id;
    if (!sharedStudentId) {
      return res.status(404).json({ success: false, message: "Quiz này chưa có student share source." });
    }
    const data = await db.getLatestQuizAttemptResultByQuizAndUser(quizId, sharedStudentId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Không tìm thấy attempt của student đã share." });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không đọc được kết quả share của student." });
  }
};

const getQuizById = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const row = await db.getQuizWithQuestions(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Không tìm thấy quiz." });
    const viewerId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const canManage = await db.canUserManageQuiz(req.params.id, viewerId);
    if (!db.quizRowIsPublished(row) && !canManage) {
      return res.status(404).json({ success: false, message: "Quiz chưa được công bố hoặc không tồn tại." });
    }
    const envMins = Number(process.env.QUIZ_DEFAULT_TIME_LIMIT_MINUTES);
    const fallbackMins = Number.isFinite(envMins) && envMins > 0 ? envMins : 10;
    const payload = {
      ...row,
      questions: normalizeQuestionsForClient(row.questions || []),
      timeLimitMinutes: Number(row.time_limit_minutes ?? row.timeLimitMinutes) || fallbackMins,
      durationMinutes: Number(row.time_limit_minutes ?? row.timeLimitMinutes) || fallbackMins,
    };
    return res.status(200).json({ success: true, data: payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Lỗi đọc quiz." });
  }
};

const updateQuiz = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const { id } = req.params;
    const userId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;
    const ok = await db.canUserManageQuiz(id, userId);
    if (!ok) return res.status(403).json({ success: false, message: "Chỉ giảng viên (chủ sở hữu quiz) mới chỉnh sửa được." });
    const role = await db.getUserRole(userId);
    const rowBefore = await db.getQuizWithQuestions(id);
    if (req.body.title != null && String(req.body.title).trim()) await db.updateQuizTitle(id, req.body.title);
    if (Array.isArray(req.body.questions)) await db.replaceQuizQuestions(id, req.body.questions);
    if (
      rowBefore &&
      Number(rowBefore.shared_from_student || 0) === 1 &&
      (String(role || "").toUpperCase() === "LECTURER" || String(role || "").toUpperCase() === "TEACHER" || String(role || "").toUpperCase() === "ADMIN")
    ) {
      await db.markQuizEditedByLecturer({ quizId: id, lecturerUserId: userId });
    }
    const row = await db.getQuizWithQuestions(id);
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không cập nhật được quiz." });
  }
};

const publishQuiz = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const { id } = req.params;
    const userId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;
    const ok = await db.canUserManageQuiz(id, userId);
    if (!ok) return res.status(403).json({ success: false, message: "Chỉ giảng viên (chủ sở hữu quiz) mới công bố được." });
    await db.setQuizPublished(id, true);
    const row = await db.getQuizWithQuestions(id);
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không công bố được quiz." });
  }
};

const deleteQuiz = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const { id } = req.params;
    const userId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id ?? req.query.userId ?? req.query.user_id;
    const ok = await db.canUserManageQuiz(id, userId);
    if (!ok) return res.status(403).json({ success: false, message: "Chỉ giảng viên (chủ sở hữu quiz) mới xóa được." });
    const removed = await db.deleteQuizById(id);
    if (!removed) return res.status(404).json({ success: false, message: "Không tìm thấy quiz để xóa." });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không xóa được quiz." });
  }
};

const getLeaderboard = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const requestingUserId = req.user?.id ?? req.query.userId ?? null;
    const result = await db.getLeaderboard({ limit, requestingUserId });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ success: false, message: err.message || "Không tải được leaderboard." });
  }
};

const createQuiz = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }

    const createdBy = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;
    const title = String(req.body.title || "").trim();
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    const status = String(req.body.status || "draft").trim().toLowerCase();
    const courseId = req.body.courseId ?? req.body.course_id ?? null;

    if (!title) {
      return res.status(400).json({ success: false, message: "Quiz title is required." });
    }
    if (!questions.length) {
      return res.status(400).json({ success: false, message: "At least one question is required." });
    }

    const quizId = await db.saveQuizWithQuestions({
      title,
      courseId,
      createdBy,
      questions,
      sourceFileUrl: null,
      documentId: null,
    });

    if (status === "published") {
      await db.setQuizPublished(quizId, true);
    }

    const row = await db.getQuizWithQuestions(quizId);
    const navigateTo = quizNavigatePath(quizId, { role: req.user?.role });
    return res.status(201).json({
      success: true,
      data: row,
      quizId,
      navigateTo,
      autoOpen: true,
      navigateReplace: QUIZ_NAVIGATE_REPLACE_DEFAULT,
    });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không tạo được quiz." });
  }
};

const getQuestionBank = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const userId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const data = await db.listQuestionBankItems(userId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Không tải được question bank." });
  }
};

const createQuestionBankItem = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const ownerUserId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;

    const row = await db.insertQuestionBankItem({
      ownerUserId,
      question: req.body.question,
      type: req.body.type,
      topic: req.body.topic,
      category: req.body.category,
      difficulty: req.body.difficulty,
      options: req.body.options,
      correctAnswer: req.body.correctAnswer,
      mediaType: req.body.mediaType ?? req.body.media_type,
      mediaUrl: req.body.mediaUrl ?? req.body.media_url ?? req.body.youtubeUrl,
    });

    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không thêm được câu hỏi." });
  }
};

const updateQuestionBankItem = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const ownerUserId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;

    const row = await db.updateQuestionBankItem(req.params.id, ownerUserId, {
      question: req.body.question,
      type: req.body.type,
      topic: req.body.topic,
      category: req.body.category,
      difficulty: req.body.difficulty,
      options: req.body.options,
      correctAnswer: req.body.correctAnswer,
      mediaType: req.body.mediaType ?? req.body.media_type,
      mediaUrl: req.body.mediaUrl ?? req.body.media_url ?? req.body.youtubeUrl,
    });

    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không cập nhật được câu hỏi." });
  }
};

const deleteQuestionBankItem = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const actorUserId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const ok = await db.deleteQuestionBankItem(req.params.id, actorUserId, {
      // This endpoint is already protected by RBAC(LECTURER, ADMIN).
      // Delete by item_id to match FE behavior showing/managing by ID.
      allowAnyOwner: true,
    });
    if (!ok) {
      return res.status(404).json({ success: false, message: "Không tìm thấy câu hỏi để xóa." });
    }
    return res.status(200).json({ success: true, message: "Đã xóa câu hỏi." });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không xóa được câu hỏi." });
  }
};

const getQuizAnalytics = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }

    const userId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const topQuestions = req.query.topQuestions ?? req.query.top_questions ?? 5;

    const data = await db.getQuizAnalyticsByOwner(userId, topQuestions);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Không tải được quiz analytics." });
  }
};

const shareQuizForReview = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const quizId = req.params.id;
    const userId = req.user?.id ?? req.user?.user_id ?? req.body.userId ?? req.body.user_id;
    await db.shareQuizForReview({ quizId, userId });
    return res.status(200).json({ success: true, message: "Quiz shared successfully for lecturer review." });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không thể chia sẻ quiz." });
  }
};

/** GET /api/quizzes/:quizId/attempts — list completed attempts (lecturer student-attempts modal) */
const listQuizAttemptsForStaff = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    }
    const qid = Number(req.params.quizId);
    if (!Number.isFinite(qid) || qid <= 0) {
      return res.status(400).json({ success: false, message: "Invalid quiz id." });
    }
    const staffId = Number(req.user?.id ?? req.user?.user_id);
    if (!Number.isFinite(staffId) || staffId <= 0) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    const quiz = await db.getQuizWithQuestions(qid);
    if (!quiz) {
      return res.status(404).json({ success: false, message: "Quiz not found." });
    }
    const allowed = await db.canUserManageQuiz(qid, staffId);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this quiz's attempts.",
      });
    }
    const rows = await db.listCompletedQuizAttemptsByQuizId(qid);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error("[listQuizAttemptsForStaff]", err);
    return res.status(500).json({ success: false, message: err.message || "Server error." });
  }
};

module.exports = {
  generateQuiz,
  getQuizHistory,
  getEditedSharedQuizzes,
  getPublishedQuizzes,
  recordQuizAttempt,
  getQuizAttemptResult,
  getQuizAttemptResultLecturer,
  manualRegradeAttempt,
  getLatestQuizAttemptResult,
  getSharedQuizStudentResult,
  getQuizById,
  updateQuiz,
  publishQuiz,
  deleteQuiz,
  getLeaderboard,
  createQuiz,
  getQuizAnalytics,
  listQuizAttemptsForStaff,
  shareQuizForReview,
  getQuestionBank,
  createQuestionBankItem,
  updateQuestionBankItem,
  deleteQuestionBankItem,
  generateQuizAsyncStart,
  getGenerateQuizAsyncStatus,
};
