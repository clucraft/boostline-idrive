'use strict';
/**
 * runs.js - Boostline's road dyno and drag timer on the head unit: arming, the live detectors and the
 * saved runs, on Boostline's own analysis (boostline-core.js: DynoDetector / analyzeDyno, DragDetector /
 * analyzeDrag), driven the way the desktop app's Dyno and Drag pages drive them.
 *
 *   const dyno = new DynoRuns(core, path.join(dataDir, 'Dyno'));
 *   dyno.arm(setup);                         // then for every sample of the stream:
 *   dyno.push(t, rpm, speedKmh, pedalPct, gear, vin);
 *   dyno.state                               // 'idle' | 'armed' | 'recording' | 'done'
 *   dyno.current, dyno.result                // the run shown, and its analysis with the current setup
 *
 * Runs are saved as the desktop app saves them (<data>/Dyno/<id>.json, <data>/Drag/<id>.json:
 * SavedDynoRun / SavedDragRun), so these folders can be copied into the desktop app's data folder.
 * Runs on the head unit's Node 8: plain ES2017.
 */
const fs = require('fs');
const path = require('path');

/** Saved runs kept in memory for the pages (newest first); the files stay. */
const LISTED = 30;

const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-02 11:36", as the desktop names runs */
function stamp(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const safeId = (id) => String(id).replace(/[^\w.-]+/g, '_');

/** One folder of saved runs (JSON files named by run id). */
class RunStore {
    constructor(dir) { this.dir = dir; }

    save(run) {
        mkdirs(this.dir);
        const file = path.join(this.dir, safeId(run.id) + '.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(run));
        fs.renameSync(file + '.tmp', file);
        return file;
    }

    /** Saved runs, newest first (files that aren't runs are skipped). */
    list() {
        let names = [];
        try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch (e) { return []; }
        const runs = [];
        names.forEach((n) => {
            try {
                const run = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
                if (run && run.id && run.result) runs.push(run);
            } catch (e) { /* not a run */ }
        });
        return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, LISTED);
    }
}

function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

const toArrays = (input) => ({
    t: Array.from(input.t), rpm: Array.from(input.rpm), speedKmh: Array.from(input.speedKmh),
    pedalPct: input.pedalPct ? Array.from(input.pedalPct) : undefined, gear: input.gear ? Array.from(input.gear) : undefined,
});
const fromArrays = (a) => ({
    t: Float64Array.from(a.t), rpm: Float64Array.from(a.rpm), speedKmh: Float64Array.from(a.speedKmh),
    pedalPct: a.pedalPct ? Float64Array.from(a.pedalPct) : undefined, gear: a.gear ? Float64Array.from(a.gear) : undefined,
});
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);

/**
 * The road dyno: armed, it waits for a full-throttle pull in one gear from about setup.startRpm,
 * records it to setup.endRpm (or the lift / shift), then analyses and saves it.
 */
class DynoRuns {
    constructor(core, dir) {
        this.core = core;
        this.store = new RunStore(dir);
        this.runs = this.store.list();
        this.state = 'idle';
        this.detector = null;
        this.setup = Object.assign({}, core.DEFAULT_DYNO_SETUP);
        this.current = this.runs[0] || null;
        this.result = this.current ? this.current.result : null;
    }

    get armed() { return this.state === 'armed' || this.state === 'recording'; }

    arm(setup) {
        this.setup = setup;
        this.detector = new this.core.DynoDetector(setup);
        this.state = 'armed';
    }

    disarm() { this.detector = null; this.state = this.current ? 'done' : 'idle'; }

    /** The setup changed (mass, loss, ...): the run shown is analysed again with it, as on the desktop. */
    setSetup(setup) {
        this.setup = setup;
        if (this.current) {
            try { this.result = this.core.analyzeDyno(fromArrays(this.current.input), setup); } catch (e) { this.result = this.current.result; }
        }
    }

    /** One sample of the stream; returns the run when this sample finished one. */
    push(t, rpm, speedKmh, pedalPct, gear, vin) {
        if (!this.detector || !isFinite(rpm) || !isFinite(speedKmh) || !isFinite(pedalPct)) return null;
        const s = this.detector.push(t, rpm, speedKmh, pedalPct, num(gear));
        if (s === 'recording') this.state = 'recording';
        else if (s === 'armed') this.state = 'armed';
        if (s !== 'done') return null;
        const input = this.detector.input();
        this.detector = null;
        const result = this.core.analyzeDyno(input, this.setup);
        const run = {
            id: uid(), name: 'Run ' + stamp() + (result.gear ? ' · gear ' + result.gear : ''), createdAt: new Date().toISOString(),
            vin: vin || undefined, result, input: toArrays(input),
        };
        this.store.save(run);
        this.runs.unshift(run);
        this.runs = this.runs.slice(0, LISTED);
        this.current = run;
        this.result = result;
        this.state = 'done';
        return run;
    }

    /** The saved run before the one shown (for the overlay), or null. */
    previous() {
        const i = this.current ? this.runs.indexOf(this.current) : -1;
        return i >= 0 && i + 1 < this.runs.length ? this.runs[i + 1] : null;
    }
}

/**
 * The drag timer: armed, a standing mode waits for the car to stop, then times from the first
 * movement; a rolling mode starts when the start speed is crossed. Finished runs are saved; an
 * aborted one is shown, not saved (as on the desktop).
 */
class DragRuns {
    constructor(core, dir) {
        this.core = core;
        this.store = new RunStore(dir);
        this.runs = this.store.list();
        this.state = 'idle';
        this.detector = null;
        this.mode = null;
        this.opts = {};
        this.current = this.runs[0] || null;
    }

    get armed() { return this.state === 'waiting-stop' || this.state === 'ready' || this.state === 'running'; }
    get result() { return this.current ? this.current.result : null; }

    arm(mode, opts) {
        this.mode = mode;
        this.opts = opts || {};
        this.detector = new this.core.DragDetector(mode, this.opts);
        this.state = this.detector.state;
    }

    disarm() { this.detector = null; this.state = 'idle'; }

    /** One sample of the stream; returns the run when this sample ended one (finished or aborted). */
    push(t, speedKmh, gear, rpm, vin) {
        if (!this.detector || !isFinite(speedKmh)) return null;
        const s = this.detector.push(t, speedKmh, num(gear), num(rpm));
        this.state = s;
        if (s !== 'finished' && s !== 'aborted') return null;
        const result = this.core.analyzeDrag(this.detector.input(), this.mode, this.opts);
        this.detector = null;
        const run = {
            id: uid(),
            name: modeName(this.mode) + ' · ' + (result.finalTime !== null ? result.finalTime.toFixed(3) + ' s' : 'unfinished') + ' · ' + stamp(),
            createdAt: new Date().toISOString(), vin: vin || undefined, result,
        };
        if (result.finished) {
            this.store.save(run);
            this.runs.unshift(run);
            this.runs = this.runs.slice(0, LISTED);
        }
        this.current = run;
        return run;
    }

    /** The best finished time saved for a mode, or null. */
    best(mode) {
        return this.runs.reduce((b, r) => (r.result.mode === mode && r.result.finished && (b === null || r.result.finalTime < b) ? r.result.finalTime : b), null);
    }
}

/** Drag modes as the desktop app labels them. */
const MODE_NAMES = {
    '0-100': '0-100 km/h', '100-200': '100-200 km/h', '200-300': '200-300 km/h', '0-60mph': '0-60 mph',
    '60-130mph': '60-130 mph', '201m': '1/8 mile', '402m': '1/4 mile',
};
const modeName = (m) => MODE_NAMES[m] || m;

module.exports = { DynoRuns, DragRuns, RunStore, modeName, MODE_NAMES, stamp };
