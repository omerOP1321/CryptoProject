'use strict';
/*
 * Minimal structured logger. In a larger system this would be pino/winston with
 * transports; the interface is kept small so swapping it later is trivial.
 */
function ts() { return new Date().toISOString(); }

function emit(level, msg, meta) {
    const line = `${ts()} [${level}] ${msg}`;
    if (meta !== undefined) {
        // never log secrets; callers pass only safe metadata
        console[level === 'error' ? 'error' : 'log'](line, meta);
    } else {
        console[level === 'error' ? 'error' : 'log'](line);
    }
}

module.exports = {
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    // security-relevant events get a distinct tag for easy auditing/alerting
    security: (msg, meta) => emit('info', `SECURITY ${msg}`, meta),
};
