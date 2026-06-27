'use strict';
/*
 * Express application assembly. Order matters:
 *   security headers -> CORS -> body/cookie parsing -> logging -> session attach
 *   -> routes -> 404 -> error handler.
 * The app is exported without listening so tests can mount it directly.
 */
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const config = require('./config');
const logger = require('./utils/logger');
const { attachUser } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth.routes');
const aboutRoutes = require('./routes/about.routes');
const usersRoutes = require('./routes/users.routes');

function createApp() {
    const app = express();

    // Behind a proxy in production: trust X-Forwarded-* so req.ip / secure cookies work.
    app.set('trust proxy', 1);

    // Security headers. CSP is left to the static site; this API only emits JSON.
    app.use(helmet({ contentSecurityPolicy: false }));

    // CORS: only the configured browser origins, with credentials (cookies).
    app.use(cors({
        origin(origin, cb) {
            // allow same-origin / curl (no Origin header) and the configured list
            if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
            return cb(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    }));

    app.use(express.json({ limit: '64kb' })); // cap body size (DoS hardening)
    app.use(cookieParser());

    if (config.nodeEnv !== 'test') {
        app.use(morgan('combined', { stream: { write: (m) => logger.info(m.trim()) } }));
    }

    app.use(attachUser);

    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    app.use('/api/auth', authRoutes);
    app.use('/api/about', aboutRoutes);
    app.use('/api/users', usersRoutes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
