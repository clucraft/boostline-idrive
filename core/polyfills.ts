// The few newer runtime APIs Boostline's core uses that the head unit's Node 8 lacks. Syntax
// (?., ??, class fields, ...) is lowered by esbuild; these are library features it can't lower.
// Each is installed only when missing, so on newer Node (the emulator, tests) nothing changes.

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = global as any

if (typeof g.performance === 'undefined') {
  // perf_hooks has performance.now() since Node 8.5
  g.performance = require('perf_hooks').performance
}

if (typeof (Object as any).hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    value: (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key),
    configurable: true,
    writable: true
  })
}

if (typeof g.AbortController === 'undefined') {
  // Enough for Boostline's Session / EnetAdapter: abort(), signal.aborted / reason / throwIfAborted
  // and abort listeners. (The head unit has no gateway search, the only place a signal cancels I/O.)
  class AbortSignalShim {
    aborted = false
    reason: unknown = undefined
    private listeners: Array<() => void> = []
    throwIfAborted(): void {
      if (this.aborted) throw this.reason
    }
    addEventListener(type: string, fn: () => void): void {
      if (type === 'abort') this.listeners.push(fn)
    }
    removeEventListener(type: string, fn: () => void): void {
      if (type === 'abort') this.listeners = this.listeners.filter((l) => l !== fn)
    }
    _abort(reason: unknown): void {
      if (this.aborted) return
      this.aborted = true
      this.reason = reason
      for (const fn of this.listeners.splice(0)) fn()
    }
  }
  class AbortControllerShim {
    readonly signal = new AbortSignalShim()
    abort(reason?: unknown): void {
      const err = reason !== undefined ? reason : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      this.signal._abort(err)
    }
  }
  g.AbortController = AbortControllerShim
  g.AbortSignal = AbortSignalShim
}
