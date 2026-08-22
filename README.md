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

## Build installers locally

Build the Apple Silicon macOS DMG, Windows x64 installer, Linux x64 AppImage, and Debian package from a macOS machine:

```bash
pnpm package:all
```

The command runs the test suite and type checker, builds every installer, and writes SHA-256 checksums to `release/`. It does not upload anything.

## Publish a release

From a clean, up-to-date `main` branch on macOS, authenticate the GitHub CLI and configure the Apple signing values in `.env.release`, then run:

```bash
pnpm release:publish
```

Each successful release advances the patch version (for example, `0.1.0` to `0.1.1`), commits and pushes that version, and uploads the installers plus the updater metadata to a GitHub Release. If publishing is interrupted after the version commit, rerunning the command retries that same version instead of skipping ahead.

Installed builds check GitHub Releases shortly after launch and every ten minutes. When a newer version exists, an update button appears beside the Shun logo; it downloads the update and then offers to restart and install it. Development builds never run the updater.
