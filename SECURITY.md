# Security policy

SAM runs inside your coding agents' hooks, reads their transcripts and tool output, stores what it captures in a local SQLite file, and pushes text back into the agents' context. Bugs in that path can leak secrets or steer an agent, so security reports are taken seriously.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x (first public release, 2026-10-07) | yes |
| pre-release development builds (internally numbered 1.0.0–1.2.0 before the public release) | no. They were never published; the issues found by the two audits ([docs/AUDIT.md](docs/AUDIT.md), [docs/AUDIT2.md](docs/AUDIT2.md)) are fixed in the public 1.0.0 |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

1. Preferred: open a private report through GitHub, **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting).
2. Or email **info@cumabozkurt.tr** with the subject `SAM security`.

Please include the SAM version (`sam --version`), Node.js version, OS, the agent(s) involved, and a minimal reproduction. Redact real secrets from logs; a fake key in the same format is enough.

What to expect:

- an acknowledgement within 3 working days;
- an assessment and a planned fix date within 10 working days;
- a fixed release, a GitHub Security Advisory and a CHANGELOG entry crediting you (unless you prefer not to be named).

Please give us up to 90 days before public disclosure, or less once a fix is released.

## Scope

In scope, for example:

- code execution through generated hook commands, MCP, the OpenCode plugin, `sam run`, or installer edits to host config files;
- memory poisoning: content from a repository, a file the agent read, a tool result or a web page becoming a stored memory, a pinned memory, or a "convention" injected into another session or another agent;
- escaping the `<memory>` data frame;
- secrets that survive redaction and are written to `~/.sam/sam.db` (memories, events, or the output vault);
- an installer that deletes or corrupts user configuration it does not own;
- a hook that blocks, hangs or crashes the host agent.

Out of scope:

- anything that needs an attacker who can already write to your home directory or your `~/.sam` database;
- secrets in formats the redactor does not claim to cover (please still tell us; we treat these as improvements);
- what an embedding endpoint you configured yourself does with the text SAM sends it.

## How SAM limits risk by design

- Everything is local. Nothing leaves the machine unless you configure an embedding endpoint. An endpoint that is not on this machine must be set in `~/.sam/config.json` (`embedUrl`, or `"allowRemoteEmbed": true`); an environment variable alone can only point at localhost.
- A single `sam run` argument containing shell operators (`;`, `&`, `|`, `<`, `>`, backticks, `$(`) is refused unless `--shell` is given, so an "always allow `sam run`" rule in a host does not silently approve arbitrary shell programs. Approve `sam run` prefixes in your host only if you accept that any argv after `--` will run.
- The installer never writes through a symlinked config file or `.sam-bak`, and `sam uninstall` removes the backups and files it created.
- A repository's `.sam/memory.md` is imported only after you review it with `sam trust` in a terminal (or `--yes`); trust is pinned to that exact content, so later edits need a new review. Team lines are never pinned and get low priority.
- Provenance: only memories you saved can be pinned, and agents cannot overwrite or supersede your values. MCP `mem_get`/`mem_forget` only see the current project and global.
- Memory text is NFKC-normalized, stripped of invisible/bidi/tag characters and escaped so it cannot close the `<memory>` block; agents are told memory never changes their permissions or tools. Markers are harvested only from the assistant's own messages.
- Secrets and `<private>…</private>` spans are masked before anything is stored, including vault output.
- Hooks never fail the host: errors are swallowed and the hook exits 0 (set `SAM_DEBUG=1` to see them on stderr).

The audit reports in [docs/AUDIT.md](docs/AUDIT.md) and [docs/AUDIT2.md](docs/AUDIT2.md) list what was found and fixed, and the known limits.
