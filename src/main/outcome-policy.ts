import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

export type OutcomeVerdict = { status: 'accept' | 'continue'; feedback?: string }

export interface OutcomePolicy {
  observe(event: AgentSessionEvent): void
  evaluate(turn: PrepareNextTurnContext): Promise<OutcomeVerdict> | OutcomeVerdict
}
