'use strict';
/*
 * Data-access for sessions and login attempts. The stored session id is the
 * SHA-256 of the opaque cookie token, so the raw token never touches the DB.
 */
const db = require('../db');

const insert = db.prepare(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, user_agent, ip)
     VALUES (@id, @user_id, @csrf_token, @expires_at, @user_agent, @ip)`
);
const getById = db.prepare('SELECT * FROM sessions WHERE id = ?');
const del = db.prepare('DELETE FROM sessions WHERE id = ?');
const delForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const purge = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");

const recordAttempt = db.prepare(
    'INSERT INTO login_attempts (identifier, ip, success) VALUES (@identifier, @ip, @success)'
);
const countRecentFails = db.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts
     WHERE identifier = @identifier COLLATE NOCASE
       AND success = 0
       AND created_at >= datetime('now', @since)`
);
const clearFails = db.prepare('DELETE FROM login_attempts WHERE identifier = ? COLLATE NOCASE');

module.exports = {
    create(row) { insert.run(row); },
    findById: (id) => getById.get(id),
    delete: (id) => del.run(id),
    deleteForUser: (userId) => delForUser.run(userId),
    purgeExpired: () => purge.run(),

    recordAttempt: ({ identifier, ip, success }) =>
        recordAttempt.run({ identifier, ip, success: success ? 1 : 0 }),
    recentFailCount: ({ identifier, windowMs }) =>
        countRecentFails.get({ identifier, since: `-${Math.round(windowMs / 1000)} seconds` }).n,
    clearFails: (identifier) => clearFails.run(identifier),
};
