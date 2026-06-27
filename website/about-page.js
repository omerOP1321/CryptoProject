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
    var current = '';

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
            var data = await A.api('GET', '/api/about');
            current = data.content || '';
            contentEl.innerHTML = renderMarkdown(current);
        } catch (e) {
            contentEl.textContent = 'Could not load About content.';
        }
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
        ta.value = current;
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
                var data = await A.api('PUT', '/api/about', { content: ta.value });
                current = data.content;
                contentEl.innerHTML = renderMarkdown(current);
                renderAdminBar();
            } catch (e) {
                errEl.textContent = e.message || 'Save failed';
                btn.disabled = false;
            }
        };
    }

    if (!A) { if (contentEl) contentEl.textContent = 'Auth client unavailable.'; return; }
    load();
    A.ready.then(renderAdminBar);
    A.on(renderAdminBar);
}());
