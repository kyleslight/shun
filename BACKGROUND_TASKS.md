# Background process architecture

## Decision

Long-running programs are first-class product resources. A normal foreground shell call must not smuggle a persistent process through `nohup`, `disown`, or an unowned trailing `&`. A task may own multiple background processes, each with independent process metadata, bounded logs, discovered endpoints, and lifecycle state.

Background-process supervision belongs to the Electron product layer, outside the agent kernel. Foreground commands, agent sessions, and background processes have different lifecycles and must remain separate.

## Identity and ownership

- `Task.id` is the conversation/session identifier and becomes `sessionId`.
- `AgentRequest.id` identifies one foreground model run and is recorded as `createdByRunId`.
- `BackgroundTask.id` is a stable process-resource identifier.

```text
Session 1 ── N BackgroundTask
AgentRun 1 ── N BackgroundTask (creation provenance only)
```

Cancelling a model run does not implicitly stop background processes that it explicitly created. Stop operations are separate and must validate session ownership in the main process.

## Durable model

Each process record includes:

- stable task, session, and creating-run identifiers;
- workspace, command, label, PID, and process-group ID;
- explicit lifecycle timestamps and state;
- exit code or terminating signal;
- monotonically increasing output sequence and bounded output size;
- endpoints discovered from that process's own output.

Output is stored per process as a bounded sequence of stdout/stderr chunks. Output from different processes must never be merged into one session-level string because ports, readiness signals, and errors would become ambiguous.

## Supervisor behavior

`BackgroundTaskManager` is the only process supervisor:

- active children are indexed by process ID and session ID;
- each process runs in its own process group so the full tree can be stopped;
- stdout and stderr append bounded chunks and publish IPC events;
- loopback endpoints are extracted only from the owning process's output;
- metadata and tail output persist after exit for diagnosis;
- persisted records are reconciled on application restart so surviving process groups recover their correct status;
- stale PIDs are never treated as proof of liveness without process-group reconciliation.

Limits are enforced structurally per session and globally. Exceeding a limit returns an explicit error rather than silently evicting an older process.

## Agent tools and IPC

The product registers four structured tools through the existing runtime boundary:

- `background_start(command, label)`
- `background_list()`
- `background_output(task_id, after_seq?, wait_ms?, until?)`
- `background_stop(task_id)`

`background_output` stays a bounded snapshot read: `wait_ms` long-polls (capped at 30s) for new output before returning, and `until` returns as soon as output contains that substring. Output arrival and lifecycle transitions wake the waiter; session ownership checks are unchanged.

A managed command runs through the platform's resolved shell: the login shell on macOS and Linux, and on Windows the same resolved interpreter the foreground shell tool uses (Git Bash when installed, otherwise PowerShell 7, Windows PowerShell 5.1, or `cmd.exe`), including its UTF-8 output encoding so persisted logs are not mojibake.

Renderer IPC exposes the corresponding list, output, stop, and event operations. Every main-process operation validates `sessionId` ownership; a model cannot inspect or stop another session's process.

## Runtime evidence

A successful build is not runtime evidence. Product claims require progressively stronger evidence:

1. A URL or port must come from current process output or a successful probe.
2. A claim that a service is running also requires current process liveness.
3. A claim that a page opens requires a successful HTTP or browser check.
4. A claim about interactive behavior requires browser-level interaction evidence.

When files change, previous runtime evidence may become stale. HMR projects require another probe; other projects require a process restart.

## UI boundary

Background processes appear in a compact global resource popover, with details disclosed on demand. The conversation feed and composer must not contain a persistent process panel. Each process may expose its label, state, duration, PID, endpoints, bounded log tail, and stop control.

Switching tasks changes the visible ownership scope without stopping processes. Removing a task that owns live processes must surface that state instead of silently orphaning them.

## Verification

Contract tests cover process-group termination, per-task limits, bounded persisted output, restart reconciliation, ownership, and state transitions. Any supervisor change must preserve those contracts.
