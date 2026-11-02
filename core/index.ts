/**
 * Boostline's core for the head unit: bundled by tools/bundle.js into app/boostline-core.js, a
 * single CommonJS file that runs on the head unit's Node 8 (the kit's build copies only the app
 * folder's top-level .js files).
 *
 * The app (app/main.js) gets Boostline's own Session: the same EnetAdapter, multi-DID batching,
 * dynamically defined DIDs, OBD-II fallback, BMW DME data and CSV recorder as the desktop app,
 * talking UDS over the head unit's transport (hsfzOverTasu.ts) instead of an ENET cable.
 */
import './polyfills'
import * as fs from 'fs'
import { Session, type SessionHost } from '@core/session'
import { defaultSettings } from '@core/defaults'
import { setRuntime } from '@core/runtime'
import type { BmwDataPack } from '@core/bmwdata/types'
import type { AppSettings } from '@shared/types'
import { headUnitRuntime, makeDirs } from './headUnitRuntime'
import { useTasuLink, type TasuLink } from './hsfzOverTasu'
import boostlinePackage from '@boostline/package.json'

export { Session }
export { useTasuLink, TasuRefusedError, type TasuLink, type TasuRequestOptions } from './hsfzOverTasu'
export { makeDirs } from './headUnitRuntime'
export { CH } from '@shared/types'
export { BMW_CATALOG, DEFAULT_LIVE_CHANNELS } from '@shared/catalog'
export { DEFAULT_UNITS, displayUnitFor } from '@shared/units'
export { logFileName } from '@core/recorder'

/** The Boostline release this bundle was built from (the vendor/boostline submodule). */
export const BOOSTLINE_VERSION: string = boostlinePackage.version

/** How Session.connect() reaches the car on the head unit: EnetAdapter over TASU (no gateway search). */
export const HEAD_UNIT_CONNECTION = { kind: 'enet', host: 'tasu' } as const

/** The DME data file Boostline's desktop app writes (userData/bmw-dme-data.json), copied to the app's data folder. */
export const BMW_DATA_FILE = 'bmw-dme-data.json'

export interface HeadUnitSessionOptions {
  /** The app's writable folder (ctx.dataDir): logs in Logs/, definition files in Definitions/, BMW DME data. */
  dataDir: string
  link: TasuLink
  /** Applied over Boostline's default settings at every connect (units, autoRecordWot, bmwDme). */
  settings?: () => Partial<AppSettings>
}

/** Boostline's Session wired to the head unit: its files, its runtime and its diagnostic link. */
export function createHeadUnitSession(opts: HeadUnitSessionOptions): Session {
  setRuntime(headUnitRuntime)
  useTasuLink(opts.link)
  const join = headUnitRuntime.joinPath
  const host: SessionHost = {
    loadSettings: async () => Object.assign(defaultSettings(opts.dataDir), opts.settings ? opts.settings() : {}),
    loadBmwData: async () => readBmwData(join(opts.dataDir, BMW_DATA_FILE)),
    dataPath: async (folder) => {
      const dir = join(opts.dataDir, folder)
      makeDirs(dir)
      return dir
    }
  }
  return new Session(host)
}

/** The desktop app's DME data pack, or null when absent or not a format-1 pack. */
async function readBmwData(file: string): Promise<BmwDataPack | null> {
  try {
    const pack = JSON.parse(await headUnitRuntime.readTextFile(file)) as BmwDataPack
    return pack.format === 1 && Array.isArray(pack.dmes) ? pack : null
  } catch {
    return null
  }
}

/** Total size of the files in `dir` in bytes (0 when it doesn't exist). */
export function folderBytes(dir: string): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  return names.reduce((sum, name) => {
    try {
      return sum + fs.statSync(headUnitRuntime.joinPath(dir, name)).size
    } catch {
      return sum
    }
  }, 0)
}
