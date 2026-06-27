/*
 * Admin Overview controller. Lists users and (for full admins) lets you change
 * roles, grant/revoke semi-admin, and delete accounts. Semi-admins see the table
 * read-only. RBAC is enforced on the BACKEND too — this UI just reflects it.
 *
 * Built with DOM APIs + textContent (not innerHTML for user data) to avoid XSS.
 */
(function () {
    'use strict';
    var A = window.AuthClient;
    var ROLES = ['user', 'semi_admin', 'admin'];
    var ROLE_LABEL = { user: 'User', semi_admin: 'Semi Admin', admin: 'Admin' };
    var content = document.getElementById('admin-content');
    var sub = document.getElementById('admin-sub');

    function fmtDate(s) {
        if (!s) return '—';
        // Supabase returns ISO-8601 (with timezone); parse directly.
        var d = new Date(s);
        return isNaN(d) ? '—' : d.toLocaleString();
    }
    function el(tag, props, kids) {
        var n = document.createElement(tag);
        if (props) Object.keys(props).forEach(function (k) {
            if (k === 'text') n.textContent = props[k];
            else if (k === 'class') n.className = props[k];
            else n.setAttribute(k, props[k]);
        });
        (kids || []).forEach(function (c) { n.appendChild(c); });
        return n;
    }

    var state = { users: [], canManage: false };

    async function load() {
        try {
            state.users = await A.listUsers();
            render();
        } catch (e) {
            content.textContent = (e && e.status === 403)
                ? 'You do not have permission to view this page.'
                : 'Could not load users.';
        }
    }

    function render() {
        state.canManage = A.user && A.user.role === 'admin';
        sub.textContent = state.canManage
            ? 'Manage accounts, roles and permissions.'
            : 'Read-only overview. Only full admins can modify users.';

        var head = ['ID', 'Username', 'Email', 'Role', 'Verified', 'Created', 'Last login'];
        if (state.canManage) head.push('Actions');
        var thead = el('thead', null, [el('tr', null, head.map(function (h) { return el('th', { text: h }); }))]);

        var rows = state.users.map(buildRow);
        var tbody = el('tbody', null, rows);
        var table = el('table', { class: 'cmp-table admin-table' }, [thead, tbody]);

        content.innerHTML = '';
        content.appendChild(el('div', { class: 'cmp-wrap' }, [table]));
    }

    function buildRow(u) {
        var isSelf = A.user && u.id === A.user.id;
        var tr = el('tr', { 'data-id': u.id });
        tr.appendChild(el('td', { text: String(u.id).slice(0, 8), title: String(u.id) }));
        tr.appendChild(el('td', null, [el('span', { class: 'admin-username', text: u.username + (isSelf ? ' (you)' : '') })]));
        tr.appendChild(el('td', { text: u.email }));
        tr.appendChild(el('td', null, [roleBadge(u.role)]));
        tr.appendChild(el('td', null, [verifiedBadge(u.emailVerified)]));
        tr.appendChild(el('td', { text: fmtDate(u.createdAt) }));
        tr.appendChild(el('td', { text: fmtDate(u.lastLoginAt) }));
        if (state.canManage) tr.appendChild(buildActions(u, isSelf));
        return tr;
    }

    function roleBadge(role) {
        return el('span', { class: 'role-pill role-' + role, text: ROLE_LABEL[role] || role });
    }
    function verifiedBadge(v) {
        return el('span', { class: 'res-badge ' + (v ? 'res-ok' : 'res-na'), text: v ? '✓ verified' : 'unverified' });
    }

    function buildActions(u, isSelf) {
        var td = el('td', { class: 'admin-actions' });
        if (isSelf) { td.appendChild(el('span', { class: 'admin-self', text: '—' })); return td; }

        // role selector
        var sel = el('select', { class: 'ana-select admin-role-select' });
        ROLES.forEach(function (r) {
            var o = el('option', { value: r, text: ROLE_LABEL[r] });
            if (r === u.role) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', function () { changeRole(u, sel.value, sel); });
        td.appendChild(sel);

        // quick grant/revoke semi-admin
        if (u.role === 'user' || u.role === 'semi_admin') {
            var grant = u.role === 'user';
            var btn = el('button', { class: 'auth-btn', text: grant ? 'Grant semi-admin' : 'Revoke semi-admin' });
            btn.addEventListener('click', function () { changeRole(u, grant ? 'semi_admin' : 'user'); });
            td.appendChild(btn);
        }

        // delete
        var del = el('button', { class: 'auth-btn admin-del', text: 'Delete' });
        del.addEventListener('click', function () { removeUser(u); });
        td.appendChild(del);
        return td;
    }

    async function changeRole(u, role, selEl) {
        if (role === u.role) return;
        try {
            await A.setRole(u.id, role);
            await load();
        } catch (e) {
            alert((e && e.message) || 'Could not change role.');
            if (selEl) selEl.value = u.role;
        }
    }

    async function removeUser(u) {
        if (!window.confirm('Delete user "' + u.username + '" (#' + u.id + ')? This cannot be undone.')) return;
        try {
            await A.deleteUser(u.id);
            await load();
        } catch (e) {
            alert((e && e.message) || 'Could not delete user.');
        }
    }

    if (!A) { content.textContent = 'Auth client unavailable.'; return; }
    A.ready.then(function () {
        if (!A.canReadUsers()) {
            content.innerHTML = '';
            content.appendChild(el('div', { class: 'cards-empty', text: 'You must be an admin or semi-admin to view this page.' }));
            sub.textContent = 'Access restricted.';
            return;
        }
        load();
    });
    // reflect login/logout changes that happen while on this page
    A.on(function () { if (A.canReadUsers()) load(); });
}());
