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

Terminal's Linux x64 native runtime is stored as a versioned, checksummed release cache under `scripts/native/`. Normal builds verify and install that cache before packaging, so the macOS release host never cross-compiles native modules. Rebuild the cache only when the `node-pty` version, native ABI requirements, or Linux target architecture changes.
