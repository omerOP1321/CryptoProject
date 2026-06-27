'use strict';
/*
 * Role-based access control. Permissions are declared per role in ONE place, so
 * adding a role or a permission later is a data change here — not edits across
 * route files. Routes ask for a permission (requirePermission), never a role
 * name, which keeps authorization decisions centralized and extensible.
 *
 * Roles:
 *   user       - read-only access to the public site
 *   semi_admin - may edit the About page and VIEW the admin overview (read-only)
 *   admin      - full user management + everything semi_admin can do
 */
const ROLE_PERMISSIONS = {
    user: [],
    semi_admin: ['about:edit', 'users:read'],
    admin: ['about:edit', 'users:read', 'users:manage'],
};

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);

function permissionsFor(role) {
    return ROLE_PERMISSIONS[role] || [];
}
function can(user, permission) {
    return !!user && permissionsFor(user.role).includes(permission);
}

module.exports = { ROLE_PERMISSIONS, ALL_ROLES, permissionsFor, can };
