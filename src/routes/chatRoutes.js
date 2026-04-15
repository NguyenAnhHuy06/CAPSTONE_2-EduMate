const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { askQuestion, getSessions, getSessionMessages } = require("../controllers/chatController");

// AI Chat — all authenticated users (Design: UC02)
router.post("/ask", askQuestion);
router.get("/sessions", auth, getSessions);
router.get("/sessions/:id/messages", auth, getSessionMessages);

module.exports = router;
