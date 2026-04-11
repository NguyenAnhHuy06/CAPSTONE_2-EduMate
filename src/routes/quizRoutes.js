const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const rbac = require("../middleware/rbac");
const {
  generateQuiz,
  getQuizHistory,
  getPublishedQuizzes,
  recordQuizAttempt,
  getQuizById,
  updateQuiz,
  publishQuiz,
} = require("../controllers/quizController");
const { getS3Documents } = require("../controllers/documentController");

// Quiz generation — any authenticated user (Design: UC03)
router.post("/quizzes/generate", auth, generateQuiz);
router.post("/quiz/generate", auth, generateQuiz);

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
router.get("/quizzes/published", auth, getPublishedQuizzes);
router.post("/quiz/attempts", auth, recordQuizAttempt);
router.get("/quizzes/:id", auth, getQuizById);

// Quiz management — Lecturer/Admin only (Design: UC03 Lecturer Flow)
router.patch("/quizzes/:id", auth, rbac("LECTURER", "ADMIN"), updateQuiz);
router.post("/quizzes/:id/publish", auth, rbac("LECTURER", "ADMIN"), publishQuiz);

// S3 listing — authenticated
router.get("/s3/documents", auth, getS3Documents);

module.exports = router;
