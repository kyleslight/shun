type MaintenanceJob = { cancelled?: boolean; ready: () => boolean; work: (signal: AbortSignal) => Promise<void>; onError: (error: unknown) => void }

/** One idle job globally; foreground work cancels it before accessing any session. */
export class AssistantIdleMaintenance {
  private timer?: ReturnType<typeof setTimeout>
  private active?: { key: string; job: MaintenanceJob; controller: AbortController; settled: Promise<void> }
  private pending = new Map<string, MaintenanceJob>()
  private idleMs: number
  constructor(idleMs = 15_000) { this.idleMs = idleMs }
  schedule(ready: () => boolean, work: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void, key = 'default') {
    this.pending.set(key, { ready, work, onError })
    this.arm()
  }
  private arm() {
    if (this.timer || this.active || !this.pending.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const entry = [...this.pending].find(([, job]) => job.ready())
      if (!entry) { this.arm(); return }
      const [key, job] = entry
      this.pending.delete(key)
      const controller = new AbortController()
      const settled = Promise.resolve().then(() => job.work(controller.signal)).catch(error => {
        if (!controller.signal.aborted) job.onError(error)
      }).finally(() => {
        if (controller.signal.aborted && !job.cancelled && !this.pending.has(key)) this.pending.set(key, job)
        if (this.active?.controller === controller) this.active = undefined
        this.arm()
      })
      this.active = { key, job, controller, settled }
    }, this.idleMs)
    this.timer.unref?.()
  }
  cancel(key: string) {
    this.pending.delete(key)
    if (this.active?.key === key) { this.active.job.cancelled = true; this.active.controller.abort() }
  }
  async yieldToForeground(key?: string) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const active = this.active
    if (active) { active.controller.abort(); if (key === undefined || active.key === key) await active.settled }
    this.arm()
  }
}
