# Integrations

SAM connects to each agent in three layers:

1. **Hooks** do automatic capture (prompts, edits, commands, replies) and injection (session card, per-prompt recall, file notes, fix pushes).
2. **MCP** gives explicit search and save (`mem_search`, `mem_get`, `mem_save`, `mem_forget`; see [MCP server](mcp.md)).
3. **Rules / skill** are a short text that teaches the agent the marker syntax, `sam-memory` and `sam run`.

If a host changes its hook system, capture degrades gracefully: MCP, rules and the CLI keep working.

`sam install` writes all three for every detected agent. Here is what it writes, per host.

## Common to all hosts

- **Launcher.** `~/.sam/bin/sam` (POSIX sh, also used by Git Bash), plus `sam.cmd` and `sam.ps1` on Windows. Hook and MCP entries call it, and it finds Node at run time: `SAM_NODE`, `PATH`, the Node that ran `sam install`, Homebrew `opt`, nvm `current`, Volta, and on Windows nvm-windows (`NVM_SYMLINK`) and `%ProgramFiles%\nodejs`. A Node that is too old is skipped. The `SAM_HOME` at install time is baked in as the default.
- **Backups.** Each edited config file gets a one-time `<file>.sam-bak`. SAM never writes through a symlinked config file. Everything it creates is tracked in `~/.sam/install-manifest.json`, so `sam uninstall` removes exactly that.
- **Self-test.** After installing, each installed command runs once through the shell its host uses (with `SAM_SELFTEST=1`, so nothing is written) and the result is printed. `sam doctor` repeats it any time.
- **Agent identity.** Each host's entries pass `--agent <host>`, so memories and handoffs record which agent wrote them.

## Claude Code

| What | Where |
|---|---|
| Hooks | `~/.claude/settings.json`: `SessionStart` (every source, including `compact` and `fork`), `UserPromptSubmit`, `PostToolUse` (Edit, MultiEdit, Write, NotebookEdit, Bash, PowerShell, Read), `PostToolUseFailure` (Bash, PowerShell; needed for fail→fix capture), `PreCompact`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd` |
| MCP | `claude mcp add --scope user sam -- …` when the `claude` CLI is on `PATH`, else an `mcpServers.sam` entry in `~/.claude.json` |
| Skill | `~/.claude/skills/sam-memory/SKILL.md` |

`CLAUDE_CONFIG_DIR` is honored (`.claude.json` then lives inside it). Claude Code ≥ 2.1.139 gets exec-form hook commands (no shell); older versions get a quoted shell command. Subagents get their own small card (`SubagentStart`) and their transcripts are harvested (`SubagentStop`).

## Codex CLI

| What | Where |
|---|---|
| MCP | `~/.codex/config.toml`: a `[mcp_servers.sam]` table between `# >>> sam (super-agent-memory)` / `# <<< sam` markers |
| Hooks | `~/.codex/hooks.json`: `SessionStart` (startup, resume, clear, compact), `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `Stop` |
| Rules | a `<!-- sam:start -->…<!-- sam:end -->` block in `~/.codex/AGENTS.md` |
| Skill | `~/.agents/skills/sam-memory/SKILL.md` (the shared skills folder; a legacy `~/.codex/skills/sam-memory` is removed) |

`CODEX_HOME` is honored. **Codex runs user hooks only after you approve them once: open Codex and run `/hooks`.** Until then only MCP, rules and the CLI work. `sam doctor` reminds you.

## Gemini CLI

| What | Where |
|---|---|
| MCP | `~/.gemini/settings.json` → `mcpServers.sam` (15 s timeout) |
| Hooks | same file: `SessionStart`, `BeforeAgent` (per-prompt recall), `AfterTool` (write_file, replace, edit, run_shell_command, read_file), `PreCompress`, `AfterAgent`, `SessionEnd` |
| Rules | a `<!-- sam:start -->` block in `~/.gemini/GEMINI.md` |

Detected by `~/.gemini/settings.json` or a `gemini` binary.

## Antigravity

| What | Where |
|---|---|
| MCP | `~/.gemini/config/mcp_config.json` (and the legacy `~/.gemini/antigravity/mcp_config.json` when that folder exists) |
| Hooks | `~/.gemini/config/hooks.json`, under a `super-agent-memory` key: `PreInvocation` (card and recall), `PostToolUse` (write_to_file, replace_file_content, multi_replace_file_content, run_command, view_file), `Stop` |
| Hook wrappers | one argument-free script per event in `~/.sam/bin/` (`antigravity-<Event>`, `.cmd` on Windows), because Antigravity runs hook commands as single unquoted paths |
| Rule | `~/.gemini/config/rules/sam-memory.md` (`trigger: always_on`) |
| Skill | `~/.gemini/config/skills/sam-memory/SKILL.md` |

Detected by `~/.gemini/antigravity`, `~/.gemini/antigravity-cli` or `~/.gemini/config`, or an `agy` / `antigravity` binary. If `~/.sam/bin` contains spaces or shell characters, the installer warns: set `SAM_HOME` to a simple path if hooks do not fire.

## OpenCode

| What | Where |
|---|---|
| MCP | `~/.config/opencode/opencode.json` (or `opencode.jsonc` if that exists) → `mcp.sam` (`type: local`) |
| Rules | `~/.config/opencode/sam-memory.md`, referenced from `instructions`. If you already have a non-empty `~/.config/opencode/AGENTS.md`, the block goes there instead. SAM never creates that file, because its existence makes OpenCode skip `~/.claude/CLAUDE.md` |
| Plugin | `~/.config/opencode/plugins/sam-memory.js`, which forwards OpenCode events to `sam hook`: `chat.message` (card on the first message, then per-prompt recall), `tool.execute.after`, `session.idle` (harvests the final reply), `session.compacted` / `experimental.session.compacting` (card re-sent into the compaction context), `session.deleted` |

`XDG_CONFIG_HOME` is honored. Comments in `opencode.jsonc` are not preserved when SAM rewrites it; the original stays in the `.sam-bak` file and the installer says so. The plugin is asynchronous with an 8 s cap, so it never blocks OpenCode.

## Cursor

| What | Where |
|---|---|
| MCP | `~/.cursor/mcp.json` → `mcpServers.sam` (`type: stdio`) |
| Hooks | `~/.cursor/hooks.json`: `sessionStart` (card), `beforeSubmitPrompt` (prompt capture), `postToolUse` (Shell, Write, Read: file notes and capture), `postToolUseFailure` (Shell), `afterAgentResponse` (marker harvest), `preCompact`, `sessionEnd` |

Cursor has no hook that can inject context per prompt, so on Cursor per-prompt recall goes through MCP (`mem_search`). Cursor also runs Claude Code hooks from `~/.claude` / `.claude` (Third-Party Imports). SAM's Claude hooks detect Cursor and stay silent when SAM's Cursor hooks are installed, so nothing fires twice.

## Any other MCP client

For Windsurf, Cline, Zed, Copilot, Roo, Goose or any other client, run:

```bash
sam snippet
```

It prints an `mcpServers` JSON entry pointing at your launcher, plus the rules block to paste into the client's rules or instructions. You get search and save through MCP, inline markers through the rules, and `sam run` through the client's shell tool. Automatic capture and injection need hooks, which only the six hosts above get.

## Windows

- Hook commands are generated per host shell. Claude Code ≥ 2.1.139 uses exec form. Older Claude uses Git Bash when present, else PowerShell. Gemini CLI and Cursor get PowerShell (`& '…\sam.cmd' …`), and Codex gets cmd quoting. Hosts that spawn without a shell (Claude exec form, MCP entries, the OpenCode plugin) call `node.exe` + `sam.js` directly, because `.cmd` files need a shell.
- `sam run` uses Git Bash if installed, else PowerShell, else cmd. `SAM_SHELL=bash|powershell|cmd` overrides. Output in a non-UTF-8 console code page (CP857, Windows-1254, …) is decoded with that code page, and `SAM_VAULT_ENCODING` forces an encoding.
- CI runs the whole test suite on Windows with Node 22.16 and 24, including simulated command generation for every host. Real-host execution of every shell form is less battle-tested than on POSIX; `sam doctor` self-tests what was installed.

## One database per environment

SQLite's WAL mode needs shared memory on one kernel. Keep one local `SAM_HOME` per environment: Windows, each WSL distro, each container or devcontainer, each SSH host.

Do not point `SAM_HOME` at any of these:

- `/mnt/c/…` from WSL;
- an NFS, SMB, 9p or FUSE mount;
- a Docker Desktop bind mount shared with the host;
- a Dropbox, iCloud Drive, OneDrive or Google Drive folder.

If the database sits on such a filesystem anyway, SAM uses the slower rollback journal instead of WAL, and `sam install` / `sam doctor` warn. Set `SAM_ALLOW_SHARED_FS=1` to force WAL if you know the mount is safe.

To move memories between environments:

```bash
sam export --jsonl --all-projects -o sam-backup.jsonl   # in the old environment
sam import sam-backup.jsonl --trusted                    # in the new one
```

With `--trusted` each JSONL row keeps its project, pin and provenance. Repos with a git remote have the same project id everywhere, while remote-less repos are keyed by path, so give those a `.sam-project` name first. Without `--trusted`, everything lands unpinned in the project of the current directory. You can also share project knowledge through a committed `.sam/memory.md` (see [Concepts → Team file](concepts.md#team-file)).


**Devcontainers:** run `sam install` inside the container (for example in `postCreateCommand`), and mount a named volume at `~/.sam` if memory should survive rebuilds.

## Adding a host

See [Architecture → Extending to a new host](ARCHITECTURE.md#extending-to-a-new-host): event names go into `normalize()` in `src/hooks.js`, the reply shape into `reply()`, and an installer plus a command form into `src/install.js`.
