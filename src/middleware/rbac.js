/**
 * RBAC middleware — checks req.user.role against allowed roles
 * Design ref: Architecture 5.1 — "API Gateway equipped with RBAC Middleware"
 *
 * Usage:
 *   router.get('/admin-only', rbac('ADMIN'), handler);
 *   router.get('/staff', rbac('ADMIN', 'LECTURER'), handler);
 */
const rbac = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Authentication required.' });
        }

        const userRole = (req.user.role || '').toUpperCase();
        const roles = allowedRoles.map(r => r.toUpperCase());

        if (!roles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: `Access denied. Required role: ${allowedRoles.join(' or ')}. Your role: ${req.user.role}.`
            });
        }

        next();
    };
};

module.exports = rbac;
