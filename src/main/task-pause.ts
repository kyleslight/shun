/** Product pause barrier: cancellation is dispatched before any asynchronous persistence. */
export class TaskPauseBarrier {
  private readonly paused = new Map<string, number>()
  pause(taskId: string, cancel: () => void, at = Date.now()) {
    this.paused.set(taskId, at)
    cancel()
    return at
  }
  has(taskId: string) { return this.paused.has(taskId) }
  resume(taskId: string) { this.paused.delete(taskId) }
  assertDelivery(taskId: string, receivedAt = 0) {
    const pausedAt = this.paused.get(taskId)
    if (pausedAt !== undefined && receivedAt <= pausedAt) throw Error('This task was paused. A new instruction is required to resume it.')
  }
}
