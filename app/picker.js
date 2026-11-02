'use strict';
/**
 * Which of the car's channels Boostline streams, and so what a capture logs.
 *
 *   defaultIds(entries, offered)   the pages' channels on this car: an entry is an id, or a list of
 *                                  alternatives of which the first the car offers counts (the DME's
 *                                  value, else the standard OBD-II one)
 *   loggedIds(wanted, offered)     what Session actually streams: the dyno's and drag timer's channels
 *                                  first, then the wanted ones the car offers, at most MAX of them
 *   channelSheet(opts)             the picker: a sheet (kit/sheet.js) the kit draws over the page,
 *                                  driven by touch and the iDrive controller. The car's channel
 *                                  groups, then a group's channels to tick; Defaults puts the pages'
 *                                  set back. What changed is handed over when the sheet closes.
 *
 * Runs on the head unit's Node 8: plain ES2017.
 */
const { list, pill, TOP } = require('./kit/sheet');

/** Session streams these whatever is chosen (the dyno and the drag timer need them). */
const REQUIRED = ['engine.rpm', 'vehicle.speed', 'throttle.pedal', 'vehicle.gear'];
const W = 1600;
/** Group names that need saying what they are. */
const GROUP_LABELS = { DME: 'Other DME values (BMW names)', Custom: 'Your definition files' };

const has = (offered, id) => (offered && typeof offered.has === 'function' ? offered.has(id) : false);

function defaultIds(entries, offered) {
    const out = [];
    entries.forEach((e) => {
        const alts = Array.isArray(e) ? e : [e];
        const id = alts.find((a) => has(offered, a)) || alts[0];
        if (out.indexOf(id) < 0) out.push(id);
    });
    return out;
}

/** As Session's resolveIds: the required ones, then the wanted, those offered, the first max. */
function loggedIds(wanted, offered, max) {
    const out = [];
    REQUIRED.concat(wanted).forEach((id) => { if (has(offered, id) && out.indexOf(id) < 0) out.push(id); });
    return out.slice(0, max);
}

/**
 * opts: {
 *   channels()      the car's channels: Map id -> ChannelDef (registry order)
 *   groups          group order (Boostline's GROUP_ORDER)
 *   wanted          the ids streamed now (a custom list keeps ids this car doesn't offer)
 *   isDefault       wanted is the pages' set (not the user's own)
 *   defaults()      the pages' set on this car
 *   max             the most Session streams
 *   unit(def)       the unit shown beside a channel (display units)
 *   done({ ids, isDefault })   on close, when the choice changed
 * }
 */
function channelSheet(opts) {
    const chosen = new Set(opts.wanted);
    let isDefault = !!opts.isDefault, changed = false;
    let note = '', noteUntil = 0;
    const say = (s) => { note = s; noteUntil = Date.now() + 4000; };
    const all = () => opts.channels();
    const logged = () => loggedIds(Array.from(chosen), all(), Infinity);

    /** [{ group, label, defs }] of the groups this car has channels in, in Boostline's order */
    function groups() {
        const by = new Map();
        all().forEach((def) => {
            const g = def.group || 'Custom';
            if (!by.has(g)) by.set(g, []);
            by.get(g).push(def);
        });
        const order = opts.groups.filter((g) => by.has(g)).concat(Array.from(by.keys()).filter((g) => opts.groups.indexOf(g) < 0));
        return order.map((g) => {
            const defs = by.get(g);
            // the DME's own list is long and by DID: by name reads better
            if (g === 'DME') defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            return { group: g, label: GROUP_LABELS[g] || g, defs };
        });
    }
    const isOn = (id) => REQUIRED.indexOf(id) >= 0 || chosen.has(id);

    function toggle(def) {
        if (REQUIRED.indexOf(def.id) >= 0) { say('Always logged: the dyno and the drag timer need it'); return; }
        if (chosen.has(def.id)) chosen.delete(def.id);
        else if (logged().length >= opts.max) { say('At most ' + opts.max + ' channels: untick one first'); return; }
        else chosen.add(def.id);
        isDefault = false;
        changed = true;
    }
    function reset() {
        chosen.clear();
        opts.defaults().forEach((id) => chosen.add(id));
        isDefault = true;
        changed = true;
        say('Back to the channels the pages show');
    }

    const sh = {
        title: 'Channels',
        focus: 0, open: null, sub: 0,       // open: the group whose channels are listed
        controller: false,                  // the controller was used: show where it is
        rows() {
            if (this.open) {
                return this.open.defs.map((d) => ({
                    label: d.name, kind: 'toggle', on: isOn(d.id),
                    value: REQUIRED.indexOf(d.id) >= 0 ? 'always' : opts.unit(d) || null,
                }));
            }
            const head = { label: 'Defaults: the channels the pages show', value: opts.defaults().filter((id) => all().has(id)).length + ' channels' };
            return [head].concat(groups().map((g) => ({
                label: g.label, kind: 'more', value: g.defs.filter((d) => isOn(d.id)).length + ' of ' + g.defs.length,
            })));
        },
        draw(r, t) {
            r.clear(t.bg);
            const rows = this.rows(), n = logged().length;
            const msg = Date.now() < noteUntil ? note : '';
            if (this.open) {
                r.text(this.open.label, 44, TOP + 40, 32, t.text, { font: 'bold' });
                const tw = r.textWidth(this.open.label, 32, { font: 'bold' });
                r.text(msg || n + ' of at most ' + opts.max + ' logged', 44 + tw + 24, TOP + 38, 22, msg ? t.warn : t.dim);
            } else {
                r.text(msg || 'Logging ' + n + ' of at most ' + opts.max + ' channels. Fewer channels, more samples per second.', 44, TOP + 38, 24, msg ? t.warn : t.dim);
            }
            const targets = [];
            // Back (a group) / Done: top right; the controller reaches it turning up from the first row
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Done', this.controller && (this.open ? this.sub : this.focus) === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            const rects = list(r, t, this.key(), rows, this.open ? this.sub : this.focus, TOP + 74, this.controller);
            rects.forEach((q) => targets.push(Object.assign(q, { act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.choose(); } })));
            return targets;
        },
        key() { return this.open ? 'ch_' + this.open.group : 'ch_groups'; },
        top() { return (this.open ? this.sub : this.focus) === -1; },
        scroll(dy) {
            const st = list.scroll[this.key()];
            if (st) { st.y += dy; st.drag = true; }
        },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            if ((this.open ? this.sub : this.focus) === -1) {
                const res = this.back();
                if (this.open === null) this.focus = Math.max(0, this.focus);
                return res;
            }
            return this.choose();
        },
        choose() {
            if (this.open) {
                const d = this.open.defs[this.sub];
                if (d) toggle(d);
                return null;
            }
            if (this.focus === 0) { reset(); return null; }
            const g = groups()[this.focus - 1];
            if (g) { this.open = g; this.sub = 0; }
            return null;
        },
        back() {
            if (this.open) { this.open = null; return null; }
            return 'close';
        },
        onClose() { if (changed) opts.done({ ids: Array.from(chosen), isDefault }); },
        /** (tests) what is chosen now */
        chosen() { return Array.from(chosen); },
    };
    return sh;
}

module.exports = { REQUIRED, defaultIds, loggedIds, channelSheet };
