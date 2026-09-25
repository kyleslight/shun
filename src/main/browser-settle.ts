/**
 * When Browser Use stops holding a tab.
 *
 * Between two steps of the same work the debugger stays attached, because detaching
 * and re-attaching is what makes Chrome's "…is debugging this browser" bar appear
 * and disappear under the person's hands — and that bar changes the height of the
 * page, so every measurement taken across one of those flips describes a layout
 * that no longer exists. That is why a run that ends suspends instead of releasing.
 *
 * The signal that the work is over is the task going quiet: a run has ended and no
 * further run for that task started. That is structural — nothing here reads a
 * prompt or classifies a task — and it is deliberately short, because a task that
 * has really stopped should lose the bar and give the tab back promptly, while the
 * steps of a task that is still going follow each other well inside the window.
 */

export type BrowserSettle = {
  /** Called after a run ends: the task is quiet for now, but it may not be finished. */
  schedule(taskId: string): void
  /** Called when a run starts: work resumed, so a pending release is not due. */
  cancel(taskId: string): void
  /** Pending releases, for observability. */
  pending(): string[]
  stop(): void
}

export type BrowserSettleOptions = {
  /** Release one task's suspended sessions for real: detach, and hand the tab back. */
  release: (taskId: string) => Promise<unknown>
  /** How long a task may stay quiet before its tabs are released anyway. */
  quietMs?: number
  onError?: (error: unknown) => void
}

/** How long a task may stay quiet before its tab is released. */
export const browserQuietMs = 30 * 1000

export function createBrowserSettle(options: BrowserSettleOptions): BrowserSettle {
  const quietMs = options.quietMs ?? browserQuietMs
  const timers = new Map<string, NodeJS.Timeout>()

  const fire = (taskId: string) => {
    timers.delete(taskId)
    void Promise.resolve(options.release(taskId)).catch(error => options.onError?.(error))
  }

  const cancel = (taskId: string) => {
    const timer = timers.get(taskId)
    if (timer) clearTimeout(timer)
    timers.delete(taskId)
  }

  return {
    schedule(taskId) {
      if (!taskId) return
      cancel(taskId)
      const timer = setTimeout(() => fire(taskId), quietMs)
      // A pending release must never be the reason the process stays alive.
      timer.unref?.()
      timers.set(taskId, timer)
    },
    cancel,
    pending() {
      return [...timers.keys()]
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
