'use strict';
/*
 * Idempotent migration + seed. Safe to run repeatedly.
 *   - applies schema.sql
 *   - seeds an admin user if none exists
 *   - seeds the singleton About content if absent
 * Exposed as functions so tests can migrate an isolated database.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const DEFAULT_ABOUT = `# About this project

Real-time cryptocurrency price prediction powered by machine-learning models.

## What it does

This dashboard streams live market data for **Bitcoin, Ethereum and Ripple** and
shows short-horizon price forecasts from several AI models side by side. Each
model's prediction, recent accuracy and directional hit-rate are tracked live so
you can compare how they perform against one another.

## The models

- **ARIMA** — the statistical baseline.
- **LSTM (5M) & TFT (5M)** — legacy deep-learning models targeting the next 5 minutes.
- **LSTM (1H) & TFT (1H)** — v2 challenger models targeting +60 minutes, anchored to the clock hour.

## How it works

A serving pipeline collects market candles, runs each model, and writes the
predictions to a Supabase database. The dashboard polls that data every 30
seconds and renders it with TradingView Lightweight Charts.

## The team

- **Dr. Ronen Almog** — Project supervisor
- **Ofir Zohar**
- **Omer Peretz**
- **Ofir Fichman**
- **Molly**`;

function applySchema(db) {
    db.exec(SCHEMA);
}

function seedAdmin(db) {
    const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (existing) return { created: false };

    let password = config.admin.password;
    let generated = false;
    if (!password) {
        password = crypto.randomBytes(12).toString('base64url'); // strong random
        generated = true;
    }
    const hash = bcrypt.hashSync(password, config.bcryptRounds);
    db.prepare(
        'INSERT INTO users (email, username, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 1)'
    ).run(config.admin.email, config.admin.username, hash, 'admin');
    return { created: true, generated, password, email: config.admin.email, username: config.admin.username };
}

function seedAbout(db) {
    const existing = db.prepare('SELECT id FROM about_content WHERE id = 1').get();
    if (existing) return { created: false };
    db.prepare('INSERT INTO about_content (id, content, updated_by) VALUES (1, ?, NULL)').run(DEFAULT_ABOUT);
    return { created: true };
}

function migrate(db) {
    applySchema(db);
    const admin = seedAdmin(db);
    seedAbout(db);
    return { admin };
}

module.exports = { migrate, applySchema, seedAdmin, seedAbout, DEFAULT_ABOUT };

// Run directly: `npm run migrate`
if (require.main === module) {
    const db = require('./index');
    const { admin } = migrate(db);
    if (admin.created) {
        console.log(`[migrate] created admin "${admin.username}" <${admin.email}>`);
        if (admin.generated) {
            console.log(`[migrate] GENERATED admin password (store it now): ${admin.password}`);
        } else {
            console.log('[migrate] admin password taken from ADMIN_PASSWORD env');
        }
    } else {
        console.log('[migrate] admin already exists — skipped');
    }
    console.log('[migrate] done');
}
