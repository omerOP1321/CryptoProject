'use strict';
/* Authentication / authorization middleware.
 *  - attachUser: resolve the session cookie into req.user/req.session (runs on all routes)
 *  - requireAuth: 401 if not logged in
 *  - requireRole: 403 if the logged-in user lacks the role (role-based; extend by
 *    adding more roles / a permissions map later without touching call sites)
 */
const config = require('../config');
const authService = require('../services/auth.service');
const { unauthorized, forbidden } = require('../utils/errors');
const { can } = require('../utils/permissions');

function attachUser(req, _res, next) {
    try {
        const token = req.cookies ? req.cookies[config.cookieName] : null;
        const resolved = authService.resolveSession(token);
        if (resolved) {
            req.user = resolved.user;
            req.session = resolved.session;
            req.rawSessionToken = token;
        }
    } catch (_e) {
        // never block the request on resolution errors; just treat as anonymous
    }
    next();
}

function requireAuth(req, _res, next) {
    if (!req.user) return next(unauthorized());
    next();
}

function requireRole(role) {
    return (req, _res, next) => {
        if (!req.user) return next(unauthorized());
        if (req.user.role !== role) return next(forbidden('Insufficient permissions'));
        next();
    };
}

// Permission-based guard (preferred): authorize by capability, not role name.
function requirePermission(permission) {
    return (req, _res, next) => {
        if (!req.user) return next(unauthorized());
        if (!can(req.user, permission)) return next(forbidden('Insufficient permissions'));
        next();
    };
}

// Block write/protected actions until the account's email is verified.
function requireVerified(req, _res, next) {
    if (!req.user) return next(unauthorized());
    if (!req.user.email_verified) return next(forbidden('Please verify your email first', 'EMAIL_NOT_VERIFIED'));
    next();
}

module.exports = { attachUser, requireAuth, requireRole, requirePermission, requireVerified };
