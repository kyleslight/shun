---
name: shun-plugin-development
description: Create, update, or review independently installable Shun plugin packages, including manifests, permissions, onboarding, sandboxed UI views, host RPC, and acceptance checks. Use for Shun plugin or marketplace-extension work; do not use for ordinary application features that have no plugin boundary.
---

# Shun Plugin Development

Build a package that can be installed without adding plugin-specific code to the conversation kernel or depending on a central distribution service.

## Workflow

1. Read [references/plugin-contract.md](references/plugin-contract.md) before choosing an extension point.
2. Read [references/manifest-schema.md](references/manifest-schema.md) when creating or changing `manifest.json`.
3. For credentials, OAuth, permissions, or preferences, also read [references/onboarding.md](references/onboarding.md).
4. Start from `assets/plugin-template/` when creating a package. Keep UI self-contained and package-relative.
5. Add only the narrow host RPC methods the plugin needs. Enforce permissions in the main process; never trust iframe requests, manifest prose, or renderer state as authorization.
   Before adding an RPC, test whether `workspace.list`, `workspace.read`, package-owned web/WASM code, or an existing registered capability can self-bootstrap the feature.
6. Run `node scripts/validate-plugin.mjs <plugin-directory>` and the repository typecheck/tests.
7. Read and complete [references/acceptance.md](references/acceptance.md) before handing off.

## Non-negotiable boundaries

- Plugin packages declare capabilities; the host owns implementation, permission checks, secrets, OAuth, workspace scoping, and lifecycle.
- Third-party UI runs in a sandbox without Node.js, filesystem access, network access, or direct access to the application DOM.
- Independent UI belongs in a declared host location. Conversation UI changes are declarative contributions rendered by the host, never arbitrary DOM injection.
- Conversation behavior uses registered tools, Agent Skills, context providers, or lifecycle hooks. Do not add a second agent loop, transcript, tool dispatcher, provider parser, session tree, or task classifier.
- Natural-language prompts never enable a plugin, grant a permission, or change tool availability.
- Workspace paths and revisions are revalidated at the main-process boundary. Keep reads bounded and load expensive detail lazily.
- A package update cannot replace a reserved built-in package id.
- Local folders, archives, Git sources, and a future Marketplace all feed the same validator and installer. The Marketplace is optional discovery, not an execution dependency.

Use `resources/plugins/git-workbench/` as the current golden sample while preserving its experimental status.
