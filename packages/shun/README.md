# Shun

**Serious coding agents, running on hardware you own.**

[Website](https://shunagent.com) · [GitHub](https://github.com/kyleslight/shun) · [Download Desktop](https://shunagent.com/download) · [Report an issue](https://github.com/kyleslight/shun/issues)

Shun brings streaming conversations, coding tools, Agent Skills, and plugins to
your terminal. Connect a local model server or a hosted model provider.

## Install

Requires **Node.js 22.19 or newer** on macOS, Linux, or Windows.

```sh
npm install -g @shunagent/shun
shun
```

Alternatively, use `pnpm add -g @shunagent/shun` or `bun add -g @shunagent/shun`.
The terminal app can run without Shun Desktop.

## Start a conversation

```sh
shun                       # Start without selecting a project
shun .                     # Work in the current directory
shun /path/to/project      # Work in another project
shun -c                    # Continue the latest conversation in this scope
shun -r                    # Choose a conversation from history
shun --session <id>         # Resume a specific conversation
shun tasks                 # List conversations
shun run "Explain this project" --workspace .
```

On first use, follow the prompts to connect a provider and choose a model.
Existing local Shun provider settings are reused. Type `/` to open the command
menu. `/connect` adds a connection, `/providers` manages connections, and `/model`
chooses a model. `/new` starts a new conversation; `/resume` opens history.

Answers stream as they arrive. Markdown and tables render in the terminal.
Click an activity row to expand its details. Older messages appear in pages of
24; scroll up and click **Show earlier messages** to read more.

Ctrl+C stops the current generation, cancels an open menu, or returns from a
finished conversation to the welcome screen. At the welcome screen, press it
twice to exit. Ctrl+D on an empty prompt detaches from Shun. Exiting the terminal
does not stop background tasks; use `/stop` to stop the current run.

## Command reference

### In your shell

| Command | What it does |
| --- | --- |
| `shun` | Start a new conversation without choosing a project. |
| `shun .` or `shun <folder>` | Start in the current directory or a chosen project. |
| `shun -c` / `--continue` | Continue the most recent conversation in the selected project scope. |
| `shun -r` / `--resume` | Search and choose a saved conversation. |
| `shun --session <id>` | Reopen a specific conversation; `--task` is an alias. |
| `shun run "message" --workspace <folder>` | Send a message and stream the answer to standard output. |
| `shun run "message" --task <id>` | Continue a saved conversation without opening the TUI. |
| `shun tasks` | Print conversation IDs, running status, and titles. |
| `shun service status` | Check whether the local background service is running. |
| `shun service stop` | Stop the service when its tasks are idle. |
| `shun desktop` | Open Shun Desktop. |
| `shun desktop --install` | Download and verify the Desktop installer. |
| `shun --help` / `-h` | Show commands and their descriptions. |
| `shun --version` / `-v` | Print the installed CLI version. |

### Inside a conversation

Type `/` for searchable suggestions, or `/help` for the command picker.

| Command | What it does |
| --- | --- |
| `/connect` | Add a model provider connection. |
| `/providers` | Manage provider credentials, settings, and connection tests. |
| `/model` | Choose the provider and model for this conversation. |
| `/new [folder]` | Start a new conversation, retaining the current project unless a folder is supplied. |
| `/new --no-workspace` | Start a new conversation without a project. |
| `/clear` | Start fresh; preserve the previous conversation in history. |
| `/resume` | Find and reopen a conversation, initially scoped to the current project. |
| `/tasks` | Browse conversations across projects. |
| `/session` | Show this conversation's ID and project. |
| `/name <title>` | Rename this conversation. |
| `/trust` | Review project configuration trust. |
| `/paste` | Attach an image from the local clipboard. |
| `/attach <path>` | Attach an image file, for example `/attach /tmp/screenshot.png`. |
| `/images` | Preview or remove images attached to your next message. |
| `/processes` | Inspect output from or stop task-owned background processes. |
| `/skills` | Enable, disable, or install Agent Skills. |
| `/desktop` | Open this conversation in Shun Desktop. |
| `/stop` | Stop the current generation. |
| `/quit` | Exit the terminal interface; background tasks can continue. |
| `/help` | Browse command descriptions and insert a selected command. |

## Images

On macOS, use **Cmd+V**. If iTerm2 asks how to paste an image, choose **Save to
Temp File and Paste Path**; you can remember that choice. Shun recognizes a single
pasted image path and adds it as an attachment. Ordinary pasted text stays text.

`/paste` reads an image from the local clipboard, `/attach /path/to/image.png`
attaches an image file, and `/images` previews or removes pending attachments.
A remote SSH terminal cannot read your computer's local clipboard.

## Desktop, plugins, and saved conversations

[Shun Desktop](https://shunagent.com/download) provides the graphical interface.
Compatible Desktop and terminal versions share conversations and model settings
on the same machine. With Desktop running, the terminal can also use its browser
and computer tools. Remote access uses Desktop's existing Remote connection.
Plugin graphical views stay in Desktop; the terminal exposes supported tools and
Agent Skills. Standalone Browser Preview uses a separate testing browser.

Use `/desktop` to open the current conversation in Desktop. Older Desktop
versions may need an update to support shared conversations and capabilities.

Shun stores its local profile under `~/.shun`. Set `SHUN_HOME` to use an isolated
profile. A selected project is a working directory, not a filesystem sandbox;
tools run with your account's permissions.

## Update

```sh
npm install -g @shunagent/shun@latest
shun --version
```

This updates the npm installation. Desktop updates separately. Restart the
terminal interface to load its new version. If a background service needs a
restart, use `shun service stop` after its tasks finish. There is currently no
`shun upgrade` command.

## Learn more

- [Shun website](https://shunagent.com)
- [Source code and documentation](https://github.com/kyleslight/shun)
- [Desktop downloads](https://shunagent.com/download)
- [Issues and feedback](https://github.com/kyleslight/shun/issues)

MIT licensed.
