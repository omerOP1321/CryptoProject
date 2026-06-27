'use strict';
/*
 * Data-access for one-time auth tokens (email verification + password reset).
 * Only the SHA-256 hash of each token is stored; lookups hash the incoming raw
 * token. used_at enforces single use. All queries are parameterized.
 */
const db = require('../db');

const insert = db.prepare(
    `INSERT INTO auth_tokens (user_id, type, token_hash, expires_at)
     VALUES (@user_id, @type, @token_hash, @expires_at)`
);
const findByHash = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?');
const markUsed = db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?");
const deleteForUserType = db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND type = ?');
const countRecent = db.prepare(
    `SELECT COUNT(*) AS n FROM auth_tokens
     WHERE user_id = @user_id AND type = @type AND created_at >= datetime('now', @since)`
);
const latestForUserType = db.prepare(
    'SELECT * FROM auth_tokens WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1'
);
const purge = db.prepare("DELETE FROM auth_tokens WHERE expires_at <= datetime('now')");

module.exports = {
    create: (row) => insert.run(row),
    findByHash: (hash) => findByHash.get(hash),
    markUsed: (id) => markUsed.run(id),
    deleteForUserType: (userId, type) => deleteForUserType.run(userId, type),
    latest: (userId, type) => latestForUserType.get(userId, type),
    recentCount: ({ userId, type, windowMs }) =>
        countRecent.get({ user_id: userId, type, since: `-${Math.round(windowMs / 1000)} seconds` }).n,
    purgeExpired: () => purge.run(),
};
