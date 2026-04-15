const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        const xAccessToken = req.headers['x-access-token'];
        const bodyToken = req.body?.token;
        const queryToken = req.query?.token;

        let token = null;
        if (authHeader) {
            const raw = String(authHeader).trim();
            token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
        } else if (xAccessToken) {
            token = String(xAccessToken).trim();
        } else if (bodyToken) {
            token = String(bodyToken).trim();
        } else if (queryToken) {
            token = String(queryToken).trim();
        }

        if (!token) {
            return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const tokenUserId = decoded?.id ?? decoded?.user_id ?? decoded?.sub;
        const normalizedUserId = Number(tokenUserId);
        if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) {
            return res.status(401).json({ success: false, message: 'Invalid token payload.' });
        }

        const user = await User.findByPk(normalizedUserId, {
            attributes: ['user_id', 'email', 'full_name', 'role', 'user_code', 'is_verified']
        });

        if (!user) {
            return res.status(401).json({ success: false, message: 'User no longer exists.' });
        }

        if (!user.is_verified) {
            return res.status(403).json({ success: false, message: 'Email not verified.' });
        }

        req.user = {
            id: user.user_id,
            user_id: user.user_id,
            email: user.email,
            full_name: user.full_name,
            name: user.full_name,
            role: user.role,
            user_code: user.user_code,
        };

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: 'Token expired. Please login again.' });
        }
        if (err.name === 'JsonWebTokenError') {
            return res.status(401).json({ success: false, message: 'Invalid token.' });
        }
        console.error('[AuthMiddleware] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Authentication error.' });
    }
};

module.exports = authMiddleware;