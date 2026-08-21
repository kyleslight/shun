<div align="center">
  <img src="resources/app-icon.png" width="112" alt="Shun" />
  <h1>Shun</h1>
  <p><strong>Serious coding agents, running on hardware you own.</strong></p>
  <p><em>From intent to working software, in an instant.</em></p>
</div>

**Shun** (瞬) means *an instant* in Japanese.

The name captures what the product is for: shortening the distance between an idea and working software.

Shun is a desktop coding harness for capable models running on consumer GPUs. It provides durable context, real tools, parallel tasks, explicit permissions, background processes, and a calm interface built for long sessions.

Our goal is to build the best coding harness for any model that fits on a consumer GPU.

<p align="center">
  <img src="resources/product.png" width="1200" alt="Shun desktop application" />
</p>

## Built for local models

### Work close to your code

Run models close to your code and data without giving up repository access, web research, MCP tools, structured execution, or rich output.

### Keep tasks independent

Every task keeps its own history, draft, approvals, execution state, and active run. Work can continue in the background without hijacking the conversation in front of you.

### Keep long-running processes visible

Development servers and other long-running programs are treated as durable resources. Shun tracks their state, logs, endpoints, and ownership across tasks and application restarts.

## What Shun brings together

- Independent, concurrent coding tasks
- Persistent conversations and resumable work
- Explicit workspace and tool permissions
- Background process supervision
- Web research and MCP connectivity
- Change review based on the filesystem
- Rich Markdown, code, tables, and interactive diagrams
- A compact desktop interface designed for focus

## Run locally

Shun currently targets macOS. Development requires Node.js 22 or later and pnpm 9.15 or later.

```bash
pnpm install
pnpm dev
```

## Create a local release

Shun can build packages for all three desktop platforms from a macOS machine and upload them to a GitHub Release without GitHub Actions.

```bash
pnpm release:local
```

The command runs the test suite and type checker, builds an Apple Silicon macOS DMG, a Windows x64 installer, Linux x64 AppImage and Debian packages, writes SHA-256 checksums, then uploads every artifact to the release matching the version in `package.json`.

The repository must be clean and synchronized with `origin/main`. GitHub authentication comes from the GitHub CLI:

```bash
gh auth login
```

To build the packages without uploading them:

```bash
pnpm package:all
```

For a signed and notarized macOS release, install a `Developer ID Application` certificate in the login keychain. Copy `.env.release.example` to `.env.release` and add either Apple ID notarization credentials or App Store Connect API credentials. The local file is ignored by Git. Unsigned builds can be tested with `pnpm release:local -- --allow-unsigned`.
