const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const { getProgressSummary } = require('../controllers/progressController');

router.get('/summary', authMiddleware, getProgressSummary);

module.exports = router;