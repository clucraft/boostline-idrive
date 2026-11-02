'use strict';
/**
 * Boostline on the iDrive 7 head unit: live engine data, CSV logs, road dyno and drag timer from the
 * DME, read-only.
 *
 * Boostline's own Session (boostline-core.js, bundled from vendor/boostline by tools/bundle.js)
 * talks UDS to the DME over the head unit's diagnostic transport (tasu-link.js): the same channel
 * set, batching, dynamically defined DIDs, OBD-II fallback and CSV format as the desktop app. The
 * dyno and the drag timer are Boostline's too (runs.js on its detectors and analysis).
 *
 * Pages (header tabs, Next page):
 *   Boost & fuel, Timing, Engine   value tiles; an actual / target pair shares a tile with a bar for
 *                                  how far apart they are; a trace of the last 12 s under the value
 *   Channels                       every channel streamed (and so captured) with its value, and Choose
 *                                  channels: the picker (picker.js) for what to stream, saved in
 *                                  <data>/boostline-app.json; by default what the tiles show
 *   Dyno                          Arm run, then a full-throttle pull in one gear: engine power, wheel
 *                                  power and torque against rpm, the peaks, the previous run dashed
 *   Drag                           Arm run, then a standing start (or through the start speed): the
 *                                  time, trap speed, splits and the speed trace with the shifts
 *   Status                         the connection (VIN, DME, its data), sample rate, the transport's
 *                                  numbers, the capture and Boostline's log
 * The first button is the page's action: Start / Stop capture on the live pages (every streamed
 * channel to <data>/Logs/Boostline_<date>.csv, as on the desktop), Arm run / Disarm on Dyno and Drag
 * (runs saved to <data>/Dyno and <data>/Drag in the desktop app's format).
 *
 * Runs on the head unit's Node 8: plain ES2017, no ?. / ?? / optional catch binding.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const core = require('./boostline-core');
const { TasuLink } = require('./tasu-link');
const { DynoRuns, DragRuns, modeName } = require('./runs');
const picker = require('./picker');
const { pill } = require('./kit/sheet');

/** A tile is an id, or alternatives of which the first streamed one shows (the DME's, else OBD-II's). */
const PAGES = [
    { name: 'Boost & fuel', ids: ['engine.rpm', 'throttle.pedal', 'boost.actual', 'boost.target', 'fuel.lambda.actual', 'fuel.lambda.target',
        'fuel.rail.actual', 'fuel.rail.target', 'boost.wg_actual', 'boost.wg_target', 'temp.intake', 'load.torque.actual'] },
    { name: 'Timing', ids: [['ign.avg', 'obd.timing_advance'], 'ign.cyl1', 'ign.cyl2', 'ign.cyl3', 'ign.cyl4', 'ign.cyl5', 'ign.cyl6', 'engine.rpm'] },
    { name: 'Engine', ids: ['vehicle.speed', 'vehicle.gear', 'temp.coolant', 'temp.oil', 'throttle.position', 'throttle.target',
        'vanos.intake.actual', 'vanos.intake.target', ['load.maf', 'obd.maf'], 'elec.battery'] },
    { name: 'Channels', kind: 'channels', ids: [] },
    { name: 'Dyno', kind: 'dyno', ids: [] },
    { name: 'Drag', kind: 'drag', ids: [] },
    { name: 'Status', kind: 'status', ids: [] },
];
/** The weather the dyno corrects for, read from the car when a run is armed. */
const ENV_IDS = ['boost.ambient', 'temp.ambient'];
/**
 * Unless the channel picker says otherwise, what the tiles show is streamed (and captured) at once:
 * switching pages doesn't restart the stream. (Session adds rpm, speed, pedal and gear, which the
 * dyno and drag timer need, by itself.)
 */
const DEFAULT_ENTRIES = PAGES.reduce((all, p) => all.concat(p.ids), []).concat(ENV_IDS);

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
/** How long the closed-course notice waits for the second press of Arm run. */
const CONFIRM_MS = 15000;
const DYNO_KEYS = ['dynoMass', 'dynoLoss', 'dynoCdA', 'dynoStartRpm', 'dynoEndRpm', 'dynoCorrection'];

/** The kit's fonts have no λ, and λ is a ratio: the value stands alone. */
const unitText = (label) => (label === 'λ' ? '' : label === '°CRK' ? '°' : label);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
/** s cut to fit w px at this size (an ellipsis where it was cut). */
function fit(cv, s, size, w, opt) {
    if (cv.textWidth(s, size, opt) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '…', size, opt) > w) n--;
    return s.slice(0, n) + '…';
}
/** A round axis step so that n steps reach at least max. */
function axisStep(max, n) {
    const raw = Math.max(max, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p * n >= max) return m * p;
    return 10 * p;
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
        let note = '';                     // a short message on the page (capture refused, run saved, ...)
        let noteUntil = 0;
        const say = (s, ms) => { note = s; noteUntil = Date.now() + (ms || 6000); };
        const lines = [];
        const addLine = (s) => { lines.push(s); if (lines.length > LOG_LINES) lines.shift(); };

        // what the app remembers between starts (the closed-course notice was acknowledged)
        const stateFile = path.join(ctx.dataDir, 'boostline-app.json');
        let appState = {};
        try { appState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { appState = {}; }
        const saveState = () => { try { fs.writeFileSync(stateFile, JSON.stringify(appState)); } catch (e) { log.warn('state: ' + e.message); } };
        let confirmUntil = 0;              // the closed-course notice is up, waiting for the second press
        // the channels to stream: the user's list from the picker, or (null) what the pages show on this car
        let logChoice = Array.isArray(appState.logChannels) ? appState.logChannels.map(String) : null;
        const wanted = () => logChoice || picker.defaultIds(DEFAULT_ENTRIES, channels);
        let streamed = new Set();          // what Session streams now (the last batch's channels)
        let streamedFrom = null;
        let listY = 0, listMax = 0;        // the Channels page's list: scrolled by, how far it can

        const units = () => Object.assign({}, core.DEFAULT_UNITS, {
            pressure: settings.get('pressure'), temperature: settings.get('temperature'), speed: settings.get('speed'),
            lambda: settings.get('lambda'), power: settings.get('power'), torque: settings.get('torque'),
        });

        const dyno = new DynoRuns(core, path.join(ctx.dataDir, 'Dyno'));
        const drag = new DragRuns(core, path.join(ctx.dataDir, 'Drag'));
        // the weather of the last dyno run (baro, outside temperature): read from the car at every arm
        let dynoEnv = dyno.current ? { baroHpa: dyno.current.result.setup.baroHpa, ambientTempC: dyno.current.result.setup.ambientTempC } : {};
        const dynoSetup = () => Object.assign({}, core.DEFAULT_DYNO_SETUP, {
            massKg: settings.get('dynoMass'), drivetrainLossPct: settings.get('dynoLoss'), cdA: settings.get('dynoCdA'),
            startRpm: settings.get('dynoStartRpm'), endRpm: settings.get('dynoEndRpm'), correction: settings.get('dynoCorrection'),
        }, dynoEnv);
        dyno.setSetup(dynoSetup());
        const dragOpts = () => {
            const pct = Number(settings.get('dragSpeedo')) || 0, amb = latest.get('temp.ambient');
            return {
                // one point: the true speed is pct % above (below) the car's at every speed
                calibration: pct ? [{ ecu: 100, gps: 100 * (1 + pct / 100) }] : [],
                environment: { altitudeM: 0, ambientTempC: isNum(amb) ? Math.round(amb * 10) / 10 : 20, humidityPct: 50 },
            };
        };

        const link = new TasuLink(ctx.signals, log);
        await link.init();
        const session = core.createHeadUnitSession({
            dataDir: ctx.dataDir,
            link,
            settings: () => ({ units: units(), autoRecordWot: !!settings.get('autoRecordWot'), bmwDme: settings.get('bmwDme') }),
        });
        session.on('log', (m) => { log.info('boostline: ' + m); addLine(m); });
        session.on('channels', (list) => { channels = new Map(list.map((c) => [c.id, c])); latest.clear(); traces.clear(); streamed = new Set(); streamedFrom = null; });
        session.on('status', (s) => {
            const was = status.recording;
            status = s;
            if (was && !s.recording) addLine('Capture saved: ' + path.basename(was.file) + ' (' + was.samples + ' samples)');
        });
        session.on('batch', (b) => {
            if (b.channelIds !== streamedFrom) { streamedFrom = b.channelIds; streamed = new Set(b.channelIds); }
            const at = (id) => b.channelIds.indexOf(id);
            const iRpm = at('engine.rpm'), iSpeed = at('vehicle.speed'), iPedal = at('throttle.pedal'), iGear = at('vehicle.gear');
            const v = (row, i) => (i >= 0 ? row[i] : NaN);
            for (let r = 0; r < b.rows.length; r++) {
                const row = b.rows[r], t = b.t[r];
                for (let i = 0; i < b.channelIds.length; i++) if (isNum(row[i])) latest.set(b.channelIds[i], row[i]);
                if (dyno.armed) {
                    const run = dyno.push(t, v(row, iRpm), v(row, iSpeed), v(row, iPedal), v(row, iGear), status.vin);
                    if (run) dynoDone(run);
                }
                if (drag.armed) {
                    const run = drag.push(t, v(row, iSpeed), v(row, iGear), v(row, iRpm), status.vin);
                    if (run) dragDone(run);
                }
                if (t - traceT < TRACE_STEP_S) continue;
                traceT = t;
                for (let i = 0; i < b.channelIds.length; i++) {
                    const id = b.channelIds[i];
                    const tr = traces.get(id) || [];
                    tr.push(row[i]);
                    if (tr.length > TRACE_S / TRACE_STEP_S) tr.shift();
                    traces.set(id, tr);
                }
            }
        });

        function dynoDone(run) {
            const p = core.powerFromKw(run.result.peakEngine.kw, units().power);
            addLine('Dyno: ' + run.name + ', ' + p.toFixed(0) + ' ' + units().power + ' at ' + Math.round(run.result.peakEngine.rpm) + ' rpm');
            say('Pull captured and saved');
            dyno.setSetup(dynoSetup());
        }
        function dragDone(run) {
            const r = run.result;
            addLine('Drag: ' + run.name + (r.warnings.length ? ' (' + r.warnings[0] + ')' : ''));
            say(r.finished ? modeName(r.mode) + ': ' + r.finalTime.toFixed(2) + ' s, saved' : 'Run aborted: the speed dropped before the finish');
        }

        // connect, and again every few seconds while the DME doesn't answer (ignition off, transport down)
        let retry = null;
        const connect = async () => {
            clearTimeout(retry); retry = null;
            if (!link.ready) { status = { state: 'error', error: 'No diagnostic link: ' + (link.error || 'TASU unavailable') }; return; }
            const s = await session.connect(core.HEAD_UNIT_CONNECTION);
            if (s.state === 'error') { addLine('Connect: ' + s.error); retry = setTimeout(connect, RETRY_MS); return; }
            await session.setStreamChannels(wanted());
        };
        addLine('Boostline ' + core.BOOSTLINE_VERSION + ' core, ' + (logChoice ? logChoice.length + ' channels chosen' : 'the pages\' channels'));
        connect().catch((e) => log.error('connect', e));

        /** The first button follows the page: capture on the live pages, Arm run on Dyno and Drag. */
        const kind = () => PAGES[page].kind || 'live';
        function actionLabel() {
            if (kind() === 'dyno') return dyno.armed ? 'Disarm' : 'Arm run';
            if (kind() === 'drag') return drag.armed ? 'Disarm' : 'Arm run';
            return status.recording ? 'Stop capture' : 'Start capture';
        }
        let shownLabel = 'Start capture';
        function syncLabel() {
            const l = actionLabel();
            if (l === shownLabel) return;
            shownLabel = l;
            Promise.resolve(ui.text('BTN_REC', l)).catch(() => {});
        }

        async function capture() {
            if (status.recording) { await session.stopRecording(); return; }
            if (status.state !== 'live') { say('Not connected to the DME'); return; }
            if (core.folderBytes(path.join(ctx.dataDir, 'Logs')) > LOGS_LIMIT) { say('Logs folder full: copy the logs off and delete them', 10000); return; }
            const r = await session.startRecording();
            addLine('Capture: ' + path.basename(r.file));
        }

        function armOrDisarm(runs) {
            if (runs.armed) { runs.disarm(); say('Disarmed', 2500); return; }
            if (status.state !== 'live') { say('Not connected to the DME'); return; }
            // once: pulls and drag runs belong on a closed course (the desktop app asks the same)
            if (!appState.closedCourseNotice) {
                if (Date.now() > confirmUntil) { confirmUntil = Date.now() + CONFIRM_MS; return; }
                appState.closedCourseNotice = true;
                saveState();
            }
            confirmUntil = 0;
            if (runs === dyno) {
                const baro = latest.get('boost.ambient'), amb = latest.get('temp.ambient');
                if (isNum(baro)) dynoEnv.baroHpa = Math.round(baro * 1000);
                if (isNum(amb)) dynoEnv.ambientTempC = Math.round(amb * 10) / 10;
                dyno.arm(dynoSetup());
            } else {
                drag.arm(settings.get('dragMode'), dragOpts());
            }
        }

        /** The channel picker, over the page (the kit draws it: GPU renderer, full-screen layout). */
        function choose() {
            if (!channels.size) { say('Not connected to the DME: its channels aren\'t known yet'); return; }
            const sh = picker.channelSheet({
                channels: () => channels,
                groups: core.GROUP_ORDER,
                wanted: wanted(),
                isDefault: !logChoice,
                defaults: () => picker.defaultIds(DEFAULT_ENTRIES, channels),
                max: core.MAX_STREAMED,
                unit: (def) => unitText(core.displayUnitFor(def, units()).label),
                done: (c) => {
                    logChoice = c.isDefault ? null : c.ids;
                    if (logChoice) appState.logChannels = logChoice; else delete appState.logChannels;
                    saveState();
                    addLine('Channels: ' + (logChoice ? logChoice.length + ' chosen' : 'the pages\' channels'));
                    // a capture keeps its columns: Session switches when it stops
                    if (status.recording) say('The new channels apply when the capture stops', 8000);
                    session.setStreamChannels(wanted()).catch((e) => log.error('channels', e));
                },
            });
            if (!ctx.sheet(sh)) say('The picker needs Screen layout: Full screen and Renderer: GPU (Settings)', 10000);
        }
        ctx.onScroll((dy) => {
            if (kind() !== 'channels') return false;
            const y = Math.max(0, Math.min(listMax, listY + dy));
            if (y === listY) return false;
            listY = y;
            return true;
        });

        ui.onClick('BTN_REC', async () => {
            if (kind() === 'dyno') armOrDisarm(dyno);
            else if (kind() === 'drag') armOrDisarm(drag);
            else await capture();
            return render();
        });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; confirmUntil = 0; return render(); });
        ctx.onTab((i) => { page = i; confirmUntil = 0; return render(); });
        settings.onChange((k) => {
            // Session reads these when it connects
            if ((k === 'autoRecordWot' || k === 'bmwDme') && !status.recording) connect().catch((e) => log.error('reconnect', e));
            // the run shown is analysed again with the new setup, as on the desktop
            if (DYNO_KEYS.indexOf(k) >= 0) dyno.setSetup(dynoSetup());
        });

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            syncLabel();
            G.frame(cv, t, PAGES.map((p) => p.name), page, badges());
            const k = kind();
            if (k === 'status') statusPage(cv, t);
            else if (k === 'dyno') dynoPage(cv, t);
            else if (k === 'drag') dragPage(cv, t);
            else if (k === 'channels') channelsPage(cv, t);
            else tilesPage(cv, t, PAGES[page].ids);
            if (Date.now() < confirmUntil) closedCourse(cv, t);
            return ui.image('MAIN_GFX', cv);
        }

        function badges() {
            const out = [];
            if (status.recording) out.push({ text: 'REC ' + clock(Date.now() - status.recording.startedAt), color: 'crit' });
            if (dyno.armed) out.push({ text: dyno.state === 'recording' ? 'PULL' : 'DYNO ARMED', color: dyno.state === 'recording' ? 'crit' : 'warn' });
            if (drag.armed) out.push({ text: drag.state === 'running' ? 'RUN' : 'DRAG ARMED', color: drag.state === 'running' ? 'crit' : 'warn' });
            if (status.state === 'live' && isNum(status.sampleRateHz)) out.push({ text: Math.round(status.sampleRateHz) + ' HZ', color: 'dim' });
            else if (status.state !== 'live') out.push({ text: status.state === 'connecting' ? 'CONNECTING' : 'NO DME', color: 'warn' });
            return out;
        }

        const pageTop = () => G.TOP + 10;
        const pageBottom = (cv) => G.pageBottom(cv) - 4;
        function noteLine(cv, t) {
            if (note && Date.now() < noteUntil) cv.text(note, cv.w - SIDE, pageBottom(cv), 20, t.warn, { align: 'right' });
        }

        /* ---------------- live tiles ---------------- */

        /** The page's tiles: channels streamed (the first of alternatives), a target folded into its actual's tile. */
        function tilesOf(entries) {
            const shown = [];
            entries.forEach((e) => {
                const id = (Array.isArray(e) ? e : [e]).find((x) => streamed.has(x) && channels.has(x));
                if (id && shown.indexOf(id) < 0) shown.push(id);
            });
            const folded = new Set(shown.filter((id) => Object.keys(PAIRS).some((a) => PAIRS[a].target === id && shown.indexOf(a) >= 0)));
            return shown.filter((id) => !folded.has(id)).map((id) => {
                const pair = PAIRS[id];
                return { a: channels.get(id), t: pair && shown.indexOf(pair.target) >= 0 ? channels.get(pair.target) : null, span: pair && pair.span };
            }).slice(0, COLS * ROWS);
        }

        function tilesPage(cv, t, ids) {
            const tiles = tilesOf(ids);
            const top = pageTop(), bottom = pageBottom(cv);
            if (!tiles.length) {
                const msg = status.state !== 'live' ? connectionLine() : !streamed.size ? 'Starting...'
                    : 'None of this page\'s channels are logged: see the Channels page';
                cv.text(msg, cv.w / 2, (top + bottom) / 2, 30, t.dim, { align: 'center' });
                return;
            }
            const w = (cv.w - 2 * SIDE - (COLS - 1) * GAP) / COLS, h = (bottom - top - (ROWS - 1) * GAP) / ROWS;
            tiles.forEach((tile, i) => tileAt(cv, t, SIDE + (i % COLS) * (w + GAP), top + Math.floor(i / COLS) * (h + GAP), w, h, tile));
            noteLine(cv, t);
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

        /* ---------------- channels ---------------- */

        /** Every channel streamed, by group, with its value; Choose channels opens the picker. */
        function channelsPage(cv, t) {
            const top = pageTop(), bottom = pageBottom(cv);
            const bw = 300, bh = 50, bx = cv.w - SIDE - bw, by = top + 2;
            pill(cv, t, bx, by, bw, bh, 'Choose channels', false);
            cv.target(bx - 6, by - 6, bw + 12, bh + 12, choose, 'choose', bh / 2 + 6);
            const n = streamed.size;
            const head = status.state !== 'live' ? connectionLine()
                : 'Logging ' + n + ' channel' + (n === 1 ? '' : 's') + (isNum(status.sampleRateHz) ? ' at ' + status.sampleRateHz.toFixed(0) + ' samples per second' : '')
                    + (logChoice ? ' (your choice)' : ' (what the pages show)');
            cv.text(fit(cv, head, 24, bx - SIDE - 30), SIDE + 4, by + 34, 24, t.text, { font: 'bold' });
            noteLine(cv, t);
            if (status.state !== 'live' || !n) return;

            // one grid in Boostline's group order; a group's name over the cell it starts at
            // (in the car's order, as the picker lists them; the DME's own values by name)
            const byGroup = new Map();
            channels.forEach((def) => {
                if (!streamed.has(def.id)) return;
                const g = def.group || 'Custom';
                if (!byGroup.has(g)) byGroup.set(g, []);
                byGroup.get(g).push(def);
            });
            if (byGroup.has('DME')) byGroup.get('DME').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            const order = core.GROUP_ORDER.filter((g) => byGroup.has(g)).concat(Array.from(byGroup.keys()).filter((g) => core.GROUP_ORDER.indexOf(g) < 0));
            const cells = [];
            order.forEach((g) => byGroup.get(g).forEach((def, i) => cells.push({ def, head: i ? '' : g })));
            const C = 5, HEAD = 26, CELL = 68, ROW = HEAD + CELL + 8, x0 = SIDE, w = cv.w - 2 * SIDE - 24, cw = (w - (C - 1) * 10) / C;
            const y0 = top + 66, view = bottom - 4 - y0, total = Math.ceil(cells.length / C) * ROW;
            listMax = Math.max(0, total - view);
            listY = Math.min(listY, listMax);
            const u = units();
            cv.clip(x0, y0, w, view);
            cells.forEach((c, i) => {
                const cx = x0 + (i % C) * (cw + 10), ry = y0 - listY + Math.floor(i / C) * ROW, cy = ry + HEAD;
                if (cy + CELL < y0 || ry > y0 + view) return;
                if (c.head) cv.text(fit(cv, c.head.toUpperCase(), 15, cw - 8, { font: 'bold' }), cx + 4, ry + 18, 15, t.accent, { font: 'bold', spacing: 1.5 });
                cv.roundRect(cx, cy, cw, CELL, 10, withAlpha('#ffffff', 0.05));
                cv.text(fit(cv, c.def.name, 17, cw - 28), cx + 14, cy + 23, 17, t.dim);
                const d = core.displayUnitFor(c.def, u), v = latest.get(c.def.id);
                const vs = G.fmt(isNum(v) ? d.toDisplay(v) : null, d.decimals(c.def.decimals));
                const vw = cv.text(vs, cx + 14, cy + 58, 30, isNum(v) ? t.text : t.dim, { font: 'num' });
                const unit = unitText(d.label);
                if (unit) cv.text(fit(cv, unit, 18, cw - 40 - vw), cx + 22 + vw, cy + 58, 18, t.dim);
            });
            cv.noclip();
            if (listMax > 0) {
                // the list scrolls (a finger, or the controller on it): where it is
                const barX = cv.w - SIDE - 8, barH = Math.max(40, view * view / total), barY = y0 + (view - barH) * (listY / listMax);
                cv.roundRect(barX, barY, 6, barH, 3, withAlpha('#ffffff', 0.3));
                cv.scroll = { y: y0, bar: { x: barX, y: barY, w: 6, h: barH } };
            }
        }

        /* ---------------- dyno and drag ---------------- */

        /** Left: the chart panel; right: the results column. */
        function runLayout(cv) {
            const top = pageTop(), bottom = pageBottom(cv), rw = 470;
            return { top, bottom, h: bottom - top, lw: cv.w - 2 * SIDE - GAP - rw, rx: cv.w - SIDE - rw, rw };
        }

        /** A labelled big number in the results column; returns the y under it. */
        function figure(cv, t, x, y, w, label, value, unit, sub, color, size) {
            size = size || 64;
            cv.text(label.toUpperCase(), x, y + 18, 18, t.dim, { font: 'bold', spacing: 1.5 });
            const vw = cv.text(value, x, y + 26 + size * 0.78, size, value === '--' ? t.dim : color || t.text, { font: 'num' });
            if (unit) cv.text(unit, x + vw + 8, y + 26 + size * 0.78, 24, t.dim);
            if (sub) cv.text(fit(cv, sub, 20, w), x, y + 26 + size * 0.78 + 30, 20, t.dim);
            return y + 26 + size * 0.78 + (sub ? 46 : 18);
        }

        /** Coloured legend entries from x, right to left; returns the x left of them. */
        function legend(cv, t, xr, y, items) {
            let x = xr;
            items.slice().reverse().forEach((it) => {
                const w = cv.textWidth(it.label, 18);
                x -= w;
                cv.text(it.label, x, y, 18, t.dim);
                x -= 34;
                if (it.dash) for (let k = 0; k < 3; k++) cv.fillRect(x + k * 9, y - 7, 6, 3, it.color);
                else cv.fillRect(x, y - 7, 24, 3, it.color);
                x -= 22;
            });
            return x;
        }

        /** The axes' units over the plot (the chart's own sits on its top number). */
        function axisUnits(cv, t, ch, left, right, rightColor) {
            cv.text(left, ch.px - 8, ch.py - 14, 14, t.dim, { align: 'right', font: 'bold' });
            if (right) cv.text(right, ch.px + ch.pw + 8, ch.py - 14, 14, rightColor || t.dim, { font: 'bold' });
        }

        function stateLine(cv, t, x, y, w, text, live) {
            if (!text) return;
            if (live) { cv.circle(x + 7, y - 7, 6, t.crit); x += 22; w -= 22; }
            cv.text(fit(cv, text, 22, w, { font: 'bold' }), x, y, 22, live ? t.text : t.warn, { font: 'bold' });
        }

        function dynoPage(cv, t) {
            const L = runLayout(cv), u = units(), r = dyno.result, setup = dynoSetup();
            const ENGINE = t.warn, WHEEL = withAlpha(t.warn, 0.55), TORQUE = t.cold || t.accent2;
            G.panel(cv, t, SIDE, L.top, L.lw, L.h, dyno.current ? dyno.current.name : 'Power and torque');
            if (!r || !r.points.length) {
                const cx = SIDE + L.lw / 2, cy = L.top + L.h / 2;
                cv.text('Arm the run, then floor it in one gear (3rd or 4th)', cx, cy - 20, 28, t.text, { align: 'center' });
                cv.text('from below ' + setup.startRpm + ' rpm to past ' + setup.endRpm + ' rpm.', cx, cy + 20, 28, t.text, { align: 'center' });
                cv.text('Power is estimated from the car\'s acceleration. Closed course only.', cx, cy + 70, 20, t.dim, { align: 'center' });
            } else {
                const pw = (p) => core.powerFromKw(p.engineKw, u.power), ww = (p) => core.powerFromKw(p.wheelKw, u.power), tq = (p) => core.torqueFromNm(p.torqueNm, u.torque);
                const prev = dyno.previous();
                const pts = r.points.concat(prev ? prev.result.points : []);
                const N = 5;
                const pStep = axisStep(Math.max.apply(null, pts.map(pw)) * 1.05, N), tStep = axisStep(Math.max.apply(null, pts.map(tq)) * 1.05, N);
                const k = pStep / tStep;          // torque drawn on the power scale, labelled on the right
                const rpms = pts.map((p) => p.rpm);
                const x0 = Math.floor(Math.min.apply(null, rpms) / 500) * 500, x1 = Math.ceil(Math.max.apply(null, rpms) / 500) * 500;
                const series = [];
                if (prev) series.push({ pts: prev.result.points.map((p) => [p.rpm, pw(p)]), color: withAlpha(t.dim, 0.9), width: 2, dash: true });
                series.push({ pts: r.points.map((p) => [p.rpm, tq(p) * k]), color: TORQUE, width: 3 });
                series.push({ pts: r.points.map((p) => [p.rpm, ww(p)]), color: WHEEL, width: 2, dash: true });
                series.push({ pts: r.points.map((p) => [p.rpm, pw(p)]), color: ENGINE, width: 3.5, fill: 0.1 });
                const ch = G.chart(cv, t, SIDE + 14, L.top + 64, L.lw - 28, L.h - 78, {
                    xMin: x0, xMax: x1, yMin: 0, yMax: pStep * N, yStep: pStep, xStep: x1 - x0 > 4000 ? 1000 : 500,
                    padLeft: 56, padRight: 64, padTop: 24, xUnit: 'rpm', series,
                });
                for (let i = 0; i <= N; i++) cv.text(G.fmt(tStep * i, tStep % 1 ? 1 : 0), ch.px + ch.pw + 8, ch.Y(pStep * i) + 6, 16, TORQUE);
                axisUnits(cv, t, ch, u.power, u.torque, TORQUE);
                const items = [{ label: 'Engine', color: ENGINE }, { label: 'Wheel', color: WHEEL, dash: true }, { label: 'Torque', color: TORQUE }];
                if (prev) items.push({ label: 'Previous', color: t.dim, dash: true });
                legend(cv, t, SIDE + L.lw - 20, L.top + 42, items);
            }
            G.panel(cv, t, L.rx, L.top, L.rw, L.h, 'Peaks');
            const x = L.rx + 20, w = L.rw - 40;
            let y = L.top + 56;
            const peak = (kw) => (r ? core.powerFromKw(kw, u.power).toFixed(0) : '--');
            y = figure(cv, t, x, y, w, 'Engine power', peak(r && r.peakEngine.kw), u.power, r ? 'at ' + Math.round(r.peakEngine.rpm) + ' rpm' : '', ENGINE, 76);
            const half = (w - 20) / 2;
            figure(cv, t, x, y, half, 'Torque', r ? core.torqueFromNm(r.peakTorque.nm, u.torque).toFixed(0) : '--', u.torque, r ? 'at ' + Math.round(r.peakTorque.rpm) + ' rpm' : '', TORQUE, 48);
            y = figure(cv, t, x + half + 20, y, half, 'Wheel power', peak(r && r.peakWheel.kw), u.power, r ? 'at ' + Math.round(r.peakWheel.rpm) + ' rpm' : '', null, 48);
            if (r) {
                const s = r.setup;
                const info = 'Gear ' + (r.gear || '--') + '  ·  ' + (s.baroHpa / 1000).toFixed(2) + ' bar  ·  ' + s.ambientTempC.toFixed(0) + ' °C  ·  ' + s.massKg + ' kg';
                cv.text(fit(cv, info, 20, w), x, y + 10, 20, t.dim);
                if (s.correction !== 'none') cv.text(s.correction + ' correction ' + r.correctionFactor.toFixed(3), x, y + 38, 20, t.dim);
                if (r.warnings.length) cv.text(fit(cv, r.warnings[0], 18, w), x, y + (s.correction !== 'none' ? 66 : 38), 18, t.warn);
            }
            const st = dyno.state === 'armed' ? 'Armed: floor it in one gear at ' + setup.startRpm + ' rpm'
                : dyno.state === 'recording' ? 'Recording the pull...' : '';
            stateLine(cv, t, x, L.bottom - 18, w, st, dyno.state === 'recording');
            noteLine(cv, t);
        }

        function dragPage(cv, t) {
            const L = runLayout(cv), u = units(), r = drag.result, mode = drag.armed ? drag.mode : settings.get('dragMode');
            const SPEED = t.warn;
            const sp = (kmh) => core.speedFromKmh(kmh, u.speed);
            G.panel(cv, t, SIDE, L.top, L.lw, L.h, drag.current ? drag.current.name : modeName(mode));
            const spec = core.DRAG_MODES[mode];
            if (!r || !r.curve.t.length) {
                const cx = SIDE + L.lw / 2, cy = L.top + L.h / 2;
                const how = spec.standing ? 'Arm the run and come to a stop. Timing starts at the first movement.'
                    : 'Arm the run below ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed + ', then accelerate through it.';
                cv.text(modeName(mode), cx, cy - 30, 36, t.text, { align: 'center', font: 'bold' });
                cv.text(how, cx, cy + 16, 24, t.text, { align: 'center' });
                cv.text('Closed course only.', cx, cy + 64, 20, t.dim, { align: 'center' });
            } else {
                const c = r.curve, xEnd = (r.finalTime !== null ? r.finalTime : c.t[c.t.length - 1]) + 0.4;
                const cal = [], raw = [];
                for (let i = 0; i < c.t.length; i++) {
                    if (c.t[i] < -0.2 || c.t[i] > xEnd) continue;
                    cal.push([c.t[i], sp(c.calibrated[i])]);
                    raw.push([c.t[i], sp(c.raw[i])]);
                }
                const vMax = Math.max.apply(null, cal.map((p) => p[1]).concat([1])), N = 5, vStep = axisStep(vMax * 1.05, N);
                const tStep = axisStep(xEnd, 6);
                // the car's own speed too, when this run was corrected (the speedometer setting)
                const calibrated = c.raw.some((v, i) => Math.abs(v - c.calibrated[i]) > 0.05);
                const series = [];
                if (calibrated) series.push({ pts: raw, color: withAlpha(t.dim, 0.9), width: 2 });
                series.push({ pts: cal, color: SPEED, width: 3.5, fill: 0.1 });
                const ch = G.chart(cv, t, SIDE + 14, L.top + 64, L.lw - 28, L.h - 78, {
                    xMin: 0, xMax: Math.ceil(xEnd / tStep) * tStep, xStep: tStep, yMin: 0, yMax: vStep * N, yStep: vStep,
                    padLeft: 56, padTop: 24, xUnit: 's', xFmt: (v) => G.fmt(v, tStep % 1 ? 1 : 0), series,
                });
                axisUnits(cv, t, ch, u.speed);
                // the shifts: a thin line and the gear it went into
                r.gearChanges.forEach((g) => {
                    if (g.time < 0 || g.time > xEnd) return;
                    const gx = ch.X(g.time);
                    cv.fillRect(gx - 1, ch.py, 2, ch.ph, withAlpha(t.text, 0.25));
                    cv.text(String(g.to), gx + 6, ch.py + 18, 16, t.dim, { font: 'bold' });
                });
                const items = [{ label: calibrated ? 'True speed' : 'Speed', color: SPEED }];
                if (calibrated) items.unshift({ label: 'Car\'s speed', color: t.dim });
                legend(cv, t, SIDE + L.lw - 20, L.top + 42, items);
            }
            G.panel(cv, t, L.rx, L.top, L.rw, L.h, 'Time');
            const x = L.rx + 20, w = L.rw - 40;
            let y = L.top + 56;
            const best = drag.best(r ? r.mode : mode);
            const sub = r ? (r.trapSpeedKmh !== null ? 'trap ' + sp(r.trapSpeedKmh).toFixed(1) + ' ' + u.speed + '  ·  ' : '') + Math.round(r.distanceM) + ' m'
                + (best !== null ? '  ·  best ' + best.toFixed(2) + ' s' : '') : (best !== null ? 'best ' + best.toFixed(2) + ' s' : '');
            y = figure(cv, t, x, y, w, r ? modeName(r.mode) : modeName(mode), r && r.finalTime !== null ? r.finalTime.toFixed(2) : '--', 's', sub, SPEED, 76);
            if (r && r.splits.length) {
                // the splits: every one up to 8 rows, else evenly spaced ones and the last
                const step = /mph/.test(r.mode) ? 'mph' : 'km/h';
                const rows = Math.max(1, Math.floor((L.bottom - 50 - y) / 30));
                let splits = r.splits;
                if (splits.length > rows) splits = splits.filter((s, i) => (i + 1) % Math.ceil(splits.length / rows) === 0 || i === splits.length - 1).slice(-rows);
                const from = Math.round(core.speedFromKmh(core.DRAG_MODES[r.mode].fromKmh, step));
                splits.forEach((s, i) => {
                    const yy = y + 8 + i * 30;
                    cv.text(from + '-' + Math.round(core.speedFromKmh(s.speedKmh, step)) + ' ' + step, x, yy, 20, t.dim);
                    cv.text(s.time.toFixed(2) + ' s', x + w, yy, 20, t.text, { align: 'right', font: 'bold' });
                });
            }
            if (r && r.warnings.length && !drag.armed) cv.text(fit(cv, r.warnings[0], 18, w), x, L.bottom - 46, 18, t.warn);
            const st = drag.state === 'waiting-stop' ? (spec.standing ? 'Armed: come to a complete stop' : 'Armed: slow down below ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed)
                : drag.state === 'ready' ? (spec.standing ? 'Ready: launch when you are' : 'Ready: accelerate through ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed)
                    : drag.state === 'running' ? 'Running...' : '';
            stateLine(cv, t, x, L.bottom - 18, w, st, drag.state === 'running');
            noteLine(cv, t);
        }

        /** The first Arm run asks once: full-throttle runs belong on a closed course. */
        function closedCourse(cv, t) {
            const w = 900, h = 250, x = (cv.w - w) / 2, y = pageTop() + 90;
            cv.roundRect(x - 6, y - 6, w + 12, h + 12, 10, withAlpha(t.bg, 0.92));
            G.panel(cv, t, x, y, w, h, 'Closed courses only');
            cv.text('Full-throttle pulls and drag runs belong on a closed course or a track,', x + 24, y + 90, 24, t.text);
            cv.text('never on public roads. Power and times are estimates from the car\'s data.', x + 24, y + 124, 24, t.text);
            cv.text('Press Arm run again to confirm.', x + 24, y + 190, 26, t.warn, { font: 'bold' });
        }

        /* ---------------- status ---------------- */

        function connectionLine() {
            if (status.state === 'live') return 'Live from the DME';
            if (status.state === 'connecting') return 'Connecting to the DME...';
            if (status.state === 'error') return status.error || 'No answer from the DME';
            return 'Not connected';
        }

        function statusPage(cv, t) {
            const top = pageTop(), bottom = pageBottom(cv), half = (cv.w - 2 * SIDE - GAP) / 2;
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
                ['Channels', channels.size ? channels.size + ' offered, ' + streamed.size + ' streamed' + (logChoice ? ' (your choice)' : '') : '--'],
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
            noteLine(cv, t);
        }

        // every screen refresh with the GPU renderer, 10 a second in software (PNG frames)
        ctx.loop('MAIN', 10, render);
    },
});
