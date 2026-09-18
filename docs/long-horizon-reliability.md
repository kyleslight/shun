# Long-horizon reliability: one silent supervisor, no second agent

This note records what Shun does when a long autonomous run starts failing, why the
mechanism is this small, and what is deliberately left unbuilt until the telemetry
justifies it.

## The governing rule

Trust the model by default. Intervene only when observable evidence shows it failing.

A normal task stays exactly what it was:

```text
User → Main Agent → Tools → Done
```

Reliability comes from a small supervisory layer around the existing Pi loop, not from
planning phases, reviewers, judges, or a second agent runtime. For a healthy run the
supervisor's contribution is a bounded token window and nothing else.

## Where it lives

| Piece | File |
| --- | --- |
| The supervisor | `src/main/agent-supervisor.ts` |
| The policy seam it plugs into | `src/main/outcome-policy.ts` (extended with `interrupt()`) |
| Delivery of an interruption | `src/main/agent-runtime.ts` (`session.steer` while generating) |
| Wiring and telemetry sink | `src/main/index.ts` (`runAgent`) |

`AgentSupervisor` is an `OutcomePolicy`, so the run's existing turn loop already delivers
what it needs: the conclusion it has to judge (`prepareNextTurnWithContext`) and the
event stream it has to observe (`session.subscribe`). No new loop, no new session, no
extra model call.

## Failure mode 1 — degeneration

Observed on V4.1 as output that repeats itself without moving the task:

```text
write / okay / execute / write / okay / execute / ...
```

This is not a reasoning mistake; it is a runtime failure, and a harness does not need a
model to see it.

**Detection is deterministic.** Streamed `text_delta` and `thinking_delta` tokens go into
a rolling window of `windowTokens` (400) — constant memory for the whole run. Over that
window the supervisor computes:

- **repetition ratio** — the share of the window covered by its most repeated four-token
  phrase;
- **unique token ratio** — the share of the window that is new.

Degenerate output is one phrase covering the window (`ratio → 1`, `unique → 0`). Healthy
reasoning of the same length shares no phrase with itself. The trigger requires all of:
240+ streamed tokens since the last state change, repetition ratio ≥ 0.5, unique ratio
≤ 0.2. False positives are worse than a delayed detection, so the thresholds are
conservative and are meant to be tuned from sessions, not from intuition.

**Progress is the real signal.** The window resets when the run obtains something it did
not already have: a tool call it had not made before, a file it actually changed
(`details.changed`), or a failure that resolved. Repeating the same successful call, or
the same failure, is not progress however busy it looks. Tool arguments are excluded from
the window entirely — a long generated file body is the answer to the request, not the
model repeating itself.

**Recovery is the smallest step that works.** On detection the supervisor delivers one
guidance message through the `interrupt()` seam, which reaches the run at the next turn
boundary. That matters: a generation that repeats itself and calls no tools is a
generation the loop is about to end, and guidance delivered after it would never arrive.
One message per episode, at most `maxSteers` per run, and only after progress has closed
the previous episode.

Repetition that continues past its guidance is recorded as `degenerationEscalations` — the
signal that the ladder would have to escalate to aborting the generation and retrying
from the current session state. **That rung is deliberately not implemented yet.** Pi
exposes no per-generation abort: `session.abort()` ends the whole run, and resuming would
mean reworking the runtime's completion path and re-deciding how a partial degenerate
assistant message is retired from the transcript. That is a kernel-integration change,
and it should be made when `supervisor-telemetry.jsonl` shows the escalation actually
happens, not before.

## Failure mode 2 — unverified limitation claims

V4.1 sometimes concludes that further progress is impossible before falsifying that
conclusion:

```text
search quality is poor → several optimizations → some failures remain
  → "the rest is the search API's limit" → a trivial query still fails
  → investigating it finds another controllable problem
```

The model's problem-solving is better than its self-assessment, so an untested
impossibility claim must not be an automatic termination reason.

**Trigger.** Only a turn with no tool call can be a conclusion. On such a turn, after the
run has made at least two tool calls, the supervisor looks for a limitation claim — an
explicit statement that what remains is caused by an external, tool, API, or base-model
limit. Matching is a short list of concrete patterns over normalized English and Chinese
text (`limitationClaim`), not a semantic classifier and not a model call. Saturation
claims, "near the limit", "requires a better model", "without an API key", "nothing more
can be done", 无法进一步优化, 接近极限, 需要 API key, 现有工具无法 and their relatives are
covered.

**The challenge tests the claim; it does not contradict it.** One bounded message, in the
run's own language, asking the model to falsify its own conclusion with the evidence and
capabilities it already has, and to finish normally with concrete evidence if the
limitation survives. The concern for ordinary simple requests is the reason for the
tool-call floor: a question answered without work never sees a challenge.

**Budget.** One challenge per run (`maxChallenges: 1`). If the model returns and still
concludes the limit is real, it is accepted. There is no challenge loop by construction.

## Telemetry

The supervisor records what happened and, more importantly, whether intervening worked:

```ts
type LongRunTelemetry = {
  peakContextTokens, providerCalls, compactionCount,
  totalToolCalls, toolErrors, repeatedToolCallBursts,
  degenerationDetections, degenerationSteers, degenerationEscalations,
  supervisorChallenges, challengeReason?, challengeOutcome?, recoveryOutcome?,
  durationMs, finalStopReason,
}
```

- `challengeOutcome` — `productive` when the run resumed real work after the challenge,
  `confirmed_limit` when it concluded again without doing any.
- `recoveryOutcome` — `recovered` when no detection was left unresolved, `persisted` when
  repetition continued past the steering budget.
- `peakContextTokens` — the largest request the provider reported. It is the closest a
  policy can get to peak context, and it is what the eventual rollover thresholds have to
  be based on.

Records are appended to `~/.shun/supervisor-telemetry.jsonl`, and only for sessions that
intervened, compacted, grew a context past 100k tokens, or ran longer than ten minutes
(`noteworthySupervisorRecord`). A trivial task leaves nothing behind, which is also how
the "no overthinking regressions" guard is enforced in practice: the file staying empty is
the evidence.

## Not built, and why

| Mechanism | Why it waits |
| --- | --- |
| Level-2 recovery: abort generation, retry | Needs a runtime change to how a run ends; build it when `degenerationEscalations > 0` is observed in real sessions |
| Emergency context rollover | Rollover is for a context that has become harmful, not a large one. It needs both the `peakContextTokens` distribution and correlated instability before a threshold means anything |
| Rollover checkpoint (`RolloverCheckpoint`) | Only has a consumer once rollover exists |
| Long-horizon benchmark and the A/B matrix | `bench:research` measures one dimension. An agent benchmark needs realistic multi-step tasks and a live model; the deterministic half of it — the scripted provider harness in `agent-runtime.test.ts` — is where the supervisor's behaviour is already pinned |
| Generic coding subagents, always-on reviewers | A coding subagent duplicates investigation and fragments ownership of shared code. Research explorers stay, because independent evidence has no shared mutable state; coding does |

## Invariants

- **No signal, no intervention.** The supervisor reacts to observed failure indicators; it
  never speculates that the model might fail.
- **It observes a run, it does not run one.** No conversation, no model call, no tool
  dispatch, no capability change. `architecture.test.ts` asserts this.
- **Bounded everything.** A fixed token window, a fixed signature memory, at most one
  challenge per run, at most one guidance message per episode.
- **Session and workspace stay authoritative.** The supervisor never paraphrases state:
  the transcript, the filesystem, and tool results are what the model reads.
