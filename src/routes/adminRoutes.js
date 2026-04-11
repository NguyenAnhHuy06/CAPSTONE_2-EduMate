const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const rbac = require("../middleware/rbac");
const User = require("../models/User");
const ActivityLog = require("../models/ActivityLog");

// All admin routes require ADMIN role (Design: E03 Administrator)

// List all users
router.get("/users", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: ["id", "email", "full_name", "role", "user_code", "is_verified", "is_active", "createdAt"],
            order: [["createdAt", "DESC"]],
        });
        return res.json({ success: true, data: users });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Update user role
router.patch("/users/:id/role", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const { role } = req.body;
        if (!["STUDENT", "LECTURER", "ADMIN"].includes(role)) {
            return res.status(400).json({ success: false, message: "Invalid role. Must be STUDENT, LECTURER, or ADMIN." });
        }
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        user.role = role;
        await user.save();
        return res.json({ success: true, message: `User role updated to ${role}.`, data: { id: user.id, role: user.role } });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Deactivate / activate user
router.patch("/users/:id/status", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const { is_active } = req.body;
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        user.is_active = is_active === true || is_active === "true" ? true : false;
        await user.save();
        return res.json({ success: true, message: `User ${user.is_active ? "activated" : "deactivated"}.` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// List pending documents for moderation (Design: UC04)
router.get("/documents/pending", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const db = require("../config/teamDb");
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: "Database not configured." });
        const [docs] = await db.getPool().execute(
            `SELECT doc.*, u.full_name as uploader_name, u.email as uploader_email 
             FROM documents doc 
             LEFT JOIN users u ON doc.uploader_id = u.id 
             WHERE doc.status = 'pending' 
             ORDER BY doc.created_at DESC LIMIT 100`
        );
        return res.json({ success: true, data: docs });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Activity logs (Design: activity_logs table)
router.get("/activity-logs", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 100, 500);
        const logs = await ActivityLog.findAll({
            include: [{
                model: User,
                attributes: ['email']
            }],
            order: [["created_at", "DESC"]],
            limit,
        });

        // Map email to the flat object for the frontend
        const mappedLogs = logs.map(l => {
            const raw = l.toJSON();
            return {
                ...raw,
                email: raw.User ? raw.User.email : null
            };
        });

        return res.json({ success: true, data: mappedLogs });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// System stats
router.get("/stats", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const userCount = await User.count();
        const verifiedUsers = await User.count({ where: { is_verified: true } });

        const db = require("../config/teamDb");
        let docCount = 0, quizCount = 0, segmentCount = 0;
        if (db.isConfigured()) {
            const pool = db.getPool();
            const [[{ cnt: dc }]] = await pool.execute("SELECT COUNT(*) as cnt FROM documents");
            const [[{ cnt: qc }]] = await pool.execute("SELECT COUNT(*) as cnt FROM quizzes");
            const [[{ cnt: sc }]] = await pool.execute("SELECT COUNT(*) as cnt FROM document_segments");
            docCount = dc;
            quizCount = qc;
            segmentCount = sc;
        }

        return res.json({
            success: true,
            data: {
                users: { total: userCount, verified: verifiedUsers },
                documents: docCount,
                quizzes: quizCount,
                document_segments: segmentCount,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
