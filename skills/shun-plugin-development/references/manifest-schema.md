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
  "icon": "plugin",
  "experimental": true,
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
      { "id": "example.main", "title": "Example", "location": "workspace.right", "entry": "ui/index.html" }
    ]
  }
}
```

## Identity

- `schemaVersion`: currently `1`.
- `id`: lowercase letters/numbers separated by `.` or `-`, at most 80 characters. Treat it as permanent.
- `version`: use semantic versioning for distributed packages.
- `publisher`: stable publisher identity.
- `experimental`: marks APIs or experiences that are not compatibility promises.

Source URLs, Marketplace ids, and install locations are not manifest authority and do not belong in runtime decisions.

## Permissions

- `workspace.git.read`: repository status, refs, bounded history, changed files, and diffs.
- `workspace.git.write`: structured, host-validated Git operations, including an explicit repository initialization action, in the selected workspace; never arbitrary command execution.
- `workspace.read`: bounded project file reads through host APIs.
- `workspace.reveal`: reveal a user-selected relative path in the operating system file browser without exposing absolute paths to the plugin view.
- `conversation.context`: bounded explicit task context contributions.
- `conversation.ui`: host-rendered conversation actions/cards.

Every permission requires a concise user-facing `reason`. Do not request speculative permissions.

With `workspace.read`, a view may call `workspace.list` and `workspace.read`. Reads use relative real paths within the selected workspace and return at most 1 MB per base64 chunk. The host also sends debounced `workspace.changed` events containing relative paths after the conversation or another local tool edits files. This is sufficient for a package-owned web/WASM LaTeX compiler to re-read dependencies, rebuild, and keep a PDF preview current without a feature-specific host integration.

## Views

- `entry` is package-relative and cannot contain `.` or `..` segments.
- HTML uses a restrictive CSP and external same-package scripts/styles.
- The iframe has scripts only: no Node.js, same-origin access, forms, popups, downloads, navigation, network, or filesystem authority.

## Agent Skills and model context

`contributes.skills` lists package-relative directories containing valid Agent Skill folders. The host indexes only names and short descriptions for discovery; it loads full `SKILL.md` instructions only after selection. Do not duplicate Skill bodies in the manifest or add them to a global prompt. Large tool catalogs follow the same deferred discovery rule and expose only a bounded exact schema subset after search.

## Onboarding and conversation UI

Supported onboarding steps are `info`, `permissions`, `choice`, `secret`, and `oauth`. See [onboarding.md](onboarding.md). Conversation actions declare `id`, `title`, `placement` (`message` or `composer`), and a host command, and require `conversation.ui`. Composer actions only place visible text in the draft; the user remains in control of sending it.
