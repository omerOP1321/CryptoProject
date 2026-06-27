'use strict';
/*
 * Admin user-management business logic. Guards protect against foot-guns:
 *   - you cannot delete or change the role of your own account (lockout safety)
 *   - the last remaining admin cannot be deleted or demoted
 * Deleting a user cascades their sessions and tokens (ON DELETE CASCADE).
 */
const users = require('../repositories/user.repo');
const { ALL_ROLES } = require('../utils/permissions');
const { badRequest, notFound, forbidden } = require('../utils/errors');
const logger = require('../utils/logger');

function list() {
    return users.listAll().map(users.publicView);
}

function parseId(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid user id');
    return n;
}

function remove(actingUser, targetIdRaw) {
    const targetId = parseId(targetIdRaw);
    if (targetId === actingUser.id) throw forbidden('You cannot delete your own account', 'SELF_DELETE');
    const target = users.findById(targetId);
    if (!target) throw notFound('User not found');
    if (target.role === 'admin' && users.countByRole('admin') <= 1) {
        throw forbidden('Cannot delete the last admin', 'LAST_ADMIN');
    }
    users.delete(targetId);
    logger.security('user deleted', { by: actingUser.id, target: targetId });
    return { ok: true };
}

function changeRole(actingUser, targetIdRaw, role) {
    const targetId = parseId(targetIdRaw);
    if (!ALL_ROLES.includes(role)) throw badRequest('Invalid role');
    if (targetId === actingUser.id) throw forbidden('You cannot change your own role', 'SELF_ROLE');
    const target = users.findById(targetId);
    if (!target) throw notFound('User not found');
    if (target.role === 'admin' && role !== 'admin' && users.countByRole('admin') <= 1) {
        throw forbidden('Cannot demote the last admin', 'LAST_ADMIN');
    }
    if (target.role !== role) {
        users.setRole(targetId, role);
        logger.security('user role changed', { by: actingUser.id, target: targetId, role });
    }
    return users.publicView(users.findById(targetId));
}

module.exports = { list, remove, changeRole };
