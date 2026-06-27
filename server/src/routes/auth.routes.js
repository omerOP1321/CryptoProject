'use strict';
/* RESTful auth endpoints.
 *   POST /api/auth/register  - create account + start session
 *   POST /api/auth/login     - start session
 *   POST /api/auth/logout    - end session (auth + CSRF)
 *   GET  /api/auth/me        - current user + CSRF token
 */
const express = require('express');
const { z } = require('zod');
const config = require('../config');
const authService = require('../services/auth.service');
const accountService = require('../services/account.service');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// ----- validation schemas (allow-list inputs; block malicious characters) -----
const email = z.string().trim().toLowerCase().email('Invalid email').max(254);
const username = z.string().trim()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Username may only contain letters, numbers, _ . -');
const password = z.string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number')
    .refine((v) => !/[\x00-\x1F\x7F]/.test(v), 'Password contains forbidden characters');

const registerSchema = z.object({ email, username, password }).strict();
const loginSchema = z.object({
    identifier: z.string().trim().min(1, 'Identifier is required').max(254),
    password: z.string().min(1, 'Password is required').max(128),
}).strict();
const tokenStr = z.string().trim().min(8, 'Invalid token').max(512);
const verifyEmailSchema = z.object({ token: tokenStr }).strict();
const forgotSchema = z.object({ email }).strict();
const resetSchema = z.object({ token: tokenStr, password }).strict();

// ----- helpers -----
function clientIp(req) { return req.ip; }
function setSessionCookie(res, rawToken) {
    res.cookie(config.cookieName, rawToken, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax',
        maxAge: config.sessionTtlMs,
        path: '/',
    });
}

router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
    try {
        const { email, username, password } = req.body;
        const { user, session, verification } = await authService.register({
            email, username, password, ip: clientIp(req), userAgent: req.get('user-agent'),
        });
        setSessionCookie(res, session.rawToken);
        res.status(201).json({ user, csrfToken: session.csrfToken, verification });
    } catch (e) { next(e); }
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
    try {
        const { identifier, password } = req.body;
        const { user, session } = await authService.login({
            identifier, password, ip: clientIp(req), userAgent: req.get('user-agent'),
        });
        setSessionCookie(res, session.rawToken);
        res.json({ user, csrfToken: session.csrfToken });
    } catch (e) { next(e); }
});

router.post('/logout', requireAuth, requireCsrf, (req, res, next) => {
    try {
        authService.logout(req.rawSessionToken);
        res.clearCookie(config.cookieName, { path: '/' });
        res.status(204).end();
    } catch (e) { next(e); }
});

router.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const { publicView } = require('../repositories/user.repo');
    res.json({ user: publicView(req.user), csrfToken: req.session.csrf_token });
});

// ----- email verification -----

// Token-authenticated (the link IS the credential); no session/CSRF required.
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), (req, res, next) => {
    try {
        const user = accountService.verifyEmail(req.body.token);
        res.json({ ok: true, user });
    } catch (e) { next(e); }
});

// Resend for the logged-in (unverified) user. Cooldown + per-window cap applied
// in the service; CSRF required since it acts on the session.
router.post('/resend-verification', authLimiter, requireAuth, requireCsrf, async (req, res, next) => {
    try {
        const result = await accountService.resendVerification(req.user);
        res.json({ ok: true, ...result });
    } catch (e) { next(e); }
});

// ----- password reset -----

// Always responds the same way regardless of whether the email exists (no enumeration).
router.post('/forgot-password', authLimiter, validate(forgotSchema), async (req, res, next) => {
    try {
        const result = await accountService.requestPasswordReset(req.body.email);
        res.json({ ok: true, ...result });
    } catch (e) { next(e); }
});

router.post('/reset-password', authLimiter, validate(resetSchema), async (req, res, next) => {
    try {
        await accountService.resetPassword(req.body.token, req.body.password);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

module.exports = router;
