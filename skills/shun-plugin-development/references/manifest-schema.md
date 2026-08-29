# Manifest schema

Every package root contains `manifest.json`.

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "name": "Example Plugin",
  "description": "What the plugin contributes.",
  "version": "0.1.0",
  "publisher": "Publisher",
  "icon": "icon.svg",
  "experimental": true,
  "runtime": {
    "workspace": "required",
    "assets": [
      { "id": "model-data", "path": "model-data.bin", "bytes": 1048576, "url": "https://publisher.example/model-data.bin" }
    ],
    "executables": [
      {
        "id": "renderer",
        "version": "1.2.3",
        "targets": [
          { "platform": "darwin", "arch": "arm64", "url": "https://publisher.example/renderer-macos-arm64.tar.gz", "bytes": 12345678, "archive": "tar.gz", "entry": "renderer" },
          { "platform": "win32", "arch": "x64", "url": "https://publisher.example/renderer-windows-x64.zip", "bytes": 12345678, "archive": "zip", "entry": "renderer.exe" }
        ]
      }
    ]
  },
  "permissions": [
    { "id": "workspace.read", "reason": "Read selected project files." }
  ],
  "onboarding": {
    "reopenable": true,
    "steps": [
      { "id": "welcome", "type": "info", "title": "Welcome", "description": "What happens next." },
      { "id": "mode", "type": "choice", "title": "Mode", "description": "Choose a default.", "key": "mode", "options": [{ "label": "Focused", "value": "focused" }, { "label": "Expanded", "value": "expanded" }] }
    ]
  },
  "contributes": {
    "skills": [{ "path": "skills" }],
    "views": [
      { "id": "example.main", "title": "Example", "location": "workspace.right", "entry": "ui/index.html", "rail": "on-demand", "launch": ["user", "assistant", "tool-result", "conversation-action"], "activation": { "fileChanges": ["**/*.example"] } }
    ],
    "conversationActions": [
      { "id": "open-preview", "title": "Open preview", "placement": "message", "viewId": "example.main" }
    ],
    "workers": [
      { "id": "render", "entry": "worker/index.mjs", "timeoutMs": 30000, "runtime": ["renderer"] }
    ]
  }
}
```

## Identity

- `schemaVersion`: currently `1`.
- `id`: lowercase letters/numbers separated by `.` or `-`, at most 80 characters. Treat it as permanent.
- `version`: use semantic versioning for distributed packages.
- `publisher`: stable publisher identity.
- `icon`: for newly created packages, a package-relative SVG asset with a product-specific identity. `plugin` and built-in icon ids remain compatibility fallbacks, not the default for new work.
- `experimental`: marks APIs or experiences that are not compatibility promises.

Source URLs, Marketplace ids, and install locations are not manifest authority and do not belong in runtime decisions.

Large runtime data does not belong in the plugin package. Declare it in
`runtime.assets` with a stable id, virtual package-relative path, and declared
byte length. A distributed asset uses credential-free HTTPS; the host downloads
and stores it in a plugin-versioned cache, then exposes it to the isolated view at
`/__runtime__/<asset.path>` on the plugin's own origin. Each asset is capped at
256 MB and the declared set at 512 MB. These cached bytes do not weaken the
25 MB / 400-file package limit.

During a reloadable development install, the URL may be omitted. Put the bytes
under the sibling directory `<plugin-root>.runtime-assets/<asset.path>`; the host
serves that current development file directly, including after Reload. Published
packages must provide durable HTTPS URLs.

Native executables belong in `runtime.executables`, not inside the 25 MB plugin
package and not on the user's `PATH`. Each executable has a stable id/version and
one exact target per supported `platform` (`darwin`, `win32`, `linux`) and `arch`
(`arm64`, `x64`). Targets use `raw`, `tar.gz`, or `zip`, declare the executable
`entry`, byte size, and credential-free HTTPS URL. Shun selects only the current
OS/CPU target, installs it once in a versioned cache, and injects its absolute
path into workers through `SHUN_PLUGIN_RUNTIME` as a JSON object keyed by id.
Workers must fail clearly on an unsupported target; never substitute a different
architecture. Development builds may use
`<plugin-root>.runtime-assets/executables/<id>/<platform>-<arch>/<entry>`.

## Runtime scope

`runtime.workspace` is required for new packages:

- `required`: the plugin capability and every workspace-bound view require a selected task workspace.
- `optional`: the plugin works in standalone tasks and may receive a workspace binding when one is selected.
- `none`: the plugin is workspace-independent and cannot request any `workspace.*` permission.

Installation is always global, but runtime instances are task-owned. A workspace-bound view authorization is issued only when that view opens and is valid only for the exact workspace it was opened against. Switching tasks or workspaces never silently rebinds a live view.

Custom SVG icons must be self-contained, no larger than 256 KB, and intentionally designed for recognition at 16–36 px. The same installed asset appears in plugin discovery, the right activity rail, and the panel header. Avoid small text, screenshot-like detail, or reusing the generic puzzle mark.

## Permissions

- `workspace.git.read`: repository status, refs, bounded history, changed files, and diffs.
- `workspace.git.write`: structured, host-validated Git operations, including an explicit repository initialization action, in the selected workspace; never arbitrary command execution.
- `workspace.read`: bounded project file reads through host APIs.
- `workspace.reveal`: reveal a user-selected relative path in the operating system file browser without exposing absolute paths to the plugin view.
- `workspace.process`: run a fixed, package-owned worker out of process for structured local/native processing. This is high trust and must be explicitly granted.
- `conversation.context`: bounded explicit task context contributions.
- `conversation.ui`: host-rendered conversation actions/cards.

Every permission requires a concise user-facing `reason`. Do not request speculative permissions.

With `workspace.read`, a view may call `workspace.list` and `workspace.read`. Reads use relative real paths within the selected workspace and return at most 1 MB per base64 chunk. The host also sends debounced `workspace.changed` events containing relative paths after the conversation or another local tool edits files. This is sufficient for package-owned web/WASM processing to re-read dependencies, rebuild, and keep a preview current without a feature-specific host integration.

## Package workers

`contributes.workers` is optional. Each worker has a stable lowercase `id`, a package-relative JavaScript `entry`, a `timeoutMs` from 100 through 120000, and an optional `runtime` list referencing declared executable ids. Any worker contribution requires `workspace.process`. The generated host client calls it with `invokeWorker(workerId, input, options)`.

The worker reads one JSON value from stdin and writes one JSON value to stdout. Input is limited to 1 MB, output to 32 MB, and stderr diagnostics to 64 KB. Declared executable paths arrive in `SHUN_PLUGIN_RUNTIME`; plugin cache data belongs under `SHUN_PLUGIN_CACHE_DIR`. The worker must not expect secrets in its environment or expose absolute paths to the view. Package workers are for generic structured processing, not for registering new host methods or running commands selected by iframe input.

## Views

- `entry` is package-relative and cannot contain `.` or `..` segments.
- `workspace.right` is the only plugin UI location. It opens in Shun's resizable auxiliary panel while the conversation remains present.
- `rail` defaults to `on-demand`. Installed packages cannot make themselves permanently resident in the activity rail; only built-in workspace utilities may use `workspace`. An on-demand view appears temporarily while open.
- `launch` declares the allowed presentation origins: `user`, `assistant`, `tool-result`, and `conversation-action`. Use only the origins the view actually supports. The host remains authoritative and may turn an open request into a non-disruptive action.
- `activation.fileChanges` is an optional list of 1–16 safe workspace-relative glob patterns. After a successful foreground file edit or write, a matching view contributes a compact tool-result card; it does not force the panel open. If that exact task view is already open, the host suppresses the duplicate card and the normal workspace watcher refreshes the view. This requires `tool-result` in `launch`. Use it only when the changed artifact is the view's primary subject, not as a broad file-type claim.
- A plugin Skill that needs visual UI should document its exact plugin/view ids and call `plugin_view_present` only when that UI materially completes the foreground workflow. Tool-only work must not open a panel.
- HTML uses a restrictive CSP and external same-package scripts/styles. Package-owned ES modules, fetches, and Web Workers are supported by the isolated `shun-plugin` origin; declare only the exact same-package CSP sources they need.
- The iframe keeps its package-specific origin so browser module and Worker rules work, but remains cross-origin from Shun and sandboxed without Node.js, forms, popups, downloads, top navigation, external network, or filesystem authority. It cannot access the host document or another plugin origin.
- User-initiated artifact export uses `exportFile({ name, data })`, which opens a host-owned destination-directory picker and writes a new file without exposing arbitrary filesystem access or overwriting an existing file.

## Agent Skills and model context

`contributes.skills` lists package-relative directories containing valid Agent Skill folders. The host indexes only names and short descriptions for discovery; it loads full `SKILL.md` instructions only after selection. Do not duplicate Skill bodies in the manifest or add them to a global prompt. Large tool catalogs follow the same deferred discovery rule and expose only a bounded exact schema subset after search.

## Onboarding and conversation UI

Supported onboarding steps are `info`, `permissions`, `choice`, `secret`, and `oauth`. See [onboarding.md](onboarding.md). Conversation actions declare `id`, `title`, `placement` (`message` or `composer`), and at least one of `command` or `viewId`; they require `conversation.ui`. A referenced view must allow the `conversation-action` launch source. Commands only place visible text in the draft; the user remains in control of sending it. A view action opens the declared panel without inventing model context.
