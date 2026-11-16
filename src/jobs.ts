import { randomBytes } from 'node:crypto'
import { Store } from './store.js'

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export type Job = {
  id: string
  kind: string
  label: string
  status: JobStatus
  done: number
  total: number | null
  startedAt: string
  finishedAt?: string
  result?: unknown
  error?: string
}

export type JobHandle = {
  job: Job
  readonly cancelled: boolean
  progress(done: number, total?: number | null): void
}

const store = new Store<{ jobs: Job[] }>('jobs', () => ({ jobs: [] }))
const cancelFlags = new Set<string>()
let loaded = false

const load = (): Job[] => {
  const s = store.get()
  if (!loaded) {
    loaded = true
    // A job still marked "running" in the file means the process died mid-run.
    for (const j of s.jobs) if (j.status === 'running') j.status = 'interrupted'
  }
  return s.jobs
}

const persist = (): void => {
  const s = store.get()
  if (s.jobs.length > 150) s.jobs.splice(0, s.jobs.length - 150)
  store.save()
}

/** Runs long work in the background. The agent starts it, then polls its status. */
export const startJob = (kind: string, label: string, fn: (h: JobHandle) => Promise<unknown>): Job => {
  const jobs = load()
  const job: Job = {
    id: `${kind}-${randomBytes(4).toString('hex')}`,
    kind,
    label,
    status: 'running',
    done: 0,
    total: null,
    startedAt: new Date().toISOString(),
  }
  jobs.push(job)
  persist()
  let lastSave = 0
  const handle: JobHandle = {
    job,
    get cancelled() {
      return cancelFlags.has(job.id)
    },
    progress(done, total) {
      job.done = done
      if (total !== undefined) job.total = total
      if (Date.now() - lastSave > 5000) {
        lastSave = Date.now()
        persist()
      }
    },
  }
  void fn(handle)
    .then(result => {
      job.status = cancelFlags.has(job.id) ? 'cancelled' : 'done'
      job.result = result
    })
    .catch(e => {
      job.status = cancelFlags.has(job.id) ? 'cancelled' : 'failed'
      job.error = (e as Error).message
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString()
      cancelFlags.delete(job.id)
      persist()
    })
  return job
}

export const getJob = (id: string): Job | undefined => load().find(j => j.id === id)
export const listJobs = (kind?: string): Job[] => load().filter(j => !kind || j.kind === kind).slice(-30).reverse()
export const runningJob = (kind: string, label?: string): Job | undefined =>
  load().find(j => j.kind === kind && j.status === 'running' && (label === undefined || j.label === label))
export const cancelJob = (id: string): boolean => {
  const j = getJob(id)
  if (!j || j.status !== 'running') return false
  cancelFlags.add(id)
  return true
}

export const jobView = (j: Job) => ({
  jobId: j.id,
  kind: j.kind,
  label: j.label,
  status: j.status,
  progress: j.total ? `${Math.min(j.done, j.total)}/${j.total}` : String(j.done),
  startedAt: j.startedAt,
  ...(j.finishedAt && { finishedAt: j.finishedAt }),
  ...(j.result !== undefined && { result: j.result }),
  ...(j.error && { error: j.error }),
})
