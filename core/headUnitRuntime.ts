import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { FileWriter, Runtime } from '@core/runtime'

// Boostline's platform services on the head unit (Node 8: no fs.promises, no recursive mkdir).
// There are no sockets: the head unit is the gateway, and UDS goes over TASU (hsfzOverTasu.ts).

const unavailable = (what: string) => (): never => {
  throw new Error(`${what} is not used on the head unit (diagnostics go over its own transport, TASU)`)
}

const call = <T>(fn: (cb: (err: NodeJS.ErrnoException | null, value: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))))

/** mkdir -p for Node 8 (fs.mkdir has no `recursive` before Node 10.12). */
export function makeDirs(dir: string): void {
  if (fs.existsSync(dir)) return
  makeDirs(path.dirname(dir))
  try {
    fs.mkdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

export const headUnitRuntime: Runtime = {
  describePlatform: () => `${os.platform()} ${os.release()} (head unit, Node ${process.version})`,
  createTcpConnection: unavailable('TCP'),
  createUdpSocket: unavailable('UDP'),
  networkInterfaces: () => ({}),
  joinPath: (...parts) => path.join(...parts),
  readDir: (dir) => call<string[]>((cb) => fs.readdir(dir, cb)),
  readTextFile: (file) => call<string>((cb) => fs.readFile(file, 'utf8', cb)),
  writeTextFile: (file, text) => call<void>((cb) => fs.writeFile(file, text, 'utf8', (err) => cb(err, undefined))),
  createFileWriter: (file): FileWriter => {
    const out = fs.createWriteStream(file, { encoding: 'utf8' })
    let failed: Error | null = null
    out.on('error', (err) => (failed = err))
    return {
      write: (text) => void out.write(text),
      end: () =>
        new Promise<void>((resolve, reject) => {
          if (failed) return reject(failed)
          out.once('error', reject)
          out.end(() => resolve())
        })
    }
  }
}
