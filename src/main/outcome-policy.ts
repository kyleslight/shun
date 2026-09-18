import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

export type OutcomeVerdict = { status: 'accept' | 'continue'; feedback?: string }

export interface OutcomePolicy {
  observe(event: AgentSessionEvent): void
  evaluate(turn: PrepareNextTurnContext): Promise<OutcomeVerdict> | OutcomeVerdict
  /**
   * A message to deliver while the model is still generating, or nothing.
   *
   * `evaluate` runs between turns, so guidance it returns is delivered after the
   * generation it is reacting to has already finished. That is too late for a
   * generation that is failing observably while it streams: the loop is about to
   * end, and the message would never be delivered at all. An interrupt arrives at
   * the next turn boundary instead, which keeps the loop alive long enough for the
   * model to act on it. A policy returns one interruption per episode it detects.
   */
  interrupt?(): string | undefined
}

/**
 * One policy list, one run. Policies observe the same events in order, and the
 * first one with something to say about a turn owns it: guidance is a correction
 * to the state the turn produced, and two corrections arriving together describe
 * the same state twice. A later policy still sees the turn after that.
 */
export function combineOutcomePolicies(...policies: Array<OutcomePolicy | undefined>): OutcomePolicy {
  const active = policies.filter((policy): policy is OutcomePolicy => Boolean(policy))
  return {
    observe(event) {
      for (const policy of active) policy.observe(event)
    },
    async evaluate(turn) {
      for (const policy of active) {
        const verdict = await policy.evaluate(turn)
        if (verdict.status === 'continue') return verdict
      }
      return { status: 'accept' }
    },
    interrupt() {
      for (const policy of active) {
        const note = policy.interrupt?.()
        if (note) return note
      }
      return undefined
    },
  }
}
