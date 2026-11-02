# Personal conversation continuity

The visible conversation can contain multiple topics. Topic notes are durable
working state, not a second conversation transcript. The session remains the
source of truth; notes carry their original message ID and text, and exact older
requirements remain recoverable through history search.

## Boundaries

- `topic_read` retrieves working notes; `topic_update` uses revision checks so a
  stale update cannot silently overwrite a newer correction. Archived topics
  remain retrievable. Personal preferences use the existing memory store.
- A bounded set of topic notes enters the session as an appended custom message
  once per compaction generation. It does not rewrite the system prefix on each
  topic switch. Omitted notes are explicitly marked and can be read on demand.
- Delegation includes the current original user message and attachments. A
  coordinator can select earlier original messages by ID. Its interpretation is
  separate from those originals. Attachment contents are copied into the child’s
  own attachment store.
- Direct task replies have an explicit target chosen by the person. They bypass
  the main model, interrupt the child, and continue its existing session. Ordinary
  messages still go through the main conversation; no keyword classifier guesses
  whether they should cancel a task.
- Deliveries to a child are serialized. Pending older instructions precede the
  latest correction; they cannot replay after it. Older coordinator turns cannot
  override a newer direct reply. Different children remain independent.

## Compaction

The working-set target is 65,536 tokens or the configured physical window when
smaller. It is expressed through the session service’s compaction threshold, not
by changing the physical window advertised to the provider adapter. Conflating
those values can leave no output budget for a large incoming message.

At 65% of the working-set target, an idle job may use the existing public session
compaction API. It waits for local foreground runs to finish and retains recent
raw messages. A new foreground request cancels the job and waits for its session
to be disposed before opening the transcript. Cancelled summaries are not
committed. Explicit compaction continues to own its conversation exclusively.

Idle maintenance is best effort: continuous input, a large single message, or
other local work can prevent it from finishing before automatic compaction is
needed. It does not promise to eliminate cold prefill or provider queuing. Topic
updates initiated by the model still incur tool round trips. External clients
using the same inference server are not scheduled by this desktop service.

## Validation

`pnpm test` covers revision conflicts, four interleaved topics, restart recovery,
source preservation, topic restoration after compaction, ordered correction
handoffs, foreground preemption, and native compaction cancellation without
losing original history.

The opt-in live runner uses the configured model with isolated data directories:

```sh
node --experimental-strip-types scripts/assistant-context-live.mjs
node --experimental-strip-types scripts/assistant-context-live.mjs --long-history
node --experimental-strip-types scripts/assistant-context-live.mjs --concurrency-only
```

It exercises the production session, topic and continuation services, but is not
an end-to-end mobile/desktop transport benchmark. It records first streamed
content, first visible text, completion latency, cache usage, compaction duration,
and correction stop/submission timing separately. Long-history input is a
synthetic tool-log workload. No mail is sent or monitoring enabled. Answers and
requirements must be reviewed as well as timings; a terminal event alone does
not establish a successful answer.
