'use strict';
/*
 * Single shared SQLite connection. better-sqlite3 is synchronous, which keeps
 * the repository layer simple and makes parameterized queries the only sane way
 * to pass values (no string interpolation anywhere => no SQL injection).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

const dbFile = path.resolve(__dirname, '..', '..', config.dbPath);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');   // better concurrency
db.pragma('foreign_keys = ON');    // enforce referential integrity

// Apply the schema on connect (idempotent CREATE ... IF NOT EXISTS). This guarantees
// tables exist before any repository prepares its statements, regardless of require
// order. Seeding (admin user, About content) is handled separately by migrate.js.
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Evolve pre-existing databases to the current shape (guarded + idempotent).
require('./migrations').runMigrations(db);

module.exports = db;
