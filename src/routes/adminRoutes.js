const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const rbac = require("../middleware/rbac");
const User = require("../models/User");
const ActivityLog = require("../models/ActivityLog");
const { logActivity } = require("../middleware/activityLog");

// All admin routes require ADMIN role (Design: E03 Administrator)

// List all users
router.get("/users", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: ["user_id", "email", "full_name", "role", "user_code", "is_verified", "is_active", "created_at"],
            order: [["created_at", "DESC"]],
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

        logActivity(req.user.id, "update_user_role", `Updated role for ${user.email} to ${role}`, req.ip);

        return res.json({ success: true, message: `User role updated to ${role}.`, data: { user_id: user.user_id, role: user.role } });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Deactivate / activate user
// Alternate endpoint for activating/deactivating user (in case PATCH status route is unreachable)
router.patch("/users/:id/activate", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const { is_active } = req.body;
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        user.is_active = is_active === true || is_active === "true" ? true : false;
        await user.save();

        logActivity(req.user.id, user.is_active ? "activate_user" : "deactivate_user", `Admin ${user.is_active ? "activated" : "deactivated"} account ${user.email}`, req.ip);

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
            `SELECT doc.*, u.name as uploader_name, u.email as uploader_email 
             FROM documents doc 
             LEFT JOIN users u ON doc.uploader_id = u.user_id 
             WHERE doc.status = 'pending' 
             ORDER BY doc.document_id DESC LIMIT 100`
        );
        return res.json({ success: true, data: docs });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Moderate document (verify/reject)
router.patch("/documents/:id/:action(verify|reject)", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const { action } = req.params;
        const status = action === 'verify' ? 'verified' : 'rejected';
        
        const Document = require("../models/Document");
        const doc = await Document.findByPk(req.params.id);
        
        if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
        
        doc.status = status;
        await doc.save();

        logActivity(req.user.id, `moderate_document_${action}`, `Document ${doc.document_id} marked as ${status}`, req.ip);

        return res.json({ success: true, message: `Document marked as ${status}.` });
    } catch (err) {
        console.error("[Admin API Error /documents/moderate]", err);
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

// Log archives listing
router.get("/logs/archives", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const s3 = require("../services/s3Upload");
        if (!s3.isS3Configured()) {
            return res.json({ success: true, data: [] });
        }
        const archives = await s3.listLogArchives();
        const mapped = archives.map(a => ({
            key: a.key,
            fileName: require("path").basename(a.key),
            sizeKB: Math.round((a.size || 0) / 1024),
            lastModified: a.lastModified
        }));
        return res.json({ success: true, data: mapped });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/logs/archives/download", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const { key } = req.query;
        if (!key) return res.status(400).json({ success: false, message: "Key is required." });
        const s3 = require("../services/s3Upload");
        if (!s3.isS3Configured()) {
            return res.status(503).json({ success: false, message: "S3 not configured." });
        }
        const url = await s3.buildSignedUrl(key);
        return res.json({ success: true, data: { url } });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Log stats
router.get("/logs/stats", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const totalLogs = await ActivityLog.count();
        const oldest = await ActivityLog.findOne({
            order: [['created_at', 'ASC']],
            attributes: ['created_at']
        });
        return res.json({ 
            success: true, 
            data: { 
                totalInDb: totalLogs, 
                oldestLog: oldest ? oldest.created_at : null 
            } 
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Archive now (Export logs older than X days to S3, then delete from DB)
router.post("/logs/archive-now", auth, rbac("ADMIN"), async (req, res) => {
    try {
        const { retentionDays = 30 } = req.body;
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        
        // 1. Fetch logs to archive
        const logsToArchive = await ActivityLog.findAll({
            where: {
                created_at: {
                    [require("sequelize").Op.lt]: cutoff
                }
            },
            include: [{ model: require("../models/User"), attributes: ["email"] }],
            order: [["created_at", "ASC"]]
        });

        if (logsToArchive.length === 0) {
            return res.json({ 
                success: true, 
                message: `No logs older than ${retentionDays} days were found. Nothing to archive.` 
            });
        }

        // 2. Format as JSON
        const archiveData = JSON.stringify(logsToArchive, null, 2);
        const timestamp = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const fileName = `activity_logs_${timestamp}.json`;
        const s3Key = `LOGS/archive/${fileName}`;

        // 3. Upload to S3
        const s3 = require("../services/s3Upload");
        if (s3.isS3Configured()) {
            await s3.uploadDocumentBuffer({
                buffer: Buffer.from(archiveData),
                key: s3Key,
                contentType: "application/json"
            });
        } else {
            console.warn("[ArchiveNow] S3 not configured, logs deleted from DB without backup.");
        }

        // 4. Delete from DB
        const deletedCount = await ActivityLog.destroy({
            where: {
                created_at: {
                    [require("sequelize").Op.lt]: cutoff
                }
            }
        });

        return res.json({ 
            success: true, 
            message: `Archiving completed. ${deletedCount} log(s) exported to S3 and removed from database.`,
            data: { fileName, s3Key, deletedCount }
        });
    } catch (err) {
        console.error("[ArchiveNow] Error:", err);
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
