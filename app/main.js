'use strict';
/**
 * Boostline on the iDrive 7 head unit: live engine data from the DME and CSV logs, read-only.
 *
 * Boostline's own Session (boostline-core.js, bundled from vendor/boostline by tools/bundle.js)
 * talks UDS to the DME over the head unit's diagnostic transport (tasu-link.js): the same channel
 * set, batching, dynamically defined DIDs, OBD-II fallback and CSV format as the desktop app.
 *
 * Pages (header tabs, Next page):
 *   Boost & fuel, Timing, Engine   value tiles; an actual / target pair shares a tile with a bar for
 *                                  how far apart they are; a trace of the last 12 s under the value
 *   Status                         the connection (VIN, DME, its data), sample rate, the transport's
 *                                  numbers, the capture and Boostline's log
 * Start capture writes every streamed channel to <data>/Logs/Boostline_<date>.csv, as on the desktop.
 *
 * Runs on the head unit's Node 8: plain ES2017, no ?. / ?? / optional catch binding.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const core = require('./boostline-core');
const { TasuLink } = require('./tasu-link');

const PAGES = [
    { name: 'Boost & fuel', ids: ['engine.rpm', 'throttle.pedal', 'boost.actual', 'boost.target', 'fuel.lambda.actual', 'fuel.lambda.target',
        'fuel.rail.actual', 'fuel.rail.target', 'boost.wg_actual', 'boost.wg_target', 'temp.intake', 'load.torque.actual'] },
    { name: 'Timing', ids: ['ign.avg', 'ign.cyl1', 'ign.cyl2', 'ign.cyl3', 'ign.cyl4', 'ign.cyl5', 'ign.cyl6', 'engine.rpm'] },
    { name: 'Engine', ids: ['vehicle.speed', 'vehicle.gear', 'temp.coolant', 'temp.oil', 'throttle.position', 'throttle.target',
        'vanos.intake.actual', 'vanos.intake.target', 'load.maf', 'elec.battery'] },
    { name: 'Status', ids: [] },
];
const STATUS_PAGE = PAGES.length - 1;
/** Everything the tiles show is streamed (and captured) at once: switching pages doesn't restart the stream. */
const STREAM_IDS = PAGES.reduce((all, p) => all.concat(p.ids.filter((id) => all.indexOf(id) < 0)), []);

/**
 * Actual -> target pairs that share a tile, with the distance (native units) that fills the bar.
 * (as PAIRS in Boostline's src/renderer/src/live/LiveTiles.tsx)
 */
const PAIRS = {
    'boost.actual': { target: 'boost.target', span: 0.2 },
    'fuel.lambda.actual': { target: 'fuel.lambda.target', span: 0.05 },
    'fuel.rail.actual': { target: 'fuel.rail.target', span: 20 },
    'throttle.position': { target: 'throttle.target', span: 10 },
    'boost.wg_actual': { target: 'boost.wg_target', span: 10 },
    'load.engine': { target: 'load.engine_target', span: 20 },
    'load.maf': { target: 'load.maf_target', span: 50 },
    'load.torque.actual': { target: 'load.torque.target', span: 50 },
    'vanos.intake.actual': { target: 'vanos.intake.target', span: 5 },
    'vanos.exhaust.actual': { target: 'vanos.exhaust.target', span: 5 },
};

const COLS = 4, ROWS = 2, GAP = 14, SIDE = 16;
const TRACE_S = 12, TRACE_STEP_S = 0.1;
const RETRY_MS = 5000;
const LOG_LINES = 200;
/** Captures stop being started above this much in Logs/ (the app's disk quota is maxDiskUsage in app.json). */
const LOGS_LIMIT = 96 * 1024 * 1024;

/** The kit's fonts have no λ, and λ is a ratio: the value stands alone. */
const unitText = (label) => (label === 'λ' ? '' : label === '°CRK' ? '°' : label);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
/** s cut to fit w px at this size (an ellipsis where it was cut). */
function fit(cv, s, size, w) {
    if (cv.textWidth(s, size) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '…', size) > w) n--;
    return s.slice(0, n) + '…';
}

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        let page = 0;
        let channels = new Map();          // id -> ChannelDef of the connected car
        const latest = new Map();          // id -> last value (native units)
        const traces = new Map();          // id -> [values], one per TRACE_STEP_S, oldest first
        let traceT = -Infinity;
        let status = { state: 'disconnected' };
        let note = '';                     // a short message in the status line (capture refused, ...)
        const lines = [];
        const addLine = (s) => { lines.push(s); if (lines.length > LOG_LINES) lines.shift(); };

        const units = () => Object.assign({}, core.DEFAULT_UNITS, {
            pressure: settings.get('pressure'), temperature: settings.get('temperature'),
            speed: settings.get('speed'), lambda: settings.get('lambda'),
        });

        const link = new TasuLink(ctx.signals, log);
        await link.init();
        const session = core.createHeadUnitSession({
            dataDir: ctx.dataDir,
            link,
            settings: () => ({ units: units(), autoRecordWot: !!settings.get('autoRecordWot'), bmwDme: settings.get('bmwDme') }),
        });
        session.on('log', (m) => { log.info('boostline: ' + m); addLine(m); });
        session.on('channels', (list) => { channels = new Map(list.map((c) => [c.id, c])); latest.clear(); traces.clear(); });
        session.on('status', (s) => {
            const was = status.recording;
            status = s;
            if (!!was !== !!s.recording) Promise.resolve(ui.text('BTN_REC', s.recording ? 'Stop capture' : 'Start capture')).catch(() => {});
            if (was && !s.recording) addLine('Capture saved: ' + path.basename(was.file) + ' (' + was.samples + ' samples)');
        });
        session.on('batch', (b) => {
            for (let r = 0; r < b.rows.length; r++) {
                const row = b.rows[r];
                for (let i = 0; i < b.channelIds.length; i++) if (isNum(row[i])) latest.set(b.channelIds[i], row[i]);
                if (b.t[r] - traceT < TRACE_STEP_S) continue;
                traceT = b.t[r];
                for (let i = 0; i < b.channelIds.length; i++) {
                    const id = b.channelIds[i];
                    const tr = traces.get(id) || [];
                    tr.push(row[i]);
                    if (tr.length > TRACE_S / TRACE_STEP_S) tr.shift();
                    traces.set(id, tr);
                }
            }
        });

        // connect, and again every few seconds while the DME doesn't answer (ignition off, transport down)
        let retry = null;
        const connect = async () => {
            clearTimeout(retry); retry = null;
            if (!link.ready) { status = { state: 'error', error: 'No diagnostic link: ' + (link.error || 'TASU unavailable') }; return; }
            const s = await session.connect(core.HEAD_UNIT_CONNECTION);
            if (s.state === 'error') { addLine('Connect: ' + s.error); retry = setTimeout(connect, RETRY_MS); return; }
            await session.setStreamChannels(STREAM_IDS);
        };
        addLine('Boostline ' + core.BOOSTLINE_VERSION + ' core, ' + STREAM_IDS.length + ' channels wanted');
        connect().catch((e) => log.error('connect', e));

        ui.onClick('BTN_REC', async () => {
            note = '';
            if (status.recording) { await session.stopRecording(); return render(); }
            if (status.state !== 'live') { note = 'Not connected to the DME'; return render(); }
            if (core.folderBytes(path.join(ctx.dataDir, 'Logs')) > LOGS_LIMIT) { note = 'Logs folder full: copy the logs off and delete them'; return render(); }
            const r = await session.startRecording();
            addLine('Capture: ' + path.basename(r.file));
            return render();
        });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((i) => { page = i; return render(); });
        settings.onChange((k) => {
            // Session reads these when it connects
            if ((k === 'autoRecordWot' || k === 'bmwDme') && !status.recording) connect().catch((e) => log.error('reconnect', e));
        });

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, PAGES.map((p) => p.name), page, badges(t));
            if (page === STATUS_PAGE) statusPage(cv, t);
            else tilesPage(cv, t, PAGES[page].ids);
            return ui.image('MAIN_GFX', cv);
        }

        function badges() {
            const out = [];
            if (status.recording) out.push({ text: 'REC ' + clock(Date.now() - status.recording.startedAt), color: 'crit' });
            if (status.state === 'live' && isNum(status.sampleRateHz)) out.push({ text: Math.round(status.sampleRateHz) + ' HZ', color: 'dim' });
            else if (status.state !== 'live') out.push({ text: status.state === 'connecting' ? 'CONNECTING' : 'NO DME', color: 'warn' });
            return out;
        }

        /** The page's tiles: channels the car offers, a target folded into its actual's tile. */
        function tilesOf(ids) {
            const shown = ids.filter((id) => channels.has(id));
            const folded = new Set(shown.filter((id) => Object.keys(PAIRS).some((a) => PAIRS[a].target === id && shown.indexOf(a) >= 0)));
            return shown.filter((id) => !folded.has(id)).map((id) => {
                const pair = PAIRS[id];
                return { a: channels.get(id), t: pair && shown.indexOf(pair.target) >= 0 ? channels.get(pair.target) : null, span: pair && pair.span };
            }).slice(0, COLS * ROWS);
        }

        function tilesPage(cv, t, ids) {
            const tiles = tilesOf(ids);
            const top = G.TOP + 10, bottom = G.pageBottom(cv) - 4;
            if (!tiles.length) {
                const msg = status.state === 'live' ? 'The DME offers none of this page\'s channels' : connectionLine();
                cv.text(msg, cv.w / 2, (top + bottom) / 2, 30, t.dim, { align: 'center' });
                return;
            }
            const w = (cv.w - 2 * SIDE - (COLS - 1) * GAP) / COLS, h = (bottom - top - (ROWS - 1) * GAP) / ROWS;
            tiles.forEach((tile, i) => tileAt(cv, t, SIDE + (i % COLS) * (w + GAP), top + Math.floor(i / COLS) * (h + GAP), w, h, tile));
            if (note) cv.text(note, cv.w - SIDE, bottom, 20, t.warn, { align: 'right' });
        }

        function tileAt(cv, t, x, y, w, h, tile) {
            G.panel(cv, t, x, y, w, h, tile.a.name);
            const u = units();
            const da = core.displayUnitFor(tile.a, u);
            const v = latest.get(tile.a.id);
            const shown = isNum(v) ? da.toDisplay(v) : null;
            const unit = unitText(da.label);
            const size = Math.min(84, h * 0.38), vy = y + 58 + size * 0.8;
            const decimals = da.decimals(tile.a.decimals);
            const vs = G.fmt(shown, decimals);
            const vw = cv.textWidth(vs, size, { font: 'num' });
            cv.text(vs, x + 20, vy, size, isNum(shown) ? t.text : t.dim, { font: 'num' });
            if (unit) cv.text(unit, x + 28 + vw, vy, 26, t.dim);
            let traceTop = vy + 14;
            if (tile.t) {
                // under the value: the target (in the actual's unit and decimals), then how far apart they are
                const dt = core.displayUnitFor(tile.t, u), tv = latest.get(tile.t.id);
                const ts = 'TARGET ' + G.fmt(isNum(tv) ? dt.toDisplay(tv) : null, decimals) + (unit ? ' ' + unit : '');
                const ry = vy + 34;
                const tw = cv.text(ts, x + 20, ry, 20, t.dim, { font: 'bold', spacing: 1 });
                deviation(cv, t, x + 36 + tw, ry - 13, w - 56 - tw, 10, isNum(v) && isNum(tv) ? (v - tv) / tile.span : null);
                traceTop = ry + 14;
            }
            trace(cv, t, x + 20, traceTop, w - 40, y + h - 18 - traceTop, tile);
        }

        /** How far actual is from target: from the middle, a full side at one span. */
        function deviation(cv, t, x, y, w, h, f) {
            cv.roundRect(x, y, w, h, h / 2, t.track);
            cv.fillRect(x + w / 2 - 1, y - 3, 2, h + 6, t.tick);
            if (!isNum(f)) return;
            const c = Math.max(-1, Math.min(1, f)), a = Math.abs(c);
            const col = a < 0.34 ? t.accent2 || t.accent : a < 0.67 ? t.warn : t.crit;
            const fx = c >= 0 ? x + w / 2 : x + w / 2 + c * (w / 2);
            cv.roundRect(fx, y, Math.max(3, a * (w / 2)), h, h / 2, col);
        }

        /** The last TRACE_S seconds: actual in the accent colour, target dimmed, on one scale. */
        function trace(cv, t, x, y, w, h, tile) {
            if (h < 24) return;
            const a = traces.get(tile.a.id) || [], b = tile.t ? traces.get(tile.t.id) || [] : [];
            const vals = a.concat(b).filter(isNum);
            if (vals.length < 3) return;
            let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
            if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
            const n = TRACE_S / TRACE_STEP_S;
            const pts = (tr) => tr.map((p, i) => [x + ((n - tr.length + i) / (n - 1)) * w, isNum(p) ? y + h - ((p - lo) / (hi - lo)) * h : y + h]);
            if (b.length > 1) cv.polyline(pts(b), 2, withAlpha(t.dim, 0.8));
            if (a.length > 1) {
                cv.fillUnder(pts(a), y + h, withAlpha(t.accent, 0.12));
                cv.polyline(pts(a), 2.5, withAlpha(t.accent, 0.9));
            }
        }

        function connectionLine() {
            if (status.state === 'live') return 'Live from the DME';
            if (status.state === 'connecting') return 'Connecting to the DME...';
            if (status.state === 'error') return status.error || 'No answer from the DME';
            return 'Not connected';
        }

        function statusPage(cv, t) {
            const top = G.TOP + 10, bottom = G.pageBottom(cv) - 4, half = (cv.w - 2 * SIDE - GAP) / 2;
            const lx = SIDE, rx = SIDE + half + GAP;
            G.panel(cv, t, lx, top, half, bottom - top, 'Connection');
            const ecu = status.ecu || {};
            const rows = [
                ['State', connectionLine()],
                ['Link', 'Head unit diagnostics (TASU)'],
                ['VIN', status.vin || '--'],
                ['DME software', ecu.softwareVersion || '--'],
                ['Diagnostic index', ecu.sgbdIndex || '--'],
                ['BMW DME data', ecu.dmeData || 'none (OBD-II channels)'],
                ['Channels', channels.size ? channels.size + ' offered, ' + STREAM_IDS.filter((id) => channels.has(id)).length + ' streamed' : '--'],
                ['Sample rate', isNum(status.sampleRateHz) ? status.sampleRateHz.toFixed(1) + ' per second' : '--'],
                ['Requests', link.stats.sent + ' sent, ' + link.stats.missed + ' unanswered, busy ' + link.busy],
                ['Capture', status.recording ? path.basename(status.recording.file) + ', ' + status.recording.samples + ' samples' : 'off'],
            ];
            rows.forEach((r, i) => {
                const yy = top + 84 + i * 38;
                cv.text(r[0], lx + 20, yy, 22, t.dim);
                cv.text(fit(cv, String(r[1]), 22, half - 270), lx + 250, yy, 22, t.text);
            });
            G.panel(cv, t, rx, top, half, bottom - top, 'Log');
            const room = Math.floor((bottom - top - 70) / 30);
            lines.slice(-room).forEach((s, i) => cv.text(fit(cv, s, 18, half - 40), rx + 20, top + 80 + i * 30, 18, t.dim));
            if (note) cv.text(note, cv.w - SIDE, bottom, 20, t.warn, { align: 'right' });
        }

        // every screen refresh with the GPU renderer, 10 a second in software (PNG frames)
        ctx.loop('MAIN', 10, render);
    },
});
