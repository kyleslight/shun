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

## Download

Download the newest version from [GitHub Releases](https://github.com/kyleslight/shun/releases/latest).

- **macOS (Apple Silicon):** download the `.dmg`, open it, and drag Shun into Applications. The app is signed with a Developer ID certificate and notarized by Apple.
- **Windows (x64):** download and run the `Shun-Setup-...-x64.exe` installer.
- **Linux (x64):** download the `.AppImage`, or install the `.deb` package on Debian and Ubuntu.

Installed builds check for updates shortly after launch and every ten minutes. When a new version is available, Shun can download it and restart into the update.

## Windows and developer tooling

Shun never installs Node, Git, or any other developer tool for you, and it never asks you to install one to keep working. It runs commands with the shell you already have:

- **Command interpreter:** Git Bash when it is installed, otherwise PowerShell 7 (`pwsh.exe`), Windows PowerShell 5.1, or `cmd.exe`. The tool description in each session states which interpreter runs your commands and how to write them for it, so PowerShell works out of the box without Git.
- **Tool discovery:** the machine's own `Path` values (registry, both the machine and user scope) are re-read before every turn and before each command, together with conventional install locations for Git, Node.js, nvm-windows, Volta, and PowerShell 7. Tooling you install while Shun is running is therefore visible to the next command — no app restart.
- **Encoding:** commands run through PowerShell set UTF-8 output encoding first, so non-ASCII output does not arrive as mojibake on systems whose console code page is not UTF-8.
- **One interpreter everywhere:** the interactive terminal, background processes, and foreground commands all use that same resolved shell, so a command you paste into the terminal also works when the agent runs it.

Because nothing is installed for you, a tool that is unpacked without being added to `Path` (for example a manually extracted Node.js archive) stays invisible until you add it yourself or select a project-scoped environment such as `.venv` or `node_modules/.bin`.

## Browser Use

The optional Browser Use plugin works with the user's existing Chrome tabs and signed-in state. While its Chrome Web Store release is paused, use Shun's one-time **Set up Chrome** flow to load the bundled extension from a stable per-user folder. See the [installation guide](docs/browser-use-installation.md) and [privacy policy](PRIVACY.md).

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
