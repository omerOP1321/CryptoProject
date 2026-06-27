/*
 * Shared Supabase client for the whole site. Loaded after the supabase-js CDN
 * and before any script that talks to Supabase (auth.js, page controllers, the
 * inline dashboard script). A single client instance avoids the "Multiple
 * GoTrueClient instances" warning and keeps one auth session across pages.
 *
 * detectSessionInUrl lets verify.html / reset.html pick up the one-time tokens
 * Supabase puts in the redirect URL (email confirmation + password recovery).
 */
(function () {
    'use strict';
    var SUPABASE_URL = 'https://iphxmjltsigsaocicipu.supabase.co';
    var SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4clMLjZVc1oacTPOb5XrUA_w9T5aevj';

    // exposed so existing inline code (index.html) can reuse the same constants
    window.SUPABASE_URL = SUPABASE_URL;
    window.SUPABASE_PUBLISHABLE_KEY = SUPABASE_PUBLISHABLE_KEY;

    if (window.supabase && !window.sb) {
        window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true,
            },
        });
    }
}());
