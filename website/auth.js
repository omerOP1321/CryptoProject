/*
 * Auth client + UI, shared by all pages. Backed by Supabase Auth (no custom
 * server): registration, login, email confirmation, password reset and the
 * session all run through supabase-js against the project's Supabase backend.
 *
 * Roles (user / semi_admin / admin) and the About content live in Postgres and
 * are reached via the SECURITY DEFINER RPCs defined in supabase/auth_setup.sql.
 *
 * Other scripts use window.AuthClient (its `ready` promise + 'change' events) to
 * react to auth state. The public surface is unchanged from the old REST client:
 *   user, isAdmin(), canReadUsers(), canEditAbout(), on(), ready,
 *   login(), register(), logout(), forgotPassword(), resendVerification(),
 *   openModal(), plus the data helpers listUsers()/setRole()/deleteUser()/
 *   getAbout()/saveAbout()/updatePassword().
 */
(function () {
    'use strict';
    var sb = window.sb; // shared client from supabase-client.js

    var listeners = [];
    var readyResolve;
    var Auth = {
        user: null,
        on: function (cb) { listeners.push(cb); },
        // Always a promise (created synchronously) so consumers can `.then` it
        // regardless of script timing; resolves once the initial session loads.
        ready: new Promise(function (res) { readyResolve = res; }),
        isAdmin: function () { return !!Auth.user && Auth.user.role === 'admin'; },
        canReadUsers: function () { return !!Auth.user && (Auth.user.role === 'admin' || Auth.user.role === 'semi_admin'); },
        // About editing is allowed for admin + semi_admin, but only once verified
        // (the RLS policy enforces it; this mirrors it so the UI matches).
        canEditAbout: function () { return Auth.canReadUsers() && !!Auth.user.emailVerified; },
    };
    function emit() { listeners.forEach(function (cb) { try { cb(Auth.user); } catch (_) {} }); }

    // base origin used to build email confirmation / reset redirect links
    function siteOrigin() { return location.origin; }

    // Turn a supabase-js error into a short, user-safe message.
    function msgOf(error, fallback) {
        if (!error) return fallback || 'Something went wrong';
        var m = error.message || fallback || 'Something went wrong';
        if (/Email not confirmed/i.test(m)) return 'Please confirm your email first — check your inbox.';
        if (/Invalid login credentials/i.test(m)) return 'Invalid credentials';
        return m;
    }

    // ----- session / current user ------------------------------------------
    async function buildUser(session) {
        if (!session || !session.user) return null;
        var u = session.user;
        var role = 'user';
        try {
            var res = await sb.from('profiles').select('username, role').eq('id', u.id).single();
            if (res.data) role = res.data.role || 'user';
            var username = (res.data && res.data.username) || (u.user_metadata && u.user_metadata.username) || u.email;
        } catch (_) {}
        return {
            id: u.id,
            email: u.email,
            username: username || u.email,
            role: role,
            emailVerified: !!u.email_confirmed_at,
            createdAt: u.created_at,
            lastLoginAt: u.last_sign_in_at,
        };
    }

    async function refresh() {
        try {
            var res = await sb.auth.getSession();
            Auth.user = await buildUser(res.data && res.data.session);
        } catch (_) {
            Auth.user = null;
        }
        renderUI();
        emit();
        return Auth.user;
    }

    // ----- auth actions -----------------------------------------------------
    Auth.login = async function (identifier, password) {
        // Supabase signs in by email; resolve a username to its email first.
        var email = identifier;
        if (identifier.indexOf('@') === -1) {
            var r = await sb.rpc('email_for_identifier', { identifier: identifier });
            email = (r && r.data) || null;
            if (!email) { var e = new Error('Invalid credentials'); throw e; }
        }
        var out = await sb.auth.signInWithPassword({ email: email, password: password });
        if (out.error) { var err = new Error(msgOf(out.error)); throw err; }
        await refresh();
        return Auth.user;
    };

    Auth.register = async function (email, username, password) {
        // friendly pre-check (the DB UNIQUE constraint is the real guard)
        try {
            var avail = await sb.rpc('username_available', { uname: username });
            if (avail && avail.data === false) { var e = new Error('Username is already taken'); throw e; }
        } catch (pre) { if (pre && /already taken/.test(pre.message)) throw pre; }

        var out = await sb.auth.signUp({
            email: email,
            password: password,
            options: {
                data: { username: username },
                emailRedirectTo: siteOrigin() + '/verify.html',
            },
        });
        if (out.error) { var err = new Error(msgOf(out.error)); throw err; }
        // With "Confirm email" ON, no session is returned until the link is
        // clicked. Signal the UI to show "check your inbox".
        var hasSession = !!(out.data && out.data.session);
        if (hasSession) await refresh();
        return { needsVerification: !hasSession, email: email };
    };

    Auth.logout = async function () {
        try { await sb.auth.signOut(); } catch (_) {}
        Auth.user = null; renderUI(); emit();
    };

    Auth.forgotPassword = async function (email) {
        var out = await sb.auth.resetPasswordForEmail(email, { redirectTo: siteOrigin() + '/reset.html' });
        // Don't surface whether the email exists (anti-enumeration); ignore errors.
        return { ok: !out.error };
    };

    Auth.resendVerification = async function (email) {
        var addr = email || (Auth.user && Auth.user.email);
        if (!addr) throw new Error('No email to resend to.');
        var out = await sb.auth.resend({ type: 'signup', email: addr, options: { emailRedirectTo: siteOrigin() + '/verify.html' } });
        if (out.error) throw new Error(msgOf(out.error));
        return { ok: true };
    };

    // Used by reset.html after the recovery session is established.
    Auth.updatePassword = async function (newPassword) {
        var out = await sb.auth.updateUser({ password: newPassword });
        if (out.error) throw new Error(msgOf(out.error));
        return { ok: true };
    };

    // ----- data helpers (replace the old REST endpoints) -------------------
    Auth.listUsers = async function () {
        var out = await sb.rpc('admin_list_users');
        if (out.error) { var e = new Error(out.error.message || 'Could not load users'); e.status = 403; throw e; }
        return (out.data || []).map(function (u) {
            return {
                id: u.id,
                username: u.username,
                email: u.email,
                role: u.role,
                emailVerified: u.email_verified,
                createdAt: u.created_at,
                lastLoginAt: u.last_login_at,
            };
        });
    };
    Auth.setRole = async function (id, role) {
        var out = await sb.rpc('admin_set_role', { target: id, new_role: role });
        if (out.error) throw new Error(out.error.message || 'Could not change role.');
    };
    Auth.deleteUser = async function (id) {
        var out = await sb.rpc('admin_delete_user', { target: id });
        if (out.error) throw new Error(out.error.message || 'Could not delete user.');
    };
    Auth.getAbout = async function () {
        var out = await sb.from('about_content').select('content').eq('id', 1).single();
        if (out.error) throw new Error('Could not load About content.');
        return { content: (out.data && out.data.content) || '' };
    };
    Auth.saveAbout = async function (content) {
        var out = await sb.from('about_content')
            .update({ content: content, updated_by: Auth.user && Auth.user.id, updated_at: new Date().toISOString() })
            .eq('id', 1).select('content').single();
        if (out.error) throw new Error(out.error.message || 'Save failed');
        return { content: out.data.content };
    };

    function renderUI() { renderHeader(); renderBanner(); }

    // ----- header control ---------------------------------------------------
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

    // ----- "verify your email" banner --------------------------------------
    // With "Confirm email" ON, an unverified user normally has no session, so
    // this rarely shows — kept as a safety net if confirmation is disabled.
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
        if (Date.now() < resendCooldownUntil) return;
        btn.disabled = true;
        try {
            await Auth.resendVerification();
            if (msg) msg.textContent = 'Verification email sent.';
            resendCooldownUntil = Date.now() + 60000; // 60s cooldown
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

    // ----- modal (login / register / forgot) -------------------------------
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

    function validRegister(email, username, password) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email address.';
        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return 'Username must be 3–32 letters, numbers, dot, dash or underscore.';
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
            return 'Password must be 8+ characters and include a letter and a number.';
        return null;
    }

    async function onSubmit(e) {
        e.preventDefault();
        var m = modal;
        m.err.textContent = ''; m.ok.textContent = '';
        m.submit.disabled = true;
        try {
            if (m.mode === 'register') {
                var email = m.form.email.value.trim();
                var username = m.form.identifier.value.trim();
                var pw = m.form.password.value;
                var bad = validRegister(email, username, pw);
                if (bad) { m.err.textContent = bad; return; }
                var res = await Auth.register(email, username, pw);
                if (res.needsVerification) {
                    m.ok.textContent = 'Account created. Check your inbox to confirm your email, then log in.';
                } else {
                    closeModal();
                }
            } else if (m.mode === 'login') {
                await Auth.login(m.form.identifier.value.trim(), m.form.password.value);
                closeModal();
            } else if (m.mode === 'forgot') {
                await Auth.forgotPassword(m.form.email.value.trim());
                m.ok.textContent = 'If that email is registered, a reset link has been sent.';
            }
        } catch (err) {
            m.err.textContent = err.message || 'Something went wrong';
        } finally {
            m.submit.disabled = false;
        }
    }

    Auth.openModal = openModal;

    function init() {
        if (!sb) {
            // supabase-client.js / CDN failed to load — degrade gracefully.
            ensureHeaderArea();
            readyResolve(null);
            return;
        }
        ensureHeaderArea();
        ensureBanner();
        // React to confirmation / recovery links and cross-tab logout.
        sb.auth.onAuthStateChange(function () { refresh(); });
        refresh().then(function (u) { readyResolve(u); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.AuthClient = Auth;
}());
