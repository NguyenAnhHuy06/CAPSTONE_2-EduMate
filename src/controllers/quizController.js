const db = require("../config/teamDb");
const { generateQuizWithAI, generateQuizFromText } = require("../services/quizService");
const { ensureIndexedForQuiz } = require("../services/documentPipeline");
const { extractDocumentText } = require("../services/extractDocumentText");
const s3 = require("../services/s3Upload");
const path = require("path");

const generateQuiz = async (req, res) => {
  try {
    const s3Key = req.body.s3Key != null && String(req.body.s3Key).trim() ? String(req.body.s3Key).trim() : "";
    const reindex = req.body.reindex === true || req.body.reindex === "true";

    if (!s3Key) {
      return res.status(400).json({ success: false, message: "Thiếu s3Key." });
    }
    if (!s3.isS3Configured()) return res.status(503).json({ success: false, message: "S3 chưa cấu hình." });
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình — cần để lưu embedding." });

    // ── REUSE PATH: check if a quiz already exists for this document ──────────
    if (!reindex) {
      try {
        const existingQuizId = await db.findQuizByS3Key(s3Key);
        if (existingQuizId) {
          const existingQuestions = await db.getQuizQuestionsById(existingQuizId);
          if (existingQuestions.length > 0) {
            // Shuffle questions to provide variety
            const shuffled = existingQuestions.slice().sort(() => Math.random() - 0.5);
            console.log(`[quiz/generate] Reusing existing quiz ${existingQuizId} (${shuffled.length} questions) for s3Key=${s3Key}`);
            return res.status(200).json({
              success: true,
              data: { quiz: shuffled, quizId: existingQuizId, reused: true },
            });
          }
        }
      } catch (reuseErr) {
        // Non-fatal: if reuse check fails, fall through to generate
        console.warn("[quiz/generate] Reuse check failed, proceeding to generate:", reuseErr.message);
      }
    }

    // ── GENERATE PATH: index document (embed), then vector search → AI ───────
    let idxMeta;
    try {
      idxMeta = await ensureIndexedForQuiz(s3Key, { reindex });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || "Lỗi tải S3 / embedding / MySQL." });
    }

    const numQuestions = Number(req.body.numQuestions) || 20;

    let rawQuiz = [];
    let targetCount = numQuestions;
    let generationMode = "vector-ai";

    try {
      const aiResult = await generateQuizWithAI({
        s3Key,
        query: req.body.query ?? req.body.topic ?? req.body.keyword ?? "core concepts and key facts",
        numQuestions,
        languageHint: "Auto",
      });
      rawQuiz = Array.isArray(aiResult?.questions) ? aiResult.questions : [];
      targetCount = aiResult?.targetCount ?? numQuestions;
    } catch (aiErr) {
      console.warn("[quiz/generate] generateQuizWithAI failed, fallback to direct text:", aiErr.message);
    }

    if (!rawQuiz.length) {
      try {
        const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
        const ext = path.extname(s3Key).toLowerCase();
        const text = await extractDocumentText(buffer, ext, contentType);

        const directResult = await generateQuizFromText({
          text,
          numQuestions,
          languageHint: req.body.language || "Auto",
        });

        rawQuiz = Array.isArray(directResult?.questions) ? directResult.questions : [];
        targetCount = directResult?.targetCount ?? numQuestions;
        generationMode = "direct-text";
      } catch (directErr) {
        console.error("[quiz/generate] direct fallback failed:", directErr.message);
      }
    }

    if (!rawQuiz.length) {
      return res.status(422).json({
        success: false,
        message: "AI không tạo được câu hỏi từ tài liệu này. Vui lòng thử lại.",
      });
    }

    // ── PERSIST: save quiz to DB for future reuse ─────────────────────────────
    let quizId = null;
    try {
      const quizTitle = String(req.body.quizTitle || req.body.title || "").trim() || "AI Quiz";
      const courseId = req.body.courseId ?? req.body.course_id;
      const createdBy = req.user?.id ?? req.user?.user_id ?? req.body.createdBy ?? req.body.created_by ?? req.body.userId;
      const documentId = idxMeta?.documentId != null ? idxMeta.documentId : await db.getDocumentIdByS3Key(s3Key);
      quizId = await db.saveQuizWithQuestions({
        title: quizTitle, courseId, createdBy,
        questions: rawQuiz, sourceFileUrl: s3Key, documentId,
      });
      console.log(`[quiz/generate] Saved new quiz ${quizId} with ${rawQuiz.length} questions`);
    } catch (saveErr) {
      // Non-fatal: still return the quiz even if saving fails
      console.error("[quiz/generate] Failed to persist quiz:", saveErr.message);
    }

    // Shuffle before returning
    const shuffled = rawQuiz.slice().sort(() => Math.random() - 0.5);
    const payload = { quiz: shuffled, quizId, reused: false };
    if (idxMeta) payload.indexMeta = { reindexed: !idxMeta.skipped, chunkCount: idxMeta.chunkCount };

    return res.status(201).json({ success: true, data: payload });
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

const getQuizHistory = async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.status(200).json({ success: true, data: [], message: "MySQL chưa cấu hình." });
    }

    const limit = req.query.limit;
    const userId = req.query.userId ?? req.query.user_id;
    const ownerOnly = String(req.query.ownerOnly || "").trim().toLowerCase() === "true";

    const data = ownerOnly
      ? await db.listOwnedQuizzesHistory(limit, userId)
      : await db.listQuizHistory(limit, userId);

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Không đọc được lịch sử quiz." });
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
    await db.finishQuizAttempt({
      quizId,
      userId,
      score,
      completedAt: req.body.completedAt,
      answers: req.body.answers,
      timeTaken: req.body.timeTaken,
    });

    return res.status(201).json({ success: true, message: "Đã lưu kết quả lượt làm bài." });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, message: err.message || "Không lưu được kết quả." });
  }
};

const getQuizResult = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    
    const attemptId = req.params.attemptId || req.params.id;
    const userId = req.user?.id ?? req.user?.user_id ?? req.query.userId;
    
    const data = await db.getAttemptResult(attemptId, userId);
    if (!data) return res.status(404).json({ success: false, message: "Không tìm thấy kết quả làm bài." });
    
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Lỗi đọc kết quả." });
  }
};

const getQuizById = async (req, res) => {
  try {
    if (!db.isConfigured()) return res.status(503).json({ success: false, message: "MySQL chưa cấu hình." });
    const row = await db.getQuizWithQuestions(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Không tìm thấy quiz." });
    const viewerId = req.query.userId ?? req.query.user_id;
    const canManage = await db.canUserManageQuiz(req.params.id, viewerId);
    if (!db.quizRowIsPublished(row) && !canManage) {
      return res.status(404).json({ success: false, message: "Quiz chưa được công bố hoặc không tồn tại." });
    }
    return res.status(200).json({ success: true, data: row });
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
    if (req.body.title != null && String(req.body.title).trim()) await db.updateQuizTitle(id, req.body.title);
    if (Array.isArray(req.body.questions)) await db.replaceQuizQuestions(id, req.body.questions);
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
    return res.status(201).json({ success: true, data: row });
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
    const ownerUserId = req.user?.id ?? req.user?.user_id ?? req.query.userId ?? req.query.user_id;
    const ok = await db.deleteQuestionBankItem(req.params.id, ownerUserId);
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

module.exports = {
  generateQuiz,
  getQuizHistory,
  getPublishedQuizzes,
  recordQuizAttempt,
  getQuizResult,
  getQuizById,
  updateQuiz,
  publishQuiz,
  getLeaderboard,
  createQuiz,
  getQuizAnalytics,
  getQuestionBank,
  createQuestionBankItem,
  updateQuestionBankItem,
  deleteQuestionBankItem,
};
