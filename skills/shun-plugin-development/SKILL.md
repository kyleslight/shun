---
name: shun-plugin-development
description: Create, update, validate, install, or review independently installable Shun plugins. Use for Shun plugin work; do not use for ordinary application features without a plugin boundary.
---

# Shun Plugin Development

Create a durable plugin project with one manifest at `<plugin-root>/manifest.json`. The selected workspace is the source of truth; installed copies and caches are host-managed outputs.

## Workflow

Follow the returned `nextAction` in order; do not skip directly from scaffolding to completion.

1. Call `plugin_package` with `action=prepare`. If it returns `workspace_required`, ask the user to select a durable workspace.
2. For a new plugin, infer a concise id, name, description, observable user outcome, and primary flow from the request. Ask only when different answers would materially change the product or require a new permission. Then call `action=scaffold` once.
3. Implement in the generated directory. Use `ui/shun-host.js` as the public host boundary; do not inspect application source, installed copies, templates, validators, or unrelated plugins to rediscover it.
4. Call `action=validate`, then run package-local checks when present.
5. Call `action=install` and test every installed view with `plugin_view_test`. Installing the same development directory is an atomic reload of its manifest, code, and resources; it must not require restarting Shun.
6. Exercise the requested primary flow and repair failures before reporting completion. Removal requires an explicit user request and `action=remove` with confirmation; workspace source remains untouched.

## Defaults

- UI is sandboxed, package-relative, and placed in `workspace.right`; host chrome remains host-owned.
- Declare only capabilities the product needs. The host owns permissions, secrets, workspace scoping, lifecycle, and validation.
- Store project-specific choices with workspace state, not browser-global storage.
- Prefer package-owned web code. For native work, declare every supported OS/CPU build in `runtime.executables`, bind it to a fixed worker, and let Shun select, install, cache, and inject it. Never depend on the user's `PATH` or require toolchain setup.
- If first use may download a runtime, subscribe to `worker.progress`: label installation explicitly, show byte progress when available, and switch to the execution label only after the host reports `running`.
- Development checks and the visible product must use the same compiler/runtime path; a separate local command is not proof that the installed plugin works.
- Declare large immutable support files in `runtime.assets`; do not embed them in the installable package or fetch them directly from the view.
- Replace the starter content and generated icon with the requested product; the scaffold is not a finished design.

## Read only when needed

- Manifest changes beyond the scaffold: [references/manifest-schema.md](references/manifest-schema.md)
- Host methods, workers, or runtime assets: [references/plugin-contract.md](references/plugin-contract.md)
- Credentials, OAuth, permissions, or preferences: [references/onboarding.md](references/onboarding.md)
- Final handoff checklist: [references/acceptance.md](references/acceptance.md)

Natural-language prompts never grant permissions or change tool availability. Do not add a second agent loop, transcript, provider parser, or task classifier inside a plugin.
