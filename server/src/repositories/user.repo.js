'use strict';
/*
 * Data-access for users. Every query is parameterized (prepared statement) — no
 * value is ever concatenated into SQL, which removes SQL-injection risk.
 */
const db = require('../db');

const insert = db.prepare(
    'INSERT INTO users (email, username, password_hash, role) VALUES (@email, @username, @password_hash, @role)'
);
const byId = db.prepare('SELECT * FROM users WHERE id = ?');
const byEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
const byUsername = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const byIdentifier = db.prepare(
    'SELECT * FROM users WHERE email = @id COLLATE NOCASE OR username = @id COLLATE NOCASE'
);
const listAll = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
const del = db.prepare('DELETE FROM users WHERE id = ?');
const setVerified = db.prepare("UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?");
const setRole = db.prepare("UPDATE users SET role = @role, updated_at = datetime('now') WHERE id = @id");
const setPassword = db.prepare("UPDATE users SET password_hash = @hash, updated_at = datetime('now') WHERE id = @id");
const touchLogin = db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?");
const countByRole = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?');

function publicView(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        username: row.username,
        role: row.role,
        emailVerified: !!row.email_verified,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at || null,
    };
}

module.exports = {
    create({ email, username, passwordHash, role = 'user' }) {
        const info = insert.run({ email, username, password_hash: passwordHash, role });
        return byId.get(info.lastInsertRowid);
    },
    findById: (id) => byId.get(id),
    findByEmail: (email) => byEmail.get(email),
    findByUsername: (username) => byUsername.get(username),
    findByIdentifier: (id) => byIdentifier.get({ id }),
    listAll: () => listAll.all(),
    delete: (id) => del.run(id),
    markVerified: (id) => setVerified.run(id),
    setRole: (id, role) => setRole.run({ id, role }),
    setPassword: (id, hash) => setPassword.run({ id, hash }),
    touchLastLogin: (id) => touchLogin.run(id),
    countByRole: (role) => countByRole.get(role).n,
    publicView,
};
