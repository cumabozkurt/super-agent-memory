# SAM documentation

SAM (super-agent-memory) is one local, token-frugal memory shared by every coding agent on a machine. These pages go deeper than the [README](../README.md); everything here describes the code in this repository.

## Using SAM

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Requirements, installing, wiring your agents, checking that it works, upgrading and uninstalling |
| [Concepts](concepts.md) | Projects, memory kinds, provenance, inline markers and directives, supersession, the session card, per-prompt recall, the ledger, the output vault, team files and handoffs |
| [CLI reference](cli.md) | Every `sam` command and flag, exit codes |
| [MCP server](mcp.md) | The four tools, their arguments and limits, protocol details |
| [Configuration](configuration.md) | Every `config.json` key with its default, environment variables, precedence |
| [Integrations](integrations.md) | What `sam install` writes for Claude Code, Codex CLI, Gemini CLI, Antigravity, OpenCode and Cursor; Windows; other MCP clients; containers and WSL |
| [FAQ and troubleshooting](faq.md) | Common questions and fixes |

## How it is built and measured

| Page | What it covers |
|---|---|
| [Architecture](ARCHITECTURE.md) | Principles, data model, write path, capture, retrieval, injection, vault, MCP, hygiene |
| [Benchmarks](benchmarks.md) | What each benchmark measures, how to reproduce it, and its limits |
| [Research](RESEARCH.md) | The review of 50 agent-memory projects that shaped the design |
| [Audit summaries](AUDIT.md), [second audit](AUDIT2.md) | What two pre-release audits found and what was fixed (detailed notes in [`audit/`](audit/) and [`audit2/`](audit2/)) |

## Project

- [Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) · [Security policy](../SECURITY.md) · [Changelog](../CHANGELOG.md) · [License (MIT)](../LICENSE)
- Türkçe genel bakış: [README.tr.md](../README.tr.md)
