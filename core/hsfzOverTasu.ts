/**
 * Boostline's ./hsfz module as the head-unit bundle sees it (tools/bundle.js points enet.ts's
 * `import ... from './hsfz'` here). Everything is Boostline's own, except HsfzConnection: on the
 * head unit it sends UDS over the head unit's diagnostic transport (TASU) instead of HSFZ over TCP.
 *
 * The head unit is itself the diagnostic gateway, so there is no host, port or discovery: the app
 * constructs EnetAdapter with host 'tasu', which skips the gateway search, and connect() lands in
 * HsfzConnection.connect() below. The UDS allowlist (uds.ts) still checks every request before it
 * gets here.
 *
 * Mapping of the transport's outcomes onto what EnetAdapter expects from HSFZ:
 *   reply                      -> the UDS reply (positive or 7F)
 *   no reply in time           -> HsfzTimeoutError
 *   the transport refused it   -> TasuRefusedError (an HsfzGatewayError: "the DME does not respond")
 */
import { EventEmitter } from 'events'
import {
  HsfzConnectionClosedError,
  HsfzGatewayError,
  HsfzTimeoutError,
  toHex,
  type HsfzConnectOptions,
  type HsfzRequestOptions
} from '@core/vehicle/hsfz'

export * from '@core/vehicle/hsfz'

export interface TasuRequestOptions {
  timeoutMs: number
  /** Deadline restarted by a "response pending" (7F xx 78). */
  pendingTimeoutMs: number
  /** false: suppressed-response request (3E 80); resolve once the transport took it. */
  expectResponse: boolean
  /** Extra check on a positive reply (EnetAdapter's DID echo check). */
  accept?: (uds: Buffer) => boolean
}

/** UDS over TASU, provided by the app (app/tasu-link.js, on the kit's kit/runtime/diag.js). */
export interface TasuLink {
  /**
   * Sends one request (service id first) to ECU `target`. Resolves with the ECU's reply, or null
   * when none came in time. Rejects when the transport refused the request.
   */
  request(target: number, uds: Buffer, opts: TasuRequestOptions): Promise<Buffer | null>
}

let link: TasuLink | undefined

/** The link HsfzConnection.connect() uses (undefined: connecting fails). */
export function useTasuLink(next: TasuLink | undefined): void {
  link = next
}

/** The head unit's transport turned a request away (busy for too long, or not allowed). */
export class TasuRefusedError extends HsfzGatewayError {
  constructor(reason: string) {
    super(0x00ff, Buffer.alloc(0))
    this.name = 'TasuRefusedError'
    this.message = `The head unit's diagnostic transport refused the request: ${reason}`
  }
}

const DEFAULT_TIMEOUT_MS = 1000
const DEFAULT_PENDING_TIMEOUT_MS = 5000

const hexByte = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

/**
 * One "connection" over TASU. Requests are serialized as over HSFZ: replies carry no request id,
 * and every app on the head unit sees every reply frame.
 */
export class HsfzConnection extends EventEmitter {
  readonly host = 'tasu'
  readonly port = 0
  private open = true
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(private readonly link: TasuLink) {
    super()
  }

  static async connect(_host: string, _port: number, _opts: HsfzConnectOptions = {}): Promise<HsfzConnection> {
    if (!link) throw new Error("The head unit's diagnostic link (TASU) is not available")
    return new HsfzConnection(link)
  }

  get isOpen(): boolean {
    return this.open
  }

  request(target: number, uds: Buffer, opts: HsfzRequestOptions = {}): Promise<Buffer> {
    const run = (): Promise<Buffer> => this.send(target, uds, opts)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  async close(): Promise<void> {
    if (!this.open) return
    this.open = false
    this.emit('close', undefined)
  }

  private async send(target: number, uds: Buffer, opts: HsfzRequestOptions): Promise<Buffer> {
    if (!this.open) throw new HsfzConnectionClosedError('connection closed')
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const expectResponse = opts.expectResponse ?? true
    let reply: Buffer | null
    try {
      reply = await this.link.request(target, uds, {
        timeoutMs,
        pendingTimeoutMs: opts.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS,
        expectResponse,
        accept: opts.accept
      })
    } catch (err) {
      throw new TasuRefusedError(err instanceof Error ? err.message : String(err))
    }
    if (!this.open) throw new HsfzConnectionClosedError('connection closed')
    if (!expectResponse) return Buffer.alloc(0)
    if (!reply) throw new HsfzTimeoutError(`No response from ECU ${hexByte(target)} to [${toHex(uds.subarray(0, 8))}] within ${timeoutMs} ms`)
    return reply
  }
}
