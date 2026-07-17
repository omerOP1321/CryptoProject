/*
 * About-page controller. Loads the markdown content from the API and renders it
 * with an escape-THEN-format pass (so stored content can never inject HTML or
 * scripts — stored-XSS safe). Admins get an inline editor that PUTs updates with
 * the CSRF token; everyone else sees read-only content.
 */
(function () {
    'use strict';
    var A = window.AuthClient;
    var contentEl = document.getElementById('about-content');
    var adminEl = document.getElementById('about-admin');
    var teamEl = document.getElementById('about-team');
    var current = '';
    var teamData = [];        // live team, loaded from DB (falls back to DEFAULT_TEAM)
    var teamLoaded = false;   // becomes true once the DB fetch resolves

    /* =========================================================================
       TEAM MEMBERS
       -------------------------------------------------------------------------
       Cards are stored in the database (team_content table) and editable from
       the web by an admin via the "✎ Edit team" button. This array is only the
       DEFAULT / fallback seed used when the DB has no team rows yet (or can't be
       reached). Per-member fields:

         name        (required)  — full name, shown as the card title
         role        (optional)  — short title under the name
         description (optional)  — one or two sentences
         emoji       (optional)  — avatar glyph; falls back to the name's initials
         accent      (optional)  — avatar accent colour (any CSS colour)
         tags        (optional)  — array of short skill chips, e.g. ['ML','API']
         links       (optional)  — array of { label, href } (GitHub, email, …)

       Only `name` is required; omit any field you don't need.
       ========================================================================= */
    var DEFAULT_TEAM = [
        {
            name: 'Dr. Ronen Almog',
            role: 'Project Supervisor',
            description: 'Academic advisor guiding the research direction and model evaluation.',
            emoji: '🎓',
            accent: '#7c5cff'
        },
        {
            name: 'Ofir Zohar',
            role: 'Backend & ML Engineering',
            description: 'Serving pipeline, Supabase integration and model deployment.',
            accent: '#2f9dff',
            tags: ['Python', 'Supabase', 'ML']
        },
        {
            name: 'Omer Peretz',
            role: 'Data & Modeling',
            description: 'Data collection, feature engineering and model training.',
            accent: '#1fc28a',
            tags: ['Data', 'LSTM', 'TFT']
        },
        {
            name: 'Ofir Fichman',
            role: 'Frontend & UX',
            description: 'Dashboard UI, charts and the analytics experience.',
            accent: '#ff8a3d',
            tags: ['JS', 'UI']
        },
        {
            name: 'Molly',
            role: 'Team Member',
            description: 'Contributing across the project.',
            accent: '#ff5c8a'
        }
    ];

    // Heading + intro shown above the cards. Edit freely.
    var TEAM_HEADING = 'Meet the team';
    var TEAM_SUBTITLE = 'The people behind the Crypto AI Prediction project.';

    /* Fallback About content shown when the database has no content yet (or the
       fetch fails). Admins can override it from the in-page editor; this just
       guarantees the page never looks empty. Plain markdown (same subset the
       editor uses). */
    var DEFAULT_ABOUT = [
        '# About this project',
        '',
        'Real-time cryptocurrency price prediction powered by machine-learning models.',
        '',
        '## What it does',
        'This dashboard streams live market data for **Bitcoin, Ethereum and Ripple** and shows short-horizon price forecasts from several AI models side by side. Each model\'s prediction, recent accuracy and directional hit-rate are tracked live so you can compare how they perform against one another.',
        '',
        '## The models',
        '- **ARIMA** — the statistical baseline targeting the next 5 minutes.',
        '- **LSTM (5M) & TFT (5M)** — legacy deep-learning models targeting the next 5 minutes.',
        '- **LSTM (1H) & TFT (1H)** — v2 challenger models targeting +60 minutes, anchored to the clock hour.',
        '- **ARIMA (1H)** — the statistical baseline at the 1-hour horizon, also anchored to the clock hour.',
        '',
        '## How it works',
        'A serving pipeline collects market candles, runs each model, and writes the predictions to a Supabase database. The dashboard polls that data and renders it with TradingView Lightweight Charts.',
        '',
        '## Investments simulator',
        'The Investments page replays how a starting amount would have performed had you followed each model\'s predictions over a chosen asset and date range — with profit/loss, win rate, drawdown and a Buy & Hold benchmark.'
    ].join('\n');

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    // Minimal, safe markdown subset. Input is escaped first; we only ever ADD a
    // fixed set of tags (h2-h4, p, ul/li, strong, em), never echo raw input as HTML.
    function renderMarkdown(md) {
        var esc = escapeHtml(md);
        var out = '', inList = false, para = [];
        function inline(t) {
            return t
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
        }
        function flushPara() { if (para.length) { out += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } }
        function closeList() { if (inList) { out += '</ul>'; inList = false; } }
        esc.split('\n').forEach(function (line) {
            var l = line.trim();
            if (l === '') { flushPara(); closeList(); return; }
            var h = l.match(/^(#{1,3})\s+(.*)$/);
            if (h) { flushPara(); closeList(); var lvl = h[1].length + 1; out += '<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'; return; }
            var li = l.match(/^[-*]\s+(.*)$/);
            if (li) { flushPara(); if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + inline(li[1]) + '</li>'; return; }
            para.push(l);
        });
        flushPara(); closeList();
        return out;
    }

    async function load() {
        try {
            var data = await A.getAbout();
            current = (data && data.content ? data.content : '').trim();
            contentEl.innerHTML = renderMarkdown(current || DEFAULT_ABOUT);
        } catch (e) {
            // Network/API failure — still show the default so the page isn't empty.
            current = '';
            contentEl.innerHTML = renderMarkdown(DEFAULT_ABOUT);
        }
    }

    // Initials from a name, used when a member has no emoji avatar.
    function initials(name) {
        var parts = String(name).trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        var first = parts[0][0] || '';
        var last = parts.length > 1 ? parts[parts.length - 1][0] : '';
        return (first + last).toUpperCase();
    }

    // Only admins may edit the team (DB RLS enforces it; this mirrors it so the
    // button only shows when the save would actually succeed).
    function canEditTeam() { return !!(A && A.isAdmin && A.isAdmin()); }

    // Load the team from the DB. Falls back to DEFAULT_TEAM when the DB is empty
    // or unreachable so the section is never blank.
    async function loadTeam() {
        try {
            var data = await A.getTeam();
            teamData = (data && Array.isArray(data.members) && data.members.length)
                ? data.members : DEFAULT_TEAM.slice();
        } catch (e) {
            teamData = DEFAULT_TEAM.slice();
        }
        teamLoaded = true;
        renderTeam();
    }

    // Build the team section from teamData. Everything is escaped, so stored
    // content can never inject HTML.
    function renderTeam() {
        if (!teamEl) return;
        var editBtn = canEditTeam()
            ? '<button class="chip" id="team-edit">✎ Edit team</button>' : '';
        var html = '<div class="about team-block">' +
            '<div class="team-head">' +
                '<div><h2>' + escapeHtml(TEAM_HEADING) + '</h2>' +
                    (TEAM_SUBTITLE ? '<p class="about-sub">' + escapeHtml(TEAM_SUBTITLE) + '</p>' : '') +
                '</div>' + editBtn +
            '</div>';
        var members = teamData.filter(function (m) { return m && m.name; });
        if (!members.length) {
            html += '<p class="about-sub">No team members yet.</p>';
        } else {
            html += '<div class="team-grid">';
            members.forEach(function (m) {
                var accent = m.accent ? escapeHtml(m.accent) : 'var(--buy)';
                var avatar = m.emoji ? escapeHtml(m.emoji) : escapeHtml(initials(m.name));
                html += '<div class="team-card">';
                html += '<div class="tc-avatar" style="--tc-accent:' + accent + '">' + avatar + '</div>';
                html += '<div class="tc-name">' + escapeHtml(m.name) + '</div>';
                if (m.role) html += '<div class="tc-role">' + escapeHtml(m.role) + '</div>';
                if (m.description) html += '<div class="tc-desc">' + escapeHtml(m.description) + '</div>';
                var tags = normTags(m.tags);
                if (tags.length) {
                    html += '<div class="tc-tags">';
                    tags.forEach(function (t) { html += '<span class="tc-tag">' + escapeHtml(t) + '</span>'; });
                    html += '</div>';
                }
                if (m.links && m.links.length) {
                    html += '<div class="tc-links">';
                    m.links.forEach(function (lnk) {
                        if (!lnk || !lnk.href) return;
                        html += '<a class="tc-link" href="' + escapeHtml(lnk.href) + '" target="_blank" rel="noopener">' +
                            escapeHtml(lnk.label || lnk.href) + '</a>';
                    });
                    html += '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        teamEl.innerHTML = html;
        var btn = document.getElementById('team-edit');
        if (btn) btn.onclick = openTeamEditor;
    }

    // tags can be stored as an array or a comma string; normalise to an array.
    function normTags(t) {
        if (Array.isArray(t)) return t.filter(Boolean);
        if (typeof t === 'string') return t.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        return [];
    }

    // ----- admin team editor (structured form) ------------------------------
    function memberRow(m, i) {
        m = m || {};
        return '<div class="tm-row" data-i="' + i + '">' +
            '<div class="tm-row-head">' +
                '<span class="tm-row-title">Member ' + (i + 1) + '</span>' +
                '<span class="tm-row-actions">' +
                    '<button type="button" class="chip tm-up" title="Move up">↑</button>' +
                    '<button type="button" class="chip tm-down" title="Move down">↓</button>' +
                    '<button type="button" class="chip tm-del" title="Remove">✕</button>' +
                '</span>' +
            '</div>' +
            '<div class="tm-fields">' +
                tmField('Name', 'name', m.name, 'Full name') +
                tmField('Role', 'role', m.role, 'e.g. Frontend Engineer') +
                tmField('Emoji', 'emoji', m.emoji, 'optional, e.g. 🎓') +
                tmField('Accent colour', 'accent', m.accent, 'e.g. #2f9dff') +
                tmField('Tags', 'tags', normTags(m.tags).join(', '), 'comma separated') +
                '<label class="tm-field tm-wide"><span>Description</span>' +
                    '<textarea data-f="description" rows="2" placeholder="One or two sentences">' +
                    escapeHtml(m.description || '') + '</textarea></label>' +
            '</div>' +
        '</div>';
    }
    function tmField(label, key, val, ph) {
        return '<label class="tm-field"><span>' + escapeHtml(label) + '</span>' +
            '<input type="text" data-f="' + key + '" value="' + escapeHtml(val || '') +
            '" placeholder="' + escapeHtml(ph || '') + '"></label>';
    }

    function openTeamEditor() {
        if (!teamEl) return;
        var draft = teamData.map(function (m) { return Object.assign({}, m); });

        function render() {
            var rows = draft.map(memberRow).join('');
            teamEl.innerHTML =
                '<div class="about team-editor">' +
                    '<div class="about-editor-head"><span>Editing team</span>' +
                        '<span class="about-editor-actions">' +
                            '<button class="chip" id="tm-cancel">Cancel</button>' +
                            '<button class="chip active" id="tm-save">Save</button>' +
                        '</span></div>' +
                    '<div id="tm-rows">' + rows + '</div>' +
                    '<button class="chip" id="tm-add">+ Add member</button>' +
                    '<div class="about-edit-err" id="tm-err"></div>' +
                '</div>';
            wire();
        }

        // Pull the current form values back into the draft array.
        function sync() {
            var rowEls = teamEl.querySelectorAll('.tm-row');
            rowEls.forEach(function (row) {
                var i = +row.getAttribute('data-i');
                var obj = draft[i] || (draft[i] = {});
                row.querySelectorAll('[data-f]').forEach(function (inp) {
                    var f = inp.getAttribute('data-f');
                    var v = inp.value.trim();
                    if (f === 'tags') obj.tags = normTags(v);
                    else if (v) obj[f] = v; else delete obj[f];
                });
            });
        }

        function wire() {
            document.getElementById('tm-add').onclick = function () {
                sync(); draft.push({ name: '' }); render();
            };
            document.getElementById('tm-cancel').onclick = function () { renderTeam(); };
            teamEl.querySelectorAll('.tm-del').forEach(function (b) {
                b.onclick = function () {
                    sync();
                    var i = +b.closest('.tm-row').getAttribute('data-i');
                    draft.splice(i, 1); render();
                };
            });
            teamEl.querySelectorAll('.tm-up').forEach(function (b) {
                b.onclick = function () {
                    sync();
                    var i = +b.closest('.tm-row').getAttribute('data-i');
                    if (i > 0) { var t = draft[i - 1]; draft[i - 1] = draft[i]; draft[i] = t; }
                    render();
                };
            });
            teamEl.querySelectorAll('.tm-down').forEach(function (b) {
                b.onclick = function () {
                    sync();
                    var i = +b.closest('.tm-row').getAttribute('data-i');
                    if (i < draft.length - 1) { var t = draft[i + 1]; draft[i + 1] = draft[i]; draft[i] = t; }
                    render();
                };
            });
            document.getElementById('tm-save').onclick = async function () {
                var errEl = document.getElementById('tm-err');
                var btn = document.getElementById('tm-save');
                errEl.textContent = '';
                try {
                    sync();
                    var clean = draft.filter(function (m) { return m && m.name; });
                    if (!clean.length) { errEl.textContent = 'Add at least one member (name required).'; return; }
                    btn.disabled = true;
                    var data = await A.saveTeam(clean);
                    teamData = (data && data.members) || clean;
                    renderTeam();
                } catch (e) {
                    errEl.textContent = e.message || 'Save failed';
                    errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    btn.disabled = false;
                }
            };
        }

        render();
    }

    function renderAdminBar() {
        if (!adminEl) return;
        // admin + semi_admin can edit About (once their email is verified)
        if (A.canEditAbout && A.canEditAbout()) {
            adminEl.innerHTML = '<button class="chip" id="about-edit">✎ Edit About</button>';
            document.getElementById('about-edit').onclick = openEditor;
        } else {
            adminEl.innerHTML = '';
        }
    }

    function openEditor() {
        adminEl.innerHTML =
            '<div class="about-editor">' +
                '<div class="about-editor-head"><span>Editing About (markdown)</span>' +
                    '<span class="about-editor-actions">' +
                        '<button class="chip" id="about-cancel">Cancel</button>' +
                        '<button class="chip active" id="about-save">Save</button>' +
                    '</span></div>' +
                '<textarea id="about-ta" spellcheck="false"></textarea>' +
                '<div class="about-edit-err" id="about-edit-err"></div>' +
                '<div class="about-preview-label">Live preview</div>' +
                '<div class="about about-preview" id="about-preview"></div>' +
            '</div>';
        var ta = document.getElementById('about-ta');
        var preview = document.getElementById('about-preview');
        ta.value = current || DEFAULT_ABOUT;
        var updatePreview = function () { preview.innerHTML = renderMarkdown(ta.value); };
        updatePreview();
        ta.addEventListener('input', updatePreview);
        document.getElementById('about-cancel').onclick = renderAdminBar;
        document.getElementById('about-save').onclick = async function () {
            var errEl = document.getElementById('about-edit-err');
            errEl.textContent = '';
            var btn = document.getElementById('about-save');
            btn.disabled = true;
            try {
                var data = await A.saveAbout(ta.value);
                current = data.content;
                contentEl.innerHTML = renderMarkdown(current);
                renderAdminBar();
            } catch (e) {
                errEl.textContent = e.message || 'Save failed';
                btn.disabled = false;
            }
        };
    }

    // Show defaults immediately, then hydrate from the DB.
    teamData = DEFAULT_TEAM.slice();
    renderTeam();
    if (!A) {
        if (contentEl) contentEl.innerHTML = renderMarkdown(DEFAULT_ABOUT);
        return;
    }
    load();
    loadTeam();
    // Re-render the admin controls + team edit button when auth state changes.
    function onAuth() { renderAdminBar(); if (teamLoaded) renderTeam(); }
    A.ready.then(onAuth);
    A.on(onAuth);
}());
