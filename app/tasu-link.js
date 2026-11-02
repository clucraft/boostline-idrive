'use strict';
/**
 * tasu-link.js - UDS over the head unit's diagnostic transport (TASU) for Boostline's core
 * (boostline-core.js: the TasuLink its HsfzConnection sends through, core/hsfzOverTasu.ts).
 *
 * Built on the kit's Diag (kit/runtime/diag.js), as M Vitals and the Fault Scanner use it. Boostline
 * checks every request against its read-only allowlist before it gets here (uds.ts).
 *
 *   const link = await new TasuLink(ctx.signals, log).init();
 *   link.request(0x12, Buffer.from([0x22, 0xF1, 0x90]), { timeoutMs, pendingTimeoutMs, expectResponse, accept })
 *     -> the ECU's reply (Buffer), null when it gave none in time; rejects when the transport refused it
 */
const { Diag } = require('./kit/diag');

const ACCEPTED = /^(NO_ERROR|REQUEST_PENDING|0|1)$/;

class TasuLink {
    constructor(signals, log) {
        this.diag = new Diag(signals, log);
        this.diag.quiet = true;           // polling: requests aren't logged one by one
        // the transport is busy now and then (other apps and BMW's own services use it too): try again
        // soon (50, 100, 150, 200 ms) instead of after seconds, and count it rather than log each one
        this.diag.busyMs = 50;
        this.diag.busyLog = false;
        this.stats = { sent: 0, replies: 0, missed: 0 };
    }

    async init() { await this.diag.init(); return this; }
    get ready() { return !!this.diag.p; }
    get error() { return this.diag.error; }
    /** how often the transport said busy so far */
    get busy() { return this.diag.busy; }

    async request(target, uds, opts) {
        const sid = uds[0], data = Array.prototype.slice.call(uds, 1);
        this.stats.sent++;
        if (!opts.expectResponse) {
            const verdict = await this.diag.send(target, sid, data);
            if (!ACCEPTED.test(verdict)) throw new Error('transport refused: ' + verdict);
            return null;
        }
        // every app gets every frame from the ECU: only a reply to this service is ours (and, for a
        // positive one, only if Boostline's own check - the echoed DID - says so)
        const accept = (u) => (u[0] === 0x7F ? u[1] === sid : u[0] === ((sid + 0x40) & 0xFF) && (!opts.accept || opts.accept(Buffer.from(u))));
        const reply = await this.diag.physical(target, sid, data, opts.timeoutMs, accept, { pendingTimeoutMs: opts.pendingTimeoutMs });
        if (reply) this.stats.replies++; else this.stats.missed++;
        return reply ? Buffer.from(reply) : null;
    }
}

module.exports = { TasuLink };
