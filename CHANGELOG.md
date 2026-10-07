# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The SQLite schema version is stored in the `meta` table (`schema`). Any release that changes it will say so under **Changed** and describe the migration.

## [1.0.0] — 2026-10-07

First public release. SAM is one persistent, token-frugal memory shared by every coding agent on a machine (Claude Code, Codex CLI, Gemini CLI, Antigravity, OpenCode, Cursor, any MCP client): zero npm dependencies, one local SQLite file (`node:sqlite`, Node.js 22.16+ (22.x) or 24+), LLM-free capture. Earlier internal milestones (numbered 1.0.0–1.2.0 during development, never published) are summarized under *Pre-release development notes* below.

### Core
- **Capture without a model call:** user directives in English and Turkish ("remember…", "from now on…", "unutma…", "bundan sonra…", "artık X değil Y"), edits, commands and outcomes, error → fix pairs, inline `⟦mem kind: text⟧` markers (no tool call), rolling session digests, subagent harvest.
- **Hybrid retrieval:** BM25 (porter) + trigram + optional embeddings fused with RRF, re-weighted by importance, per-kind decay with a floor for durable kinds, pinning, project scope and coverage of rare query concepts; bilingual EN/TR alias table, Turkish suffix stripper, typo correction, identifier twins, temporal intent ("yesterday", "dün").
- **Budgeted injection:** a ≤320-token session card, relevance-gated per-prompt recall (≤160 tokens), file-anchored notes, ≤140-token subagent mini-cards, and a per-session ledger so nothing is paid for twice.
- **Output vault** (`sam run`, `sam out`), a 4-tool MCP server plus short MCP `instructions`, a CLI for every operation (`sam-memory` alias for machines where `sam` is the AWS SAM CLI), Markdown/JSONL export/import, a reviewed and content-pinned team file (`.sam/memory.md`, `sam trust`).
- **Installers** for all six hosts, with per-shell Windows hook commands, a stable launcher that survives Node upgrades, a real-shell self-test, `.sam-bak` backups and a clean `sam uninstall`.
- **Robustness:** corrupt-DB salvage (`sam doctor --repair`), read-only / full-disk tolerance, rollback journal on shared or synced filesystems, clock-jump clamping, a light daily gc, hook fast path with V8 compile cache.

### Memory model and privacy
- **Schema v3** (migrated automatically from v1/v2): `status`, `valid_from` / `valid_to`, `tombstones`, `handoffs`. A binary older than the DB opens it **read-only** instead of damaging it; `sam doctor` reports the newer schema.
- **One live-row predicate** (`liveSql()` in `store.js`) on every read path — search (IDF, candidate lists, session recall, specificity signature), card, small-store dump, file notes, fix push: not superseded, `status = 'active'`, inside its validity window. `sam q --include-quarantined` adds held rows for the human only.
- **`procedure` kind** (tag `R`, long half-life) for repeatable multi-step how-tos, listed in `mem_save`, the installed rules and the skill text.
- **Validity windows** (`sam add --valid-from/--valid-to`): a fact can be scheduled or expire.
- **Additive guard:** "also", "ayrıca", "de ekle" add to a subject instead of replacing it. **Two-stage dedup** (SimHash candidate, then Jaccard + polarity/negation) in save and gc; held rows never merge or absorb.
- **`sam purge`** erases content from every table (memories and the versions they superseded, raw events, first prompts, vault, digests, handoffs, the team file), then VACUUM + WAL truncate; `--include-backups` also deletes `sam.db.corrupt-*` copies. **Tombstones** (exact + substring fingerprints, case/space/diacritic-robust) stop re-capture; `sam forget --hard` leaves one by default. `saveMemory` returns `{ id: null, status: 'tombstoned' }` and every caller handles it.
- **PII redaction** (`redactPII`, on): e-mail, phone (TR / E.164), IBAN (mod-97), TCKN (checksum), on top of ~30 secret formats; RFC 2606/6761 reserved addresses (`admin@shop.test`, `jane@example.com`) stay readable.

### Poisoning defense and review
- **Guard** (`src/guard.js`): non-user writes that match injection heuristics (remote scripts, disabling checks, exfiltration, weakening auth, "ignore the user"…) are **quarantined**; per-session and per-day caps on agent-written rows put the excess in **pending**. Held rows are invisible to agents (search, card, `mem_get` shows id + status only) and never retire or rewrite a live row. Tool-output taint marks writes that follow a suspicious tool result.
- **`sam review`** inbox (approve / reject / approve-all) with expiry (`reviewExpireDays`), **`sam audit`** (counts by source/status/kind, most injected, follow-up rate, quarantine reasons), optional `reviewAgentRules`.
- **Source tags:** agent / team / import lines carry `-a` / `-t` / `-i` bullets plus one legend line; user and auto lines keep `-`. Imported and team rows pass the guard too.

### Injection
- **Project-specificity gate** (`specGate`): no per-prompt recall for prompts about a sibling project (naive-Bayes LLR over the projects in the DB) or a stack this project never uses. Held-out false injections 0.275 → 0.144 at unchanged hit.
- **Native memory awareness:** CLAUDE.md, AGENTS.md, GEMINI.md, rules files, Claude auto memory and Antigravity knowledge are read (never written); card lines the host already loads are dropped and contradictions noted once per session.
- **Factual card wording** ("conventions the user recorded", "how-to steps the user recorded", "saved inline: …"), no imperative out-of-band text; host output limits respected (`fitContext`, Claude Code 10,000 chars).
- **Cache hygiene:** card ranking in whole UTC days with id tie-breaks, read counters out of card ranking, a tools/list hash test.
- **Small-store mode:** a project with ≤40 live memories gets a deterministic full dump (≤1,500 tokens, ≤9,000 chars).
- **Host-profiled budgets** (`budgetProfile`, e.g. Claude 4.7+ ×1.6) and a ×1.25 budget for Turkish-heavy stores.
- **Compact fix card + push after failure:** after a failed command, the matching past fix is pushed once (≤2 per session, ≤70 tokens). The always-on "1-experience push" was measured and not shipped.
- **Durable-line card cut:** convention / decision / preference / procedure lines get 120 characters (`cardGistMaxDurable`) and a clause-boundary cut that never splits a `code span`, flag or quoted token (the coding eval showed `--error-on-warnings`, an `ff-` prefix and a timezone being cut at 80).

### Sharing
- **Agent-to-agent handoffs:** written automatically at Stop / SessionEnd (and with `sam handoff [--to agent] "<note>"`), surfaced once (≤60 tokens) to the next session of another agent in the same repo; `sam handoff --list`.
- **Portable skill** with a CLI pull section for agents without MCP.
- **Experimental, off by default:** ACT-R activation as a ranking factor (`actr`, imported lazily so the prompt hook pays nothing while off), demotion instead of archiving (`demote`), `sam sleep` consolidation (`sleep`), skill drafts from repeated fixes (`sam skills draft`, never installed).
- **gc** prunes per-session and orphaned meta keys (`fixpush:`, `needcard:`, `route:`, `tjson:`, `guard:`, `reinforced:`, `demoted:`).

### Benchmarks and evaluation
- `npm run bench` (token benchmark, now with a pure-BM25 baseline row), `npm run bench:retrieval` (411 memories, 239 EN/TR prompts), `npm run bench:v2` (blind EN/TR set of 539 positives + 858 negatives written and judged by different vendors, dev / held-out split, knowledge-update, poisoning, dedup and latency suites, bootstrap CIs, BM25 baselines), `npm run bench:latency`, `npm run bench:coding` (memory-necessary coding eval, 34 pairs + 10 harm tasks), `npm run e2e`.
- Results at release: token bench ≈2,100 tokens at 20/20 recall vs 35,608 for a full dump (−94%) and ≈2,530 at 13/20 for pure BM25 top-3; retrieval v2 held-out hit 0.699 / false injections 0.144 (BM25 top-3: 0.903 / 0.935; BM25 with a dev-tuned floor: 0.741 / 0.124); guard quarantines 43 of 48 poisoned notes (topical injection 0.79 → 0.10); coding eval: SAM push + pull 93.1% vs no memory 16.7% vs full dump 94.6% at ≈1/12 of the dump's tokens.
- Test suite: 168 tests across 13 files, plus `SAM_SLOW=1` chaos runs and a 36-command host e2e.

### Known limitations
- Knowledge updates written as a full restatement without `subject: value`, "X instead of Y" or a negation are not superseded (bench:v2: 3 of 66 updates supersede, the old value is still injected for 71% of update prompts; a small-store dump can show both values, dated, newest first). Reworded duplicates are not merged (0 of 60). Write decisions as `subject: value`.
- 5 of 48 adversarial notes in bench:v2's poisoning suite pass the guard heuristics.
- Antigravity's pre-invocation path does not surface handoffs; Cursor has no per-prompt injection hook (recall goes through MCP there).

## Pre-release development notes (never published)

### dev-4 (hook performance, Cursor double-fire, native token counts)

#### Performance
- Per-prompt hook ≈20% faster (Linux arm64, Node 22: median ≈85 → ≈67 ms, of which ≈18 ms is Node startup): `sam hook` loads only the hook module graph instead of the whole CLI, enables the V8 compile cache (`NODE_COMPILE_CACHE`, falling back to `~/.sam/cache/v8` when the shared temp dir is not writable; `SAM_NO_COMPILE_CACHE=1` opts out), and loads `node:child_process`, the team-file sync and auto-GC lazily.
- `bench/hook-latency.mjs` (`npm run bench:latency`); CI reports it on Linux, macOS and Windows.

#### Fixed
- Cursor double-fire: Cursor runs Claude Code hooks from `~/.claude` and `.claude` by default (always in `cursor-agent`). The Claude copy now also recognises Cursor by `CURSOR_VERSION`, and stays silent when SAM's Cursor hooks are installed in the project's `.cursor/hooks.json` as well as `~/.cursor/hooks.json`.

#### Documentation
- Gemini CLI marked legacy (Google moved individual accounts to Antigravity on 2026-06-18).
- README/README.tr: token counts of SAM's card, recall, gists and MCP schemas measured with each provider's native tokenizer (Claude 4.6, Claude 4.7+/5.x, Gemini 3.x) next to o200k; budgets are documented as o200k-equivalent units; MCP schema size corrected to 270–310 tokens (about 440 on Claude 4.7+).
- `bench/native-tokens.mjs`: reproduces the native counts through OpenRouter (needs `OPENROUTER_API_KEY`).

### dev-3 (internally "1.2.0": six-perspective audit fixes, retrieval upgrade)

A fix pass after a six-perspective audit of 1.1.0 (security, robustness, multi-agent workflow, cross-platform, packaging, retrieval quality), plus a retrieval upgrade. Summary in [docs/AUDIT2.md](docs/AUDIT2.md).

#### Breaking changes
- **Node.js 22.16+ (22.x) or 24+ is required.** 22.13–22.15 and 23.x lack FTS5 in `node:sqlite` and are refused with a clear message (hooks stay silent).
- **Re-run `sam install` after upgrading.** Hooks and MCP entries now call a launcher (`~/.sam/bin/sam`; `sam.cmd`/`sam.ps1` on Windows) instead of embedding the Node path, and Claude Code gets `SubagentStart`/`SubagentStop` hooks.
- **`sam trust` is interactive and content-pinned.** It shows a preview and asks `[y/N]` in a terminal, or needs `--yes` in scripts. A changed team file is not imported until it is reviewed again. `sam export --team` no longer marks a repo trusted.
- **Provenance rules.** New `source` column (`user|agent|auto|team|import`; schema version 2, migrated automatically; v1's `source` column is renamed `agent`). Only `user` rows can be pinned; agents (MCP or markers) cannot overwrite or supersede the user's or pinned values. The MCP `mem_save` tool no longer has a `pin` argument.
- **MCP scoping.** `mem_get` and `mem_forget` only see the current project and global, at most 20 ids per call; arguments are length-capped.
- **`sam import` is untrusted by default:** rows land in the current project as `source=import`, unpinned; `--trusted` keeps pins and projects for your own backups.
- **`sam run "a && b"`** (one argument with shell operators) needs `--shell`.
- **Exit codes:** unknown commands/agents and usage errors exit 2, "not found" exits 1.
- **Card format changed:** spelled-out section headings, dates on decisions and facts, `#id` only when `mem_get` has more, no `n=` count, a footer that teaches `subject: value`.
- **Per-prompt recall gate changed** (`gateMode: "coverage"`, new keys below; `maxPromptHits` 4 → 3). `gateMode: "rrf"` restores the v1.1 behaviour.
- **`.sam-project` ids** now include the remote or root, so two repos can no longer share an id by name; existing data is adopted once by the repo whose root matches.

#### Security
- `sam run` refuses a single argument containing shell operators (`;`, `&`, `|`, `<`, `>`, backticks, `$(`) unless `--shell` is given (a host's "always allow `sam run`" rule no longer approves arbitrary shell programs).
- A non-localhost embedding endpoint is used only when `~/.sam/config.json` opts in (`embedUrl` there, or `"allowRemoteEmbed": true`); `SAM_EMBED_URL` alone can only point at this machine.
- The installer never writes through a symlinked config file or a planted `.sam-bak` symlink, and resolves the `claude` CLI on PATH only (never the current directory).
- Untrusted repo content: `.sam-project` must be a small regular file and is ignored in `$HOME`, `/`, temp and world-writable directories; team export writes atomically and refuses symlinks.
- Text is NFKC-normalized and stripped of invisible, bidi and Unicode-tag characters before it is stored; every card field is escaped.
- Marker harvest uses an allow-list of assistant-message formats per host; compaction summaries, reasoning, tool output, quotes, code blocks and blockquotes are never harvested; at most 8 markers per turn. Directives come only from short, unquoted user text. Fix gists carry no command output.
- Redaction is linear time (bounded quantifiers, single-pass PEM and `<private>` scanners) and covers more shapes (base64-wrapped keys, URL query keys, `*_PASS`/`_PWD`/`_AUTH`, `_authToken`, truncated PEM, PuTTY keys, YAML block scalars, `curl -u`, `mysql -p`, Discord tokens): 0 of 34 matrix cases leak.
- `~/.sam` is 0700, the DB files 0600; `secure_delete` is on; `sam forget --hard` purges the FTS index and the WAL.
- `--grep` accepts only a backtracking-safe regex subset, with a 500 ms budget.
- MCP request lines over 1 MB are refused.

#### Added
- **Retrieval:** a bilingual (EN/TR) dev-vocabulary alias table, a light Turkish suffix stripper, typo correction against the index vocabulary, identifier twins (`useAuthStore` → `use auth store`), temporal intent ("yesterday", "dün", "where did I leave off" → recent session digests), IDF over live rows in scope, per-concept coverage, and an evidence-based relevance gate whose "rare concept" test is relative to the store size, with joint selectivity for word combinations. New config keys: `gateMode`, `minPromptCoverage`, `relPromptFloor`, `rareConceptShare`, `gateMinConcepts`, `singleConceptCoverage`, `weakPromptCoverage`, `absentTermWeight`, `minPromptCosine`, `expandQuery`, `expansionWeight`, `decayFloor`, `globalFactor`, `cardCoreMax`, `cardGlobalMax`, `cardGistMax`, `cardDiverse`.
- **Card:** a decay floor for important decisions/conventions/preferences, at most 3 unpinned global lines, one line per area first, 80-character gists, agent-marker lines capped, packed to 94% of the budget so the real token count stays within it.
- **Supersession** by negation (≥75% keyword overlap) and by replacement phrases ("X instead of Y", "switched from Y to X", "Y → X", "artık Y değil X", "Y yerine X", "no longer use Y"); stale fixes for a replaced tool retire too.
- **Turkish directives:** "bundan sonra bana…", "artık … değil …", "sakın …", "önemli:"; time words make an ephemeral todo that expires after 2 days.
- **Subagents:** a ≤140-token mini-card on Claude `SubagentStart`, harvest on `SubagentStop`, per-subagent ledgers.
- **Robustness:** a corrupt DB is moved aside and recreated; `sam doctor --repair` rebuilds indexes or salvages every readable row; a read-only or full disk still serves cards and search; hooks read before they write; a light gc runs once a day; clock jumps are clamped (`sam gc --force` overrides).
- **Shared filesystems:** on WSL `/mnt/<drive>`, NFS/SMB/9p/FUSE and cloud-sync folders the DB uses the rollback journal instead of WAL (`SAM_ALLOW_SHARED_FS=1` forces WAL).
- **Parent folders:** a folder holding several repos is `unscoped` instead of `global`; a prompt that names one child repo routes the session's captures there.
- **Team sync** merges instead of overwriting, keeps hand edits, and propagates deletions (tombstones).
- `bench/retrieval/` with `npm run bench:retrieval` (411 memories, 239 EN/TR prompts, tuning and held-out halves; no embeddings or Python needed) and `npm run e2e` (installs into a temp home and runs every installed hook command through `sh`).

#### Fixed
- Windows: hook commands are generated per host shell. Claude Code uses exec form (`args`, no shell) from 2.1.139, otherwise Git Bash or PowerShell with an explicit `shell`; Gemini CLI and Cursor get PowerShell `& '…'`; Codex gets cmd quoting; Antigravity gets one argument-free wrapper per event. `sam install` and `sam doctor` run every installed command through its host's real shell (self-test).
- Hooks and MCP servers call a stable launcher (`~/.sam/bin/sam`, plus `sam.cmd`/`sam.ps1` on Windows) that finds Node at run time, so `brew upgrade node`, `nvm uninstall` and similar no longer break them. `sam doctor` reports installed entries that point at missing paths.
- Node 22.13–22.15 and 23.x (no FTS5 in `node:sqlite`) get a clear error instead of a stack trace; hooks stay silent and exit 0.
- `sam run` on Windows prefers Git Bash, then PowerShell, then cmd, with matching argv quoting; output in a non-UTF-8 console code page (CP857, Windows-1254, …) is decoded correctly and CRLF no longer breaks `--grep 'x$'`.
- `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` (OpenCode) are honored.
- `sam --version` / `-v` print the version; `--flag=a=b` keeps `a=b`; unknown commands and agents exit 2 with a one-line message; "not found" exits 1; user errors print no stack trace (`SAM_DEBUG=1` shows it); `sam add` validates the kind and length like MCP `mem_save`.
- `sam uninstall` removes the `.sam-bak` files and empty files/directories that install created.
- Config values are type-checked (a non-numeric budget no longer disables the budget; `"false"` is false); bad JSON and unknown keys are reported on stderr and by `sam doctor`.
- `sam doctor` warns when the database sits on a filesystem where SQLite WAL is unsafe (WSL `/mnt/<drive>`, NFS/SMB/9p/FUSE, Dropbox/iCloud/OneDrive folders).
- Tests never run the real `claude` binary or touch the real home directory.
- Cursor's `beforeSubmitPrompt` no longer marks recall it cannot deliver as shown.
- Gemini gets the card again after `PreCompress`.
- Fix detection: timings stripped, assertion lines preferred, `cd X &&` stripped, docs-only edits are never a fix.
- The token estimator was recalibrated on real cards (newlines, random ids, Turkish).
- `npm run bench` counts memories already shown on the session card as recalled (the ledger deliberately does not repeat them).
- `mcp.js` takes its version from `package.json`; stale comments (MCP schema size, estimator accuracy, a missing calibration file) corrected.

#### Changed
- Requires Node.js 22.16+ (22.x) or 24+ (`engines` and the runtime gate).
- New bin alias `sam-memory`; installed rules and skills use it (plain `sam` may be the AWS SAM CLI) and name the launcher's absolute path as a fallback.
- The npm package ships only `bin`, `src`, `plugins`, the READMEs, LICENSE, CHANGELOG, SECURITY and `docs/ARCHITECTURE.md`; `exports` limits the public surface to the CLI.
- `autoProjectCard` config key retired (it was never read).
- README and README.tr.md have full parity; ARCHITECTURE describes 1.2.0; the audit reports are in `docs/audit2/` with internal paths removed.
- Test suite grew from 22 to 93 tests.

### dev-2 (internally "1.1.0": code + host-integration audit fixes)

A full fix pass after two independent audits of 1.0.0 (code and host integrations). Details and reproductions are in [docs/AUDIT.md](docs/AUDIT.md).

#### Security
- A repository's `.sam/memory.md` is imported only after `sam trust` in that repository. Imported team lines are never pinned and are capped at importance 0.5.
- Memory text is escaped (`<` → `‹`, `>` → `›`) so a stored line cannot close the `<memory>` block.
- Generated hook commands are shell-quoted (POSIX single quotes, `cmd.exe` double quotes). An install path containing `$()` or backticks can no longer execute code on every hook run.
- `sam run` with several arguments quotes each one, so an argument cannot inject a second shell command.
- Secret redaction covers many more formats (OpenAI, Anthropic, Stripe, GitHub, GitLab, npm, Hugging Face, Slack, AWS, Google, SendGrid, JWTs, private-key blocks, Bearer/Basic headers, URL passwords, `key = value` pairs) without masking ordinary code such as `pwd = os.getcwd()`. Vault output is redacted at rest.
- `--grep` patterns that could backtrack catastrophically, or that are invalid, fall back to a literal match. Lines are capped at 2,000 characters.
- Markers are harvested from complete transcript lines only, and tool calls and tool results are skipped.

#### Fixed
- Search drove the join from `memories` instead of the FTS match, which made it O(N × MATCH): 47 s at 20k memories, now tens of milliseconds (`CROSS JOIN`).
- Near-duplicate merge could keep the old meaning ("should not use Redis" merged into "should use Redis"). Negation and before/after words stay in the fingerprint, a merge requires equal polarity, the newest wording wins, and text with no fingerprint never merges.
- Hooks no longer hang when a host keeps stdin open: stdin is released after a complete JSON document, EOF, or 1.5 s.
- Fresh databases no longer fail with "database is locked" under parallel hooks (`busy_timeout` is set before switching to WAL; the schema row is `INSERT OR IGNORE`).
- Codex `config.toml` editing uses exact markers and removes any existing `[mcp_servers.sam]` table first; no deprecated feature flag is written.
- JSONC host configs are parsed with a string-aware parser. Invalid files are left untouched, with a warning that comments are not preserved.
- Command outcome detection trusts exit codes first and uses text heuristics only for known test/build/lint runners, so a successful `grep error` is no longer a failure or a fake "fix".
- `sam gc` uses LSH buckets for the duplicate sweep (6.9 s → 0.2 s at 20k memories). Reinforcement happens at most once per 30 days.
- The token estimator was recalibrated against tiktoken o200k/cl100k.
- Remaining Medium and Low findings from the code audit (see docs/AUDIT.md for the list and the two that remain open).

#### Changed
- Host integrations corrected against current host docs:
  - Claude Code: `PostToolUseFailure`, `PowerShell`, `fork` sessions.
  - Codex: `apply_patch` paths come from `command`; one-time `/hooks` trust note; skills in the shared `~/.agents/skills`.
  - OpenCode: `patchText`; async plugin; marker harvest on `session.idle`; rules through `instructions` (a global `AGENTS.md` is never created, because it would shadow `~/.claude/CLAUDE.md`).
  - Cursor: native `~/.cursor/hooks.json` with `additional_context`; `conversation_id`; JSON-string `tool_output`; Claude-format hooks that Cursor imports are ignored once native hooks exist; MCP `type: stdio`.
  - All hosts: markers are also harvested from the final message the host hands over (`last_assistant_message`, `prompt_response`, `afterAgentResponse`).
- `sam run -- X` is recorded as `X`, so error→fix detection pairs vault runs with plain runs.
- Test suite grew from 14 to 22 tests.

### dev-1 (internally "1.0.0": first working build)

#### Added
- First release: one local SQLite memory (`~/.sam/sam.db`, `node:sqlite`, zero npm dependencies) shared by Claude Code, Codex CLI, Gemini CLI, Antigravity, OpenCode, Cursor and any MCP client.
- `sam install` / `sam uninstall` for hooks, MCP and rules on each host, with `.sam-bak` backups.
- LLM-free capture: user directives (English and Turkish), edits, commands and outcomes, error→fix pairs, inline `⟦mem kind: text⟧` markers, rolling session digests.
- Hybrid retrieval: BM25 (porter) + trigram + optional embeddings, fused with RRF and re-weighted by importance, per-kind recency, pinning, project scope and usage.
- Budgeted injection: a session card, relevance-gated per-prompt recall, file-anchored notes and a per-session ledger.
- Output vault (`sam run`, `sam out`), a 4-tool MCP server, Markdown/JSONL export and import, team file sharing, `sam gc`, `sam stats`, and the token benchmark (`npm run bench`).

[Unreleased]: https://github.com/cumabozkurt/super-agent-memory/compare/972a2e8f02cd5d1ed98c6c20bc74f9180007958f...main
[1.0.0]: https://github.com/cumabozkurt/super-agent-memory/tree/972a2e8f02cd5d1ed98c6c20bc74f9180007958f
