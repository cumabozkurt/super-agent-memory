# Audit — v1.1.0

> **Second audit:** v1.1.0 was audited again from six perspectives (security, robustness, multi-agent workflow, cross-platform, packaging, retrieval quality) and fixed in v1.2.0. See [AUDIT2.md](AUDIT2.md).

Two independent reviews of v1.0.0 were run on 2026-10-07, followed by a fix pass:

1. **Adversarial code audit.** Line-by-line, every finding reproduced. 2 Critical, 10 High, 15 Medium, 24 Low. Full report: [audit/code-audit.md](audit/code-audit.md).
2. **Host integration audit.** Every config path, hook payload field, reply format and tool name checked against current official docs and host source code. 17 wrong items, 8 unverifiable. Full report: [audit/integration-audit.md](audit/integration-audit.md).

Line numbers in both reports refer to v1.0.0 (`670b9b4`).

## Results after the fix pass

| Check | v1.0.0 | v1.1.0 |
|---|---|---|
| Search latency, 20k memories | 47 s | 39 ms |
| Prompt hook end to end, 20k memories | several seconds | 75 ms |
| Insert, 20k memories | 2.3–3.2 ms | 0.78 ms |
| `sam gc`, 20k memories | 6.9 s | 0.18 s |
| Parallel hooks on a fresh DB (160 processes) | 6 "database is locked" per 120 | 0 |
| Hook with a host that keeps stdin open | killed at the host timeout | exits at ~1.5 s |
| Token estimator vs tiktoken o200k (held-out prose / code) | +16% to +75% (hex −62%) | +1% / −2% (on real cards: −4.7% mean; recalibrated in v1.2.0) |
| Generated hook commands executed from real installed configs (6 hosts) | — | 28 of 28 ran, all with valid JSON output |
| Tests | 14 | 22 |

## Fixed

**Critical**
- C1: FTS query plan. `CROSS JOIN` makes SQLite drive from the match.
- C2: duplicate merge kept the old meaning. Negations ("not", "before/after", "değil", "asla"…) stay in the fingerprint, a merge needs equal polarity, the newest wording wins, and text with an empty fingerprint never merges.

**High**
- H1: stdin is detached and destroyed after a full JSON document, EOF, or 1.5 s.
- H2: `sam run` with several args shell-quotes each one.
- H3: team files need `sam trust`. Team lines are never pinned and get low importance. Memory text is escaped so it cannot close `<memory>`.
- H4: generated commands use POSIX single quotes (Windows: double quotes). The OpenCode plugin gets full JS string literals.
- H5: exact TOML markers. Any existing `[mcp_servers.sam]` table is removed before writing. No deprecated feature flag.
- H6: a string-aware JSONC parser. Invalid files are left untouched, and you are warned that comments are not preserved.
- H7: `busy_timeout` is set before WAL. The schema row is `INSERT OR IGNORE`.
- H8: only complete transcript lines are read, raw lines are never harvested, and tool calls and results are skipped.
- H9: `--grep` falls back to a literal match on invalid or catastrophic patterns, and lines are capped at 2,000 chars.
- H10: redaction covers about 25 secret formats without over-redacting code. Vault output is redacted at rest.

**Medium**: all of M1–M15. The OpenCode plugin is async, and markers are harvested on `session.idle`. M10 is solved by normalizing `sam run -- X` to `X`, so the host's own shell hook pairs failures and fixes.

**Low**: L1–L4, L6–L15, L17–L24.

**Integrations**: all 17 wrong items.
- Claude: `PostToolUseFailure`, `PowerShell`, `fork` sessions.
- Codex: `apply_patch` paths come from `command`; the `/hooks` trust note; no deprecated flag; the shared `~/.agents/skills`.
- OpenCode: `patchText`; marker harvest; no global `AGENTS.md` (which would shadow `CLAUDE.md`); `instructions`.
- Cursor: `conversation_id`; JSON-string `tool_output`; native `hooks.json` with `additional_context`; claude-tagged duplicate calls ignored; MCP `type: stdio`.
- All hosts: final-message harvest from `last_assistant_message` / `prompt_response` / `afterAgentResponse`.

## Known limits (not fixed)

- L5: the MCP server scopes to its working directory. Hosts that launch global MCP servers from `~` (some Cursor/Antigravity setups) fall back to the `global` project for MCP calls. Hooks are unaffected because they get the real cwd.
- L16: single-symbol terms (`C#`, emoji) are not searchable.
- Cursor has no per-prompt injection hook. Per-prompt recall there goes through MCP.
- Not verifiable without a live host: Antigravity transcript format and `invocationNum` semantics (SAM falls back to the injection ledger), Cursor `tool_input` field names for Write/Read, and Codex transcript format. Marker harvest uses the final message the host hands over, so it does not depend on these.
- Benchmark: memory ids are random, so repeated runs vary by a few dozen tokens. A later measurement on v1.1.0 found about 1 run in 10 at 19/20 (not 1 in 40 as first stated); v1.2.0 scored 20/20 in 25 of 25 runs.
