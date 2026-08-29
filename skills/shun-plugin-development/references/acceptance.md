# Plugin acceptance checklist

Use this checklist after implementation; it is not a second build manual.

## Package

- `manifest.json` validates and contains no unresolved placeholders.
- The selected workspace is the source of truth; installation does not require application-source changes.
- Entries and assets stay inside the package. Declared permissions are the minimum required.
- The package has a recognizable icon and no repeated host-owned title, icon, close control, or workspace header.

## Boundaries

- The view uses only the generated host client and declared capabilities.
- Workspace state is scoped per workspace; secrets stay in host storage.
- Optional workers have fixed entries, structured bounded input/output, timeouts, and explicit grants.
- Native dependencies declare exact OS/CPU artifacts in `runtime.executables`, are injected into fixed workers, and never assume a developer-machine command or user toolchain.
- A first-use runtime download is visibly labeled as installation, reports available progress, and is not presented as ordinary execution.
- Product verification uses the installed worker/runtime path, not a separate terminal command.
- Large immutable resources are declared through `runtime.assets`.
- Plugin failures remain contained and show a useful summary without exposing internal implementation details.

## Lifecycle

- The view opens, closes, and reopens without leaking state across tasks or workspaces.
- Reinstalling the same development directory reloads current manifest, code, and resources without restarting Shun.
- Loading, empty, ready, and error states do not overlap or reserve stale layout space.
- Theme, narrow-panel layout, cancellation, stale-result protection, and relevant workspace changes behave correctly.

## Verification

- Run `plugin_package action=validate` and package-local checks.
- Install or reload the requested package and run `plugin_view_test` for every contributed view.
- Exercise the primary non-destructive user flow and inspect DOM, screenshot, console, resource-load, and RPC diagnostics.
- Fix failures and repeat until the installed requested workflow passes. A generated stand-in or unrelated plugin is not evidence.
