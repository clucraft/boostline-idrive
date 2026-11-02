/**
 * The emulator's engine computer: answers the app's UDS requests over the emulated TASU link
 * (vendor/idrive7-apps kit/tools/hu-stub.js, `emu.js --diag build/fake-dme.js`) the way a DME
 * behind the head unit would, with live values from Boostline's own B58 simulator (SimEngine).
 *
 * ECUs: the gateway (0x10: VIN) and the DME (0x12). The DME answers
 *   10 01 / 10 03      sessions (a session change drops dynamic DIDs, as ISO 14229 says)
 *   3E 00 / 3E 80      tester present
 *   22 <DID>...        up to MAX_DIDS identifiers per request (NRC 13 above): VIN F190, SVK F101,
 *                      diagnostic index F150, OBD-II F4xx (supported-PID masks and live PIDs), and
 *                      the invented DME DIDs of FAKE_MEASUREMENTS
 *   2C 01 / 2C 03      dynamically defined DIDs by identifier (up to MAX_DYNAMIC_ENTRIES entries),
 *                      2C 02 (by memory) is refused: this DME has no readable RAM
 *   19 02 <mask>       no stored faults
 *   22 F1 50 to 0xDF   both units answer (functional discovery, as the kit's apps send it)
 * Everything else gets NRC 11 (service not supported).
 *
 * The DIDs, scalings and the diagnostic index of FAKE_MEASUREMENTS are invented for the emulator;
 * they are not BMW data. dataPack() is a Boostline DME data pack for them (format 1), which
 * tools/emu.js puts in the emulator's data folder so Boostline's BMW-data path (curated channels,
 * 2C 01 block reads) runs as it would with the user's imported data on a car.
 *
 * Replies come after LATENCY_MS (FAKE_DME_LATENCY_MS), a guess: how fast the real head unit
 * answers is what the first test on a car has to measure.
 */
import { SimEngine } from '@core/vehicle/simulator'
import type { BmwDataPack, BmwMeasurement, BmwValueType } from '@core/bmwdata/types'

const ZGW = 0x10
const DME = 0x12
const ALL = 0xdf
/** Invented (valid VIN characters only: no I, O or Q, or Boostline rejects it as a car would never send it). */
const VIN = 'WBAEMU000BL000001'
const MAX_DIDS = 8
const MAX_DYNAMIC_ENTRIES = 16
const LATENCY_MS = Number(process.env.FAKE_DME_LATENCY_MS ?? 6)
/** Invented diagnostic index (F150) that selects FAKE_SGBD in dataPack(). */
export const FAKE_SGBD_INDEX = 0x0b0057
const FAKE_SGBD = 'emu_dme'
const REFERENCE_TORQUE_NM = 650

/** SVK: header, 13-byte fingerprint, HWEL / BTLD / SWFL entries (layout as Boostline's parser expects). */
const SVK = Buffer.from([
  0x01, 0x01, 0x00, 0x03, ...new Array<number>(13).fill(0),
  0x01, 0x00, 0x00, 0x0e, 0x40, 1, 0, 0,
  0x06, 0x00, 0x00, 0x0e, 0x41, 1, 0, 0,
  0x08, 0x00, 0x00, 0x0e, 0x42, 1, 0, 0
])

type Snapshot = Record<string, number>

interface FakeMeasurement {
  did: number
  /** SGBD-style result name: Boostline's curated rules map these onto its channel ids. */
  result: string
  info: string
  unit: string
  type: BmwValueType
  mul: number
  div: number
  add: number
  /** The physical value in `unit` from a simulator snapshot. */
  value: (s: Snapshot) => number
}

const m = (did: number, result: string, info: string, unit: string, type: BmwValueType, mul: number, div: number, add: number, value: (s: Snapshot) => number): FakeMeasurement =>
  ({ did, result, info, unit, type, mul, div, add, value })

/** Invented DIDs and scalings (not BMW data); the result names follow the SGBD naming the curated rules know. */
export const FAKE_MEASUREMENTS: readonly FakeMeasurement[] = [
  m(0x6a01, 'STAT_MOTORDREHZAHL_WERT', 'Motordrehzahl', 'rpm', 'u16', 1, 2, 0, (s) => s['engine.rpm']),
  m(0x6a02, 'STAT_FAHRPEDAL_WERT', 'Fahrpedal', '%', 'u16', 1, 100, 0, (s) => s['throttle.pedal']),
  m(0x6a03, 'STAT_DROSSELKLAPPENWINKEL_WERT', 'Drosselklappenwinkel', '%', 'u16', 1, 100, 0, (s) => s['throttle.position']),
  m(0x6a04, 'STAT_LADEDRUCK_WERT', 'Ladedruck ist', 'hPa', 'u16', 1, 1, 0, (s) => s['boost.map'] * 1000),
  m(0x6a05, 'STAT_S_LADEDRUCK_WERT', 'Ladedruck soll', 'hPa', 'u16', 1, 1, 0, (s) => (s['boost.ambient'] + s['boost.target']) * 1000),
  m(0x6a06, 'STAT_UMGEBUNGSDRUCK_WERT', 'Umgebungsdruck', 'hPa', 'u16', 1, 1, 0, (s) => s['boost.ambient'] * 1000),
  m(0x6a07, 'STAT_I_EWG_POS_WERT', 'Wastegate Position ist', '%', 'u16', 1, 100, 0, (s) => s['boost.wg_actual']),
  m(0x6a08, 'STAT_SOLL_POS_EWG_WERT', 'Wastegate Position soll', '%', 'u16', 1, 100, 0, (s) => s['boost.wg_target']),
  m(0x6a09, 'STAT_RAILDRUCK_IST_WERT', 'Raildruck ist', 'MPa', 'u16', 1, 100, 0, (s) => s['fuel.rail.actual'] / 10),
  m(0x6a0a, 'STAT_S_RAILDRUCKREGELUNG_WERT', 'Raildruck soll', 'MPa', 'u16', 1, 100, 0, (s) => s['fuel.rail.target'] / 10),
  m(0x6a0b, 'STAT_LAMBDA_BANK1_IST_WERT', 'Lambda ist Bank 1', '', 'u16', 1, 1000, 0, (s) => s['fuel.lambda.actual']),
  m(0x6a0c, 'STAT_LAMBDA_BANK1_SOLL_WERT', 'Lambda soll Bank 1', '', 'u16', 1, 1000, 0, (s) => s['fuel.lambda.target']),
  m(0x6a0d, 'STAT_ANSAUGLUFTTEMPERATUR_WERT', 'Ansauglufttemperatur', '°C', 's16', 1, 10, 0, (s) => s['temp.intake']),
  m(0x6a0e, 'STAT_MOTORMOMENT_IST_WERT', 'Motormoment ist', 'Nm', 's16', 1, 1, 0, (s) => s['load.torque.actual']),
  m(0x6a0f, 'STAT_KUEHLMITTELTEMPERATUR_WERT', 'Kuehlmitteltemperatur', '°C', 's16', 1, 10, 0, (s) => s['temp.coolant']),
  m(0x6a10, 'STAT_OELTEMPERATUR_WERT', 'Oeltemperatur', '°C', 's16', 1, 10, 0, (s) => s['temp.oil']),
  m(0x6a11, 'STAT_GESCHWINDIGKEIT_WERT', 'Geschwindigkeit', 'km/h', 'u16', 1, 10, 0, (s) => s['vehicle.speed']),
  m(0x6a12, 'STAT_GANG_WERT', 'Gang', '', 'u8', 1, 1, 0, (s) => s['vehicle.gear']),
  m(0x6a13, 'STAT_I_NWSE_SPREIZUNG_WERT', 'Einlassspreizung ist', '°CRK', 's16', 1, 10, 0, (s) => s['vanos.intake.actual']),
  m(0x6a14, 'STAT_S_NWSE_SPREIZUNG_WERT', 'Einlassspreizung soll', '°CRK', 's16', 1, 10, 0, (s) => s['vanos.intake.target']),
  m(0x6a15, 'STAT_I_ZUENDWINKEL_WERT', 'Zuendwinkel ist', '°CRK', 's16', 1, 10, 0, (s) => s['ign.avg']),
  ...[1, 2, 3, 4, 5, 6].map((n, i) =>
    m(0x6a20 + i, `STAT_ZUENDWINKEL_ZYL${n}_WERT`, `Zuendwinkel Zylinder ${n}`, '°CRK', 's16', 1, 10, 0, (s) => s[`ign.cyl${n}`])
  )
]

/** Boostline DME data pack (format 1) describing FAKE_MEASUREMENTS. */
export function dataPack(): BmwDataPack {
  const measurements: BmwMeasurement[] = FAKE_MEASUREMENTS.map((x) => ({
    did: x.did, arg: x.result.replace(/^STAT_|_WERT$/g, ''), result: x.result, info: x.info, unit: x.unit,
    type: x.type, littleEndian: false, mul: x.mul, div: x.div, add: x.add, composable: true
  }))
  return {
    format: 1,
    source: 'boostline-idrive emulator (invented DIDs, not BMW data)',
    importedAt: new Date(0).toISOString(),
    dmes: [{
      sgbd: FAKE_SGBD, name: 'Emulator DME', comment: 'emu/fakeDme.ts', chassis: [], engines: ['B58 (simulated)'],
      diagAddress: DME, sgbdIndexes: [FAKE_SGBD_INDEX], measurements
    }]
  }
}

const SIZE: Record<BmwValueType, number> = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, f32: 4 }

function encode(x: FakeMeasurement, physical: number): Buffer {
  const out = Buffer.alloc(SIZE[x.type])
  const raw = Math.round((((Number.isFinite(physical) ? physical : 0) - x.add) * x.div) / x.mul)
  const clamp = (lo: number, hi: number): number => Math.max(lo, Math.min(hi, raw))
  switch (x.type) {
    case 'u8': out.writeUInt8(clamp(0, 0xff)); break
    case 's8': out.writeInt8(clamp(-0x80, 0x7f)); break
    case 'u16': out.writeUInt16BE(clamp(0, 0xffff)); break
    case 's16': out.writeInt16BE(clamp(-0x8000, 0x7fff)); break
    case 'u32': out.writeUInt32BE(clamp(0, 0xffffffff)); break
    case 's32': out.writeInt32BE(clamp(-0x80000000, 0x7fffffff)); break
    case 'f32': out.writeFloatBE(physical); break
  }
  return out
}

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)))
const word = (v: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(Number.isFinite(v) ? v : 0))))
  return b
}
const pct = (v: number): number => byte((v * 255) / 100)

/** OBD-II mode 01 PIDs (read as DIDs F4xx), encoded as SAE J1979 defines them, from the simulator. */
const PIDS: Record<number, (s: Snapshot) => Buffer> = {
  0x04: (s) => Buffer.from([pct(s['load.calc'])]),
  0x05: (s) => Buffer.from([byte(s['temp.coolant'] + 40)]),
  0x0b: (s) => Buffer.from([byte(s['boost.map'] * 100)]),
  0x0c: (s) => word(s['engine.rpm'] * 4),
  0x0d: (s) => Buffer.from([byte(s['vehicle.speed'])]),
  0x0e: (s) => Buffer.from([byte((s['ign.avg'] + 64) * 2)]),
  0x0f: (s) => Buffer.from([byte(s['temp.intake'] + 40)]),
  0x10: (s) => word((s['load.maf'] / 3.6) * 100),
  0x11: (s) => Buffer.from([pct(s['throttle.position'])]),
  0x23: (s) => word(s['fuel.rail.actual'] * 10),
  0x33: (s) => Buffer.from([byte(s['boost.ambient'] * 100)]),
  0x34: (s) => Buffer.concat([word((s['fuel.lambda.actual'] * 65536) / 2), Buffer.from([0x80, 0x00])]),
  0x42: (s) => word(s['elec.battery'] * 1000),
  0x44: (s) => word((s['fuel.lambda.target'] * 65536) / 2),
  0x46: (s) => Buffer.from([byte(s['temp.ambient'] + 40)]),
  0x49: (s) => Buffer.from([pct(s['throttle.pedal'])]),
  0x4c: (s) => Buffer.from([pct(s['throttle.target'])]),
  0x5c: (s) => Buffer.from([byte(s['temp.oil'] + 40)]),
  0x62: (s) => Buffer.from([byte((s['load.torque.actual'] / REFERENCE_TORQUE_NM) * 100 + 125)]),
  0x63: () => word(REFERENCE_TORQUE_NM),
  0xa4: (s) => Buffer.from([0x02, (Math.round(s['vehicle.gear']) & 0x0f) << 4, 0x00, 0x00])
}

/** Supported-PID bitmask for the 32 PIDs after `base` (bit 0 of the last byte: more follow). */
function pidMask(base: number): Buffer {
  const out = Buffer.alloc(4)
  const pids = Object.keys(PIDS).map(Number)
  for (const pid of pids) {
    if (pid <= base || pid > base + 0x20) continue
    const bit = pid - base - 1
    out[bit >> 3] |= 0x80 >> (bit & 7)
  }
  if (pids.some((p) => p > base + 0x20)) out[3] |= 0x01
  return out
}

interface Log {
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
}

type Reply = (ecu: number, bytes: Uint8Array) => void

/** The responder hu-stub.js loads: (log) => ({ request(target, uds, reply) }). */
function createResponder(log: Log) {
  const engine = new SimEngine()
  const byDid = new Map(FAKE_MEASUREMENTS.map((x) => [x.did, x]))
  let last = Date.now()
  let snap: Snapshot = engine.snapshot()
  let session = 0x01
  const dynamic = new Map<number, Array<{ did: number; position: number; size: number }>>()
  let requests = 0
  let windowStart = Date.now()

  /** Runs the simulator up to now (the drive cycle goes on in real time, read or not). */
  const advance = (): void => {
    const now = Date.now()
    const dt = Math.min(1, (now - last) / 1000)
    if (dt > 0) {
      engine.step(dt)
      snap = engine.snapshot()
      last = now
    }
  }
  const ticker = setInterval(advance, 50)
  ticker.unref?.()

  const readDid = (target: number, did: number): Buffer | undefined => {
    if (did === 0xf190) return Buffer.from(VIN, 'latin1')
    if (target !== DME) return did === 0xf150 ? Buffer.from([0x00, 0x00, 0x7a]) : undefined
    if (did === 0xf101) return SVK
    if (did === 0xf150) return Buffer.from([(FAKE_SGBD_INDEX >> 16) & 0xff, (FAKE_SGBD_INDEX >> 8) & 0xff, FAKE_SGBD_INDEX & 0xff])
    if (did >= 0xf400 && did <= 0xf4ff) {
      const pid = did - 0xf400
      if (pid % 0x20 === 0) return pidMask(pid)
      return PIDS[pid]?.(snap)
    }
    const entries = dynamic.get(did)
    if (entries) {
      const blocks = entries.map((e) => readDid(target, e.did)?.subarray(e.position - 1, e.position - 1 + e.size))
      return blocks.every((b): b is Buffer => b !== undefined) ? Buffer.concat(blocks) : undefined
    }
    const x = byDid.get(did)
    return x ? encode(x, x.value(snap)) : undefined
  }

  const respond = (target: number, uds: Buffer): Buffer | undefined => {
    const sid = uds[0]
    const nrc = (code: number): Buffer => Buffer.from([0x7f, sid, code])
    switch (sid) {
      case 0x10: {
        const s = uds[1] & 0x7f
        if (target !== DME) return nrc(0x11)
        if (uds.length !== 2 || (s !== 0x01 && s !== 0x03)) return nrc(0x12)
        if (s !== session) dynamic.clear()
        session = s
        return uds[1] & 0x80 ? undefined : Buffer.from([0x50, s, 0x00, 0x32, 0x01, 0xf4])
      }
      case 0x3e:
        return uds[1] & 0x80 ? undefined : Buffer.from([0x7e, 0x00])
      case 0x22: {
        if (uds.length < 3 || (uds.length - 1) % 2 !== 0) return nrc(0x13)
        const count = (uds.length - 1) / 2
        if (count > MAX_DIDS) return nrc(0x13)
        const parts: Buffer[] = [Buffer.from([0x62])]
        for (let i = 0; i < count; i++) {
          const did = uds.readUInt16BE(1 + 2 * i)
          const data = readDid(target, did)
          if (data) parts.push(Buffer.from([did >> 8, did & 0xff]), data)
        }
        return parts.length > 1 ? Buffer.concat(parts) : nrc(0x31)
      }
      case 0x2c: {
        if (target !== DME) return nrc(0x11)
        if (uds.length < 4) return nrc(0x13)
        const sub = uds[1] & 0x7f
        const did = uds.readUInt16BE(2)
        if (did < 0xf200 || did > 0xf3ff) return nrc(0x31)
        if (sub === 0x03) {
          dynamic.delete(did)
          return Buffer.from([0x6c, 0x03, did >> 8, did & 0xff])
        }
        if (sub !== 0x01) return nrc(0x12)
        if (uds.length < 8 || (uds.length - 4) % 4 !== 0) return nrc(0x13)
        const entries = []
        for (let pos = 4; pos < uds.length; pos += 4) {
          const e = { did: uds.readUInt16BE(pos), position: uds[pos + 2], size: uds[pos + 3] }
          const record = e.did >= 0xf200 && e.did <= 0xf3ff ? undefined : readDid(DME, e.did)
          if (!record || e.position < 1 || e.size < 1 || e.position - 1 + e.size > record.length) return nrc(0x31)
          entries.push(e)
        }
        const all = [...(dynamic.get(did) ?? []), ...entries]
        if (all.length > MAX_DYNAMIC_ENTRIES) return nrc(0x31)
        dynamic.set(did, all)
        return Buffer.from([0x6c, sub, did >> 8, did & 0xff])
      }
      case 0x19:
        if (uds[1] === 0x02) return Buffer.from([0x59, 0x02, 0xff])
        return nrc(0x12)
      default:
        return nrc(0x11)
    }
  }

  log.info(`fake DME: VIN ${VIN}, diagnostic index ${FAKE_SGBD_INDEX.toString(16).toUpperCase().padStart(6, '0')}, replies after ${LATENCY_MS} ms`)

  return {
    request(target: number, uds: Buffer, reply: Reply): void {
      advance()
      requests++
      if (Date.now() - windowStart >= 10000) {
        log.info(`fake DME: ${(requests / ((Date.now() - windowStart) / 1000)).toFixed(1)} requests/s`)
        requests = 0
        windowStart = Date.now()
      }
      const units = target === ALL ? [ZGW, DME] : [target]
      for (const ecu of units) {
        if (ecu !== ZGW && ecu !== DME) continue
        if (target === ALL && !(uds[0] === 0x22 && uds.length === 3)) continue
        const res = respond(ecu, uds)
        if (res) setTimeout(() => reply(ecu, res), LATENCY_MS)
      }
    }
  }
}

// (tools/bundle.js makes this the module itself: require('build/fake-dme.js')(log), .dataPack(), ...)
export default createResponder
