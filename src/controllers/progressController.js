const teamDb = require('../config/teamDb');

async function getProgressSummary(req, res) {
  try {
    const rawUserId = req.query.userId ?? req.user?.id ?? req.user?.user_id;
    const userId = Number(rawUserId);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'userId is required and must be a valid number.',
      });
    }

    const data = await teamDb.getProgressSummary(userId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[progress] getProgressSummary error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to load progress summary.',
    });
  }
}

module.exports = {
  getProgressSummary,
};