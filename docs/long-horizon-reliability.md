# Long-horizon reliability: a silent supervisor, a declared goal, no second agent

This note records what Shun does when a long autonomous run starts failing, and what it does
when a run stops short of the completion conditions the person declared, why both mechanisms
are this small, and what is deliberately left unbuilt until the telemetry justifies it.

## The governing rule

Trust the model by default. Intervene only when observable evidence shows it failing.

A normal task stays exactly what it was:

```text
User → Main Agent → Tools → Done
```

Reliability comes from small policy layers around the existing Pi loop, not from planning
phases, reviewers, judges, or a second agent runtime. For a healthy run the supervisor's
contribution is a bounded token window and nothing else, and a run with no declared goal never
sees the goal policy at all.

Neither layer may guess. The supervisor acts on failure it can point at in the transcript; the
goal policy acts on a condition the person wrote down before the work started. A run's own
account of whether it is finished is neither, which is why it is never an input to either.

## Where it lives

| Piece | File |
| --- | --- |
| The supervisor | `src/main/agent-supervisor.ts` |
| The declared goal | `src/main/goal-policy.ts` |
| The goal as the person writes it | `src/shared.ts` (`TaskGoal`, `parseTaskGoalCommand`) |
| The policy seam both plug into | `src/main/outcome-policy.ts` (extended with `interrupt()`) |
| Delivery of an interruption | `src/main/agent-runtime.ts` (`session.steer` while generating) |
| Wiring and telemetry sinks | `src/main/index.ts` (`runAgent`) |

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

**Quoting is not claiming.** A phrase inside backticks or a fenced block is removed before
anything is matched (`withoutQuotedCode`): a run quoting the trigger list, or writing a string
that happens to contain it into a file, is not asserting that a limitation stops this task.
Both false positives this matcher produced in real sessions were exactly that — a turn
explaining the patterns, in backticks — and each one spent the run's single challenge before a
real claim arrived. A missed claim costs a delayed nudge; an invented one costs the budget.

**The challenge tests the claim; it does not contradict it.** One bounded message, in the
run's own language, asking the model to falsify its own conclusion with the evidence and
capabilities it already has, and to finish normally with concrete evidence if the
limitation survives. The concern for ordinary simple requests is the reason for the
tool-call floor: a question answered without work never sees a challenge.

**Budget.** One challenge per run (`maxChallenges: 1`). If the model returns and still
concludes the limit is real, it is accepted. There is no challenge loop by construction.

## Failure mode 3 — a declared goal that is not met

The two modes above are the harness noticing a run failing. This one is the run stopping at a
place the person already said was not the end of the work:

```text
/objective is to ship the importer
  → several turns of real work → "I have built the pipeline; the rest is weeks of depth"
  → the run ends with the deliverable missing
```

Nothing in the transcript separates that turn from a run that stopped because the work was
done. Both are one assistant turn with no tool call, and reading the prose for "done" is
precisely the guessing this file exists to prevent — a matcher cannot even tell a limitation
claim from a sentence quoting one.

**A goal is explicit configuration, and its completion is a check.** The person declares an
objective and one or more checks with `/goal`: `file:<path>` must exist, `absent:<path>` must
not, `run:<command>` must exit 0. A goal with no check is refused where it is typed, because
nothing could decide it. The objective is carried verbatim and never parsed, classified, or
matched against; only the person writes it.

**The policy reads the checks when a turn concludes.** A turn that still calls tools is work in
progress and is never interrupted. On a concluding turn the checks run in the task's workspace
under the same environment the run's own commands got (task-root `.venv`, `node_modules/.bin`),
because a condition that resolves differently from the work it judges is a second way to be
wrong. All checks passing accepts the conclusion; a failing check returns the run to work with
one message naming the objective, the check, and what was observed — a run sent back without
the gap has to re-read its own transcript to find it, and usually restates the plan instead.
A command check can be a test suite, so while one runs the run says so in its own status line:
there is no model and no tool call during a check, and a run that looks stalled at exactly the
moment it is being held to the person's conditions is the failure this section exists to remove.

**Budget.** `maxContinuations` (default 5, ceiling 20). Spent, the next conclusion is accepted
and the goal is recorded as `exhausted` with the checks that were still failing, so the person
reads a gap rather than a completion. A run that ended without ever reaching a conclusion —
aborted, or errored mid-turn — is recorded as `not-checked`, and never as met.

**A condition written mid-run binds that run.** Every run carries a policy, even when nothing was
declared yet, and the window that holds the task hands a declaration to the run working on it
(`goal:update`). A long run is exactly when somebody realises what "finished" has to mean, and a
declaration that only bound the next run would leave the run they are watching unbound for as long
as it keeps working — which, for a run fed by queued follow-ups, is the whole of it. A replaced
goal is a new goal, so it starts its own continuation budget; a judgement whose goal was replaced
while its checks ran is taken again, against the conditions that are live now. A run nothing was
ever declared for leaves no record.

**Not a second model.** No conversation, no model call, no tool dispatch, no capability change.
It cannot conclude anything the person did not write down, which is what makes a failed check
evidence instead of an opinion.

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
(`noteworthySupervisorRecord`). A trivial task leaves nothing behind, which is also how the
"no overthinking regressions" guard is enforced in practice: the file staying empty is
the evidence.

A declared goal is deliberate, so it always leaves its own line in
`~/.shun/goal-telemetry.jsonl`: how many checks were declared, how many times the goal was
read against the workspace, how many continuations were spent, which checks were still failing
when the run last looked, and how it ended (`met`, `unmet`, `exhausted`, `not-checked`). That
is the record the default budget of 5 should be tuned from.

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
  never speculates that the model might fail. The goal policy reacts to a condition the person
  declared; a task without a goal never sees it.
- **They observe a run, they do not run one.** No conversation, no model call, no tool
  dispatch, no capability change. `architecture.test.ts` asserts this for both.
- **Completion is never read from prose.** A goal's checks are the filesystem and exit codes.
  Neither policy matches the run's own claims about its work to decide whether the work is
  done — the supervisor's own limitation matcher stays the one place product text is read, and
  only to challenge a conclusion, never to accept one.
- **Bounded everything.** A fixed token window, a fixed signature memory, at most one
  challenge per run, at most one guidance message per episode, and a continuation budget with
  a product ceiling.
- **Session and workspace stay authoritative.** Neither policy paraphrases state: the
  transcript, the filesystem, and tool results are what the model reads.
