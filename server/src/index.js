'use strict';
/* Server entry point: ensure the schema exists, start periodic session cleanup,
 * and listen. */
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');
const sessions = require('./repositories/session.repo');

// Ensure schema + seed exist (idempotent).
migrate(db);

// Periodically purge expired sessions (hourly).
setInterval(() => {
    try { sessions.purgeExpired(); } catch (e) { logger.error('session purge failed', { message: e.message }); }
}, 60 * 60 * 1000).unref();

const app = createApp();
app.listen(config.port, () => {
    logger.info(`auth API listening on http://localhost:${config.port} (${config.nodeEnv})`);
    logger.info(`CORS origins: ${config.corsOrigins.join(', ')}`);
});
