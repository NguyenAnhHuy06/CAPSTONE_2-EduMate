const ActivityLog = require("../models/ActivityLog");

/**
 * Activity logging middleware — logs key user actions
 * Design ref: Database Design "activity_logs" table
 * 
 * Usage: logActivity('upload_document', 'Uploaded file xyz.pdf')
 */
async function logActivity(userId, action, details, ipAddress) {
    try {
        await ActivityLog.create({
            user_id: userId || null,
            action: String(action || "unknown").substring(0, 100),
            details: details ? String(details).substring(0, 2000) : null,
            ip_address: ipAddress || null,
        });
    } catch (err) {
        // Non-fatal: don't crash the request if logging fails
        console.warn("[ActivityLog] Failed to log:", err.message);
    }
}

/**
 * Express middleware that auto-logs requests to specific endpoints
 */
function activityLogMiddleware(action) {
    return (req, res, next) => {
        // Log after response is sent
        res.on("finish", () => {
            if (res.statusCode < 400) {
                const userId = req.user?.user_id || null;
                const ip = req.ip || req.connection?.remoteAddress || null;
                logActivity(userId, action, `${req.method} ${req.originalUrl}`, ip);
            }
        });
        next();
    };
}

module.exports = { logActivity, activityLogMiddleware };
