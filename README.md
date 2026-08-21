# Shun

Shun is a desktop agent for focused coding, research, and long-running work.

## Highlights

- Run multiple independent tasks without mixing drafts, approvals, or execution state.
- Keep exact task history and resume previous conversations.
- Work with local projects through explicit permission controls.
- Use web research, MCP tools, workspace review, and background processes.
- Render rich Markdown, code, tables, and interactive diagrams.
- Track active work from a compact task sidebar and process popover.

## Development

Requirements:

- Node.js 22 or later
- pnpm 10

```bash
pnpm install
pnpm dev
```

## Verification

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

## Packaging

```bash
pnpm run dist:mac
```

Generated packages are written to `release/` and are not tracked by Git.
