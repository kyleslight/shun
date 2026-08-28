# Onboarding and settings

Onboarding is a host-rendered state machine declared in the manifest. It is not a privileged plugin page.

## Step ownership

- `info`: host renders title and description.
- `permissions`: host shows requested permissions/reasons and persists the exact granted set.
- `choice`: host persists a non-secret value under plugin preferences.
- `secret`: host writes through encrypted plugin secret storage; settings keep only connection state.
- `oauth`: host owns callback verification, token refresh, and secure storage, exposing only connection state/account label.

`reopenable: true` requires a later “Run setup again” or equivalent settings action. Re-running setup preserves working values until the user confirms replacements.

## Rules

- Never return stored secrets to iframe UI or renderer state.
- The host validates OAuth state, redirect origin, connector identity, and scopes.
- Permission and credential errors are recoverable; removing a plugin offers explicit disconnection where applicable.
- Added permissions or onboarding keys on update require review.
- Setup copy describes concrete effects and never claims connectivity before a real probe succeeds.
