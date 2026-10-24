type PowerBlocker = {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): boolean
}

/** Keep active work running through idle display sleep; release when the last run settles. */
export class RunAwake {
  private readonly owners = new Set<symbol>()
  private blocker: number | undefined

  private readonly power: PowerBlocker
  private readonly onError: (error: unknown) => void

  constructor(power: PowerBlocker, onError: (error: unknown) => void = () => {}) {
    this.power = power
    this.onError = onError
  }

  acquire(runId: string) {
    const owner = Symbol(runId)
    this.owners.add(owner)
    if (this.blocker === undefined) {
      try { this.blocker = this.power.start('prevent-app-suspension') }
      catch (error) { this.onError(error) }
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.owners.delete(owner)
      if (!this.owners.size) this.stop()
    }
  }

  dispose() {
    this.owners.clear()
    this.stop()
  }

  private stop() {
    if (this.blocker === undefined) return
    const blocker = this.blocker
    this.blocker = undefined
    try { this.power.stop(blocker) }
    catch (error) { this.onError(error) }
  }
}
