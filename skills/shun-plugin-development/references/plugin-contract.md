# Plugin contract

## Architecture

A plugin package is data plus sandboxed web assets. It does not receive an unrestricted in-process module slot. Large engine/model/font data stays outside the package as manifest-declared runtime layers served from the host's versioned cache. Runtime metadata must never become an execution gate.

The stable boundary has three layers:

1. Package layer: identity, version, requested permissions, onboarding, and contributions in `manifest.json`.
2. Host layer: source adapters, installation, validation, permission grants, secrets, OAuth, workspace scoping, bounded RPC, lifecycle, and compatibility.
3. Presentation layer: host-owned view containers and declarative conversation contributions. A plugin view is an isolated iframe served from its own secure origin.

The host may add RPC methods without changing the package format. Removing or changing a method requires compatibility review and an engine or schema version change.

Installed development views can be exercised through the deferred `plugin_view_test` capability. It loads the package asset through the same isolated protocol and sandbox, sends the same bounded context, services authorized read-only RPC, and returns bounded DOM, controls, console/load diagnostics, action results, and an optional screenshot. Its click/fill actions execute only inside the plugin frame. The test host blocks operating-system reveals and Git mutations even when the installed package has those permissions; mutation behavior requires separate fixture-level command tests and explicit user authorization.

### Self-bootstrapping test

A feature-specific host edit is a failed plugin boundary. A package must be able to bring its own presentation and pure web/WASM implementation while using only generic declared host capabilities.

For example, a package can contribute a `workspace.right` view, request `workspace.read`, load only the relevant project inputs through bounded workspace RPC, and process them with package-owned web/WASM code. Shun does not need a feature-specific route, transformer branch, prompt rule, or central service.

When an outcome genuinely requires local/native processing, the package may use the separate package-worker tier. It declares a fixed JavaScript entry in `contributes.workers`, requests `workspace.process`, and the view invokes that worker by id through `worker.invoke`. Native programs are declared in `runtime.executables` with exact OS/CPU targets and referenced by the worker's `runtime` list. The host selects and caches the matching build, emits `worker.progress` while installing it, injects its path through `SHUN_PLUGIN_RUNTIME`, starts the worker out of process in the selected workspace, sends one bounded JSON value on stdin, accepts one bounded JSON value on stdout, captures bounded stderr diagnostics, enforces the declared timeout, and terminates the process group on failure. The iframe cannot choose an executable path or command, and the worker must never fall back to a developer-machine `PATH` command. This is explicitly high trust and must not be smuggled into an ordinary sandboxed UI package or granted implicitly.

## Distribution

Installation never depends on one central service. Local folders, archives, Git sources, and a future recommended Marketplace are source adapters that all produce the same validated package directory. Source metadata must not grant permissions or change runtime behavior. A Marketplace may add discovery, signatures, reputation, updates, and compatibility metadata, but the package stays independently installable.

## Extension points

### Workspace views

Use `contributes.views` for independent UI. Views open only in `workspace.right`; the host conversation is the durable primary surface and cannot be replaced by a plugin. Installed views are on-demand by default and do not become permanent activity-rail entries merely because the plugin is enabled. A `transient` rail policy is available for task-scoped previews that must never leave a recent entry in the activity rail after closing. The host owns discovery, open/close, resize, focus, theme, task/workspace binding, and whether an assistant, local resource, or tool-result presentation request should open immediately. Do not duplicate host conversation or project navigation.

View discovery and authorization are separate. Listing an enabled view returns inert presentation metadata. Opening it creates a short-lived grant bound to the exact plugin, view, and canonical workspace; closing it revokes that grant. An existing iframe or token must never be carried to a different task workspace.

After the view reports `ready`, the host sends a context message containing the selected workspace, language, resolved light/dark theme, granted permissions, and a bounded `themeTokens` map. Views should map those semantic tokens into their own CSS custom properties instead of copying application colors. The host may resend context when theme, accent, workspace, or language changes; applying it must not reload the view or discard local UI state.

### Visual integration

The auxiliary panel already owns the plugin icon, title, close action, resizing, and task/workspace binding. An iframe must not render a second branded header or repeat host-owned context. Its first viewport belongs to the user outcome: a preview should be mostly preview, a diff should be mostly diff, and a dashboard should lead with its primary signal.

Persistent controls must participate in normal layout. A toolbar above scrollable content reserves its own height and stays outside the content viewport; it must not float over, obscure, or reduce access to the plugin's primary content.

Document and media viewers should maximize the primary artifact. Use only the compact outer gutter needed to keep content off the panel edge, and separate consecutive pages or items with a small, unambiguous gap instead of a decorative stage.

When a refresh fails but a previous artifact remains usable, keep that artifact visible and state the situation in plain language: the source changed, the refresh failed, and the previous result is still being shown. Provide bounded diagnostics and retry in normal layout; never leave the user to infer this from an ambiguous status word or color alone.

Use `themeTokens` as the visual source of truth. Map the exact semantic keys (`app-bg`, `surface-1..3`, `border-1..2`, `text-1..4`, `hover-bg`, `code-bg`, and `accent`) into package-local CSS variables and apply updates from every context message. Hard-coded light/dark colors are fallbacks only. Controls should use the host's density, system typography, restrained radii, one-pixel borders, and subtle hover/focus states; ornamental gradients, oversized status pills, heavy shadows, and unrelated brand color fields should not dominate the panel.

Apply progressive disclosure inside the view as well as to plugin discovery. Hide redundant labels when the selected value already explains itself, hide selectors when only one option exists, reduce a healthy status to a quiet indicator or tooltip, and keep engine/version/byte/timing metadata out of persistent footers. Keep frequent controls small and nearby; move diagnostics and rare actions behind an explicit disclosure. Error, stale, and compiling states may become more visible because they require attention.

The iframe sends:

```json
{"source":"shun-plugin","channel":"<host token>","type":"request","requestId":"1","method":"capability.method","payload":{}}
```

The host responds with the same channel/request id and either `result` or `error`. The host rejects unknown sources, channels, views, methods, permissions, workspaces, paths, and revisions.

The initial generic workspace surface is:

- `workspace.list`: bounded directory listing with optional recursion; skips symbolic links and generated dependency metadata.
- `workspace.read`: base64 file chunks of at most 1 MB, with byte offsets for continuation.
- `workspace.search`: bounded filename/path search across the selected workspace; Git workspaces follow standard ignore rules by default, while all workspaces skip symbolic links and dependency metadata trees and report truncation. An explicit `includeIgnored` request may opt into the broader filesystem scan.
- `workspace.pdfPage`: render one page of a workspace PDF into a bounded, display-ready raster; the host caches recent documents and pages instead of returning the full PDF to the sandboxed view.
- `workspace.copyPath`: on an explicit user action, copy the canonical absolute path of one exact relative workspace entry to the operating-system clipboard without returning the absolute path to the view.
- `workspace.state.get` / `workspace.state.set`: bounded JSON preferences isolated by plugin and canonical workspace. Use these for a selected input, preview mode, or other UI state that must follow the project instead of the global installation. The host emits `workspace.state.changed` after either the view or Agent updates a key.
- `workspace.reveal`: on an explicit user action, reveal a relative workspace file or its nearest existing directory in the operating system file browser; it does not return an absolute path to the view.
- `workspace.open`: on an explicit user action, open an exact relative workspace file with its default desktop application, a supported document-application protocol, or the operating system's application chooser when available; it does not return an absolute path to the view.
- `workspace.changed`: debounced host event containing only changed relative paths and an overflow flag.
- `worker.invoke`: invoke one manifest-declared package worker by id with structured input; requires `workspace.process` and is available only after an explicit permission grant.
- `host.export`: on an explicit click, pass one bounded binary artifact and a safe suggested file name to Shun. The host asks the user for a destination directory and writes a non-overwriting file; the iframe never receives general filesystem authority.

The read APIs require `workspace.read`, accept only relative paths, resolve real paths inside the selected task workspace, and return structured metadata. Views with workspace read or Git read capability receive `workspace.changed`; they should debounce compilation, ignore irrelevant paths, and re-read dependencies instead of trusting event payloads as content. Feature-specific packages should prefer these APIs plus package-owned web/WASM code before proposing a new host RPC.

Workspace state does not require a filesystem permission because it is bounded plugin-owned preference data stored outside the project. If the Agent must change the same preference from conversation, contribute a narrowly scoped Skill that documents the plugin id and exact state key; the Agent can then call `plugin_workspace_state`. Do not encode the task in a host prompt rule or maintain a separate global preference.

A view may declare `activation.localEndpoints: true` when its primary purpose is previewing a task-owned local web endpoint. The host may present the first matching view when a background resource reports a loopback HTTP(S) endpoint, and sends that exact URL as a `resource.open` event after the view is ready. This activation comes from explicit resource state, never prompt text. Pair it with `rail: transient` when closing the preview should leave no activity-rail entry.

### Conversation behavior

Choose the smallest stable contribution:

- Agent Skill: progressively disclosed domain instructions.
- Tool: structured capability with validated arguments/results.
- Context provider: bounded explicit task context.
- Lifecycle hook: provider-neutral behavior at an existing host boundary.
- Conversation action/card: declarative UI rendered by the host.

Conversation actions may insert a visible, user-editable command into the draft, open one declared view that allows `conversation-action`, or do both. They never submit a message or silently mutate model context.

Arbitrary transcript replacement, raw DOM access, hidden prompt-based activation, and plugin-owned agent loops are not supported.

Plugin count must not linearly expand the prompt. Agent Skill contributions expose bounded discovery metadata first and load complete instructions only after selection. Tool providers expose a compact searchable directory first and materialize only a bounded exact schema subset. A disabled plugin contributes neither discovery metadata nor executable capability.

### Conversation UI

Conversation contributions are host-rendered. The host passes only a bounded message/task projection. A plugin cannot inject CSS or script into the conversation tree. Rich output uses a host-defined card schema or opens a declared isolated view.

An Agent Skill may request a declared view through `plugin_view_present` after tool-only capability work has established that visual UI is useful. The request is visible in the tool timeline and leaves a host-rendered open-view card in history, applies only to the foreground task, respects the view's declared launch sources, and does not reopen a view the user dismissed. The historical card remains after removal; attempting to open it explains that the plugin must be installed or enabled again. Workspace change events keep an already-open preview current; they are not a reason to reopen a closed panel.

## Trust and permissions

Installation and permission grant are separate durable facts. Enabling a plugin does not grant new permissions. Updates requesting more permissions require another user decision.

`workspace.process` is a high-trust permission. A package worker is not a renderer escape hatch: it has no in-process host module slot and cannot register RPC methods. Its fixed entry and resource limits are validated at installation, and every invocation is authorized against the installed view grant.

Secrets never enter settings, manifests, iframe context, logs, or exported task state. OAuth callbacks and token refresh belong to the host. Preferences are non-secret typed values editable through plugin settings.

## Performance

- Render the shell immediately; fetch detail lazily.
- Bound list sizes and expose pagination.
- Cancel or ignore stale results after selection/workspace changes.
- Prefer host events or explicit refresh over polling.
- Do not put large diffs, binaries, or full history in initial context.
- Render ready content at a backing resolution appropriate for the display, keep CSS geometry on integer pixels, and verify screenshots at narrow and wide panel widths so text/canvas previews do not look soft.
