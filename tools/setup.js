'use strict';
/**
 * Gets a checkout ready to build and emulate (safe to run again):
 *
 *   1. the submodules (vendor/boostline, vendor/idrive7-apps) at their pinned commits
 *   2. patches/idrive7-apps/*.patch applied to the kit (the emulator on Windows, its diagnostics hook)
 *   3. app/ linked into the kit as apps/boostline (a junction on Windows), where its build and
 *      emulator look for apps
 *   4. an SDK placeholder in vendor/idrive7-apps/oap-sdk when there is no SDK: build.py stages every
 *      app with BMW's SDK, which isn't in git; the emulator never loads it. Car builds refuse the
 *      placeholder (tools/build-car.js): extract the real SDK from your own head unit
 *   5. the bundles (tools/bundle.js)
 *
 *   node tools/setup.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KIT = path.join(ROOT, 'vendor', 'idrive7-apps');
const APP_LINK = path.join(KIT, 'apps', 'boostline');
const SDK = path.join(KIT, 'oap-sdk');
const PLACEHOLDER_VERSION = '0.0.0-emulator-placeholder';

const git = (args, cwd) => execFileSync('git', args, { cwd: cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const step = (s) => console.log('setup: ' + s);

function submodules() {
    if (fs.existsSync(path.join(KIT, 'kit', 'tools', 'emu.js')) && fs.existsSync(path.join(ROOT, 'vendor', 'boostline', 'src'))) return;
    step('fetching the submodules');
    execFileSync('git', ['submodule', 'update', '--init'], { cwd: ROOT, stdio: 'inherit' });
}

function patches() {
    const dir = path.join(ROOT, 'patches', 'idrive7-apps');
    for (const p of fs.readdirSync(dir).filter((f) => f.endsWith('.patch')).sort()) {
        const file = path.join(dir, p);
        try {
            git(['apply', '--reverse', '--check', file], KIT);
            continue;                                    // already applied
        } catch (e) { /* not applied yet */ }
        try {
            git(['apply', '--check', file], KIT);
        } catch (e) {
            throw new Error(p + ' does not apply to vendor/idrive7-apps (another kit commit?):\n' + String(e.stderr || e.message));
        }
        git(['apply', file], KIT);
        step('applied ' + p);
    }
}

function linkApp() {
    const target = path.join(ROOT, 'app');
    let st = null;
    try { st = fs.lstatSync(APP_LINK); } catch (e) { /* none */ }
    if (st) {
        if (st.isSymbolicLink() && path.resolve(path.dirname(APP_LINK), fs.readlinkSync(APP_LINK)) === target) return;
        throw new Error(path.relative(ROOT, APP_LINK) + ' exists and is not a link to app/: move it away and run setup again');
    }
    fs.symlinkSync(target, APP_LINK, process.platform === 'win32' ? 'junction' : 'dir');
    // keep the kit's own status clean
    const exclude = path.resolve(KIT, git(['rev-parse', '--git-path', 'info/exclude'], KIT));
    const have = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (have.indexOf('/apps/boostline') < 0) fs.appendFileSync(exclude, (have && !have.endsWith('\n') ? '\n' : '') + '/apps/boostline\n');
    step('linked app/ as vendor/idrive7-apps/apps/boostline');
}

function sdkPlaceholder() {
    if (fs.existsSync(path.join(SDK, 'index.js'))) return;
    fs.mkdirSync(SDK, { recursive: true });
    fs.writeFileSync(path.join(SDK, 'package.json'), JSON.stringify({
        name: 'oap-sdk', version: PLACEHOLDER_VERSION,
        description: "NOT BMW's SDK: an empty stand-in so build.py can stage apps for the emulator. Car builds need the real SDK from your own head unit (kit/tools/extract_sdk.js).",
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(SDK, 'index.js'), "'use strict';\n// NOT BMW's SDK: an empty stand-in so build.py can stage apps for the emulator (hu-stub.js never loads it).\n" +
        "throw new Error('oap-sdk emulator placeholder: extract the real SDK from your own head unit (kit/tools/extract_sdk.js)');\n");
    step('no SDK found: wrote the emulator placeholder (vendor/idrive7-apps/oap-sdk)');
}

/** true when vendor/idrive7-apps/oap-sdk is the placeholder (or missing). */
function sdkIsPlaceholder() {
    try { return JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8')).version === PLACEHOLDER_VERSION; } catch (e) { return true; }
}

function setup() {
    submodules();
    patches();
    linkApp();
    sdkPlaceholder();
    execFileSync(process.execPath, [path.join(__dirname, 'bundle.js')], { cwd: ROOT, stdio: 'inherit' });
}

module.exports = { setup, sdkIsPlaceholder, ROOT, KIT };

if (require.main === module) {
    try { setup(); step('ready'); } catch (e) { console.error('setup: ' + e.message); process.exit(1); }
}
