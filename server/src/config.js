'use strict';
/*
 * Centralised configuration. Reads a local .env (simple KEY=VALUE parser, no
 * dependency) then process.env, with sane defaults. Throwing here fails fast on
 * misconfiguration rather than at request time.
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
    const file = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // strip surrounding quotes and inline comments on unquoted values
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        } else {
            const hash = val.indexOf(' #');
            if (hash !== -1) val = val.slice(0, hash).trim();
        }
        if (!(key in process.env)) process.env[key] = val;
    }
}
loadDotEnv();

const env = process.env;
const config = {
    nodeEnv: env.NODE_ENV || 'development',
    port: parseInt(env.PORT || '4000', 10),
    dbPath: env.DB_PATH || './data/app.db',
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:8765')
        .split(',').map((s) => s.trim()).filter(Boolean),
    cookieName: env.COOKIE_NAME || 'sid',
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionTtlMs: parseInt(env.SESSION_TTL_HOURS || '168', 10) * 3600 * 1000,
    bcryptRounds: parseInt(env.BCRYPT_ROUNDS || '12', 10),
    admin: {
        email: env.ADMIN_EMAIL || 'admin@local',
        username: env.ADMIN_USERNAME || 'admin',
        password: env.ADMIN_PASSWORD || null,
    },
    // login rate limiting
    login: {
        maxFailPerIdentifier: parseInt(env.LOGIN_MAX_FAIL || '5', 10), // failed attempts ...
        windowMs: parseInt(env.LOGIN_WINDOW_MIN || '15', 10) * 60 * 1000, // ... within this window locks the account
        ipMax: parseInt(env.LOGIN_IP_MAX || '30', 10),                 // coarse per-IP cap on auth endpoints / window
    },

    // Base URL of the static site, used to build verification / reset links.
    appBaseUrl: env.APP_BASE_URL || 'http://localhost:8765',

    // One-time token lifetimes and resend throttling.
    tokens: {
        verifyTtlMs: parseInt(env.VERIFY_TTL_HOURS || '24', 10) * 3600 * 1000,
        resetTtlMs: parseInt(env.RESET_TTL_MIN || '30', 10) * 60 * 1000,
        resendCooldownMs: parseInt(env.RESEND_COOLDOWN_SEC || '60', 10) * 1000,
        maxPerWindow: parseInt(env.TOKEN_MAX_PER_WINDOW || '5', 10),   // verify/reset requests ...
        windowMs: parseInt(env.TOKEN_WINDOW_MIN || '60', 10) * 60 * 1000, // ... per user per hour
    },

    // Email delivery. If SMTP_HOST is set, real email is sent via nodemailer;
    // otherwise a dev transport logs to the console and writes to data/outbox.
    mail: {
        from: env.MAIL_FROM || 'Crypto AI <no-reply@cryptoai.local>',
        smtp: env.SMTP_HOST ? {
            host: env.SMTP_HOST,
            port: parseInt(env.SMTP_PORT || '587', 10),
            secure: env.SMTP_SECURE === 'true',
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        } : null,
        // In non-production, include the verification/reset link in the API
        // response so the flow is testable without a real mailbox.
        devPreview: (env.NODE_ENV || 'development') !== 'production' && env.DEV_EMAIL_PREVIEW !== 'false',
    },
};

module.exports = config;
