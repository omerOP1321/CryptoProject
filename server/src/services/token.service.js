'use strict';
/*
 * One-time token issuance/consumption for email verification & password reset.
 * Tokens are cryptographically random; only their SHA-256 is persisted. Issuing
 * a new token of a type invalidates older ones for that user. Consuming checks
 * type, single-use (used_at) and expiry, then marks the token used.
 */
const crypto = require('crypto');
const tokens = require('../repositories/token.repo');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function issue(userId, type, ttlMs) {
    tokens.deleteForUserType(userId, type); // only the latest token of a type stays valid
    const raw = randomToken();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    tokens.create({ user_id: userId, type, token_hash: sha256(raw), expires_at: expiresAt });
    return { raw, expiresAt };
}

function consume(rawToken, type) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const row = tokens.findByHash(sha256(rawToken));
    if (!row || row.type !== type || row.used_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    tokens.markUsed(row.id);
    return row.user_id;
}

module.exports = { issue, consume, sha256 };
