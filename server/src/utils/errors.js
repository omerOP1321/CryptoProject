'use strict';
/*
 * Operational errors carry a safe, client-facing message and an HTTP status.
 * Anything that is NOT an AppError is treated as unexpected by the error
 * handler and reported generically, so internals/stack traces never leak.
 */
class AppError extends Error {
    constructor(statusCode, message, code) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code || undefined;
        this.expose = true; // safe to show this message to the client
    }
}

const badRequest = (msg, code) => new AppError(400, msg || 'Bad request', code);
const unauthorized = (msg, code) => new AppError(401, msg || 'Authentication required', code);
const forbidden = (msg, code) => new AppError(403, msg || 'Forbidden', code);
const notFound = (msg, code) => new AppError(404, msg || 'Not found', code);
const conflict = (msg, code) => new AppError(409, msg || 'Conflict', code);
const tooManyRequests = (msg, code) => new AppError(429, msg || 'Too many requests', code);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests };
