'use strict';
/* Validation middleware: runs a zod schema against part of the request and
 * replaces it with the parsed (coerced, stripped) value. Rejects on first issue
 * with a safe 400 message. */
const { badRequest } = require('../utils/errors');

function validate(schema, source = 'body') {
    return (req, _res, next) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) {
            const issue = result.error.issues[0];
            const where = issue.path && issue.path.length ? `${issue.path.join('.')}: ` : '';
            return next(badRequest(`${where}${issue.message}`, 'VALIDATION'));
        }
        req[source] = result.data;
        next();
    };
}

module.exports = { validate };
