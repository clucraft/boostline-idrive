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
fs.copyFileSync(path.join(ROOT, 'vendor', 'idrive7-apps', 'kit', 'runtime', 'diag.js'), path.join(stage, 'kit', 'diag.js'));

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
