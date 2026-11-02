'use strict';
/**
 * The package for a car: dist/boostline@<version>.mgu, for the kit's installer
 * (vendor/idrive7-apps deploy/make-car-kit.sh, push-to-car.sh / .ps1).
 *
 *   node tools/build-car.js
 *
 * Needs BMW's SDK extracted from your own head unit in vendor/idrive7-apps/oap-sdk
 * (vendor/idrive7-apps/kit/tools/extract_sdk.js): the emulator's placeholder is refused.
 * The .mgu contains BMW's SDK: keep it for your own car and never publish it.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { setup, sdkIsPlaceholder, ROOT, KIT } = require('./setup');

setup();
if (sdkIsPlaceholder()) {
    console.error('build-car: vendor/idrive7-apps/oap-sdk is the emulator placeholder, not BMW\'s SDK.\n' +
        'Extract the SDK from your own head unit first (vendor/idrive7-apps README, "Get the SDK from your unit").');
    process.exit(1);
}
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
execFileSync(python, [path.join(KIT, 'kit', 'tools', 'build.py'), 'boostline'], { cwd: KIT, stdio: 'inherit' });
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'app.json'), 'utf8')).version;
const name = 'boostline@' + version + '.mgu';
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.copyFileSync(path.join(KIT, 'dist', name), path.join(ROOT, 'dist', name));
console.log('build-car: dist/' + name + ' (contains BMW\'s SDK: for your own car only, never publish it)');
