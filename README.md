<div align="center">
  <img src="resources/app-icon.png" width="112" alt="Shun" />
  <h1>Shun</h1>
  <p><strong>The coding harness that makes consumer-GPU models feel first-class.</strong></p>
  <p><em>From intent to working software—in an instant.</em></p>
</div>

---

**Shun** — **瞬** — is the Japanese word for *an instant*.

The name reflects a simple belief: useful AI should collapse the distance between an idea and working software, on hardware people can actually own.

Shun is a desktop coding harness for capable models running on consumer GPUs. It gives them the environment they need to do serious work: durable context, real tools, parallel tasks, explicit permissions, background processes, and a calm interface built for long sessions.

Our ambition is straightforward: **build the best coding harness for any model that fits on a consumer GPU.**

## Built for serious local work

### Local-first, not local-limited

Run powerful models close to your code and data while retaining the workflows expected from a modern coding agent: repository access, web research, MCP tools, structured execution, and rich output.

### Many tasks, one calm workspace

Every task keeps its own history, draft, approvals, execution state, and active run. Work can continue in the background without hijacking the conversation in front of you.

### Processes that outlive a reply

Development servers and other long-running programs are treated as durable resources. Shun tracks their state, logs, endpoints, and ownership across tasks and application restarts.

### Evidence over theater

Workspace changes come from filesystem truth. Runtime claims come from live processes and real probes. The interface shows what happened without turning the conversation into a wall of machinery.

## What Shun brings together

- Independent, concurrent coding tasks
- Persistent conversations and resumable work
- Explicit workspace and tool permissions
- Background-process supervision
- Web research and MCP connectivity
- Filesystem-grounded change review
- Rich Markdown, code, tables, and interactive diagrams
- A compact desktop interface designed for focus

## Development

Shun currently targets macOS. Development requires Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm dev
```

Run the verification suite:

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

Create a macOS package:

```bash
pnpm run dist:mac
```

Generated packages are written to `release/` and are not tracked by Git.
