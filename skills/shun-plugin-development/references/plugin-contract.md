# Plugin contract

## Architecture

A plugin package is data plus sandboxed web assets. It does not receive an unrestricted in-process module slot.

The stable boundary has three layers:

1. Package layer: identity, version, requested permissions, onboarding, and contributions in `manifest.json`.
2. Host layer: source adapters, installation, validation, permission grants, secrets, OAuth, workspace scoping, bounded RPC, lifecycle, and compatibility.
3. Presentation layer: host-owned view containers and declarative conversation contributions. A plugin view is an isolated iframe served from its own secure origin.

The host may add RPC methods without changing the package format. Removing or changing a method requires compatibility review and an engine or schema version change.

### Self-bootstrapping test

A feature-specific host edit is a failed plugin boundary. A package must be able to bring its own presentation and pure web/WASM implementation while using only generic declared host capabilities.

For example, a LaTeX preview plugin can contribute a `workspace.right` view, request `workspace.read`, load `.tex`, `.sty`, fonts, and images through the bounded workspace RPC, compile with a package-owned WASM engine, and display the resulting PDF beside the conversation. Shun does not need a LaTeX route, compiler branch, prompt rule, or central service. A native executable is a separate high-trust extension tier and must not be smuggled into an ordinary sandboxed UI package.

## Distribution

Installation never depends on one central service. Local folders, archives, Git sources, and a future recommended Marketplace are source adapters that all produce the same validated package directory. Source metadata must not grant permissions or change runtime behavior. A Marketplace may add discovery, signatures, reputation, updates, and compatibility metadata, but the package stays independently installable.

## Extension points

### Workspace views

Use `contributes.views` for independent UI. The first locations are `workspace.right` and `workspace.main`. The host owns close, resize, focus, theme, and task/workspace changes.

After the view reports `ready`, the host sends a context message containing the selected workspace, language, resolved light/dark theme, granted permissions, and a bounded `themeTokens` map. Views should map those semantic tokens into their own CSS custom properties instead of copying application colors. The host may resend context when theme, accent, workspace, or language changes; applying it must not reload the view or discard local UI state.

The iframe sends:

```json
{"source":"shun-plugin","channel":"<host token>","type":"request","requestId":"1","method":"capability.method","payload":{}}
```

The host responds with the same channel/request id and either `result` or `error`. The host rejects unknown sources, channels, views, methods, permissions, workspaces, paths, and revisions.

The initial generic workspace surface is:

- `workspace.list`: bounded directory listing with optional recursion; skips symbolic links and generated dependency metadata.
- `workspace.read`: base64 file chunks of at most 1 MB, with byte offsets for continuation.
- `workspace.reveal`: on an explicit user action, reveal a relative workspace file or its nearest existing directory in the operating system file browser; it does not return an absolute path to the view.
- `workspace.changed`: debounced host event containing only changed relative paths and an overflow flag.

The read APIs require `workspace.read`, accept only relative paths, resolve real paths inside the selected task workspace, and return structured metadata. Views with workspace read or Git read capability receive `workspace.changed`; they should debounce compilation, ignore irrelevant paths, and re-read dependencies instead of trusting event payloads as content. Feature-specific packages should prefer these APIs plus package-owned web/WASM code before proposing a new host RPC.

### Conversation behavior

Choose the smallest stable contribution:

- Agent Skill: progressively disclosed domain instructions.
- Tool: structured capability with validated arguments/results.
- Context provider: bounded explicit task context.
- Lifecycle hook: provider-neutral behavior at an existing host boundary.
- Conversation action/card: declarative UI rendered by the host.

Composer actions insert a visible, user-editable command into the draft. They never submit a message or silently mutate model context.

Arbitrary transcript replacement, raw DOM access, hidden prompt-based activation, and plugin-owned agent loops are not supported.

Plugin count must not linearly expand the prompt. Agent Skill contributions expose bounded discovery metadata first and load complete instructions only after selection. Tool providers expose a compact searchable directory first and materialize only a bounded exact schema subset. A disabled plugin contributes neither discovery metadata nor executable capability.

### Conversation UI

Conversation contributions are host-rendered. The host passes only a bounded message/task projection. A plugin cannot inject CSS or script into the conversation tree. Rich output uses a host-defined card schema or opens a declared isolated view.

## Trust and permissions

Installation and permission grant are separate durable facts. Enabling a plugin does not grant new permissions. Updates requesting more permissions require another user decision.

Secrets never enter settings, manifests, iframe context, logs, or exported task state. OAuth callbacks and token refresh belong to the host. Preferences are non-secret typed values editable through plugin settings.

## Performance

- Render the shell immediately; fetch detail lazily.
- Bound list sizes and expose pagination.
- Cancel or ignore stale results after selection/workspace changes.
- Prefer host events or explicit refresh over polling.
- Do not put large diffs, binaries, or full history in initial context.
