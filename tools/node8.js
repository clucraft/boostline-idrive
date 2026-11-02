'use strict';
/**
 * Runs a script on Node 8, the Node.js the head unit runs its apps on, so old-Node problems show
 * up here rather than in the car:
 *
 *   node tools/node8.js test/run.js
 *
 * The first run downloads Node v8.17.0 (the last 8.x) for this computer from nodejs.org into
 * .cache/, checked against the release's SHASUMS256.txt.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = 'v8.17.0';
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const DIST = 'https://nodejs.org/dist/' + VERSION + '/';

const PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform];
if (!PLATFORM) { console.error('node8: no Node 8 build for ' + process.platform); process.exit(1); }
// (Node 8 has no arm64 build for macOS: the x64 one runs under Rosetta)
const ARCH = process.arch === 'arm64' && PLATFORM === 'linux' ? 'arm64' : 'x64';
const NAME = 'node-' + VERSION + '-' + PLATFORM + '-' + ARCH;
const ARCHIVE = NAME + (PLATFORM === 'win' ? '.zip' : '.tar.gz');
const BIN = path.join(CACHE, NAME, PLATFORM === 'win' ? 'node.exe' : path.join('bin', 'node'));

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ': HTTP ' + res.statusCode)); return; }
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => resolve(Buffer.concat(parts)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function install() {
    if (fs.existsSync(BIN)) return;
    console.log('node8: downloading ' + DIST + ARCHIVE);
    const [sums, archive] = await Promise.all([get(DIST + 'SHASUMS256.txt'), get(DIST + ARCHIVE)]);
    const line = sums.toString('utf8').split('\n').find((l) => l.trim().endsWith('  ' + ARCHIVE));
    if (!line) throw new Error(ARCHIVE + ' is not in SHASUMS256.txt');
    const want = line.split(/\s+/)[0], got = crypto.createHash('sha256').update(archive).digest('hex');
    if (want !== got) throw new Error(ARCHIVE + ': SHA-256 ' + got + ', expected ' + want);
    fs.mkdirSync(CACHE, { recursive: true });
    const file = path.join(CACHE, ARCHIVE);
    fs.writeFileSync(file, archive);
    // Windows 10+ has bsdtar, which unpacks zip (another tar on the PATH may not)
    const tar = PLATFORM === 'win' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-xf', file, '-C', CACHE], { stdio: 'inherit' });
    fs.unlinkSync(file);
    if (r.status !== 0 || !fs.existsSync(BIN)) throw new Error('could not unpack ' + ARCHIVE);
}

install().then(() => {
    const r = spawnSync(BIN, process.argv.slice(2), { cwd: ROOT, stdio: 'inherit' });
    process.exit(r.status === null ? 1 : r.status);
}).catch((e) => { console.error('node8: ' + e.message); process.exit(1); });
