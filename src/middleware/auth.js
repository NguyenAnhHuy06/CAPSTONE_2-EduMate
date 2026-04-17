const jwt = require('jsonwebtoken');
const User = require('../models/User');

function resolveJwtSecret() {
    const s = process.env.JWT_SECRET && String(process.env.JWT_SECRET).trim();
    return s || "dev-only-secret-change-me";
}

function resolveJwtSecrets() {
    const primary = process.env.JWT_SECRET && String(process.env.JWT_SECRET).trim();
    const legacy = process.env.JWT_SECRET_LEGACY && String(process.env.JWT_SECRET_LEGACY).trim();
    const out = [];
    if (primary) out.push(primary);
    if (legacy && legacy !== primary) out.push(legacy);
    if (!out.includes("dev-only-secret-change-me")) out.push("dev-only-secret-change-me");
    return out;
}

function normalizeToken(rawToken) {
    let token = String(rawToken || "").trim();
    if (!token) return "";
    if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
    ) {
        token = token.slice(1, -1).trim();
    }
    return token;
}

function getTokenFromCookieHeader(cookieHeader) {
    const raw = String(cookieHeader || "").trim();
    if (!raw) return null;

    const pairs = raw.split(";").map((part) => part.trim()).filter(Boolean);
    const map = new Map();
    for (const pair of pairs) {
        const idx = pair.indexOf("=");
        if (idx <= 0) continue;
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        map.set(key, value);
    }

    const cookieToken = map.get("token") || map.get("accessToken") || map.get("access_token");
    return cookieToken ? decodeURIComponent(cookieToken) : null;
}

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        const xAccessToken = req.headers['x-access-token'];
        const cookieToken = getTokenFromCookieHeader(req.headers.cookie);
        const bodyToken = req.body?.token;
        const queryToken = req.query?.token;

        let token = null;
        if (authHeader) {
            const raw = String(authHeader).trim();
            token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
        } else if (xAccessToken) {
            token = String(xAccessToken).trim();
        } else if (cookieToken) {
            token = String(cookieToken).trim();
        } else if (bodyToken) {
            token = String(bodyToken).trim();
        } else if (queryToken) {
            token = String(queryToken).trim();
        }
        token = normalizeToken(token);

        if (!token) {
            return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });
        }

        let decoded = null;
        const secrets = resolveJwtSecrets();
        for (const secret of secrets) {
            try {
                decoded = jwt.verify(token, secret);
                break;
            } catch (_) {
                // Try next known secret.
            }
        }
        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Invalid token.' });
        }
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