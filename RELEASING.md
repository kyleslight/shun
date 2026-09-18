# Releasing Shun

This document is for project maintainers. Release builds currently run from a macOS machine and produce installers for Apple Silicon macOS, Windows x64, and Linux x64.

## Prerequisites

- A clean, up-to-date `main` branch
- An authenticated GitHub CLI session with release access to `kyleslight/shun`
- A valid Apple Developer ID Application certificate
- Apple notarization credentials in the ignored `.env.release` file:

```dotenv
APPLE_ID=developer@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
```

- The host-owned Google OAuth client in the same ignored file, so released builds
authorize Gmail in one step:

```dotenv
SHUN_GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
SHUN_GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
```

These two values are the "Desktop app" OAuth client from Google Cloud
(APIs & Services → Credentials). The build bakes them into the main bundle, so
they never appear in the repository and installed builds carry their
registration without reading the environment at runtime. A build without them
ships no bundled client, and the Gmail plugin asks the user for their own
desktop client instead. Development builds read the same variables from the
shell environment.

Never commit `.env.release`.

## Build installers without publishing

```bash
pnpm package:all
```

This runs the test suite and type checker, builds every installer, and writes SHA-256 checksums to `release/` without uploading anything.

## Publish a release

```bash
pnpm release:publish
```

A release advances the patch version in the working tree and uses that version for every installer. It then uploads the installers and updater metadata to a draft GitHub Release. Only after every upload succeeds does it commit and push `package.json`, point the release at that commit, and publish it. If the final publish step is interrupted, rerunning the command retries the same version instead of skipping ahead.

Before publishing, the command requires a Developer ID signing identity and complete Apple notarization credentials. Installed builds check GitHub Releases shortly after launch and every ten minutes; development builds do not run the updater.

Publishing is written to survive a connection that drops calls. Reads that a release acts on
(owner, release lookup, release list, asset list, manifests) are retried while the failure is a
connection failure and are never read as their answer; a lookup answers "no release yet" only when
GitHub says the release is not found. A draft is never created twice: a `gh release create` that
failed is resolved by looking the release up again. A version commit whose `git push` failed is sent
by the next run instead of stopping at the clean-tree check. Rerun the same command after an
interruption; it resumes the version already on disk.

Terminal's Linux x64 native runtime is stored as a versioned, checksummed release cache under `scripts/native/`. Normal builds verify and install that cache before packaging, so the macOS release host never cross-compiles native modules. Rebuild the cache only when the `node-pty` version, native ABI requirements, or Linux target architecture changes.
