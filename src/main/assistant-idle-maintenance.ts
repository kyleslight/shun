/** One idle job globally; foreground work cancels it before accessing any session. */
export class AssistantIdleMaintenance {
  private timer?: ReturnType<typeof setTimeout>
  private active?: { controller: AbortController; settled: Promise<void> }
  private idleMs: number
  constructor(idleMs = 15_000) { this.idleMs = idleMs }
  schedule(ready: () => boolean, work: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.active) return
      if (!ready()) { this.schedule(ready, work, onError); return }
      const controller = new AbortController()
      const settled = Promise.resolve().then(() => work(controller.signal)).catch(error => { if (!controller.signal.aborted) onError(error) }).finally(() => { if (this.active?.controller === controller) this.active = undefined })
      this.active = { controller, settled }
    }, this.idleMs)
    this.timer.unref?.()
  }
  async yieldToForeground() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const active = this.active
    if (!active) return
    active.controller.abort()
    await active.settled
  }
}
