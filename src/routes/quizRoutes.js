const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const optionalAuth = auth.optionalAuth;
const rbac = require("../middleware/rbac");

/** Lecturer-facing quiz APIs (includes TEACHER — some DBs use TEACHER instead of LECTURER). */
const staffRoles = ["LECTURER", "TEACHER", "ADMIN"];

const {
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
} = require("../controllers/quizController");
const { getS3Documents } = require("../controllers/documentController");

// Quiz generation — any authenticated user (Design: UC03)
// Default to async generation so FE can run in background.
router.post("/quizzes/generate", auth, generateQuizAsyncStart);
router.post("/quiz/generate", auth, generateQuizAsyncStart);
router.post("/quizzes/generate-async", auth, generateQuizAsyncStart);
router.post("/quiz/generate-async", auth, generateQuizAsyncStart);
// Keep a sync fallback endpoint for backward compatibility.
router.post("/quizzes/generate-sync", auth, generateQuiz);
router.post("/quiz/generate-sync", auth, generateQuiz);
router.get("/quizzes/generate-status/:jobId", auth, getGenerateQuizAsyncStatus);
router.get("/quiz/generate-status/:jobId", auth, getGenerateQuizAsyncStatus);

// Direct quiz route (fallback, no embedding) — authenticated
router.post("/quiz/generate-direct", auth, async (req, res) => {
  try {
    const s3 = require("../services/s3Upload");
    const { extractDocumentText } = require("../services/extractDocumentText");
    const { generateQuizFromText } = require("../services/quizService");
    const path = require("path");

    const s3Key = String(req.body.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ success: false, message: "Missing s3Key." });
    if (!s3.isS3Configured()) return res.status(503).json({ success: false, message: "S3 not configured." });

    const { buffer, contentType } = await s3.getObjectBuffer(s3Key);
    const ext = path.extname(s3Key).toLowerCase();
    const text = await extractDocumentText(buffer, ext, contentType);
    if (!text || !text.trim()) {
      return res.status(422).json({ success: false, message: "Could not extract text from document." });
    }

    const numQuestions = Number(req.body.numQuestions) || 5;
    const languageHint = req.body.language || "Auto";
    const { questions } = await generateQuizFromText({ text, numQuestions, languageHint });

    return res.status(200).json({ success: true, data: { quiz: questions } });
  } catch (err) {
    console.error("[quiz/generate-direct]", err.message);
    return res.status(500).json({ success: false, message: err.message || "Quiz generation failed." });
  }
});

// Quiz CRUD — authenticated
router.get("/quizzes/history", auth, getQuizHistory);
router.get("/quizzes/edited-by-lecturer", auth, getEditedSharedQuizzes);
// FE compatibility alias for lecturer tab "Shared by Students".
router.get("/quizzes/shared-by-students", auth, getEditedSharedQuizzes);
router.get("/quizzes/published", auth, getPublishedQuizzes);
router.get("/quizzes/analytics", auth, rbac(...staffRoles), getQuizAnalytics);
/** Instructor portal — student attempts list per quiz (must be before /quizzes/:id) */
router.get("/quizzes/:quizId/attempts", auth, rbac(...staffRoles), listQuizAttemptsForStaff);
router.get("/leaderboard", auth, getLeaderboard);
router.post("/quiz/attempts", auth, recordQuizAttempt);
router.get("/quiz/result/:attemptId", auth, getQuizAttemptResult);
router.get("/quiz/attempts/:attemptId/lecturer", auth, rbac(...staffRoles), getQuizAttemptResultLecturer);
router.patch("/quiz/attempts/:attemptId/grade", auth, rbac(...staffRoles), manualRegradeAttempt);
router.get("/quiz/result/latest/:quizId", auth, getLatestQuizAttemptResult);
router.get("/quizzes/:id/shared-student-result", auth, rbac(...staffRoles), getSharedQuizStudentResult);
router.get("/quizzes/:id", optionalAuth, getQuizById);
router.post("/quizzes/:id/share", auth, shareQuizForReview);

// Quiz management — Lecturer/Admin only (Design: UC03 Lecturer Flow)
router.patch("/quizzes/:id", auth, rbac(...staffRoles), updateQuiz);
router.post("/quizzes/:id/publish", auth, rbac(...staffRoles), publishQuiz);
router.delete("/quizzes/:id", auth, rbac(...staffRoles), deleteQuiz);

// S3 listing — authenticated
router.get("/s3/documents", auth, getS3Documents);

// Question bank management — Lecturer/Admin only
router.post("/quizzes", auth, rbac(...staffRoles), createQuiz);

// Question bank routes
router.get("/questions/bank", auth, rbac(...staffRoles), getQuestionBank);
router.post("/questions/bank", auth, rbac(...staffRoles), createQuestionBankItem);
router.patch("/questions/bank/:id", auth, rbac(...staffRoles), updateQuestionBankItem);
router.delete("/questions/bank/:id", auth, rbac(...staffRoles), deleteQuestionBankItem);

module.exports = router;
