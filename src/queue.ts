import { cfg } from './config.js'
import { IgError } from './errors.js'

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
export const rand = (a: number, b: number) => a + Math.random() * (b - a)

/**
 * A single queue for every request to Instagram. Each request waits a random delay after the
 * previous one, so bursts of agent calls do not look like a bot. Calls that would wait too long
 * are rejected with `busy` so the agent can retry later.
 */
export class PacedQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private nextAt = 0
  private pending = 0
  /** Set when Instagram signals trouble. All write actions stop until this time. */
  pausedUntil = 0
  pauseReason = ''

  constructor(private gap: { min: number; max: number } = { min: cfg.minGapMs, max: cfg.maxGapMs }) {}

  estimateWaitMs(): number {
    const base = Math.max(0, this.nextAt - Date.now())
    return base + this.pending * ((this.gap.min + this.gap.max) / 2)
  }

  /** `patient` is for background jobs: they accept long waits and never get `busy`. */
  async run<T>(fn: () => Promise<T>, opts: { instant?: boolean; patient?: boolean } = {}): Promise<T> {
    if (opts.instant) return fn()
    const wait = this.estimateWaitMs()
    if (wait > cfg.maxWaitMs && !opts.patient) throw new IgError('busy', `Queue is full, try again in ${Math.ceil(wait / 1000)} seconds`)
    this.pending++
    const job = this.tail.then(async () => {
      const delay = this.nextAt - Date.now()
      if (delay > 0) await sleep(delay)
      try {
        return await fn()
      } finally {
        this.pending--
        this.nextAt = Date.now() + rand(this.gap.min, this.gap.max)
      }
    })
    this.tail = job.catch(() => undefined)
    return job
  }

  pause(ms: number, reason: string): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms)
    this.pauseReason = reason
  }

  get paused(): boolean {
    return Date.now() < this.pausedUntil
  }
}
