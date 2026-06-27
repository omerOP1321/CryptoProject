'use strict';
/* Coarse per-IP rate limiting on auth endpoints (a second layer on top of the
 * per-identifier failed-login throttle in the auth service). */
const rateLimit = require('express-rate-limit');
const config = require('../config');

const authLimiter = rateLimit({
    windowMs: config.login.windowMs,
    max: config.login.ipMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP. Please slow down.' },
});

module.exports = { authLimiter };
