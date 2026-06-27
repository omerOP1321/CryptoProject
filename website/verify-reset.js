/*
 * Controller for verify.html and reset.html. The flow is selected via the
 * data-flow attribute on this script tag ("verify" | "reset"). Both read the
 * one-time token from ?token= and call the public auth endpoints, then redirect.
 */
(function () {
    'use strict';
    var A = window.AuthClient;
    var flow = (document.currentScript && document.currentScript.dataset.flow) || 'verify';
    var token = new URLSearchParams(location.search).get('token') || '';

    function go(url, delay) { setTimeout(function () { location.href = url; }, delay || 1500); }

    if (flow === 'verify') {
        var icon = document.getElementById('vf-icon');
        var title = document.getElementById('vf-title');
        var msg = document.getElementById('vf-msg');
        var cta = document.getElementById('vf-cta');
        if (!token) {
            icon.textContent = '⚠️'; title.textContent = 'Invalid link';
            msg.textContent = 'This verification link is missing its token.'; cta.style.display = '';
            return;
        }
        A.verifyEmail(token).then(function () {
            icon.textContent = '✓'; title.textContent = 'Email verified';
            msg.textContent = 'Your email is confirmed. Redirecting to the dashboard…';
            cta.style.display = '';
            // refresh auth state (if logged in here) so the banner clears, then redirect
            if (A.ready) { A.ready.catch(function () {}); }
            go('index.html', 1800);
        }).catch(function (err) {
            icon.textContent = '⚠️'; title.textContent = 'Verification failed';
            msg.textContent = (err && err.message) || 'This link is invalid or has expired. Request a new one from the banner after logging in.';
            cta.style.display = '';
        });
        return;
    }

    // reset flow
    var form = document.getElementById('reset-form');
    var err = document.getElementById('reset-err');
    var ok = document.getElementById('reset-ok');
    if (!token) {
        err.textContent = 'This reset link is missing its token. Request a new one from “Forgot password?”.';
        form.querySelector('button[type=submit]').disabled = true;
        return;
    }
    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        err.textContent = ''; ok.textContent = '';
        var pw = form.password.value;
        var confirm = form.confirm.value;
        if (pw !== confirm) { err.textContent = 'Passwords do not match.'; return; }
        if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
            err.textContent = 'Password must be 8+ characters and include a letter and a number.'; return;
        }
        var btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await A.resetPassword(token, pw);
            ok.textContent = 'Password updated. Redirecting to log in…';
            go('index.html', 1600);
        } catch (e2) {
            err.textContent = (e2 && e2.message) || 'Could not reset password. The link may have expired.';
            btn.disabled = false;
        }
    });
}());
