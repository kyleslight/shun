export class TaskRunRegistry {
  readonly #active = new Map<string, string>()

  claim(taskId: string, runId: string) {
    const current = this.#active.get(taskId)
    if (current) return current
    this.#active.set(taskId, runId)
    return undefined
  }

  release(taskId: string, runId: string) {
    if (this.#active.get(taskId) === runId) this.#active.delete(taskId)
  }

  get(taskId: string) {
    return this.#active.get(taskId)
  }

  snapshot() {
    return Object.fromEntries(this.#active)
  }
}
