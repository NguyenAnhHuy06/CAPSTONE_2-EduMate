const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Notification = require('../models/Notification');

// GET /api/notifications - Fetch all notifications for the current user
router.get('/', auth, async (req, res) => {
    try {
        const notifications = await Notification.findAll({
            where: { user_id: req.user.id },
            order: [['created_at', 'DESC']],
            limit: 50
        });
        return res.json({ success: true, data: notifications });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// PATCH /api/notifications/:id/read - Mark a notification as read
router.patch('/:id/read', auth, async (req, res) => {
    try {
        const notification = await Notification.findOne({
            where: { notification_id: req.params.id, user_id: req.user.id }
        });
        
        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found.' });
        }

        notification.is_read = true;
        await notification.save();

        return res.json({ success: true, message: 'Notification marked as read.' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE /api/notifications/:id - Delete a notification
router.delete('/:id', auth, async (req, res) => {
    try {
        const result = await Notification.destroy({
            where: { notification_id: req.params.id, user_id: req.user.id }
        });
        
        if (!result) {
            return res.status(404).json({ success: false, message: 'Notification not found.' });
        }

        return res.json({ success: true, message: 'Notification deleted.' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
