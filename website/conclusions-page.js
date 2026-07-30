/*
 * Page controller for conclusions.html — a self-refreshing summary of what the models
 * and the market are doing right now.
 *
 * Computes nothing new: every figure comes from window.ChartUtils using the same
 * maturation and horizon rules as the dashboard and the Analytics page, so a model's
 * accuracy here can never disagree with its accuracy there.
 */
(function () {
    'use strict';
    const SUPABASE_URL = 'https://iphxmjltsigsaocicipu.supabase.co';
    const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4clMLjZVc1oacTPOb5XrUA_w9T5aevj';
    const AUI = window.AnalyticsUI;
    const CU = window.ChartUtils;
    const MODELS = AUI.MODELS;
    const supabase = window.sb || window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

    const REFRESH_MS = 30000;
    let activeId = 1, activeSym = 'BTC', activeName = 'Bitcoin';
    let payload = null;
    let timer = null;
    // Guards against overlapping fetches: a coin switch during an in-flight request
    // used to let the slower response overwrite the newer coin's data.
    let requestSeq = 0;
    // Mirrors the dashboard's probe-before-pull. The engine only publishes every 5
    // minutes; re-downloading the full ~458KB payload on every 30s tick is what pushed
    // this project over its Supabase egress quota once already, so poll the timestamp
    // (37 bytes) and only pull the row when it has actually moved.
    let lastPayloadId = null, lastPayloadTs = null;

    const SPANS = { '24H': 86400, '7D': 7 * 86400, '30D': 30 * 86400 };
    let activeRange = localStorage.getItem('concRange') || 'ALL';

    // ---------------------------------------------------------------- helpers
    const $ = id => document.getElementById(id);

    function dataEndSec() {
        const h = (payload && payload.history && payload.history['5m']) || [];
        return h.length ? h[h.length - 1].time + 300 : Math.floor(Date.now() / 1000);
    }
    function rangeWindow() {
        const end = dataEndSec();
        if (activeRange === 'TODAY') {
            const d = new Date(end * 1000);
            d.setHours(0, 0, 0, 0);
            return { fromSec: Math.floor(d.getTime() / 1000), toSec: end };
        }
        const span = SPANS[activeRange];
        if (!span) return {};
        return { fromSec: end - span, toSec: end };
    }
    function rangeLabel() {
        const w = rangeWindow();
        return w.fromSec == null ? 'Full retained history'
                                 : AUI.fmtDateTime(w.fromSec) + ' → ' + AUI.fmtDateTime(w.toSec);
    }

    function tile(label, value, sub, accent) {
        return '<div class="m-tile' + (accent ? ' wide' : '') + '">' +
            '<div class="m-label">' + AUI.esc(label) + '</div>' +
            '<div class="m-value' + (accent ? ' accent' : '') + '">' + value + '</div>' +
            (sub ? '<div class="m-sub">' + sub + '</div>' : '') + '</div>';
    }
    /* An interval that clears 50% and one that sits entirely BELOW it are both
     * "conclusive" — but they mean opposite things, so they never share wording. */
    function ciVerdict(ci) {
        if (!ci || ci.low == null) return 'no scored calls';
        if (ci.beatsChance) return 'clears 50%';
        if (ci.belowChance) return 'below 50% — reliably worse than chance';
        return 'not separable from chance';
    }
    function dirWord(d) {
        return d === 'UP' ? '<span class="c-up">UP</span>'
             : d === 'DOWN' ? '<span class="c-down">DOWN</span>'
             : '<span class="c-flat">FLAT</span>';
    }

    /* Per-model standings over the selected window. Gated on matured history rather
     * than on payload.predictions[m], so a model that missed the current cycle keeps
     * its row instead of silently vanishing from the ranking. */
    function computeStandings() {
        const win = rangeWindow();
        const out = [];
        MODELS.order.forEach(m => {
            const log = AUI.fullLog(payload, m, win);
            if (!log.length) return;
            const cls = CU.classificationMetrics(log);
            const reg = CU.regressionMetrics(log);
            const ci = CU.directionInterval(log);
            const pt = CU.pesaranTimmermann(log);
            out.push({
                model: m,
                da: cls.accuracy != null ? cls.accuracy * 100 : null,
                ci: ci, p: pt.pValue, n: ci.n,
                mae: reg.mae, mape: reg.mape, mase: reg.mase
            });
        });
        return out;
    }

    // ---------------------------------------------------------------- renderers
    function renderLive(standings, snap, agree) {
        const preds = payload.predictions || {};
        const lastPrice = payload.last_price;

        // Best / worst by directional accuracy over the window; ties keep MODELS.order.
        const scored = standings.filter(s => s.da != null);
        const byDa = scored.slice().sort((a, b) => b.da - a.da);
        const best = byDa[0] || null;
        const worst = byDa.length > 1 ? byDa[byDa.length - 1] : null;

        // "Highest accuracy" is deliberately the PRICE metric (lowest MAPE), not the
        // direction metric above — two different questions that a single "accuracy"
        // tile would blur together.
        const byErr = standings.filter(s => s.mape != null).sort((a, b) => a.mape - b.mape);
        const sharpest = byErr[0] || null;

        // Most confident live call = largest absolute predicted move.
        let confident = null;
        MODELS.order.forEach(m => {
            const p = preds[m];
            if (!p || !isFinite(Number(p.change_pct))) return;
            if (!confident || Math.abs(p.change_pct) > Math.abs(confident.chg)) {
                confident = { model: m, chg: Number(p.change_pct), price: p.price, signal: p.signal };
            }
        });

        const sentiment = agree.directional === 0 ? 'NO CALL'
            : (agree.consensus >= 75 ? (agree.majority === 'UP' ? 'BULLISH' : 'BEARISH')
                                     : 'MIXED');

        $('live-tiles').innerHTML =
            tile('Market sentiment',
                 '<span class="' + (sentiment === 'BULLISH' ? 'c-up' : sentiment === 'BEARISH' ? 'c-down' : 'c-flat') + '">' + sentiment + '</span>',
                 agree.directional
                    ? agree.up + ' up · ' + agree.down + ' down · ' + agree.flat + ' flat'
                    : 'no model is taking a side',
                 true) +
            tile('Volatility',
                 snap.volClass || '—',
                 snap.volPct != null
                    ? AUI.fmt(snap.volPct, 3) + '% per 5-min candle' +
                      (snap.volClass ? ' · vs its own last 24h' : '')
                    : 'not enough candles') +
            tile('Price trend',
                 snap.trend ? dirWord(snap.trend) : '—',
                 snap.changePct != null ? AUI.signed(snap.changePct, 2) + '% over the last hour' : '') +
            tile('Model agreement',
                 agree.consensus != null ? AUI.fmt(agree.consensus, 0) + '%' : '—',
                 agree.directional
                    ? Math.max(agree.up, agree.down) + ' of ' + agree.directional + ' models say ' + agree.majority
                    : 'no directional calls') +
            tile('Best model (direction)',
                 best ? AUI.esc(MODELS.labelOf(best.model)) : '—',
                 best ? AUI.fmtPct(best.da, 1) + ' over ' + best.n + ' calls · ' + ciVerdict(best.ci) : '',
                 true) +
            tile('Weakest model (direction)',
                 worst ? AUI.esc(MODELS.labelOf(worst.model)) : '—',
                 worst ? AUI.fmtPct(worst.da, 1) + ' over ' + worst.n + ' calls' : '') +
            tile('Sharpest on price',
                 sharpest ? AUI.esc(MODELS.labelOf(sharpest.model)) : '—',
                 sharpest ? AUI.fmtPct(sharpest.mape, 3) + ' mean abs error' +
                            (sharpest.mase != null ? ' · MASE ' + AUI.fmt(sharpest.mase, 2) : '') : '') +
            tile('Most confident call',
                 confident ? AUI.esc(MODELS.labelOf(confident.model)) : '—',
                 confident
                    ? AUI.signed(confident.chg, 2) + '% → ' + AUI.fmtPrice(confident.price) +
                      (confident.signal ? ' · ' + AUI.esc(confident.signal) : '')
                    : 'no live prediction');

        return { best, worst, sharpest, confident, sentiment, lastPrice };
    }

    function renderAgreement(agree) {
        const rows = MODELS.order.filter(m => agree.byModel[m]).map(m => {
            const b = agree.byModel[m];
            // Bars grow from a centre line — right for up, left for down — so a large
            // DOWN call can't read as a large positive one. Half-width, since each side
            // only owns half the track. 0.5% saturates it.
            const w = Math.min(50, Math.abs(b.changePct) / 0.5 * 50);
            const color = MODELS.colors[m];
            const side = b.changePct >= 0
                ? 'left:50%;width:' + w.toFixed(1) + '%'
                : 'right:50%;width:' + w.toFixed(1) + '%';
            return '<div class="agree-row">' +
                '<span class="agree-name"><span class="dot" style="background:' + color + '"></span>' +
                    AUI.esc(MODELS.labelOf(m)) + '</span>' +
                '<span class="agree-dir">' + dirWord(b.dir) + '</span>' +
                '<div class="agree-bar"><span class="mid"></span><div class="fill" style="' + side +
                    ';background:' + color + '"></div></div>' +
                '<span class="agree-val">' + AUI.signed(b.changePct, 2) + '%</span>' +
            '</div>';
        }).join('');
        $('agreement-body').innerHTML = rows ||
            '<div class="chart-empty" style="height:120px">No live predictions in this payload yet.</div>';
    }

    function renderStandings(standings) {
        if (!standings.length) {
            $('standings-body').innerHTML =
                '<div class="chart-empty" style="height:120px">No matured predictions in this window — try a wider one.</div>';
            return;
        }
        const rows = standings.slice().sort((a, b) => {
            if (a.da == null) return 1; if (b.da == null) return -1;
            return b.da - a.da;
        }).map((s, i) => {
            const color = MODELS.colors[s.model];
            const ci = s.ci;
            return '<div class="stand-row">' +
                '<span class="stand-rank">' + (i + 1) + '</span>' +
                '<span class="stand-name"><span class="dot" style="background:' + color + '"></span>' +
                    AUI.esc(MODELS.labelOf(s.model)) + '</span>' +
                '<span class="stand-da" style="color:' + color + '">' + AUI.fmtPct(s.da, 1) + '</span>' +
                '<span class="stand-ci ' +
                    (ci.beatsChance ? 'beats' : ci.belowChance ? 'below' : 'inconclusive') +
                    '" title="' + ciVerdict(ci) + '">' +
                    (ci.low != null ? '95% CI ' + AUI.fmt(ci.low, 1) + '–' + AUI.fmt(ci.high, 1) + '%' : '—') +
                '</span>' +
                '<span class="stand-n">' + s.n + ' calls</span>' +
            '</div>';
        }).join('');
        $('standings-body').innerHTML = rows;
    }

    function renderInsights(ctx, standings, snap, agree) {
        const out = [];
        const scored = standings.filter(s => s.da != null);
        const conclusive = scored.filter(s => s.ci && s.ci.beatsChance);
        const reliablyWrong = scored.filter(s => s.ci && s.ci.belowChance);

        if (ctx.best) {
            out.push({
                kind: ctx.best.ci.beatsChance ? 'good' : 'warn',
                text: MODELS.labelOf(ctx.best.model) + ' leads on direction at ' +
                    AUI.fmtPct(ctx.best.da, 1) + ' over ' + ctx.best.n + ' calls, and its 95% interval (' +
                    AUI.fmt(ctx.best.ci.low, 1) + '–' + AUI.fmt(ctx.best.ci.high, 1) + '%) ' +
                    (ctx.best.ci.beatsChance
                        ? 'clears 50%, so the edge survives the sample size.'
                        : 'still spans 50%, so the lead is not yet distinguishable from luck.')
            });
        }
        if (!conclusive.length && scored.length) {
            out.push({ kind: 'warn',
                text: 'No model clears 50% with confidence in this window — every interval spans a coin flip. Treat the ranking as provisional.' });
        } else if (conclusive.length) {
            out.push({ kind: 'good',
                text: conclusive.length + ' of ' + scored.length + ' models have an interval that clears 50%: ' +
                    conclusive.map(s => MODELS.labelOf(s.model)).join(', ') + '.' });
        }
        if (reliablyWrong.length) {
            out.push({ kind: 'warn',
                text: reliablyWrong.map(s => MODELS.labelOf(s.model)).join(', ') +
                    ' sits entirely BELOW 50% — reliably worse than a coin flip over this window, ' +
                    'which is a signal in its own right, not merely a weak model.' });
        }

        const beatsNaive = standings.filter(s => s.mase != null && s.mase < 1);
        out.push({
            kind: beatsNaive.length ? 'good' : 'warn',
            text: beatsNaive.length
                ? beatsNaive.map(s => MODELS.labelOf(s.model)).join(', ') +
                  ' beat a naive no-change forecast on price error (MASE < 1).'
                : 'No model beats a naive no-change forecast on price error (every MASE ≥ 1) — the price predictions are not adding accuracy over "the price stays put".'
        });

        if (agree.directional) {
            out.push({
                kind: agree.consensus >= 75 ? 'info' : 'warn',
                text: agree.consensus >= 75
                    ? 'Strong consensus: ' + AUI.fmt(agree.consensus, 0) + '% of the models taking a side call the next move ' + agree.majority + '.'
                    : 'The models are split (' + agree.up + ' up vs ' + agree.down + ' down) — consensus ' +
                      AUI.fmt(agree.consensus, 0) + '%, which carries little information either way.'
            });
        }
        if (snap.volClass) {
            out.push({
                kind: snap.volClass === 'HIGH' ? 'warn' : 'info',
                text: 'Volatility is ' + snap.volClass + ' for this coin (' + AUI.fmt(snap.volPct, 3) +
                    '% per 5-min candle versus its own last 24 hours)' +
                    (snap.volClass === 'HIGH'
                        ? ' — directional calls are least reliable in this regime.'
                        : '.')
            });
        }
        if (snap.trend && snap.changePct != null) {
            out.push({ kind: 'info',
                text: 'Price is ' + snap.trend.toLowerCase() + ' ' + AUI.signed(snap.changePct, 2) +
                      '% over the last hour of candles.' });
        }
        if (ctx.confident) {
            out.push({ kind: 'info',
                text: 'Largest live call is ' + MODELS.labelOf(ctx.confident.model) + ' at ' +
                    AUI.signed(ctx.confident.chg, 2) + '%. A big predicted move is conviction, not accuracy — check its interval above.' });
        }

        $('insight-list').innerHTML = out.map(i =>
            '<li class="insight ' + i.kind + '">' + AUI.esc(i.text) + '</li>').join('');
    }

    function renderAll() {
        if (!payload) return;
        const hist5m = (payload.history && payload.history['5m']) || [];
        const snap = CU.marketSnapshot(hist5m);
        const agree = CU.modelAgreement(payload.predictions, MODELS.order);
        const standings = computeStandings();

        $('loading').style.display = 'none';
        $('error-box').style.display = 'none';
        $('content').style.display = 'block';
        $('range-note').textContent = rangeLabel();

        const ctx = renderLive(standings, snap, agree);
        renderAgreement(agree);
        renderStandings(standings);
        renderInsights(ctx, standings, snap, agree);

        const sync = $('last-sync');
        if (sync) sync.textContent = 'Live · updated ' + new Date().toLocaleTimeString();
    }

    // ---------------------------------------------------------------- data
    function showError(msg) {
        $('loading').style.display = 'none';
        const box = $('error-box');
        box.textContent = msg;
        box.style.display = 'block';
        // Keep whatever is already rendered: a transient network blip shouldn't blank
        // a page the viewer is reading.
        if (!payload) $('content').style.display = 'none';
    }

    async function fetchPayload(force) {
        const seq = ++requestSeq;
        const wantId = activeId;
        try {
            if (!force && lastPayloadId === wantId) {
                const { data: probe, error: probeErr } = await supabase
                    .from('predictions').select('payload->>timestamp')
                    .eq('id', wantId).single();
                if (seq !== requestSeq) return;                 // superseded by a newer request
                if (!probeErr && probe && probe.timestamp === lastPayloadTs) {
                    const sync = $('last-sync');
                    if (sync) sync.textContent = 'Live · checked ' + new Date().toLocaleTimeString();
                    return;
                }
            }
            const { data, error } = await supabase
                .from('predictions').select('payload').eq('id', wantId).single();
            if (seq !== requestSeq) return;
            if (error) {
                showError(error.code === 'PGRST116'
                    ? '⏳ Waiting for live predictions for ' + activeSym + '…'
                    : '❌ Could not load predictions: ' + (error.message || 'unknown error'));
                return;
            }
            if (!data || !data.payload) { showError('⏳ Waiting for live predictions for ' + activeSym + '…'); return; }
            payload = data.payload;
            lastPayloadId = wantId;
            lastPayloadTs = payload.timestamp;
            renderAll();
        } catch (e) {
            if (seq !== requestSeq) return;
            console.error('[conclusions] fetch failed', e);
            showError('❌ Connection error — retrying automatically.');
        }
    }

    function startTimer() {
        if (timer) clearInterval(timer);
        timer = setInterval(() => { if (!document.hidden) fetchPayload(false); }, REFRESH_MS);
    }
    // Pausing the poll while the tab is hidden keeps a backgrounded tab from spending
    // egress all day; refresh once on return so the view is never stale on focus.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) fetchPayload(false);
    });

    // ---------------------------------------------------------------- controls
    function switchCoin(btn) {
        document.querySelectorAll('.coin-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        activeId = Number(btn.dataset.id);
        activeSym = btn.dataset.sym;
        activeName = btn.dataset.name;
        $('coin-note').textContent = activeName + ' · refreshes automatically';
        $('loading').style.display = 'block';
        $('loading').textContent = 'Loading ' + activeSym + '…';
        $('content').style.display = 'none';
        $('error-box').style.display = 'none';
        payload = null;
        history.replaceState(null, '', '?coin=' + activeSym);
        fetchPayload(true);
    }
    document.querySelectorAll('.coin-tab').forEach(t => t.onclick = () => switchCoin(t));

    function syncRangeUI() {
        document.querySelectorAll('#range-seg .seg-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.range === activeRange));
    }
    document.querySelectorAll('#range-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
        activeRange = b.dataset.range;
        localStorage.setItem('concRange', activeRange);
        syncRangeUI();
        if (payload) renderAll();
    }));
    if (!SPANS[activeRange] && activeRange !== 'TODAY' && activeRange !== 'ALL') activeRange = 'ALL';
    syncRangeUI();

    const wanted = new URLSearchParams(location.search).get('coin');
    if (wanted) {
        const t = [].slice.call(document.querySelectorAll('.coin-tab'))
            .find(x => x.dataset.sym === wanted.toUpperCase());
        if (t) {
            document.querySelectorAll('.coin-tab').forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            activeId = Number(t.dataset.id); activeSym = t.dataset.sym; activeName = t.dataset.name;
            $('coin-note').textContent = activeName + ' · refreshes automatically';
        }
    }
    fetchPayload(true);
    startTimer();
}());
