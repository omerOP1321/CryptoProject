-- Schema for the auth / user-management service.
-- Designed so future per-user data (e.g. Part C saved simulations) can be added
-- as new tables that reference users(id) WITHOUT altering existing tables.
--
-- This is the baseline for FRESH databases. Existing databases are evolved by
-- the guarded steps in migrations.js (add columns, widen role, add auth_tokens).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
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

-- Server-side sessions. The cookie holds an opaque random token; only its SHA-256
-- hash is stored here, so a DB leak cannot be replayed as a live session.
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,                 -- sha256(raw session token)
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    user_agent  TEXT,
    ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- One-time, time-limited tokens for email verification and password reset.
-- Only the SHA-256 of the token is stored; used_at marks single-use consumption.
CREATE TABLE IF NOT EXISTS auth_tokens (
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

-- Singleton row holding the editable About-page content (markdown).
CREATE TABLE IF NOT EXISTS about_content (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    content     TEXT NOT NULL,
    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail of authentication attempts; powers per-identifier login throttling.
CREATE TABLE IF NOT EXISTS login_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier  TEXT NOT NULL COLLATE NOCASE,
    ip          TEXT,
    success     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(identifier, created_at);
