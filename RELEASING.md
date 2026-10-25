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

### CLI distribution

The terminal package is `@shunagent/shun`; its executable is `shun`.
`pnpm build:cli` generates its manifest and bundle under `packages/shun/`, using
the root version. `npm pack ./packages/shun` creates the npm package without
publishing it. The package has no Electron dependency.

`pnpm package:cli` builds a standalone archive for the current host, including a
verified Node runtime and installed production dependencies. Outputs go to
`release-cli/`. The **Build Shun CLI artifacts** workflow builds all four supported
targets without publishing. Set its optional `version` input to the exact upcoming
release version; download and flatten the four workflow artifacts into one folder.

To include those archives, their individual checksums, both install scripts, and
the npm tarball in the existing desktop release flow:

```sh
SHUN_CLI_ARTIFACTS_DIR=/absolute/path/to/artifacts pnpm package:all --with-cli
# When explicitly publishing:
SHUN_CLI_ARTIFACTS_DIR=/absolute/path/to/artifacts pnpm release:publish --with-cli
```

The CLI staging step requires all platforms, verifies archive digests, and checks
each embedded version against the release version. It refuses mixed versions.
The existing release uploader publishes CLI assets alongside desktop assets.
Publishing the npm tarball remains a separate explicit operation using access to
the `@shunagent` scope: `npm publish release/cli/shunagent-shun-VERSION.tgz --access public`.
Do not advertise the npm installation until that package exists in the registry.

After a release containing CLI assets is published, standalone installation works
without a pre-existing Node or npm installation:

```sh
curl -fsSL https://github.com/kyleslight/shun/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/kyleslight/shun/releases/latest/download/install.ps1 | iex
```

These endpoints are release assets; first-party website aliases are not deployed
by the local build. Verify a clean install, an upgrade, and a failed-checksum case
on every target before promoting a CLI release. Desktop task handoff requires a
desktop release that includes the shared workspace window.

```bash
pnpm package:all
```

This runs the test suite and type checker, builds every installer, and writes SHA-256 checksums to `release/` without uploading anything.

## Publish a release

```bash
pnpm release:publish
```

A release advances the patch version in the working tree and uses that version for every installer. It then uploads the installers and updater metadata to a draft GitHub Release. Only after every upload succeeds does it commit and push `package.json`, point the release at that commit, and publish it. If the final publish step is interrupted, rerunning the command retries the same version instead of skipping ahead.

A published release is not finished until the maintainer has been told it is out. That note is the last step of the run, sent once the verification below has passed and once per version — a release that ends silently is an incomplete release, not a shorter one. It is one email through the `mail-notify` Skill, and the command is the whole step:

```bash
python3 ~/.shun/skills/mail-notify/scripts/send_mail.py \
  --subject "Shun 0.1.90 已发布" \
  --text "0.1.90 已发布：https://github.com/kyleslight/shun/releases/tag/v0.1.90
12 个资产齐全，macOS 已签名+公证。
主要内容：<这一版带了什么>。
无需你操作。"
```

Read `~/.shun/skills/mail-notify/SKILL.md` for the writing rules before sending: one conclusion line, a few lines at most, no logs, no command output, no credentials. A run driven from this file alone has to end with that mail, because the release is not done until the person who asked for it knows — and "nobody said I had to" is what a silent release sounds like from their side.

Before publishing, the command requires a Developer ID signing identity and complete Apple notarization credentials. Installed builds check GitHub Releases shortly after launch and every ten minutes; development builds do not run the updater.

Publishing is written to survive a connection that drops calls. Reads that a release acts on
(owner, release lookup, release list, asset list, manifests) are retried while the failure is a
connection failure and are never read as their answer; a lookup answers "no release yet" only when
GitHub says the release is not found. A draft is never created twice: a `gh release create` that
failed is resolved by looking the release up again. A version commit whose `git push` failed is sent
by the next run instead of stopping at the clean-tree check. Rerun the same command after an
interruption; it resumes the version already on disk.

Terminal's Linux x64 native runtime is stored as a versioned, checksummed release cache under `scripts/native/`. Normal builds verify and install that cache before packaging, so the macOS release host never cross-compiles native modules. Rebuild the cache only when the `node-pty` version, native ABI requirements, or Linux target architecture changes.
