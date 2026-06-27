'use strict';
/*
 * About-content business logic. Content is stored as markdown and rendered with
 * an escape-then-format pass on the client, so it can never inject HTML/scripts.
 * As defense-in-depth we also reject control characters and cap the length here.
 */
const about = require('../repositories/about.repo');
const { badRequest, notFound } = require('../utils/errors');
const logger = require('../utils/logger');

const MAX_LEN = 20000;
// Disallow control chars except tab/newline/carriage-return.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function get() {
    const row = about.get();
    if (!row) throw notFound('About content not found');
    return { content: row.content, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

function update({ content, userId }) {
    if (typeof content !== 'string') throw badRequest('content must be a string');
    const trimmed = content.trim();
    if (trimmed.length === 0) throw badRequest('content cannot be empty');
    if (trimmed.length > MAX_LEN) throw badRequest(`content exceeds ${MAX_LEN} characters`);
    if (CONTROL_CHARS.test(trimmed)) throw badRequest('content contains forbidden control characters');

    const row = about.save({ content: trimmed, updatedBy: userId });
    logger.security('about content updated', { by: userId, length: trimmed.length });
    return { content: row.content, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

module.exports = { get, update, MAX_LEN };
