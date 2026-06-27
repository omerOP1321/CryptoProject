'use strict';
/*
 * Integration tests for the auth + about API. Runs the real Express app against
 * an isolated temp SQLite database. Exercises the auth flow, authorization, and
 * the security controls (validation, CSRF, login throttling, SQLi safety).
 *
 *   node --test tests/
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Isolate config BEFORE requiring app/db (both read env at load time).
const TMP_DB = path.join(os.tmpdir(), `auth-test-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = TMP_DB;
process.env.ADMIN_PASSWORD = 'AdminPass123';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_EMAIL = 'admin@local';
process.env.LOGIN_IP_MAX = '1000';   // don't let the coarse IP limiter interfere
process.env.LOGIN_MAX_FAIL = '5';

const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');

let server, base;

before(async () => {
    migrate(db);
    const app = createApp();
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    if (server) server.close();
    db.close();
    for (const ext of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + ext); } catch (_) {} }
});

// ---- helpers ----
function cookieFrom(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const sid = set.find((c) => c.startsWith('sid='));
    return sid ? sid.split(';')[0] : null;
}
async function api(method, p, { cookie, csrf, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(base + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, cookie: cookieFrom(res) };
}
async function registerUser(email, username, password = 'GoodPass123') {
    return api('POST', '/api/auth/register', { body: { email, username, password } });
}

// ---- tests ----

test('health endpoint', async () => {
    const r = await api('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ok');
});

test('register creates a user, returns csrf, sets httpOnly cookie', async () => {
    const r = await registerUser('a@example.com', 'alice');
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.user.role, 'user');
    assert.ok(r.json.csrfToken);
    assert.ok(r.cookie && r.cookie.startsWith('sid='));
});

test('register rejects duplicate email (409)', async () => {
    await registerUser('dup@example.com', 'dupuser');
    const r = await registerUser('dup@example.com', 'otheruser');
    assert.strictEqual(r.status, 409);
});

test('register rejects weak password (400 validation)', async () => {
    const r = await api('POST', '/api/auth/register', { body: { email: 'w@example.com', username: 'weakuser', password: 'short' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'VALIDATION');
});

test('register rejects malicious username characters', async () => {
    const r = await api('POST', '/api/auth/register', { body: { email: 'x@example.com', username: '<script>', password: 'GoodPass123' } });
    assert.strictEqual(r.status, 400);
});

test('login with wrong password returns generic 401', async () => {
    await registerUser('bob@example.com', 'bob');
    const r = await api('POST', '/api/auth/login', { body: { identifier: 'bob', password: 'WrongPass123' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.error, 'Invalid credentials');
});

test('SQL-injection attempt in identifier is harmless (parameterized)', async () => {
    const r = await api('POST', '/api/auth/login', { body: { identifier: "' OR '1'='1", password: "' OR '1'='1" } });
    assert.strictEqual(r.status, 401); // no row matched; no error leaked
    // table still intact
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    assert.ok(n >= 1);
});

test('login throttles after too many failures (429)', async () => {
    await registerUser('carol@example.com', 'carol');
    for (let i = 0; i < 5; i++) {
        await api('POST', '/api/auth/login', { body: { identifier: 'carol', password: 'Nope12345' } });
    }
    const r = await api('POST', '/api/auth/login', { body: { identifier: 'carol', password: 'Nope12345' } });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.json.code, 'LOGIN_THROTTLED');
});

test('me returns null when unauthenticated', async () => {
    const r = await api('GET', '/api/auth/me');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.user, null);
});

test('logout ends the session', async () => {
    const reg = await registerUser('dave@example.com', 'dave');
    const me1 = await api('GET', '/api/auth/me', { cookie: reg.cookie });
    assert.strictEqual(me1.json.user.username, 'dave');
    const out = await api('POST', '/api/auth/logout', { cookie: reg.cookie, csrf: reg.json.csrfToken });
    assert.strictEqual(out.status, 204);
    const me2 = await api('GET', '/api/auth/me', { cookie: reg.cookie });
    assert.strictEqual(me2.json.user, null);
});

test('about GET is public', async () => {
    const r = await api('GET', '/api/about');
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.json.content === 'string' && r.json.content.length > 0);
});

test('non-admin cannot edit about (403)', async () => {
    const reg = await registerUser('erin@example.com', 'erin');
    const r = await api('PUT', '/api/about', { cookie: reg.cookie, csrf: reg.json.csrfToken, body: { content: 'hacked' } });
    assert.strictEqual(r.status, 403);
});

test('admin cannot edit about without CSRF token (403)', async () => {
    const login = await api('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'AdminPass123' } });
    const r = await api('PUT', '/api/about', { cookie: login.cookie, body: { content: '# x\n\nyo' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'CSRF');
});

test('admin can edit about with CSRF token (200)', async () => {
    const login = await api('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'AdminPass123' } });
    const r = await api('PUT', '/api/about', {
        cookie: login.cookie, csrf: login.json.csrfToken, body: { content: '# Edited\n\nBy **admin**.' },
    });
    assert.strictEqual(r.status, 200);
    assert.match(r.json.content, /Edited/);
    const pub = await api('GET', '/api/about');
    assert.match(pub.json.content, /Edited/);
});

test('unauthenticated about edit is rejected (401)', async () => {
    const r = await api('PUT', '/api/about', { body: { content: '# x\n\nhi' } });
    assert.strictEqual(r.status, 401);
});

test('malformed JSON body returns a safe 400 (no 500/leak)', async () => {
    const res = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not valid json',
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.error, 'Invalid request body');
});

test('about rejects empty content (400)', async () => {
    const login = await api('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'AdminPass123' } });
    const r = await api('PUT', '/api/about', { cookie: login.cookie, csrf: login.json.csrfToken, body: { content: '   ' } });
    assert.strictEqual(r.status, 400);
});

// =================================================== email verification

function tokenFromLink(link) {
    return new URL(link).searchParams.get('token');
}
async function adminSession() {
    const login = await api('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'AdminPass123' } });
    return login; // { cookie, json.csrfToken }
}
async function findUserId(username) {
    const a = await adminSession();
    const r = await api('GET', '/api/users', { cookie: a.cookie });
    const u = r.json.users.find((x) => x.username === username);
    return u && u.id;
}

test('new users start unverified and get a verification link', async () => {
    const r = await registerUser('ver@example.com', 'veruser');
    assert.strictEqual(r.json.user.emailVerified, false);
    assert.ok(r.json.verification && r.json.verification.devLink, 'dev verification link present');
    const me = await api('GET', '/api/auth/me', { cookie: r.cookie });
    assert.strictEqual(me.json.user.emailVerified, false);
});

test('verify-email marks the account verified; bad token is rejected', async () => {
    const r = await registerUser('ver2@example.com', 'veruser2');
    const bad = await api('POST', '/api/auth/verify-email', { body: { token: 'not-a-real-token-string' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.code, 'INVALID_TOKEN');
    const ok = await api('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(r.json.verification.devLink) } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.user.emailVerified, true);
});

test('requireVerified blocks an unverified semi_admin from editing About', async () => {
    const reg = await registerUser('unv@example.com', 'unverified_sa');
    const a = await adminSession();
    const id = await findUserId('unverified_sa');
    // promote to semi_admin while still unverified
    const promo = await api('PUT', `/api/users/${id}/role`, { cookie: a.cookie, csrf: a.json.csrfToken, body: { role: 'semi_admin' } });
    assert.strictEqual(promo.json.user.role, 'semi_admin');
    // they have about:edit permission but are NOT verified -> 403 EMAIL_NOT_VERIFIED
    const me = await api('GET', '/api/auth/me', { cookie: reg.cookie });
    const blocked = await api('PUT', '/api/about', { cookie: reg.cookie, csrf: me.json.csrfToken, body: { content: '# x\n\nhi' } });
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.json.code, 'EMAIL_NOT_VERIFIED');
    // verify -> now allowed
    await api('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(reg.json.verification.devLink) } });
    const me2 = await api('GET', '/api/auth/me', { cookie: reg.cookie });
    const allowed = await api('PUT', '/api/about', { cookie: reg.cookie, csrf: me2.json.csrfToken, body: { content: '# ok\n\nedited by semi admin' } });
    assert.strictEqual(allowed.status, 200);
});

// =================================================== RBAC: user management

test('regular user cannot list users (403)', async () => {
    const reg = await registerUser('plain@example.com', 'plainuser');
    const r = await api('GET', '/api/users', { cookie: reg.cookie });
    assert.strictEqual(r.status, 403);
});

test('semi_admin can read users but cannot manage them', async () => {
    const reg = await registerUser('sa2@example.com', 'semiadmin2');
    await api('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(reg.json.verification.devLink) } });
    const a = await adminSession();
    const id = await findUserId('semiadmin2');
    await api('PUT', `/api/users/${id}/role`, { cookie: a.cookie, csrf: a.json.csrfToken, body: { role: 'semi_admin' } });
    const me = await api('GET', '/api/auth/me', { cookie: reg.cookie });
    const read = await api('GET', '/api/users', { cookie: reg.cookie });
    assert.strictEqual(read.status, 200);
    const del = await api('DELETE', `/api/users/${id}`, { cookie: reg.cookie, csrf: me.json.csrfToken });
    assert.strictEqual(del.status, 403);
    const role = await api('PUT', `/api/users/${id}/role`, { cookie: reg.cookie, csrf: me.json.csrfToken, body: { role: 'admin' } });
    assert.strictEqual(role.status, 403);
});

test('admin cannot delete or demote their own account', async () => {
    const a = await adminSession();
    const id = await findUserId('admin');
    const del = await api('DELETE', `/api/users/${id}`, { cookie: a.cookie, csrf: a.json.csrfToken });
    assert.strictEqual(del.status, 403);
    assert.strictEqual(del.json.code, 'SELF_DELETE');
    const role = await api('PUT', `/api/users/${id}/role`, { cookie: a.cookie, csrf: a.json.csrfToken, body: { role: 'user' } });
    assert.strictEqual(role.status, 403);
    assert.strictEqual(role.json.code, 'SELF_ROLE');
});

test('admin can delete a user', async () => {
    await registerUser('todelete@example.com', 'todelete');
    const a = await adminSession();
    const id = await findUserId('todelete');
    const del = await api('DELETE', `/api/users/${id}`, { cookie: a.cookie, csrf: a.json.csrfToken });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(await findUserId('todelete'), undefined);
});

// =================================================== password reset

test('forgot-password does not reveal whether an email exists', async () => {
    const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'nobody@nowhere.com' } });
    assert.strictEqual(unknown.status, 200);
    assert.strictEqual(unknown.json.ok, true);
    assert.strictEqual(unknown.json.devLink, undefined); // no link for non-existent account
});

test('password reset works once, then the token is invalid; old password fails', async () => {
    await registerUser('reset@example.com', 'resetuser', 'OldPass123');
    const fp = await api('POST', '/api/auth/forgot-password', { body: { email: 'reset@example.com' } });
    assert.ok(fp.json.devLink);
    const token = tokenFromLink(fp.json.devLink);
    const r1 = await api('POST', '/api/auth/reset-password', { body: { token, password: 'NewPass456' } });
    assert.strictEqual(r1.status, 200);
    // single-use
    const r2 = await api('POST', '/api/auth/reset-password', { body: { token, password: 'Another789' } });
    assert.strictEqual(r2.status, 400);
    // old password no longer works, new one does
    const oldLogin = await api('POST', '/api/auth/login', { body: { identifier: 'resetuser', password: 'OldPass123' } });
    assert.strictEqual(oldLogin.status, 401);
    const newLogin = await api('POST', '/api/auth/login', { body: { identifier: 'resetuser', password: 'NewPass456' } });
    assert.strictEqual(newLogin.status, 200);
});
