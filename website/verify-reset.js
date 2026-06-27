/*
 * Controller for verify.html and reset.html. The flow is selected via the
 * data-flow attribute on this script tag ("verify" | "reset").
 *
 * Supabase delivers email-confirmation and password-recovery as one-time tokens
 * in the redirect URL. The shared client (supabase-client.js) is created with
 * detectSessionInUrl:true, so it consumes those tokens and establishes a session
 * automatically. Here we just read the resulting session and drive the UI.
 */
(function () {
    'use strict';
    var sb = window.sb;
    var flow = (document.currentScript && document.currentScript.dataset.flow) || 'verify';

    function go(url, delay) { setTimeout(function () { location.href = url; }, delay || 1500); }

    // Surface an explicit error Supabase may put in the URL (hash or query).
    function urlError() {
        var hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
        var qs = new URLSearchParams(location.search || '');
        return hash.get('error_description') || qs.get('error_description') ||
               hash.get('error') || qs.get('error') || '';
    }

    async function currentSession() {
        if (!sb) return null;
        try { var r = await sb.auth.getSession(); return r.data && r.data.session; }
        catch (_) { return null; }
    }

    if (flow === 'verify') {
        var icon = document.getElementById('vf-icon');
        var title = document.getElementById('vf-title');
        var msg = document.getElementById('vf-msg');
        var cta = document.getElementById('vf-cta');

        (async function () {
            var err = urlError();
            if (err) {
                icon.textContent = '⚠️'; title.textContent = 'Verification failed';
                msg.textContent = decodeURIComponent(err) || 'This link is invalid or has expired.';
                cta.style.display = ''; return;
            }
            var session = await currentSession();
            if (session) {
                icon.textContent = '✓'; title.textContent = 'Email verified';
                msg.textContent = 'Your email is confirmed. Redirecting to the dashboard…';
                cta.style.display = '';
                go('index.html', 1800);
            } else {
                icon.textContent = '⚠️'; title.textContent = 'Invalid link';
                msg.textContent = 'This verification link is invalid or has already been used. ' +
                    'Log in, then use “Resend email” if you still need to confirm.';
                cta.style.display = '';
            }
        }());
        return;
    }

    // ----- reset flow -------------------------------------------------------
    var form = document.getElementById('reset-form');
    var errEl = document.getElementById('reset-err');
    var okEl = document.getElementById('reset-ok');
    var submitBtn = form.querySelector('button[type=submit]');

    // The recovery session must exist before we can set a new password.
    (async function () {
        var err = urlError();
        var session = await currentSession();
        if (err || !session) {
            errEl.textContent = (err && decodeURIComponent(err)) ||
                'This reset link is invalid or has expired. Request a new one from “Forgot password?”.';
            submitBtn.disabled = true;
        }
    }());

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        errEl.textContent = ''; okEl.textContent = '';
        var pw = form.password.value;
        var confirm = form.confirm.value;
        if (pw !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
        if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
            errEl.textContent = 'Password must be 8+ characters and include a letter and a number.'; return;
        }
        submitBtn.disabled = true;
        try {
            await window.AuthClient.updatePassword(pw);
            okEl.textContent = 'Password updated. Redirecting to log in…';
            try { await sb.auth.signOut(); } catch (_) {}
            go('index.html', 1600);
        } catch (e2) {
            errEl.textContent = (e2 && e2.message) || 'Could not reset password. The link may have expired.';
            submitBtn.disabled = false;
        }
    });
}());
