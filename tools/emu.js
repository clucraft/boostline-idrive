'use strict';
/**
 * The live emulator with a DME behind the head unit (no car, no BMW SDK):
 *
 *   node tools/emu.js [--port 8077] [--no-touch] [--obd-only]   ->  http://localhost:8077
 *
 * Runs the kit's emulator (vendor/idrive7-apps kit/tools/emu.js) on the app, with emu/fakeDme.ts
 * answering its diagnostic requests (--diag), and tools/bundle.js --watch beside it: a save in
 * core/, vendor/boostline or app/ rebuilds the bundle, and the emulator rebuilds and restarts the app.
 *
 * The fake DME's data pack (invented DIDs) goes into the emulator's data folder as the app's
 * bmw-dme-data.json, so the BMW-data path (curated channels, 2C 01 block reads) runs as with real
 * imported data. --obd-only removes it: the app then reads the standard OBD-II channels only.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setup, ROOT, KIT } = require('./setup');

const args = process.argv.slice(2);
const obdOnly = args.indexOf('--obd-only') >= 0;
const pass = args.filter((a) => a !== '--obd-only');

setup();

// the emulator keeps each app's settings and files in preview/emu/<id>/ (its ctx.dataDir)
const dataDir = path.join(KIT, 'preview', 'emu', 'boostline');
fs.mkdirSync(dataDir, { recursive: true });
const pack = path.join(dataDir, 'bmw-dme-data.json');
if (obdOnly) {
    fs.rmSync(pack, { force: true });
} else {
    // (a fresh copy each start: it must match build/fake-dme.js)
    delete require.cache[require.resolve(path.join(ROOT, 'build', 'fake-dme.js'))];
    fs.writeFileSync(pack, JSON.stringify(require(path.join(ROOT, 'build', 'fake-dme.js')).dataPack(), null, 1));
}
console.log('emu: app data (logs, settings) in ' + path.relative(ROOT, dataDir) + (obdOnly ? ' - OBD-II only' : ''));

const children = [
    spawn(process.execPath, [path.join(__dirname, 'bundle.js'), '--watch'], { cwd: ROOT, stdio: 'inherit' }),
    spawn(process.execPath, [path.join(KIT, 'kit', 'tools', 'emu.js'), 'boostline', '--diag', path.join(ROOT, 'build', 'fake-dme.js')].concat(pass), { cwd: KIT, stdio: 'inherit' }),
];
const stop = (code) => { children.forEach((c) => { try { c.kill(); } catch (e) { /* gone */ } }); process.exit(code || 0); };
children.forEach((c) => c.on('exit', (code) => stop(code)));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
