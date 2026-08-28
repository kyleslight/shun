# Plugin acceptance standard

## Package and distribution

- `manifest.json` validates; ids are stable; entries stay inside the package; no symlinks or placeholders.
- The package installs from a local directory without application source changes or a central service.
- Each archive, Git, or Marketplace source is normalized through the same validator/installer.
- Installed packages cannot shadow reserved built-in ids.
- Removal disables contributions without deleting workspace data or external accounts.
- A package-owned web/WASM feature can be installed and run through generic host APIs without feature-specific changes to Shun.

## Permissions and security

- Every RPC maps to an exact permission and validates plugin/view/method/payload/workspace/path/revision.
- UI is sandboxed with restrictive CSP, no Node.js/application DOM/direct network/filesystem access.
- Secrets use encrypted host storage and never appear in renderer props, settings, logs, exports, screenshots, or errors.
- Added permissions on update require renewed consent.

## UX and onboarding

- Install shows publisher, version, experimental status, permissions, and reasons.
- Setup supports cancellation, retry, and later editing without prematurely discarding working authorization.
- Views fit their location, preserve conversation when required, resize, handle narrow windows, and follow theme/language.
- Loading, empty, error, stale-selection, and unavailable-workspace states exist.

## Conversation boundaries

- Behavior uses declared Agent Skills, tools, context providers, hooks, or host-rendered contributions.
- Prompt wording never controls availability, permission, execution mode, or hidden policy.
- Tasks keep plugin state, runs, drafts, queues, and resources isolated.

## Performance and verification

- Initial lists are bounded and pagination is tested; detail/diffs load after selection.
- Workspace file access rejects absolute paths, traversal, and symlink escapes, and streams binary-safe chunks rather than loading arbitrary files whole.
- Requests have bounded time/output and stale results cannot replace current selection.
- Conversation-driven workspace changes reach an open view through debounced path-only events and trigger bounded dependency reloads without polling.
- UI remains usable with 500 refs, 500 commits, 2,000 files, and a diff at the host limit.
- Run the skill validator plus repository typecheck/tests.
- Add parser/authorization tests for malformed/adversarial inputs and exercise the installed host.
- Inspect the final diff for product-boundary naming leaks and unrelated changes.
