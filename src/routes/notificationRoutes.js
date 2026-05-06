const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Notification = require('../models/Notification');

const VALID_TYPES = new Set(['info', 'success', 'warning', 'error']);

function getCurrentUserId(req) {
  return req.user?.id || req.user?.user_id;
}

// GET /api/notifications
// Default: only unread notifications
// Optional:
// - ?includeRead=true
// - ?type=success|info|warning|error
router.get('/', auth, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    const includeRead = String(req.query.includeRead || '').toLowerCase() === 'true';
    const type = String(req.query.type || '').toLowerCase();

    const where = {
      user_id: userId,
    };

    if (!includeRead) {
      where.is_read = false;
    }

    if (VALID_TYPES.has(type)) {
      where.type = type;
    }

    const notifications = await Notification.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: 50,
    });

    return res.json({
      success: true,
      data: notifications,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// PATCH /api/notifications/read-all
// Body optional:
// { "type": "success" }
router.patch('/read-all', auth, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    const type = String(req.body?.type || '').toLowerCase();

    const where = {
      user_id: userId,
      is_read: false,
    };

    if (VALID_TYPES.has(type)) {
      where.type = type;
    }

    const [updatedCount] = await Notification.update(
      { is_read: true },
      { where }
    );

    return res.json({
      success: true,
      message: 'Notifications marked as read.',
      data: {
        updatedCount,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// PATCH /api/notifications/:id/read - Mark one notification as read
router.patch('/:id/read', auth, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    const notification = await Notification.findOne({
      where: {
        notification_id: req.params.id,
        user_id: userId,
      },
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found.',
      });
    }

    notification.is_read = true;
    await notification.save();

    return res.json({
      success: true,
      message: 'Notification marked as read.',
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// DELETE /api/notifications/:id - Delete one notification
router.delete('/:id', auth, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    const result = await Notification.destroy({
      where: {
        notification_id: req.params.id,
        user_id: userId,
      },
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found.',
      });
    }

    return res.json({
      success: true,
      message: 'Notification deleted.',
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;