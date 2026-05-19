const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { askQuestion, getSessions, getSessionMessages } = require("../controllers/chatController");
const { activityLogMiddleware } = require("../middleware/activityLog");

// AI Chat — all authenticated users (Design: UC02)
router.post("/ask", auth, activityLogMiddleware("ai_chat"), askQuestion);
router.get("/sessions", auth, getSessions);
router.get("/sessions/:id/messages", auth, getSessionMessages);

module.exports = router;
