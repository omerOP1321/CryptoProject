'use strict';
/*
 * CSRF protection for authenticated, state-changing requests. The session holds
 * a CSRF token that is handed to the client (via /me and on login). The client
 * must echo it in the X-CSRF-Token header for unsafe methods. Combined with an
 * httpOnly + SameSite=Lax cookie this defeats cross-site request forgery.
 *
 * Login/registration are intentionally NOT guarded here: there is no session yet,
 * and they are protected by SameSite, CORS allow-listing and rate limiting.
 */
const crypto = require('crypto');
const { forbidden } = require('../utils/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function requireCsrf(req, _res, next) {
    if (SAFE.has(req.method)) return next();
    if (!req.session) return next(forbidden('Missing session for CSRF check', 'CSRF'));
    const header = req.get('X-CSRF-Token');
    if (!header || !safeEqual(header, req.session.csrf_token)) {
        return next(forbidden('Invalid or missing CSRF token', 'CSRF'));
    }
    next();
}

module.exports = { requireCsrf };
