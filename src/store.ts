import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

/** Simple named JSON store, written atomically so a crash cannot corrupt it. */
export class Store<T> {
  private file: string
  private cache: T | null = null
  constructor(name: string, private def: () => T) {
    this.file = path.join(DATA_DIR, `${name}.json`)
  }
  get(): T {
    if (this.cache != null) return this.cache
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) as T
    } catch {
      this.cache = this.def()
    }
    return this.cache
  }
  save(): void {
    if (this.cache == null) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
  set(v: T): void {
    this.cache = v
    this.save()
  }
  update(fn: (v: T) => void): T {
    const v = this.get()
    fn(v)
    this.save()
    return v
  }
}

/** Daily counters used to cap risky actions (cold DMs, likes, follows, comments). */
type Counters = Record<string, Record<string, number>>
const counters = new Store<Counters>('daily-counters', () => ({}))
const today = () => new Date().toISOString().slice(0, 10)

export const dailyCount = (kind: string): number => counters.get()[today()]?.[kind] ?? 0
export const dailyBump = (kind: string): void => {
  counters.update(c => {
    const d = today()
    for (const k of Object.keys(c)) if (k !== d) delete c[k]
    c[d] ??= {}
    c[d][kind] = (c[d][kind] ?? 0) + 1
  })
}
