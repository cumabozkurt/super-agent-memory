# Getting started

## Requirements

- **Node.js 22.16+ (22.x) or 24+.** SAM uses the built-in `node:sqlite` module with FTS5 and the trigram tokenizer. Node 22.13–22.15 and every 23.x ship `node:sqlite` without FTS5; SAM refuses them with a one-line message (`sam: Node.js 22.16+ (22.x) or 24+ is required …`), and hooks stay silent instead of failing the host.
- Nothing else: no npm dependencies, no Python, no Docker, no API key. SAM never calls a model.
- macOS, Linux and Windows are tested in CI. On Windows, see [Integrations → Windows](integrations.md#windows).

Check your Node version:

```bash
node --version   # v22.16.0 or later on 22.x, or v24+
```

## Install

SAM is published on npm as [`super-agent-memory`](https://www.npmjs.com/package/super-agent-memory):

```bash
npm i -g super-agent-memory

# or a specific GitHub release tarball (offline / pinned installs)
npm i -g https://github.com/cumabozkurt/super-agent-memory/releases/download/vX.Y.Z/super-agent-memory-X.Y.Z.tgz

# or from a clone (handy if you want to hack on it)
git clone https://github.com/cumabozkurt/super-agent-memory.git
cd super-agent-memory
npm link
```

Each [GitHub release](https://github.com/cumabozkurt/super-agent-memory/releases) also carries `SHA256SUMS.txt`; to check a tarball, download both files and run `sha256sum -c SHA256SUMS.txt`. The npm package is published from GitHub Actions with [provenance](https://docs.npmjs.com/generating-provenance-statements), so `npm audit signatures` can verify where it was built.

The package installs three names for the same CLI: `sam`, `sam-memory` and `super-agent-memory`. If `sam` on your machine is the AWS SAM CLI, use `sam-memory`. The rules and skills SAM writes for agents always call `sam-memory`.

```bash
sam-memory --version
```

## Wire your agents

```bash
sam install --dry-run   # preview: which files would be written
sam install             # detect installed agents and wire hooks + MCP + rules
```

`sam install` detects Claude Code, Codex CLI, Gemini CLI, Antigravity, OpenCode and Cursor from their config folders (and their binaries on `PATH`). To choose explicitly:

```bash
sam install claude codex   # only these
sam install --all          # every supported agent
```

What it does, in short (details per host in [Integrations](integrations.md)):

1. Writes a small launcher, `~/.sam/bin/sam` (plus `sam.cmd` and `sam.ps1` on Windows). Hooks and MCP entries call the launcher, which finds Node at run time, so upgrading or switching Node (Homebrew, nvm, Volta) does not break them.
2. Adds SAM's hook entries, its MCP server and a short rules block / skill to each host's config. Each edited file gets a one-time `.sam-bak` backup. SAM never writes through a symlinked config file.
3. Runs every installed command once through the shell its host uses and prints `self-test: N/N commands ran through their host shell`.

Then **restart your agents**. Codex CLI runs user hooks only after you approve them once: open Codex and run `/hooks`.

## Check that it works

```bash
sam doctor
```

`sam doctor` prints the Node and DB status, which agents were detected, the token budgets, the MCP schema size, config problems, broken install paths, and a self-test of every installed hook and MCP command. It exits 1 when a check fails.

Save something and look at what an agent would receive:

```bash
cd ~/code/my-project
sam add "package manager: pnpm, never npm" -k convention
sam add "queue: SQS, not Kafka" -k decision
sam context --prompt "which queue do we use?"
```

`sam context` prints the session card exactly as an agent gets it at session start, the per-prompt recall for `--prompt`, and their token counts.

From now on most of SAM is automatic:

- At **session start** each agent receives a short project card (≤320 tokens by default).
- On **each prompt** a few relevant lines are added only when a relevance gate passes (≤160 tokens).
- Agents save durable facts with an inline marker in their reply (`⟦mem decision: queue: SQS, not Kafka⟧`), with the `mem_save` MCP tool, or with `sam-memory add`.
- You can simply say *"remember that …"*, *"from now on …"*, *"always / never …"* (Turkish: *"unutma …"*, *"bundan sonra …"*, *"her zaman / asla …"*) and it is saved as a fact, convention, preference or decision.

See [Concepts](concepts.md) for how each piece works.

## Where data lives

| Path | What |
|---|---|
| `~/.sam/sam.db` (+ `-wal`, `-shm`) | the SQLite database (files `0600`, folder `0700`) |
| `~/.sam/config.json` | optional configuration ([Configuration](configuration.md)) |
| `~/.sam/bin/` | the launcher(s) and Antigravity hook wrappers |
| `~/.sam/install-manifest.json` | which files and backups `sam install` created (used by `sam uninstall`) |
| `~/.sam/drafts/` | skill drafts from `sam skills draft` (never installed automatically) |

`SAM_HOME` moves all of it. Keep one `SAM_HOME` per environment (each OS, WSL distro, container or SSH host) on a local disk; see [Integrations → One database per environment](integrations.md#one-database-per-environment).

## Upgrade

Reinstall the newer version the same way you installed it (`npm i -g super-agent-memory@latest`, the new release's tarball URL from [Releases](https://github.com/cumabozkurt/super-agent-memory/releases), or `git pull` in your clone), then run `sam install` once more so the launcher and host entries point at the new files. `sam doctor` reports entries that point at missing paths (`BROKEN: … → run sam install`).

Database migrations run automatically. An older SAM that meets a database written by a newer one opens it read-only instead of damaging it.

## Uninstall

```bash
sam uninstall          # agents that are currently wired
sam uninstall --all    # every supported agent
```

`sam uninstall` removes exactly what `sam install` added: hook entries, MCP entries, rules blocks, skills, the launcher (once no agent uses it), the `.sam-bak` backups it made, and any config file it created that is empty again. Your memories stay in `~/.sam/sam.db`; delete `~/.sam` yourself if you want them gone (or use `sam purge`, see [CLI reference → Maintenance](cli.md#maintenance)). Then remove the package (`npm rm -g super-agent-memory`, or `npm unlink` in your clone).

## Next steps

- [Concepts](concepts.md): what gets captured and injected, and why.
- [CLI reference](cli.md): every command.
- [Configuration](configuration.md): budgets, gates, privacy switches, optional embeddings.
