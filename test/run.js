'use strict';
/**
 * The head-unit app's link to the DME, end to end, without a car or the emulator: Boostline's Session
 * (app/boostline-core.js) -> app/tasu-link.js -> the kit's Diag (kit/runtime/diag.js) -> a stubbed
 * TASU transport -> the emulator's fake DME (build/fake-dme.js).
 *
 *   node test/run.js                     (npm test bundles first)
 *   node tools/node8.js test/run.js      the same on Node 8, as the head unit runs it (npm run test:node8)
 *
 * Node 8 syntax on purpose: no ?. / ?? / optional catch binding / fs.rmSync.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// The app's files as the kit's build lays them out (app.js beside ./kit/diag.js)
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'boostline-idrive-'));
fs.mkdirSync(path.join(stage, 'kit'));
fs.copyFileSync(path.join(ROOT, 'app', 'boostline-core.js'), path.join(stage, 'boostline-core.js'));
fs.copyFileSync(path.join(ROOT, 'app', 'tasu-link.js'), path.join(stage, 'tasu-link.js'));
fs.copyFileSync(path.join(ROOT, 'app', 'runs.js'), path.join(stage, 'runs.js'));
fs.copyFileSync(path.join(ROOT, 'app', 'picker.js'), path.join(stage, 'picker.js'));
// the kit's runtime: diag.js, and sheet.js and the drawing it needs for the picker
(function copyDir(from, to) {
    fs.readdirSync(from).forEach((f) => {
        const a = path.join(from, f), b = path.join(to, f);
        if (fs.statSync(a).isDirectory()) { fs.mkdirSync(b); copyDir(a, b); } else fs.copyFileSync(a, b);
    });
})(path.join(ROOT, 'vendor', 'idrive7-apps', 'kit', 'runtime'), path.join(stage, 'kit'));

const core = require(path.join(stage, 'boostline-core.js'));
const { TasuLink } = require(path.join(stage, 'tasu-link.js'));
const fakeDme = require(path.join(ROOT, 'build', 'fake-dme.js'));

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const later = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_ONLY = [0x10, 0x19, 0x22, 0x23, 0x2C, 0x3E];

function rmrf(p) {
    if (!fs.existsSync(p)) return;
    if (fs.lstatSync(p).isDirectory()) fs.readdirSync(p).forEach((f) => rmrf(path.join(p, f)));
    if (fs.lstatSync(p).isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
}
function dataDir(withPack) {
    const d = fs.mkdtempSync(path.join(stage, 'data-'));
    if (withPack) fs.writeFileSync(path.join(d, core.BMW_DATA_FILE), JSON.stringify(fakeDme.dataPack()));
    return d;
}

/**
 * ctx.signals with the TASU interface as the head unit offers it (kit/runtime/diag.js), answered by
 * `responder` (the fake DME's interface: request(target, uds, reply)). verdict: what sendTasuRequest
 * returns instead of taking the request. seen: every request that reached the transport.
 */
function tasuSignals(responder, verdict) {
    const listeners = [], seen = [];
    const signals = {
        proxy: async () => ({ iface: 'InternalTasu' }),
        on: async (p, ev, fn) => { listeners.push(fn); },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, method, a) => {
            const uds = Buffer.concat([Buffer.from([a.serviceID]), Buffer.from(a.udsData)]);
            seen.push({ target: a.targetAddress, uds });
            if (verdict) return verdict;
            responder.request(a.targetAddress, uds, (ecu, bytes) => setImmediate(() => listeners.forEach((fn) =>
                fn({ errorCode: 'NO_ERROR', udsResponse: Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0]), Buffer.from(bytes)]) }))));
            return 'NO_ERROR';
        },
    };
    return { signals, seen };
}

/** A Session on the stub, with what it reports collected. */
async function headUnit(responder, opts) {
    opts = opts || {};
    const bus = tasuSignals(responder, opts.verdict);
    const link = await new TasuLink(bus.signals, quiet).init();
    const session = core.createHeadUnitSession({ dataDir: opts.dataDir || dataDir(true), link, settings: () => opts.settings || {} });
    const got = { logs: [], batches: [], channels: [] };
    session.on('log', (m) => got.logs.push(m));
    session.on('batch', (b) => got.batches.push(b));
    session.on('channels', (c) => { got.channels = c; });
    return { session, link, bus, got };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('connects over TASU, identifies the DME and picks its data by the diagnostic index', async () => {
    const h = await headUnit(fakeDme(quiet));
    const s = await h.session.connect(core.HEAD_UNIT_CONNECTION);
    try {
        assert.strictEqual(s.state, 'live', s.error);
        assert.strictEqual(s.vin, 'WBAEMU000BL000001');
        assert.strictEqual(s.ecu.sgbdIndex, '0x0B0057');
        assert(/emu_dme/.test(s.ecu.dmeData), 'DME data: ' + s.ecu.dmeData);
        const ids = h.got.channels.map((c) => c.id);
        ['engine.rpm', 'boost.actual', 'boost.target', 'fuel.rail.actual', 'fuel.lambda.actual', 'ign.cyl6'].forEach((id) => assert(ids.indexOf(id) >= 0, id + ' missing'));
    } finally { await h.session.disconnect(); }
});

test('streams the DME channels as block reads of dynamically defined DIDs (2C 01)', async () => {
    const h = await headUnit(fakeDme(quiet));
    await h.session.connect(core.HEAD_UNIT_CONNECTION);
    try {
        await h.session.setStreamChannels(['engine.rpm', 'boost.actual', 'boost.target', 'fuel.rail.actual', 'ign.cyl1', 'temp.intake']);
        await later(1500);
        const defines = h.bus.seen.filter((r) => r.uds[0] === 0x2C && r.uds[1] === 0x01);
        const dynamicReads = h.bus.seen.filter((r) => r.uds[0] === 0x22 && r.uds[1] === 0xF3);
        assert(defines.length >= 1, 'no 2C 01 definitions');
        assert(dynamicReads.length >= 5, dynamicReads.length + ' reads of dynamic DIDs');
        const last = h.got.batches[h.got.batches.length - 1];
        assert(last, 'no samples');
        const row = last.rows[last.rows.length - 1], rpm = row[last.channelIds.indexOf('engine.rpm')];
        assert(rpm > 500 && rpm < 7500, 'rpm ' + rpm);
        const rate = h.session.status().sampleRateHz;
        assert(rate > 5, 'sample rate ' + rate);
    } finally { await h.session.disconnect(); }
    // stopping the stream clears its dynamic DIDs again (2C 03)
    assert(h.bus.seen.some((r) => r.uds[0] === 0x2C && r.uds[1] === 0x03), 'dynamic DIDs not cleared');
});

test('only read-only services reach the head unit\'s transport', async () => {
    const h = await headUnit(fakeDme(quiet));
    await h.session.connect(core.HEAD_UNIT_CONNECTION);
    try {
        await h.session.setStreamChannels(['engine.rpm', 'boost.actual', 'fuel.rail.actual']);
        await later(800);
        await h.session.startRecording();
        await later(300);
        await h.session.stopRecording();
    } finally { await h.session.disconnect(); }
    assert(h.bus.seen.length > 20);
    h.bus.seen.forEach((r) => assert(READ_ONLY.indexOf(r.uds[0]) >= 0, 'service ' + r.uds[0].toString(16) + ' sent'));
    h.bus.seen.filter((r) => r.uds[0] === 0x10).forEach((r) => assert([0x01, 0x03].indexOf(r.uds[1] & 0x7F) >= 0, 'session ' + r.uds[1]));
});

test('captures to a Boostline CSV in the app\'s Logs folder', async () => {
    const dir = dataDir(true);
    const h = await headUnit(fakeDme(quiet), { dataDir: dir });
    await h.session.connect(core.HEAD_UNIT_CONNECTION);
    let file;
    try {
        await h.session.setStreamChannels(['engine.rpm', 'boost.actual', 'boost.target']);
        const r = await h.session.startRecording();
        assert.strictEqual(path.dirname(r.file), path.join(dir, 'Logs'));
        await later(1000);
        file = await h.session.stopRecording();
    } finally { await h.session.disconnect(); }
    const text = fs.readFileSync(file, 'utf8').split('\n');
    assert(text.some((l) => l === '# vin=WBAEMU000BL000001'), 'vin line');
    assert(text.some((l) => /^# ids=.*engine\.rpm.*boost\.actual/.test(l)), 'ids line');
    const header = text.findIndex((l) => /^Time \[s\],/.test(l));
    assert(header > 0, 'header line');
    assert(text.slice(header + 1).filter((l) => /^\d/.test(l)).length > 5, 'rows');
    assert(core.folderBytes(path.join(dir, 'Logs')) > 0);
});

test('the channel picker: groups, ticks, the four the dyno needs, the limit, Defaults', async () => {
    const picker = require(path.join(stage, 'picker.js'));
    const { Recorder } = require(path.join(stage, 'kit', 'record.js'));
    const theme = require(path.join(stage, 'kit', 'themes.js')).theme('m_tricolour');
    const h = await headUnit(fakeDme(quiet));
    await h.session.connect(core.HEAD_UNIT_CONNECTION);
    const channels = new Map(h.got.channels.map((c) => [c.id, c]));
    await h.session.disconnect();
    // the pages' alternatives: the DME's value when there is one, else OBD-II's
    const entries = [['ign.avg', 'obd.timing_advance'], ['load.maf', 'obd.maf'], 'engine.rpm'];
    assert.deepStrictEqual(picker.defaultIds(entries, channels), ['ign.avg', 'load.maf', 'engine.rpm']);
    assert.deepStrictEqual(picker.defaultIds(entries, new Set(['obd.timing_advance', 'obd.maf', 'engine.rpm'])), ['obd.timing_advance', 'obd.maf', 'engine.rpm']);
    // required first, then the wanted the car offers
    assert.deepStrictEqual(picker.loggedIds(['boost.actual', 'nope'], channels, 70).slice(0, 5), ['engine.rpm', 'vehicle.speed', 'throttle.pedal', 'vehicle.gear', 'boost.actual']);

    let done = null;
    const sheetFor = (wanted, max) => picker.channelSheet({
        channels: () => channels, groups: core.GROUP_ORDER, wanted, isDefault: true, max,
        defaults: () => ['boost.actual', 'boost.target'], unit: (d) => d.unit, done: (c) => { done = c; },
    });
    const sh = sheetFor(['boost.actual'], 70);
    const r = new Recorder(1600, 520);
    assert(sh.draw(r, theme).length > 3, 'targets');
    const rows = sh.rows();
    assert(/Defaults/.test(rows[0].label));
    const knock = rows.findIndex((x) => x.label === 'Knock');
    assert(knock > 0 && rows[knock].value === '0 of 6', 'Knock group: ' + JSON.stringify(rows[knock]));
    assert(rows.some((x) => /BMW names/.test(x.label)), 'the DME group');
    // open Knock, tick cylinder 1
    sh.focus = knock; sh.press();
    assert(sh.open && sh.open.group === 'Knock');
    r.reset(); sh.draw(r, theme);
    sh.sub = 0; sh.press();
    assert(sh.rows()[0].on, 'knock cyl 1 ticked');
    assert(sh.chosen().indexOf('knock.signal.cyl1') >= 0);
    sh.press(); sh.press();
    assert(sh.chosen().indexOf('knock.signal.cyl1') >= 0, 'ticked twice more: on');
    // engine speed can't be unticked
    sh.back();
    sh.focus = sh.rows().findIndex((x) => x.label === 'Engine'); sh.press();
    sh.sub = sh.open.defs.findIndex((d) => d.id === 'engine.rpm'); sh.press();
    assert(sh.rows()[sh.sub].on && sh.rows()[sh.sub].value === 'always');
    sh.back();
    assert.strictEqual(sh.back(), 'close');
    sh.onClose();
    assert(done && !done.isDefault && done.ids.indexOf('knock.signal.cyl1') >= 0 && done.ids.indexOf('boost.actual') >= 0);
    // at the limit nothing more goes on; Defaults puts the pages' set back
    done = null;
    const full = sheetFor(['boost.actual'], 5);
    full.focus = full.rows().findIndex((x) => x.label === 'Boost'); full.press();
    full.sub = full.open.defs.findIndex((d) => d.id === 'boost.target'); full.press();
    assert(full.chosen().indexOf('boost.target') < 0, 'over the limit');
    full.back();
    full.focus = 0; full.press();
    assert.deepStrictEqual(full.chosen(), ['boost.actual', 'boost.target']);
    full.onClose();
    assert(done && done.isDefault);
    // nothing changed: nothing handed over
    done = null;
    const same = sheetFor(['boost.actual'], 70);
    same.onClose();
    assert.strictEqual(done, null);
});

test('picked channels are streamed and captured, the rest not; Session stops at MAX_STREAMED', async () => {
    const dir = dataDir(true);
    const h = await headUnit(fakeDme(quiet), { dataDir: dir });
    await h.session.connect(core.HEAD_UNIT_CONNECTION);
    let file;
    try {
        await h.session.setStreamChannels(['knock.signal.cyl1', 'dme.6a48', 'boost.actual']);
        await h.session.startRecording();
        await later(800);
        file = await h.session.stopRecording();
        const last = h.got.batches[h.got.batches.length - 1];
        assert.deepStrictEqual(last.channelIds.slice().sort(), ['boost.actual', 'dme.6a48', 'engine.rpm', 'knock.signal.cyl1', 'throttle.pedal', 'vehicle.gear', 'vehicle.speed']);
        const row = last.rows[last.rows.length - 1], knock = row[last.channelIds.indexOf('knock.signal.cyl1')];
        assert(knock >= 0.3 && knock < 2.5, 'knock signal ' + knock);
        // everything the car offers: Session streams the first MAX_STREAMED
        const all = h.got.channels.map((c) => c.id);
        assert(all.length > core.MAX_STREAMED, all.length + ' channels offered');
        await h.session.setStreamChannels(all);
        h.got.batches = [];
        await later(800);
        const b = h.got.batches[h.got.batches.length - 1];
        assert(b, 'no samples');
        assert.strictEqual(b.channelIds.length, core.MAX_STREAMED);
    } finally { await h.session.disconnect(); }
    const ids = fs.readFileSync(file, 'utf8').split('\n').find((l) => /^# ids=/.test(l));
    assert(/knock\.signal\.cyl1/.test(ids) && /dme\.6a48/.test(ids), ids);
    assert(!/boost\.target/.test(ids), 'boost.target was not picked: ' + ids);
});

test('without BMW DME data: the standard OBD-II channels, read plainly', async () => {
    const h = await headUnit(fakeDme(quiet), { dataDir: dataDir(false) });
    const s = await h.session.connect(core.HEAD_UNIT_CONNECTION);
    try {
        assert.strictEqual(s.state, 'live', s.error);
        assert.strictEqual(s.ecu.dmeData, undefined);
        const ids = h.got.channels.map((c) => c.id);
        ['engine.rpm', 'boost.actual', 'vehicle.gear', 'fuel.lambda.actual'].forEach((id) => assert(ids.indexOf(id) >= 0, id + ' missing'));
        await h.session.setStreamChannels(['engine.rpm', 'boost.actual']);
        await later(700);
        assert(h.got.batches.length > 0, 'no samples');
        assert(h.bus.seen.some((r) => r.uds[0] === 0x22 && r.uds[1] === 0xF4 && r.uds[2] === 0x0C), 'no OBD rpm read');
    } finally { await h.session.disconnect(); }
});

test('a DME that doesn\'t answer: a clear error, nothing streamed', async () => {
    const silent = { request() {} };
    const h = await headUnit(silent);
    const s = await h.session.connect(core.HEAD_UNIT_CONNECTION);
    await h.session.disconnect();
    assert.strictEqual(s.state, 'error');
    assert(/does not respond/.test(s.error), s.error);
});

test('the transport refusing requests: the same error, and the log says why', async () => {
    const h = await headUnit(fakeDme(quiet), { verdict: 'APP_REQUEST_NOT_ACCEPTED' });
    const s = await h.session.connect(core.HEAD_UNIT_CONNECTION);
    await h.session.disconnect();
    assert.strictEqual(s.state, 'error');
    assert(/does not respond/.test(s.error), s.error);
    assert(h.got.logs.some((l) => /refused the request: transport refused: APP_REQUEST_NOT_ACCEPTED/.test(l)), h.got.logs.join('\n'));
});

/**
 * Boostline's simulated drive cycle (idle, launch to ~190 km/h, cruise, a 4th-gear pull to the limiter,
 * stop) at `hz`, faster than real time: fn(t, snapshot) per sample until it returns true or `seconds` pass.
 */
function driveCycle(hz, seconds, fn) {
    const engine = new fakeDme.SimEngine();
    for (let i = 0; i * (1 / hz) < seconds; i++) {
        engine.step(1 / hz);
        if (fn(i / hz, engine.snapshot())) return true;
    }
    return false;
}

test('the dyno captures the drive cycle\'s 4th-gear pull and saves it as the desktop does', () => {
    const { DynoRuns } = require(path.join(stage, 'runs.js'));
    const dir = path.join(dataDir(false), 'Dyno');
    const dyno = new DynoRuns(core, dir);
    assert.strictEqual(dyno.state, 'idle');
    let run = null, fast = false;
    // 30 samples a second, about what the emulator streams. Armed once the launch is over (the car slowing
    // from its top speed), as a driver arms before the pull: armed at a stop, the launch in 1st would be the pull.
    driveCycle(30, 180, (t, s) => {
        if (s['vehicle.speed'] > 150) fast = true;
        if (!dyno.armed && fast && s['throttle.pedal'] < 10) dyno.arm(Object.assign({}, core.DEFAULT_DYNO_SETUP, { massKg: 1835 }));
        run = dyno.push(t, s['engine.rpm'], s['vehicle.speed'], s['throttle.pedal'], s['vehicle.gear'], 'WBAEMU000BL000001');
        return !!run;
    });
    assert(run, 'no pull captured');
    assert.strictEqual(dyno.state, 'done');
    assert.strictEqual(run.result.gear, 4);
    // the simulator's B58: about 630 Nm, so a peak of roughly 300-360 kW at the crank
    assert(run.result.peakEngine.kw > 250 && run.result.peakEngine.kw < 420, 'peak ' + run.result.peakEngine.kw.toFixed(0) + ' kW');
    assert(run.result.peakTorque.nm > 450 && run.result.peakTorque.nm < 750, 'torque ' + run.result.peakTorque.nm.toFixed(0) + ' Nm');
    // saved as SavedDynoRun, <id>.json, with the raw samples (the desktop re-analyses from them)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, run.id + '.json'), 'utf8'));
    assert.strictEqual(saved.vin, 'WBAEMU000BL000001');
    assert(Array.isArray(saved.input.rpm) && saved.input.rpm.length === saved.input.t.length && saved.input.t.length > 50);
    // another setup analyses the run again: more mass, more power
    const before = dyno.result.peakEngine.kw;
    dyno.setSetup(Object.assign({}, core.DEFAULT_DYNO_SETUP, { massKg: 2100 }));
    assert(dyno.result.peakEngine.kw > before * 1.05, dyno.result.peakEngine.kw + ' vs ' + before);
    // and a new DynoRuns lists it
    assert.strictEqual(new DynoRuns(core, dir).runs[0].id, run.id);
});

test('the drag timer times the drive cycle\'s launch: 0-100 km/h and the 1/8 mile', () => {
    const { DragRuns } = require(path.join(stage, 'runs.js'));
    const dir = path.join(dataDir(false), 'Drag');
    ['0-100', '201m'].forEach((mode) => {
        const drag = new DragRuns(core, dir);
        drag.arm(mode, { calibration: [], environment: { altitudeM: 0, ambientTempC: 20, humidityPct: 50 } });
        let run = null;
        driveCycle(30, 120, (t, s) => { run = drag.push(t, s['vehicle.speed'], s['vehicle.gear'], s['engine.rpm']); return !!run; });
        assert(run, mode + ': no run');
        assert(run.result.finished, mode + ': ' + run.result.warnings.join('; '));
        const time = run.result.finalTime;
        if (mode === '0-100') {
            assert(time > 3 && time < 7, '0-100 in ' + time);
            assert(run.result.splits.length >= 8, 'splits');
            assert(run.result.gearChanges.some((g) => g.from === 1 && g.to === 2), 'no 1-2 shift');
        } else assert(time > 6 && time < 14, '1/8 mile in ' + time);
        assert(fs.existsSync(path.join(dir, run.id + '.json')), 'not saved');
    });
    const drag = new DragRuns(core, dir);
    assert.strictEqual(drag.runs.length, 2);
    assert(drag.best('0-100') > 3);
});

test('a drag run with a speedometer correction times on the corrected speed', () => {
    const { DragRuns } = require(path.join(stage, 'runs.js'));
    const times = [0, 5].map((pct) => {
        const drag = new DragRuns(core, path.join(dataDir(false), 'Drag'));
        drag.arm('0-100', { calibration: pct ? [{ ecu: 100, gps: 100 * (1 + pct / 100) }] : [] });
        let run = null;
        driveCycle(30, 120, (t, s) => { run = drag.push(t, s['vehicle.speed']); return !!run; });
        return run.result.finalTime;
    });
    // 5 % faster than the car says: 100 km/h true comes before the car shows 100
    assert(times[1] < times[0], times.join(' vs '));
});

test('the app\'s own code compiles on this Node', () => {
    const vm = require('vm');
    fs.readdirSync(path.join(ROOT, 'app')).filter((f) => f.endsWith('.js')).forEach((f) => {
        const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
        try { new vm.Script('(function (exports, require, module, __filename, __dirname) {' + src + '\n})', { filename: f }); } catch (e) { throw new Error(f + ': ' + e.message); }
    });
});

(async () => {
    let failed = 0;
    console.log('Node ' + process.version + ', Boostline ' + core.BOOSTLINE_VERSION + ' core');
    for (const t of tests) {
        try { await t.fn(); console.log('  ok   ' + t.name); } catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + String(e && e.stack || e).split('\n').join('\n       ')); }
    }
    rmrf(stage);
    console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
