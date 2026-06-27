'use strict';
/*
 * Authentication business logic: registration, login, logout, and session
 * lifecycle. Knows nothing about HTTP — routes adapt it to requests/responses.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const users = require('../repositories/user.repo');
const sessions = require('../repositories/session.repo');
const account = require('./account.service');
const { conflict, unauthorized, tooManyRequests } = require('../utils/errors');
const logger = require('../utils/logger');

// Dummy hash used to equalize timing when an identifier doesn't exist, so login
// timing can't be used to enumerate valid accounts.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', config.bcryptRounds);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function createSession(userId, { ip, userAgent } = {}) {
    const rawToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
    sessions.create({
        id: sha256(rawToken),
        user_id: userId,
        csrf_token: csrfToken,
        expires_at: expiresAt,
        user_agent: (userAgent || '').slice(0, 255),
        ip: (ip || '').slice(0, 64),
    });
    return { rawToken, csrfToken, expiresAt };
}

async function register({ email, username, password, ip, userAgent }) {
    if (users.findByEmail(email)) throw conflict('Email is already registered', 'EMAIL_TAKEN');
    if (users.findByUsername(username)) throw conflict('Username is already taken', 'USERNAME_TAKEN');

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const user = users.create({ email, username, passwordHash, role: 'user' });
    logger.security('user registered', { id: user.id, username: user.username });

    // Issue + send the verification email (no throttle on the very first send).
    const verification = await account.issueVerification(user, { throttle: false });
    const session = createSession(user.id, { ip, userAgent });
    return { user: users.publicView(user), session, verification };
}

async function login({ identifier, password, ip, userAgent }) {
    // Per-identifier throttle: too many recent failures locks logins for a while.
    const fails = sessions.recentFailCount({ identifier, windowMs: config.login.windowMs });
    if (fails >= config.login.maxFailPerIdentifier) {
        logger.security('login throttled', { identifier, ip });
        throw tooManyRequests('Too many failed attempts. Try again later.', 'LOGIN_THROTTLED');
    }

    const user = users.findByIdentifier(identifier);
    const hash = user ? user.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
        sessions.recordAttempt({ identifier, ip, success: false });
        logger.security('login failed', { identifier, ip });
        throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    sessions.recordAttempt({ identifier, ip, success: true });
    sessions.clearFails(identifier);
    users.touchLastLogin(user.id);
    const session = createSession(user.id, { ip, userAgent });
    logger.security('login success', { id: user.id, username: user.username, ip });
    return { user: users.publicView(user), session };
}

function logout(rawToken) {
    if (!rawToken) return;
    sessions.delete(sha256(rawToken));
}

// Resolve a raw cookie token to its session + user, or null if invalid/expired.
function resolveSession(rawToken) {
    if (!rawToken) return null;
    const row = sessions.findById(sha256(rawToken));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        sessions.delete(row.id);
        return null;
    }
    const user = users.findById(row.user_id);
    if (!user) {
        sessions.delete(row.id);
        return null;
    }
    return { session: row, user };
}

module.exports = { register, login, logout, resolveSession, createSession };
