'use strict';
/*
 * Guarded, idempotent migrations that evolve an EXISTING database to the current
 * schema. Fresh databases already get the latest shape from schema.sql, so every
 * step here first checks whether it is needed. Safe to run on every boot.
 *
 * Covers the user-management upgrade:
 *   - users.email_verified, users.last_login_at columns
 *   - widen users.role to allow 'semi_admin' (rebuild table to drop old CHECK)
 *   - auth_tokens table (email verification + password reset)
 *   - grandfather pre-existing users as verified so they aren't locked out
 */

function columnExists(db, table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function tableSql(db, table) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    return row ? row.sql : '';
}
function tableExists(db, table) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

function runMigrations(db) {
    // 1) add new user columns if missing
    if (!columnExists(db, 'users', 'email_verified')) {
        db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
        // grandfather everyone who existed before verification was introduced
        db.exec('UPDATE users SET email_verified = 1');
    }
    if (!columnExists(db, 'users', 'last_login_at')) {
        db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
    }

    // 2) widen the role CHECK to include 'semi_admin' by rebuilding the table.
    //    SQLite can't ALTER a CHECK constraint, so copy -> drop -> rename.
    if (!/semi_admin/.test(tableSql(db, 'users'))) {
        // PRAGMA foreign_keys can't change inside a transaction, so toggle it
        // around the rebuild (the documented SQLite table-rebuild procedure).
        db.pragma('foreign_keys = OFF');
        const rebuild = db.transaction(() => {
            db.exec(`
                CREATE TABLE users_new (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash  TEXT NOT NULL,
                    role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'semi_admin', 'admin')),
                    email_verified INTEGER NOT NULL DEFAULT 0,
                    last_login_at  TEXT,
                    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO users_new (id, email, username, password_hash, role, email_verified, last_login_at, created_at, updated_at)
                    SELECT id, email, username, password_hash, role, email_verified, last_login_at, created_at, updated_at FROM users;
                DROP TABLE users;
                ALTER TABLE users_new RENAME TO users;
            `);
        });
        rebuild();
        db.pragma('foreign_keys = ON');
    }

    // 3) auth_tokens table (verification + reset)
    if (!tableExists(db, 'auth_tokens')) {
        db.exec(`
            CREATE TABLE auth_tokens (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type        TEXT NOT NULL CHECK (type IN ('email_verify', 'password_reset')),
                token_hash  TEXT NOT NULL UNIQUE,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at  TEXT NOT NULL,
                used_at     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, type);
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);
        `);
    }
}

module.exports = { runMigrations, columnExists, tableExists };
