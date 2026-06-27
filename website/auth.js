/*
 * Auth client + UI, shared by all pages. Talks to the REST API, keeps the
 * current user + CSRF token in memory, and renders a header control plus a
 * login/register modal. Other scripts use window.AuthClient (and its `ready`
 * promise + 'change' events) to react to auth state — e.g. the About editor.
 *
 * The API base is derived from the current hostname so the session cookie stays
 * same-site (localhost page -> localhost API, 127.0.0.1 page -> 127.0.0.1 API).
 */
(function () {
    'use strict';
    var API = location.protocol + '//' + location.hostname + ':4000';

    var listeners = [];
    var readyResolve;
    var Auth = {
        user: null,
        csrfToken: null,
        apiBase: API,
        isAdmin: function () { return !!Auth.user && Auth.user.role === 'admin'; },
        on: function (cb) { listeners.push(cb); },
        // Always a promise (created synchronously) so consumers can `.then` it
        // regardless of script timing; resolves once the initial /me completes.
        ready: new Promise(function (res) { readyResolve = res; }),
    };
    function emit() { listeners.forEach(function (cb) { try { cb(Auth.user); } catch (_) {} }); }

    // ----- API calls -----
    async function api(method, path, body) {
        var headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (Auth.csrfToken && method !== 'GET') headers['X-CSRF-Token'] = Auth.csrfToken;
        var res = await fetch(API + path, {
            method: method,
            headers: headers,
            credentials: 'include',
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        var json = null;
        try { json = await res.json(); } catch (_) {}
        if (!res.ok) {
            var msg = (json && json.error) || ('Request failed (' + res.status + ')');
            var err = new Error(msg); err.status = res.status; err.code = json && json.code;
            throw err;
        }
        return json;
    }
    Auth.api = api; // exposed for other authenticated views (e.g. About editor)

    async function refresh() {
        try {
            var data = await api('GET', '/api/auth/me');
            Auth.user = data.user;
            Auth.csrfToken = data.csrfToken || null;
        } catch (_) {
            Auth.user = null; Auth.csrfToken = null;
        }
        renderUI();
        emit();
        return Auth.user;
    }
    Auth.login = async function (identifier, password) {
        var data = await api('POST', '/api/auth/login', { identifier: identifier, password: password });
        Auth.user = data.user; Auth.csrfToken = data.csrfToken; renderUI(); emit(); return data.user;
    };
    Auth.register = async function (email, username, password) {
        var data = await api('POST', '/api/auth/register', { email: email, username: username, password: password });
        Auth.user = data.user; Auth.csrfToken = data.csrfToken; renderUI(); emit(); return data;
    };
    Auth.logout = async function () {
        try { await api('POST', '/api/auth/logout'); } catch (_) {}
        Auth.user = null; Auth.csrfToken = null; renderUI(); emit();
    };
    // public auth helpers used by the banner and the verify/reset pages
    Auth.resendVerification = function () { return api('POST', '/api/auth/resend-verification'); };
    Auth.forgotPassword = function (email) { return api('POST', '/api/auth/forgot-password', { email: email }); };
    Auth.verifyEmail = function (token) { return api('POST', '/api/auth/verify-email', { token: token }); };
    Auth.resetPassword = function (token, password) { return api('POST', '/api/auth/reset-password', { token: token, password: password }); };
    Auth.canReadUsers = function () { return !!Auth.user && (Auth.user.role === 'admin' || Auth.user.role === 'semi_admin'); };
    // About editing is allowed for admin + semi_admin, but only once verified
    // (the backend enforces both; this mirrors it so the UI matches).
    Auth.canEditAbout = function () { return Auth.canReadUsers() && !!Auth.user.emailVerified; };

    function renderUI() { renderHeader(); renderBanner(); }

    // ----- header control -----
    function renderHeader() {
        var area = document.getElementById('auth-area');
        if (!area) return;
        if (Auth.user) {
            var roleBadge = Auth.user.role === 'admin' ? '<span class="auth-role">ADMIN</span>'
                : (Auth.user.role === 'semi_admin' ? '<span class="auth-role semi">SEMI</span>' : '');
            var adminLink = Auth.canReadUsers() ? '<a class="auth-btn" href="admin.html">Admin</a>' : '';
            area.innerHTML =
                adminLink +
                '<span class="auth-user">' + roleBadge + '<span class="auth-name"></span></span>' +
                '<button class="auth-btn" data-act="logout">Log out</button>';
            area.querySelector('.auth-name').textContent = Auth.user.username; // textContent => no XSS
        } else {
            area.innerHTML =
                '<button class="auth-btn" data-act="login">Log in</button>' +
                '<button class="auth-btn primary" data-act="register">Sign up</button>';
        }
    }

    function ensureHeaderArea() {
        var header = document.querySelector('header');
        if (!header || document.getElementById('auth-area')) return;
        var area = document.createElement('div');
        area.id = 'auth-area';
        area.className = 'auth-area';
        header.appendChild(area);
        header.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-act]');
            if (!btn) return;
            var act = btn.dataset.act;
            if (act === 'logout') Auth.logout();
            else if (act === 'login' || act === 'register') openModal(act);
        });
    }

    // ----- "verify your email" banner -----
    var resendCooldownUntil = 0;
    function ensureBanner() {
        if (document.getElementById('verify-banner')) return;
        var page = document.querySelector('.page');
        if (!page) return;
        var b = document.createElement('div');
        b.id = 'verify-banner';
        b.className = 'verify-banner';
        b.style.display = 'none';
        var header = page.querySelector('header');
        if (header && header.nextSibling) page.insertBefore(b, header.nextSibling);
        else page.insertBefore(b, page.firstChild);
        b.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-act="resend"]');
            if (btn) doResend(btn);
        });
    }
    function renderBanner() {
        ensureBanner();
        var b = document.getElementById('verify-banner');
        if (!b) return;
        if (Auth.user && !Auth.user.emailVerified) {
            b.style.display = '';
            b.innerHTML =
                '<span class="vb-text">Please verify your email to unlock protected features.</span>' +
                '<button class="auth-btn vb-btn" data-act="resend">Resend email</button>' +
                '<span class="vb-msg" role="status"></span>';
        } else {
            b.style.display = 'none';
            b.innerHTML = '';
        }
    }
    async function doResend(btn) {
        var msg = document.querySelector('#verify-banner .vb-msg');
        var now = Date.now();
        if (now < resendCooldownUntil) return;
        btn.disabled = true;
        try {
            var res = await Auth.resendVerification();
            if (msg) {
                msg.textContent = 'Verification email sent.';
                if (res && res.devLink) msg.innerHTML = 'Sent. <a href="' + res.devLink + '">Open verification link (dev)</a>';
            }
            // 60s cooldown
            resendCooldownUntil = Date.now() + 60000;
            var left = 60;
            var tick = setInterval(function () {
                left -= 1;
                btn.textContent = left > 0 ? 'Resend in ' + left + 's' : 'Resend email';
                if (left <= 0) { clearInterval(tick); btn.disabled = false; }
            }, 1000);
        } catch (err) {
            if (msg) msg.textContent = err.message || 'Could not resend right now.';
            btn.disabled = false;
        }
    }

    // ----- modal (login / register / forgot) -----
    var modal = null;
    function buildModal() {
        if (modal) return modal;
        var backdrop = document.createElement('div');
        backdrop.className = 'auth-modal-backdrop';
        backdrop.innerHTML =
            '<div class="auth-modal" role="dialog" aria-modal="true">' +
                '<div class="auth-tabs">' +
                    '<button class="auth-tab" data-tab="login">Log in</button>' +
                    '<button class="auth-tab" data-tab="register">Sign up</button>' +
                    '<button class="auth-x" aria-label="Close">✕</button>' +
                '</div>' +
                '<form class="auth-form" novalidate>' +
                    '<div class="auth-field f-email"><label>Email</label>' +
                        '<input name="email" type="email" autocomplete="email" maxlength="254"></div>' +
                    '<div class="auth-field f-id"><label class="lbl-id">Username or email</label>' +
                        '<input name="identifier" type="text" autocomplete="username" maxlength="254"></div>' +
                    '<div class="auth-field f-pw"><label>Password</label>' +
                        '<input name="password" type="password" autocomplete="current-password" maxlength="128"></div>' +
                    '<p class="auth-hint f-hint">8+ characters, with at least one letter and one number.</p>' +
                    '<div class="auth-error" role="alert"></div>' +
                    '<div class="auth-ok" role="status"></div>' +
                    '<button class="auth-submit" type="submit"></button>' +
                    '<button type="button" class="auth-link-btn f-forgot" data-mode="forgot">Forgot password?</button>' +
                    '<button type="button" class="auth-link-btn f-back" data-mode="login">‹ Back to log in</button>' +
                '</form>' +
            '</div>';
        document.body.appendChild(backdrop);
        modal = {
            backdrop: backdrop,
            form: backdrop.querySelector('.auth-form'),
            err: backdrop.querySelector('.auth-error'),
            ok: backdrop.querySelector('.auth-ok'),
            submit: backdrop.querySelector('.auth-submit'),
            mode: 'login',
        };
        backdrop.querySelector('.auth-x').onclick = closeModal;
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
        window.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
        backdrop.querySelectorAll('.auth-tab').forEach(function (t) { t.onclick = function () { setMode(t.dataset.tab); }; });
        modal.form.addEventListener('click', function (e) {
            var lk = e.target.closest('[data-mode]');
            if (lk) { e.preventDefault(); setMode(lk.dataset.mode); }
        });
        modal.form.addEventListener('submit', onSubmit);
        return modal;
    }
    function show(el, on) { el.style.display = on ? '' : 'none'; }
    var MODES = {
        login:    { email: 0, id: 1, pw: 1, hint: 0, forgot: 1, back: 0, submit: 'Log in', tabs: 1 },
        register: { email: 1, id: 1, pw: 1, hint: 1, forgot: 0, back: 0, submit: 'Create account', tabs: 1 },
        forgot:   { email: 1, id: 0, pw: 0, hint: 0, forgot: 0, back: 1, submit: 'Send reset link', tabs: 0 },
    };
    function setMode(mode) {
        var m = buildModal();
        var cfg = MODES[mode] || MODES.login;
        m.mode = mode;
        m.err.textContent = ''; m.ok.textContent = '';
        m.backdrop.querySelectorAll('.auth-tab').forEach(function (t) {
            t.classList.toggle('active', cfg.tabs && t.dataset.tab === mode);
        });
        show(m.form.querySelector('.f-email'), cfg.email);
        show(m.form.querySelector('.f-id'), cfg.id);
        show(m.form.querySelector('.f-pw'), cfg.pw);
        show(m.form.querySelector('.f-hint'), cfg.hint);
        show(m.form.querySelector('.f-forgot'), cfg.forgot);
        show(m.form.querySelector('.f-back'), cfg.back);
        m.backdrop.querySelector('.lbl-id').textContent = mode === 'register' ? 'Username' : 'Username or email';
        m.form.password.setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
        m.submit.textContent = cfg.submit;
    }
    function openModal(mode) {
        var m = buildModal();
        setMode(mode || 'login');
        m.form.reset();
        m.backdrop.classList.add('open');
        var sel = m.mode === 'register' ? '[name=email]' : (m.mode === 'forgot' ? '[name=email]' : '[name=identifier]');
        var first = m.form.querySelector(sel);
        if (first) setTimeout(function () { first.focus(); }, 30);
    }
    function closeModal() { if (modal) modal.backdrop.classList.remove('open'); }

    async function onSubmit(e) {
        e.preventDefault();
        var m = modal;
        m.err.textContent = ''; m.ok.textContent = '';
        m.submit.disabled = true;
        try {
            if (m.mode === 'register') {
                await Auth.register(m.form.email.value.trim(), m.form.identifier.value.trim(), m.form.password.value);
                closeModal();
            } else if (m.mode === 'login') {
                await Auth.login(m.form.identifier.value.trim(), m.form.password.value);
                closeModal();
            } else if (m.mode === 'forgot') {
                var res = await Auth.forgotPassword(m.form.email.value.trim());
                m.ok.textContent = 'If that email is registered, a reset link has been sent.';
                if (res && res.devLink) m.ok.innerHTML += ' <a href="' + res.devLink + '">Open reset link (dev)</a>';
            }
        } catch (err) {
            m.err.textContent = err.message || 'Something went wrong';
        } finally {
            m.submit.disabled = false;
        }
    }

    Auth.openModal = openModal;

    function init() {
        ensureHeaderArea();
        ensureBanner();
        refresh().then(function (u) { readyResolve(u); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.AuthClient = Auth;
}());
