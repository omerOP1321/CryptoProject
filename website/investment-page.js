/*
 * Page controller for investment.html — the Investment Simulation page (Task 6).
 *
 * ALL financial math runs in the `simulate` Supabase Edge Function; this file
 * only collects parameters, calls the backend, and renders the results. It
 * reuses window.AnalyticsUI for SVG chart primitives, model colors/labels and
 * formatting so the page matches the rest of the dashboard and stays DRY.
 */
(function () {
    'use strict';
    var AUI = window.AnalyticsUI;
    var MODELS = AUI.MODELS;
    var sb = window.sb;
    var fmt = AUI.fmt, signed = AUI.signed, esc = AUI.esc;

    var COINS = [
        { id: 'BTCUSDT', sym: 'BTC', name: 'Bitcoin' },
        { id: 'ETHUSDT', sym: 'ETH', name: 'Ethereum' },
        { id: 'XRPUSDT', sym: 'XRP', name: 'Ripple' }
    ];

    var state = {
        coin: 'BTCUSDT',
        mode: 'single',          // 'single' | 'allocation'
        view: 'results',         // 'results' | 'leaderboard' | 'saved'
        result: null,            // last full simulate response
        bounds: null,            // { from, to } unix seconds of available data
        loggedIn: false
    };

    // ---- formatting helpers ------------------------------------------------
    function money(v, dp) {
        if (v == null || !isFinite(v)) return '—';
        return '$' + Number(v).toLocaleString('en-US', {
            minimumFractionDigits: dp == null ? 2 : dp,
            maximumFractionDigits: dp == null ? 2 : dp
        });
    }
    function pct(v, dp) { return v == null || !isFinite(v) ? '—' : signed(v, dp == null ? 2 : dp) + '%'; }
    function num(v, dp) { return v == null || !isFinite(v) ? '—' : fmt(v, dp == null ? 2 : dp); }
    function cls(v) { return v == null || !isFinite(v) ? '' : (v > 0 ? 'pos' : (v < 0 ? 'neg' : '')); }
    function colorOf(m) { return MODELS.colors[m] || '#3b9eff'; }
    function labelOf(m) { return MODELS.labelOf(m); }
    function isoDay(sec) { return new Date(sec * 1000).toISOString().slice(0, 10); }
    function isoTime(sec) { return new Date(sec * 1000).toISOString().slice(11, 16); }

    // ---- backend call ------------------------------------------------------
    async function invoke(body) {
        var res = await sb.functions.invoke('simulate', { body: body });
        if (res.error) {
            var msg = res.error.message || 'Request failed';
            // Edge function returns a JSON { error } body on 4xx — surface it.
            try {
                if (res.error.context && typeof res.error.context.json === 'function') {
                    var j = await res.error.context.json();
                    if (j && j.error) msg = j.error;
                }
            } catch (_) { /* keep generic message */ }
            throw new Error(msg);
        }
        if (res.data && res.data.error) throw new Error(res.data.error);
        return res.data;
    }

    // Combine a date input (YYYY-MM-DD) with its time input (HH:MM) into a unix
    // second. Times are interpreted as UTC so the value matches the backend,
    // which filters candles by raw unix seconds (timezone-agnostic).
    //   edge='start' + empty time -> 00:00:00 (start of day)
    //   edge='end'   + empty time -> 24:00    (end of day, i.e. 23:59:59)
    function combineDateTime(dateVal, timeVal, edge) {
        if (!dateVal) return undefined;
        var sec;
        if (timeVal) {
            sec = Date.parse(dateVal + 'T' + timeVal + ':00Z') / 1000;
        } else if (edge === 'end') {
            sec = Date.parse(dateVal + 'T23:59:59Z') / 1000; // 24:00 default
        } else {
            sec = Date.parse(dateVal + 'T00:00:00Z') / 1000;
        }
        return Number.isFinite(sec) ? Math.floor(sec) : undefined;
    }

    function params() {
        var amount = parseFloat(document.getElementById('inv-amount').value);
        var body = { coin: state.coin, initialAmount: amount };
        var s = combineDateTime(document.getElementById('inv-start').value,
            document.getElementById('inv-start-time').value, 'start');
        var e = combineDateTime(document.getElementById('inv-end').value,
            document.getElementById('inv-end-time').value, 'end');
        if (s !== undefined) body.startDate = s;
        if (e !== undefined) body.endDate = e;
        if (state.mode === 'allocation') body.allocation = readAllocation();
        return body;
    }

    function readAllocation() {
        var out = [];
        MODELS.order.forEach(function (m) {
            var el = document.getElementById('alloc-' + m);
            if (el) { var w = parseFloat(el.value) || 0; if (w > 0) out.push({ model: m, weight: w }); }
        });
        return out;
    }

    // ---- chart helpers (time-align curves so they overlay correctly) -------
    function gridTimes(from, to, n) {
        var out = [];
        for (var i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
        return out;
    }
    function resample(curve, grid, initial, field) {
        field = field || 'value';
        if (!curve || !curve.length) return grid.map(function () { return null; });
        var j = 0;
        return grid.map(function (t) {
            while (j + 1 < curve.length && curve[j + 1].time <= t) j++;
            if (curve[j].time <= t) return curve[j][field];
            return initial != null ? initial : curve[0][field];
        });
    }
    function dateLabels(grid) {
        return grid.map(function (t, i) {
            if (i === 0 || i === grid.length - 1 || i === Math.floor(grid.length / 2)) {
                return new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }
            return null;
        });
    }

    // =======================================================================
    //  RENDERING
    // =======================================================================
    function renderResults() {
        var r = state.result;
        var host = document.getElementById('inv-results');
        if (!r) { host.innerHTML = ''; return; }
        if (!r.models.length) {
            host.innerHTML = '<div class="chart-empty" style="height:120px">No matured predictions in this period. Try a wider date range.</div>';
            return;
        }
        var best = r.models[0], worst = r.models[r.models.length - 1];
        var amount = best.initialAmount;

        var html = '';
        // Highlight cards
        html += '<div class="inv-highlight">';
        html += highlightCard('Best performer', best, true);
        if (r.portfolio) html += portfolioCard(r.portfolio);
        else html += highlightCard('Worst performer', worst, false);
        html += buyHoldCard(r.buyHold, amount);
        html += '</div>';

        // Ranking table
        html += '<div class="section-title">Model ranking</div>';
        html += '<p class="section-sub">Every model ranked by total return (highest first). ' +
            'A long/short strategy that follows each model’s predicted direction, starting from ' + money(amount, 0) +
            '. Raw gross performance — no fees or slippage. Green beats Buy &amp; Hold.</p>';
        html += rankingTable(r);

        // Comparison charts
        html += '<div class="a-grid2">';
        html += '<div class="a-card"><div class="a-card-title">Portfolio growth (equity curves)</div>' + equityChart(r) + '</div>';
        html += '<div class="a-card"><div class="a-card-title">Drawdown over time</div>' + drawdownChart(r) + '</div>';
        html += '</div>';
        html += '<div class="a-card"><div class="a-card-title">Total return vs Buy &amp; Hold</div>' + profitChart(r) + '</div>';

        host.innerHTML = html;
        AUI.attachTooltips(host);
    }

    function highlightCard(title, m, good) {
        // "Best performer" still tops the ranking, but if it lost money color the
        // card red — green border on a loss reads wrong.
        var tone = good && m.profit >= 0 ? 'good' : 'bad';
        return '<div class="inv-hl-card ' + tone + '">' +
            '<div class="inv-hl-title">' + esc(title) + '</div>' +
            '<div class="inv-hl-model"><span class="dot" style="background:' + colorOf(m.model) + '"></span>' + esc(labelOf(m.model)) + '</div>' +
            '<div class="inv-hl-value ' + cls(m.profit) + '">' + money(m.finalValue) + '</div>' +
            '<div class="inv-hl-sub ' + cls(m.profitPct) + '">' + pct(m.profitPct) + ' &middot; ' + signed(m.profit, 0).replace('-', '−') + ' $</div>' +
            '</div>';
    }
    function portfolioCard(p) {
        return '<div class="inv-hl-card port">' +
            '<div class="inv-hl-title">Your portfolio</div>' +
            '<div class="inv-hl-model">' + esc(p.model) + '</div>' +
            '<div class="inv-hl-value ' + cls(p.profit) + '">' + money(p.finalValue) + '</div>' +
            '<div class="inv-hl-sub ' + cls(p.profitPct) + '">' + pct(p.profitPct) + '</div>' +
            '</div>';
    }
    function buyHoldCard(bh, amount) {
        return '<div class="inv-hl-card bh">' +
            '<div class="inv-hl-title">Buy &amp; Hold</div>' +
            '<div class="inv-hl-model">Passive benchmark</div>' +
            '<div class="inv-hl-value ' + cls(bh.profit) + '">' + money(bh.finalValue) + '</div>' +
            '<div class="inv-hl-sub ' + cls(bh.profitPct) + '">' + pct(bh.profitPct) + '</div>' +
            '</div>';
    }

    var COLS = [
        { k: 'rank', label: '#', cell: function (m, i) { return '<td class="rk">' + (i + 1) + '</td>'; } },
        { k: 'model', label: 'Model', cell: function (m) {
            return '<td class="mdl"><span class="dot" style="background:' + colorOf(m.model) + '"></span>' + esc(labelOf(m.model)) + '</td>'; } },
        { k: 'final', label: 'Final value', cell: function (m) { return '<td>' + money(m.finalValue) + '</td>'; } },
        { k: 'pnl', label: 'Profit / Loss', cell: function (m) {
            return '<td class="' + cls(m.profit) + '">' + (m.profit >= 0 ? '+' : '−') + money(Math.abs(m.profit)).slice(1) + '</td>'; } },
        { k: 'ret', label: 'Total return', cell: function (m) { return '<td class="' + cls(m.profitPct) + '">' + pct(m.profitPct) + '</td>'; } },
        { k: 'trades', label: 'Trades (W / L)', cell: function (m) {
            return '<td class="muted">' + m.trades + ' <span class="wl">(' + m.winningTrades + ' / ' + m.losingTrades + ')</span></td>'; } },
        { k: 'win', label: 'Win rate', cell: function (m) { return '<td>' + (m.winRate == null ? '—' : fmt(m.winRate, 1) + '%') + '</td>'; } },
        { k: 'dd', label: 'Max DD', cell: function (m) { return '<td class="neg">' + (m.maxDrawdown ? '−' + fmt(m.maxDrawdown, 1) + '%' : '0%') + '</td>'; } },
        { k: 'sharpe', label: 'Sharpe', cell: function (m) { return '<td class="' + cls(m.sharpe) + '">' + num(m.sharpe) + '</td>'; } },
        { k: 'sortino', label: 'Sortino', cell: function (m) { return '<td class="' + cls(m.sortino) + '">' + num(m.sortino) + '</td>'; } },
        { k: 'calmar', label: 'Calmar', cell: function (m) { return '<td class="' + cls(m.calmar) + '">' + num(m.calmar) + '</td>'; } },
        { k: 'var', label: 'VaR 95%', cell: function (m) { return '<td class="neg">' + (m.valueAtRisk == null ? '—' : '−' + fmt(m.valueAtRisk, 2) + '%') + '</td>'; } },
        { k: 'vsbh', label: 'vs Buy&Hold', cell: function (m) {
            return '<td class="' + cls(m.vsBuyHold) + '">' + (m.vsBuyHold == null ? '—' : signed(m.vsBuyHold, 1) + ' pp') + '</td>'; } }
    ];

    function rankingTable(r) {
        var head = '<tr>' + COLS.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr>';
        var rows = r.models.map(function (m, i) {
            var rowCls = i === 0 ? 'best' : (i === r.models.length - 1 && r.models.length > 1 ? 'worst' : '');
            return '<tr class="' + rowCls + '">' + COLS.map(function (c) { return c.cell(m, i); }).join('') + '</tr>';
        }).join('');
        return '<div class="cmp-wrap"><table class="cmp-table inv-table">' + head + rows + '</table></div>';
    }

    function equityChart(r) {
        var grid = gridTimes(r.range.from, r.range.to, 120);
        var series = r.models.map(function (m) {
            return { name: labelOf(m.model), color: colorOf(m.model), data: resample(m.equityCurve, grid, m.initialAmount) };
        });
        series.push({ name: 'Buy & Hold', color: 'rgba(255,255,255,.55)', data: resample(r.buyHold.equityCurve, grid, r.buyHold.initialAmount) });
        if (r.portfolio) series.push({ name: 'Portfolio', color: '#ffffff', data: resample(r.portfolio.equityCurve, grid, r.portfolio.initialAmount) });
        return AUI.svgLineMulti(series, {
            w: 560, h: 260, xLabels: dateLabels(grid),
            baseline: { value: r.models[0].initialAmount, label: 'start' },
            fmtY: function (v) { return '$' + fmt(v, 0); }
        });
    }

    function drawdownChart(r) {
        var grid = gridTimes(r.range.from, r.range.to, 120);
        var series = r.models.map(function (m) {
            return { name: labelOf(m.model), color: colorOf(m.model), data: resample(m.drawdownCurve, grid, 0, 'dd').map(function (v) { return v == null ? null : -v; }) };
        });
        return AUI.svgLineMulti(series, {
            w: 560, h: 260, xLabels: dateLabels(grid), yMax: 0,
            fmtY: function (v) { return fmt(v, 0); }, ySuffix: '%'
        });
    }

    function profitChart(r) {
        var vals = r.models.map(function (m) { return m.profitPct; }).concat([r.buyHold.profitPct]);
        var maxAbs = Math.max(1, Math.max.apply(null, vals.map(function (v) { return Math.abs(v); })));
        var rows = r.models.map(function (m) {
            return divergingBar(labelOf(m.model), m.profitPct, maxAbs, colorOf(m.model));
        }).join('');
        rows += divergingBar('Buy & Hold', r.buyHold.profitPct, maxAbs, 'rgba(255,255,255,.5)');
        return '<div class="diverge">' + rows + '</div>';
    }
    // Center-anchored bar: positive grows right (green tint), negative left (red).
    function divergingBar(label, v, maxAbs, color) {
        var w = Math.min(50, Math.abs(v) / maxAbs * 50);
        var posSide = v >= 0;
        return '<div class="dv-row" data-tip="' + esc(label) + ': ' + pct(v) + '">' +
            '<span class="dv-label">' + esc(label) + '</span>' +
            '<span class="dv-track">' +
            '<span class="dv-mid"></span>' +
            '<span class="dv-fill ' + (posSide ? 'pos' : 'neg') + '" style="width:' + w.toFixed(1) + '%;' +
            (posSide ? 'left:50%;background:' + color : 'right:50%;background:' + color) + '"></span>' +
            '</span>' +
            '<span class="dv-val ' + cls(v) + '">' + pct(v, 1) + '</span>' +
            '</div>';
    }

    // ---- leaderboard -------------------------------------------------------
    function renderLeaderboard(data) {
        var host = document.getElementById('inv-results');
        if (!data || !data.models.length) { host.innerHTML = '<div class="chart-empty" style="height:120px">No data for this range.</div>'; return; }
        var html = '<div class="section-title">Historical leaderboard — ' + esc(data.coin) + '</div>';
        html += '<p class="section-sub">Model ranking for the selected date range. Buy &amp; Hold returned ' +
            pct(data.buyHold.profitPct) + ' over the same window.</p>';
        html += '<div class="cmp-wrap"><table class="cmp-table inv-table"><tr>' +
            '<th>#</th><th>Model</th><th>Total return</th><th>Win rate</th><th>Trades</th><th>Max DD</th><th>Sharpe</th><th>vs Buy&Hold</th></tr>' +
            data.models.map(function (m, i) {
                var rc = i === 0 ? 'best' : (i === data.models.length - 1 && data.models.length > 1 ? 'worst' : '');
                return '<tr class="' + rc + '"><td class="rk">' + (i + 1) + '</td>' +
                    '<td class="mdl"><span class="dot" style="background:' + colorOf(m.model) + '"></span>' + esc(labelOf(m.model)) + '</td>' +
                    '<td class="' + cls(m.profitPct) + '">' + pct(m.profitPct) + '</td>' +
                    '<td>' + (m.winRate == null ? '—' : fmt(m.winRate, 1) + '%') + '</td>' +
                    '<td class="muted">' + m.trades + '</td>' +
                    '<td class="neg">' + (m.maxDrawdown ? '−' + fmt(m.maxDrawdown, 1) + '%' : '0%') + '</td>' +
                    '<td class="' + cls(m.sharpe) + '">' + num(m.sharpe) + '</td>' +
                    '<td class="' + cls(m.vsBuyHold) + '">' + (m.vsBuyHold == null ? '—' : signed(m.vsBuyHold, 1) + ' pp') + '</td></tr>';
            }).join('') + '</table></div>';
        host.innerHTML = html;
        AUI.attachTooltips(host);
    }

    // ---- saved simulations -------------------------------------------------
    async function renderSaved() {
        var host = document.getElementById('inv-results');
        if (!state.loggedIn) {
            host.innerHTML = '<div class="chart-empty" style="height:120px">Log in to save simulations and revisit them later.</div>';
            return;
        }
        host.innerHTML = '<div class="loading-spinner">Loading saved simulations…</div>';
        try {
            var data = await invoke({ action: 'list' });
            var saved = data.saved || [];
            if (!saved.length) { host.innerHTML = '<div class="chart-empty" style="height:120px">No saved simulations yet. Run one and click “Save”.</div>'; return; }
            host.innerHTML = '<div class="section-title">Saved simulations</div>' +
                '<div class="saved-grid">' + saved.map(savedCard).join('') + '</div>';
            host.querySelectorAll('[data-load]').forEach(function (b) {
                b.addEventListener('click', function () { loadSaved(saved.find(function (s) { return s.id === b.dataset.load; })); });
            });
            host.querySelectorAll('[data-del]').forEach(function (b) {
                b.addEventListener('click', async function () {
                    b.disabled = true;
                    try { await invoke({ action: 'delete', id: b.dataset.del }); renderSaved(); }
                    catch (e) { alert(e.message); b.disabled = false; }
                });
            });
        } catch (e) {
            host.innerHTML = '<div class="chart-empty" style="height:120px">' + esc(e.message) + '</div>';
        }
    }
    function savedCard(s) {
        var top = (s.summary && s.summary.models && s.summary.models[0]) || null;
        var p = s.params || {};
        return '<div class="saved-card">' +
            '<div class="saved-name">' + esc(s.name) + '</div>' +
            '<div class="saved-meta">' + esc(s.coin) + ' &middot; ' + money(p.initialAmount, 0) +
            (p.startDate ? ' &middot; ' + esc(isoDay(Number(p.startDate) || Date.parse(p.startDate) / 1000)) : '') + '</div>' +
            (top ? '<div class="saved-top">Best: <b>' + esc(labelOf(top.model)) + '</b> <span class="' + cls(top.profitPct) + '">' + pct(top.profitPct) + '</span></div>' : '') +
            '<div class="saved-actions"><button class="auth-btn" data-load="' + esc(s.id) + '">Load</button>' +
            '<button class="auth-btn" data-del="' + esc(s.id) + '">Delete</button></div>' +
            '</div>';
    }
    function loadSaved(s) {
        if (!s) return;
        var p = s.params || {};
        setCoin(p.coin || 'BTCUSDT');
        document.getElementById('inv-amount').value = p.initialAmount || 1000;
        if (p.startDate) {
            var ss = Number(p.startDate) || Date.parse(p.startDate) / 1000;
            document.getElementById('inv-start').value = isoDay(ss);
            document.getElementById('inv-start-time').value = isoTime(ss);
        }
        if (p.endDate) {
            var es = Number(p.endDate) || Date.parse(p.endDate) / 1000;
            document.getElementById('inv-end').value = isoDay(es);
            document.getElementById('inv-end-time').value = isoTime(es);
        }
        setMode(p.allocation && p.allocation.length ? 'allocation' : 'single');
        if (p.allocation) p.allocation.forEach(function (a) {
            var el = document.getElementById('alloc-' + a.model); if (el) el.value = Math.round(a.weight * 100);
        });
        setView('results');
        calculate();
    }

    async function saveCurrent() {
        if (!state.loggedIn) { alert('Log in to save simulations.'); return; }
        if (!state.result) { alert('Run a simulation first.'); return; }
        var name = prompt('Name this simulation:', state.coin + ' ' + money(state.result.models[0].initialAmount, 0));
        if (!name) return;
        var body = params(); body.action = 'save'; body.name = name;
        try { await invoke(body); alert('Saved.'); }
        catch (e) { alert(e.message); }
    }

    // =======================================================================
    //  ACTIONS / WIRING
    // =======================================================================
    function setBusy(on) {
        var btn = document.getElementById('inv-calc');
        btn.disabled = on;
        btn.textContent = on ? 'Calculating…' : 'Calculate';
    }

    async function calculate() {
        var p = params();
        if (!(p.initialAmount > 0)) { alert('Enter an investment amount greater than 0.'); return; }
        if (state.mode === 'allocation' && (!p.allocation || !p.allocation.length)) {
            alert('Give at least one model a non-zero allocation.'); return;
        }
        if (p.startDate !== undefined && p.endDate !== undefined && p.startDate > p.endDate) {
            alert('Start must be before end.'); return;
        }
        setBusy(true);
        try {
            var data = await invoke(p);
            state.result = data;
            if (!state.bounds && data.range) { state.bounds = data.range; applyBounds(); }
            setView('results');
            renderResults();
        } catch (e) {
            document.getElementById('inv-results').innerHTML = '<div class="chart-empty" style="height:120px">' + esc(e.message) + '</div>';
        } finally { setBusy(false); }
    }

    async function loadLeaderboard() {
        setBusy(true);
        try {
            var p = params(); p.action = 'leaderboard';
            var data = await invoke(p);
            renderLeaderboard(data);
        } catch (e) {
            document.getElementById('inv-results').innerHTML = '<div class="chart-empty" style="height:120px">' + esc(e.message) + '</div>';
        } finally { setBusy(false); }
    }

    function applyBounds() {
        if (!state.bounds) return;
        var lo = isoDay(state.bounds.from), hi = isoDay(state.bounds.to);
        var s = document.getElementById('inv-start'), e = document.getElementById('inv-end');
        s.min = lo; s.max = hi; e.min = lo; e.max = hi;
        if (!s.value) s.value = lo;
        if (!e.value) e.value = hi;
        document.getElementById('inv-range-note').textContent =
            'Data available ' + lo + ' → ' + hi + ' (UTC · empty end time = 24:00)';
    }

    function setCoin(coin) {
        state.coin = coin;
        document.querySelectorAll('#inv-coins .coin-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.id === coin);
        });
        // Re-derive the available range for the new asset on the next run.
        state.bounds = null;
        document.getElementById('inv-start').value = '';
        document.getElementById('inv-end').value = '';
        document.getElementById('inv-start-time').value = '';
        document.getElementById('inv-end-time').value = '';
        document.getElementById('inv-range-note').textContent = 'Press Calculate to load ' + coin + ' data range';
    }
    function setMode(mode) {
        state.mode = mode;
        document.getElementById('mode-single').classList.toggle('active', mode === 'single');
        document.getElementById('mode-alloc').classList.toggle('active', mode === 'allocation');
        document.getElementById('alloc-panel').style.display = mode === 'allocation' ? '' : 'none';
    }
    function setView(view) {
        state.view = view;
        ['results', 'leaderboard', 'saved'].forEach(function (v) {
            var t = document.getElementById('view-' + v);
            if (t) t.classList.toggle('active', v === view);
        });
        if (view === 'results') renderResults();
        else if (view === 'leaderboard') loadLeaderboard();
        else renderSaved();
    }

    function buildControls() {
        // coin tabs
        document.getElementById('inv-coins').innerHTML = COINS.map(function (c, i) {
            return '<button class="coin-tab' + (i === 0 ? ' active' : '') + '" data-id="' + c.id + '"><b>' + c.sym + '</b><span>' + c.name + '</span></button>';
        }).join('');
        document.querySelectorAll('#inv-coins .coin-tab').forEach(function (t) {
            t.addEventListener('click', function () { setCoin(t.dataset.id); });
        });
        // allocation sliders
        document.getElementById('alloc-rows').innerHTML = MODELS.order.map(function (m) {
            return '<div class="alloc-row"><span class="dot" style="background:' + colorOf(m) + '"></span>' +
                '<span class="alloc-name">' + esc(labelOf(m)) + '</span>' +
                '<input type="number" id="alloc-' + m + '" min="0" max="100" step="5" value="0" class="alloc-input"> %</div>';
        }).join('');
    }

    function init() {
        if (!sb) { document.getElementById('inv-results').textContent = 'Supabase client unavailable.'; return; }
        buildControls();
        document.getElementById('inv-calc').addEventListener('click', calculate);
        document.getElementById('inv-save').addEventListener('click', saveCurrent);
        document.getElementById('mode-single').addEventListener('click', function () { setMode('single'); });
        document.getElementById('mode-alloc').addEventListener('click', function () { setMode('allocation'); });
        document.getElementById('view-results').addEventListener('click', function () { setView('results'); });
        document.getElementById('view-leaderboard').addEventListener('click', function () { setView('leaderboard'); });
        document.getElementById('view-saved').addEventListener('click', function () { setView('saved'); });

        if (window.AuthClient) {
            window.AuthClient.ready.then(function (u) { state.loggedIn = !!u; });
            window.AuthClient.on(function (u) {
                state.loggedIn = !!u;
                if (state.view === 'saved') renderSaved();
            });
        }
        // Kick off an initial full-range run to populate bounds + first results.
        calculate();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
