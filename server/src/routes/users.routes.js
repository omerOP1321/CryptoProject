'use strict';
/* Admin user-management endpoints (RBAC-enforced).
 *   GET    /api/users          - list users        (users:read   -> admin + semi_admin)
 *   PUT    /api/users/:id/role - change a role      (users:manage -> admin only)
 *   DELETE /api/users/:id      - delete a user      (users:manage -> admin only)
 * The "grant/revoke semi-admin" action is just a role change to/from 'semi_admin'.
 */
const express = require('express');
const { z } = require('zod');
const userService = require('../services/user.service');
const { validate } = require('../middleware/validate');
const { requirePermission, requireVerified } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router();

const roleSchema = z.object({ role: z.enum(['user', 'semi_admin', 'admin']) }).strict();

router.get('/', requirePermission('users:read'), (_req, res, next) => {
    try {
        res.json({ users: userService.list() });
    } catch (e) { next(e); }
});

router.put('/:id/role', requirePermission('users:manage'), requireVerified, requireCsrf, validate(roleSchema), (req, res, next) => {
    try {
        res.json({ user: userService.changeRole(req.user, req.params.id, req.body.role) });
    } catch (e) { next(e); }
});

router.delete('/:id', requirePermission('users:manage'), requireVerified, requireCsrf, (req, res, next) => {
    try {
        res.json(userService.remove(req.user, req.params.id));
    } catch (e) { next(e); }
});

module.exports = router;
