'use strict';
/* About-content endpoints.
 *   GET /api/about        - public; returns the markdown content
 *   PUT /api/about        - admin only (auth + role + CSRF); updates the content
 */
const express = require('express');
const { z } = require('zod');
const aboutService = require('../services/about.service');
const { validate } = require('../middleware/validate');
const { requirePermission, requireVerified } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router();

const updateSchema = z.object({
    content: z.string()
        .min(1, 'content cannot be empty')
        .max(aboutService.MAX_LEN, `content exceeds ${aboutService.MAX_LEN} characters`),
}).strict();

router.get('/', (_req, res, next) => {
    try {
        res.json(aboutService.get());
    } catch (e) { next(e); }
});

router.put('/', requirePermission('about:edit'), requireVerified, requireCsrf, validate(updateSchema), (req, res, next) => {
    try {
        const updated = aboutService.update({ content: req.body.content, userId: req.user.id });
        res.json(updated);
    } catch (e) { next(e); }
});

module.exports = router;
