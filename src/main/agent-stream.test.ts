import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../shared.ts'
import { coalesceStreamedText } from './agent-runtime.ts'

/**
 * Streamed text is what a link is metered in.
 *
 * Every token of every answer was its own event, and every event its own frame:
 * one streaming reply reached most of a connection's whole budget on its own,
 * and the relay it reaches is a service with a daily request limit. What is
 * asserted here is the trade — the same text, in far fewer pieces.
 */
test('a token stream leaves as far fewer pieces without losing any of it', async () => {
  const tokens = Array.from({ length: 300 }, (_, index) => `t${index} `)
  const out: AgentEvent[] = []
  const emit = coalesceStreamedText(event => out.push(event), 10)
  for (const token of tokens) {
    emit({ id: 'run-1', type: 'delta', text: token })
    // A model's tokens arrive on a clock; the event loop stands in for it.
    await new Promise<void>(resolve => { setImmediate(() => resolve()) })
  }
  emit.flush()

  const texts = out.filter(event => event.type === 'delta').map(event => event.text || '')
  assert.equal(texts.join(''), tokens.join(''), 'every token arrived, in order')
  assert.ok(out.length < tokens.length / 5, `${tokens.length} tokens left as ${out.length} pieces`)
})

/** Anything that is not text goes at once, and flushes what is waiting first. */
test('a tool call never overtakes the text before it', async () => {
  const out: AgentEvent[] = []
  const emit = coalesceStreamedText(event => out.push(event), 10_000)
  emit({ id: 'run-1', type: 'delta', text: 'half a ' })
  emit({ id: 'run-1', type: 'delta', text: 'sentence' })
  emit({ id: 'run-1', type: 'tool', tool: { id: 'tool-1', name: 'bash', input: '{}', state: 'running' } })
  emit({ id: 'run-1', type: 'done' })
  emit.flush()

  assert.deepEqual(out.map(event => event.type), ['delta', 'tool', 'done'])
  assert.equal(out[0].text, 'half a sentence')
})

/** Text for one run never joins text for another. */
test('a second run starts its own piece', () => {
  const out: AgentEvent[] = []
  const emit = coalesceStreamedText(event => out.push(event), 10_000)
  emit({ id: 'run-1', type: 'delta', text: 'first' })
  emit({ id: 'run-2', type: 'delta', text: 'second' })
  emit.flush()
  assert.deepEqual(out.map(event => `${event.id}:${event.text}`), ['run-1:first', 'run-2:second'])
})

/** Writing and thinking are different rows and are not merged into one. */
test('reasoning and text do not merge', () => {
  const out: AgentEvent[] = []
  const emit = coalesceStreamedText(event => out.push(event), 10_000)
  emit({ id: 'run-1', type: 'delta', text: 'answer' })
  emit({ id: 'run-1', type: 'reasoning', text: 'thought' })
  emit.flush()
  assert.deepEqual(out.map(event => event.type), ['delta', 'reasoning'])
})
