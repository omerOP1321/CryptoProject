'use strict';
/* Central error handling. Operational AppErrors return their safe message;
 * anything unexpected is logged server-side and reported as a generic 500 so no
 * stack trace, SQL text, or internal detail ever reaches the client. */
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

function notFoundHandler(_req, res) {
    res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars  (Express needs the 4-arg signature)
function errorHandler(err, req, res, _next) {
    if (err instanceof AppError && err.expose) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    // Known client errors from body-parser (malformed / oversized JSON): respond
    // with a safe 4xx instead of a confusing 500. Still no internal detail leaks.
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
        return res.status(400).json({ error: 'Invalid request body' });
    }
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return res.status(413).json({ error: 'Request body too large' });
    }
    // CORS rejection from the origin allow-list.
    if (err && err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    logger.error('unhandled error', { method: req.method, path: req.path, message: err && err.message });
    res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };
