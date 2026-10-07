# SAM — Super Agent Memory

**One persistent, token-frugal memory for every coding agent.**
Claude Code · Codex CLI · Gemini CLI · Antigravity (IDE / CLI / 2.0) · OpenCode · Cursor · any MCP client.

[![CI](https://github.com/cumabozkurt/super-agent-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/cumabozkurt/super-agent-memory/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cumabozkurt/super-agent-memory?sort=semver)](https://github.com/cumabozkurt/super-agent-memory/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.16%2B%20%7C%2024%2B-339933.svg)](docs/getting-started.md#requirements)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

[Türkçe README](README.tr.md) · [Documentation](docs/README.md) · [Getting started](docs/getting-started.md) · [CLI](docs/cli.md) · [FAQ](docs/faq.md)

```bash
npm i -g https://github.com/cumabozkurt/super-agent-memory/releases/download/v1.0.0/super-agent-memory-1.0.0.tgz
sam install        # detects your agents and wires hooks + MCP + rules
```

**v1.0.0** is on [GitHub Releases](https://github.com/cumabozkurt/super-agent-memory/releases/latest) (tarball + `SHA256SUMS.txt`). The package is not on the npm registry yet, so the line above installs the release tarball. Alternatives: `npm i -g github:cumabozkurt/super-agent-memory#v1.0.0`, or `git clone … && npm link` for a working copy. Details: [Getting started](docs/getting-started.md#install).

That is the whole setup. No server, no API key, no Python, no Docker, **zero npm dependencies**. Requires **Node.js 22.16+ (22.x) or 24+**. One SQLite file at `~/.sam/sam.db` is shared live by all agents in the same environment, so a decision made in Claude Code is known to Codex, Gemini and OpenCode the next time they start.

The package installs three names for the same CLI: `sam`, **`sam-memory`** and `super-agent-memory`. Use `sam-memory` if `sam` on your machine is the AWS SAM CLI; the rules SAM installs for agents always use `sam-memory`.

---

## Why another memory?

We reviewed the **50 most-starred agent-memory repos updated in the last year** end to end (README + source). Full reviews are in [docs/RESEARCH.md](docs/RESEARCH.md). The same five problems kept coming up:

| Problem in the field | What SAM does instead |
|---|---|
| Memory is dumped into context (whole memory files, or top-k full bodies every prompt): thousands of tokens per turn | **Budgeted, progressive context.** A ≤320-token (o200k-equivalent) project card at session start; per-prompt recall only when a relevance gate passes (≤160 tokens); everything else is one `mem_search` away as `[kind] gist #id` lines |
| The same memories are re-sent turn after turn | **Per-session injection ledger.** A memory is never paid for twice in one session; the ledger resets only after compaction |
| A model call for every write or tool event (observer LLMs, extraction prompts) | **LLM-free capture.** Edits, commands, outcomes and error→fix pairs are captured deterministically; agents save memories with *inline markers* (`⟦mem decision: queue: SQS, not Kafka⟧`), which cost no tool call |
| Large MCP tool surfaces (19–54 tools, several thousand schema tokens per session) | **4 tools, about 270–310 schema tokens** (o200k/Claude 4.6; about 440 on Claude 4.7+), or no MCP at all: every operation is also a `sam-memory` shell command |
| Tool output (test logs, builds) floods the context | **Output vault.** `sam run -- npm test` stores the full log locally and prints a digest (errors with context + tail). An 1,800-test log goes from 20,652 to 89 tokens |

### Benchmarks

**Token benchmark** (`npm run bench`): a synthetic project corpus (600 saved, 540 live after near-duplicate merges) and a 30-prompt session: 20 prompts need a specific stored memory, 10 are unrelated asks.

| Strategy | Tokens pushed into context | Needed memory reached the agent |
|---|---:|---:|
| A. Full memory dump at session start (memory-bank / big CLAUDE.md style) | 35,608 | 20/20 |
| B. Top-10 full-text recall on every prompt (common default) | ≈32,100 | 20/20 |
| D. Pure BM25 top-3 on every prompt (no gate, no ledger) | ≈2,530 | 13/20 |
| **C. SAM** (card + gated recall + ledger) | **≈2,100** | **20/20** |

**About 94% fewer tokens than a dump at the same recall, and fewer tokens than plain BM25 with far better recall.** SAM spent about 140 tokens in total on the 10 unrelated prompts (BM25: about 425). Memory ids are random, so repeated runs vary by a few dozen tokens (2,073–2,110 over 6 runs, all 20/20). Token counts use SAM's estimator (within about ±5% of tiktoken o200k). The baselines are strategy archetypes seen across the reviewed repos, not re-implementations of specific projects. The corpus is templated, which flatters lexical search, so treat it as indicative. The harness is `bench/tokens.js`.

**Tokens across models.** Budgets and the numbers above are in o200k-equivalent units (SAM's estimator, calibrated to tiktoken o200k). Each model family tokenizes the same text differently, so the real count depends on the host. Counts measured on SAM's own output through each provider's tokenizer (OpenRouter `usage.prompt_tokens`, 2026-10-07):

| SAM text | o200k | Claude 4.6 | Claude 4.7+ / 5.x | Gemini 3.x |
|---|---:|---:|---:|---:|
| Session card (EN) | 299 | 334 (1.12×) | 453 (1.52×) | 326 (1.09×) |
| Session card (TR) | 281 | 358 (1.27×) | 469 (1.67×) | 297 (1.06×) |
| Per-prompt recall (EN) | 34 | 38 (1.12×) | 51 (1.50×) | 36 (1.06×) |
| Memory gists (TR) | 239 | 335 (1.40×) | 453 (1.90×) | 243 (1.02×) |
| MCP tool schemas (4 tools) | 268 | 309 (1.15×) | 443 (1.65×) | 280 (1.04×) |

So a 320-token card is about 320 tokens on GPT and Gemini models and about 485–540 on Claude 4.7 and later. Turkish text costs 1.24–1.34× English on o200k and Gemini, and 1.40–1.69× on Claude. The savings ratio in the token benchmark compares SAM with the baselines in the same units; it was not re-measured per tokenizer. Script: `bench/native-tokens.mjs`.

**Retrieval benchmark** (`npm run bench:retrieval`): 411 hand-written memories across three projects plus global and auto-capture noise, 239 English and Turkish prompts with graded labels (32 of them unrelated), a 40-turn session and a must-know set per project. Gate settings were tuned only on the odd-numbered half; the even half is held out.

| | dev-2 | dev-3 | **1.0.0** |
|---|---:|---:|---:|
| search Recall@3 / MRR | 0.771 / 0.749 | 0.886 / 0.852 | **0.886 / 0.852** |
| Recall@3, Turkish ↔ English prompts (35) | 0.495 | 0.848 | **0.848** |
| Recall@3, prompts sharing no word with the answer (22) | 0.091 | 0.500 | **0.500** |
| per-prompt recall: answer injected | 0.775 | 0.845 | **0.845** |
| false injections on unrelated prompts | 0.750 | 0.500 | **0.500** |
| tokens per prompt | 103 | 85 | **85** |
| session card: share of the must-know set | 0.16 | 0.35 (295 tokens) | **0.73** (1,005 tokens, small-store dump) |
| held-out half: Recall@3 · answer injected · false injections | 0.760 · 0.750 · 0.938 | 0.902 · 0.868 · 0.500 | **0.902 · 0.868 · 0.500** |
| 40-turn session: total tokens | 3,479 | 2,365 | **2,386** |

(dev-2/dev-3 are pre-release builds.) The three bench projects each hold 40 or fewer non-note memories, so 1.0.0 gives them the whole store as a deterministic dump instead of a ranked card. Details, splits and caveats are in [bench/retrieval/README.md](bench/retrieval/README.md). Embeddings are not needed for any of these numbers.

**Blind benchmark** (`npm run bench:v2`): 539 positive and 858 negative EN/TR prompts written by one model vendor and judged by another, split by hash into a dev half (used for tuning) and a held-out half (reported). Negatives are other-stack, other-project, unrelated coding, chit-chat and near-miss prompts.

| held-out (265 positive, 418 negative) | answer injected [95% CI] | false injections [95% CI] |
|---|---:|---:|
| **SAM 1.0.0** (relevance gate + project-specificity gate) | **0.699** [0.647, 0.752] | **0.144** [0.110, 0.177] |
| SAM without the specificity gate | 0.699 | 0.275 [0.234, 0.318] |
| BM25 top-3, no gate | 0.903 | 0.935 |
| BM25 top-3 with a score floor tuned on dev to SAM's hit rate | 0.741 | 0.124 |

The specificity gate removes almost every other-stack injection (0.35 → 0.01) and most other-project ones (0.25 → 0.06) at no hit cost. A tuned BM25 floor is a strong baseline on this set; SAM's gate needs no per-store tuning, and SAM adds the card and the ledger on top. The same run also covers: poisoning (the guard quarantines 43 of 48 agent-written poisoned notes; a poisoned note reaches a topical prompt 10% of the time, down from 79%), knowledge updates and dedup (see *Known limitations* in the [CHANGELOG](CHANGELOG.md)), and in-process recall latency (p50 ≈6 ms, of which ≈0.5 ms is the specificity gate). Full report: `bench/retrieval-v2/results/1.0.0.txt`.

**Coding eval** (`npm run bench:coding`): 34 coding tasks that can only be solved with a stored project fact (26 EN, 8 TR) plus 10 harm tasks, graded by tests, in three model/store conditions (gemini-3.8-flash on a 50- and a 270-row store, deepseek-v4-flash on the 50-row store; 1,899 graded calls, paired task-cluster bootstrap).

| arm | tasks passed | Δ vs no memory [95% CI] | context tokens added |
|---|---:|---:|---:|
| no memory | 16.7% | — | 0 |
| irrelevant memory of the same size | 20.6% | +3.9 [−0.5, +9.8] | 379 |
| SAM push only (card + recall) | 72.1% | +55.4 [+40.2, +69.1] | 380 |
| **SAM push + pull** (`mem_search` / `mem_get`) | **93.1%** | **+76.5 [+63.2, +88.7]** | 380 + pulls |
| full dump of the store | 94.6% | +77.9 [+64.7, +89.7] | 4,603 |

SAM ties a full dump at about one twelfth of its tokens; harm rates are 1.8–5.3% in every arm with no measurable difference. Pushing a fix card *after a failure* recovered +19.7 pp [+4.5, +38.8] of failed attempts and ships; an always-on "experience push" did not help (−1.5 pp) and does not. Method and per-task tables: `bench/coding-eval/`.

**Hook latency** (`npm run bench:latency`, fresh process per prompt, 60 memories, Linux x64, Node 22.23): median ≈86 ms, of which ≈26 ms is Node startup (the last pre-release build measured ≈79 ms on the same machine, so 1.0.0's guard, gates and handoffs add ≈7 ms; run-to-run noise is about ±10 ms).

---

## How it works

```
 Claude Code ─┐  hooks: SessionStart · UserPromptSubmit · PostToolUse(+Failure) · PreCompact · Stop · Subagent*
 Codex CLI ───┤  hooks.json (same events) + config.toml MCP
 Gemini CLI ──┤  SessionStart · BeforeAgent · AfterTool · PreCompress · AfterAgent · SessionEnd
 Antigravity ─┤  PreInvocation (injectSteps) · PostToolUse · Stop  + mcp_config.json + rules
 OpenCode ────┤  plugin: chat.message · tool.execute.after · session.idle · compacting
 Cursor ──────┤  hooks.json: sessionStart · postToolUse(+Failure) · afterAgentResponse + MCP
 other MCP ───┘  MCP + rules (`sam snippet`)
        │
        ▼   ~/.sam/bin/sam hook <event> --agent <name>   (launcher finds Node; ≈70–90 ms per prompt on Linux incl. Node startup, `npm run bench:latency`; never blocks the host)
 ┌──────────────────────────── SAM engine (Node 22.16+/24, node:sqlite) ────────────────────────┐
 │ capture   prompts → directives ("from now on…", "unutma…") · edits · commands + outcome    │
 │           error→fix detection · inline ⟦mem⟧ markers from the assistant's own prose only   │
 │ store     typed memories · provenance (user/agent/auto/team/import) · near-dup merge       │
 │           supersession ("subject: value", "X instead of Y", negations) · secret redaction  │
 │ retrieve  BM25 + trigram + EN/TR alias expansion [+ optional embeddings] → RRF            │
 │           × concept coverage × importance × recency (with a floor for key decisions)      │
 │ inject    budgeted card · evidence-gated recall · file notes · subagent mini-card · ledger │
 │ vault     full command output stored, digest shown, `sam-memory out <id> --grep` on demand│
 │ hygiene   `sam gc` (also a light daily run): expire, merge, archive, reinforce            │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲
        └── MCP (4 tools) and CLI for explicit recall/save; Markdown/JSONL export; team file in git
```

What an agent sees at session start (real output of `sam context`, 172 tokens):

```
<memory project="shop">
conventions the user recorded:
- commit mesajlarını İngilizce yaz
- package manager: pnpm, never npm
user preferences:
- answer in Turkish, code comments in English
decisions (newest wins):
- auth: JWT in an httpOnly cookie, refreshed every 15 min · 10-07
- test runner: vitest with --pool=forks; threads crash on Node 22 · 10-07
facts:
- Stripe webhooks are verified with STRIPE_WEBHOOK_SECRET in... · 10-07 #vs0h
saved inline: ⟦mem decision: <subject>: <value>⟧ (same subject replaces the old value; no status notes) · more: mem_search → mem_get(#id)
</memory>
```

And for the prompt *"how do we verify the stripe webhook signature?"* (39 tokens):

```
<memory recall>
- (fact 10-07) Stripe webhooks are verified with STRIPE_WEBHOOK_SECRET in src/billing/webhook.ts #vs0h
</memory>
```

Decisions and facts carry their date and are listed newest first, so the model can tell which of two lines is current. A `#id` appears only when `mem_get` would return more than the line shows. Conventions can come from the user saying *"Bundan sonra commit mesajlarını İngilizce yaz"*, decisions from an inline `⟦mem⟧` marker in the agent's reply, fixes from a failing → edited → passing test run. No model call is involved.

Design details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Integrations

`sam install` auto-detects agents; `sam install claude codex …` or `--all` to choose; `--dry-run` to preview. It writes a small launcher (`~/.sam/bin/sam`, plus `sam.cmd`/`sam.ps1` on Windows) that hooks and MCP entries call, so upgrading or switching Node (Homebrew, nvm, Volta) does not break them. After installing, it runs every installed command once through its host's real shell and prints `self-test: …`. Every edited file gets a one-time `.sam-bak` backup; `sam uninstall` removes what was added, including the backups and any file it created that is empty again.

| Agent | What gets configured |
|---|---|
| **Claude Code** | `settings.json` hooks (SessionStart for every source incl. `compact`/`fork`, UserPromptSubmit, PostToolUse, PostToolUseFailure, PreCompact, Stop, SessionEnd, SubagentStart, SubagentStop); MCP via `claude mcp add --scope user` (or `.claude.json`); skill `skills/sam-memory`. Honors `CLAUDE_CONFIG_DIR` |
| **Codex CLI** | `config.toml` (`[mcp_servers.sam]`), `hooks.json`, an `AGENTS.md` block, skill `~/.agents/skills/sam-memory` (shared with Gemini CLI and OpenCode). Honors `CODEX_HOME`. **Codex runs user hooks only after you approve them once with `/hooks`** |
| **Gemini CLI** (legacy: since 2026-06-18 only for paid API keys and Code Assist licences; Antigravity `agy` replaces it) | `~/.gemini/settings.json` (`mcpServers.sam` + hooks); `~/.gemini/GEMINI.md` block |
| **Antigravity** | `~/.gemini/config/mcp_config.json` (and the legacy `~/.gemini/antigravity/mcp_config.json` if present); `~/.gemini/config/hooks.json` (PreInvocation → `injectSteps`, PostToolUse, Stop) via one wrapper per event; rule and skill under `~/.gemini/config/` |
| **OpenCode** | `opencode.json(c)` MCP + `instructions` entry for `sam-memory.md` (never a global `AGENTS.md`, which would shadow `~/.claude/CLAUDE.md`); async plugin `plugins/sam-memory.js`. Honors `XDG_CONFIG_HOME` |
| **Cursor** | `~/.cursor/mcp.json` (`type: stdio`); `~/.cursor/hooks.json` (sessionStart card, file notes on postToolUse, prompt capture, marker harvest on afterAgentResponse, preCompact, sessionEnd). Cursor has no per-prompt injection hook, so per-prompt recall goes through MCP there. Cursor also runs `~/.claude` / `.claude` hooks (Third-Party Imports, on by default; always on in `cursor-agent`): SAM's Claude hooks detect Cursor (`cursor_version` / `CURSOR_VERSION`) and stay silent when SAM's Cursor hooks are installed (user or project scope), so nothing fires twice |
| **Anything else** (Windsurf, Cline, Zed, Copilot, Roo, Goose…) | `sam snippet` prints the MCP JSON and the rules block |

If an agent's hook system changes, capture degrades gracefully: MCP, rules and the CLI keep working. `sam doctor` reports installed entries that point at missing paths (`BROKEN: … → run sam install`).

### Windows

- Hook commands are generated per host shell: Claude Code ≥ 2.1.139 uses exec form (no shell); older Claude uses Git Bash when present, else PowerShell; Gemini CLI and Cursor get PowerShell (`& '…\sam.cmd' …`); Codex gets cmd quoting. Hosts that spawn without a shell (Claude exec form, MCP entries, the OpenCode plugin) call `node.exe` + `sam.js` directly.
- `sam run` uses Git Bash if installed, else PowerShell, else cmd (`SAM_SHELL=bash|powershell|cmd` overrides). Output in a non-UTF-8 console code page (CP857, Windows-1254, …) is decoded correctly; `SAM_VAULT_ENCODING` forces one.
- Windows support is exercised in CI (Windows × Node 22.16/24) and by simulated command generation; real-host execution of every shell form is less battle-tested than POSIX. `sam doctor` self-tests what was installed.

### One database per environment

SQLite's WAL mode needs shared memory on one kernel. Keep one local `SAM_HOME` per environment: Windows, each WSL distro, each container or devcontainer, each SSH host. Do not point `SAM_HOME` at `/mnt/c/…` from WSL, an NFS/SMB/9p/FUSE mount, a Docker Desktop bind mount shared with the host, or a Dropbox / iCloud Drive / OneDrive / Google Drive folder. If the DB is on such a filesystem anyway, SAM uses the slower rollback journal instead of WAL and `sam doctor` / `sam install` warn (`SAM_ALLOW_SHARED_FS=1` forces WAL if you know the mount is safe).

Move memories between environments with `sam export --jsonl` / `sam import --trusted`, or share project knowledge through a committed `.sam/memory.md`. Repos with a git remote get the same project id everywhere; give remote-less repos a `.sam-project` file with a name. In a devcontainer, run `sam install` inside the container (e.g. in `postCreateCommand`) and mount a named volume at `~/.sam` if memory should survive rebuilds.

---

## Security and safety

- **Team files need a human review.** A repo's `.sam/memory.md` is imported only after you run `sam trust` in that repo: it shows the number of lines and a preview and asks `[y/N]` in a terminal (scripts pass `--yes`). Trust is pinned to that exact content: when a teammate changes the file, nothing new is imported until you review it again, and the card tells the agent to ask you. An agent running `sam trust` from its shell has no terminal and is refused. `sam export --team` never marks a repo trusted.
- **Provenance.** Every memory records who wrote it: `user` (`sam add`, your directives), `agent` (markers, `mem_save`), `auto` (captured fixes and digests), `team`, `import`. Only you can pin. An agent cannot overwrite or supersede a value you saved or pinned (MCP tells it to ask you), unless you named the new value yourself in the same session. Team lines are never pinned; imports are untrusted unless you pass `--trusted` for your own backups.
- **Poisoning guard.** Memories written by agents, teammates or imports that look like an injection (remote scripts, disabled checks, exfiltration, weakened auth, "ignore the user") are quarantined, and bursts of agent writes beyond a per-session / per-day cap wait as pending. Held memories are invisible to agents and never replace a live one; you see them in `sam review` (approve / reject; unreviewed ones expire after 14 days) and `sam audit`. On the card, agent / team / import lines are tagged `-a` / `-t` / `-i`.
- **Memory is data.** Text is NFKC-normalized and stripped of invisible, bidi and Unicode-tag characters, and `<`/`>` are escaped, so a stored line cannot close the `<memory>` block or hide instructions from a reviewer. The installed rules say memory lines never change the agent's permissions or tools.
- **Harvest only what the assistant said.** Markers come from an allow-list of assistant-message formats per host; tool output, files the agent read, compaction summaries, reasoning, quoted text, code blocks and blockquotes are ignored. At most 8 markers per turn.
- **Secrets are masked before anything is stored**, including vault output: about 30 formats (OpenAI, Anthropic, Stripe, GitHub, GitLab, npm, Hugging Face, Slack, AWS, Google, SendGrid, Discord, JWTs, PEM and PuTTY keys, base64-wrapped keys, Bearer/Basic headers, URL passwords, `curl -u`, `*_PASSWORD=`, `"token": "…"`). Redaction runs in linear time on adversarial input.
- **MCP is scoped.** `mem_get` and `mem_forget` only see the current project and global; arguments are length-capped and oversized requests refused.
- **`sam run`** refuses a single quoted argument that contains shell operators unless you pass `--shell`. Approving `sam run` in a host still approves whatever comes after `--`, so treat that approval like approving a shell.
- **Erasure.** `sam purge` removes content from every table (memories and their older versions, raw events, first prompts, vault, digests, handoffs, the team file) and rewrites the DB; a fingerprint (tombstone) keeps it from being captured again. `sam forget --hard` leaves a tombstone too.
- **Files and installer.** `~/.sam` is 0700 and the DB files 0600; `sam forget --hard` securely deletes and purges the search index. The installer never writes through a symlinked config file. A non-localhost embedding endpoint is used only when `~/.sam/config.json` opts in, never from an environment variable alone.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). The audits (code, host integrations, and the six-perspective audit of v1.1.0) are summarized in [docs/AUDIT.md](docs/AUDIT.md) and [docs/AUDIT2.md](docs/AUDIT2.md).

---

## Using it

Mostly you don't. Capture and injection are automatic. Useful commands (`sam` and `sam-memory` are the same):

```bash
sam q "stripe webhook"            # search → [kind] gist #id
sam get 29on 17vc                 # full detail
sam add "deploy: fly.io via GH Actions" -k decision --pin
sam context --prompt "fix login"  # preview exactly what an agent would receive, with token counts
sam run -- pnpm test              # output vault: digest now, `sam out <id> --grep FAIL` later
sam stats                         # tokens injected vs. kept out of context
sam export --team                 # write <repo>/.sam/memory.md, commit it
sam trust                         # teammates: review that file, then allow its import (off by default)
sam doctor                        # detection, DB health, config problems, broken paths, self-test
sam doctor --repair               # rebuild the search index or salvage a damaged DB
sam gc                            # hygiene (also runs lightly once a day on its own)
sam review                        # held memories (quarantined / pending): approve or reject
sam audit                         # who wrote what, what gets injected, quarantine reasons
sam purge --query "old api key"   # erase content everywhere (+ tombstone), then VACUUM
sam handoff "auth done; tests for refresh left" --to codex   # the next codex session here gets it once
```

Inside any agent you can also just say *"remember that…"*, *"from now on…"*, *"always/never…"* (Turkish: *"unutma…"*, *"bundan sonra…"*, *"artık X değil Y"*, *"her zaman/asla…"*). These are saved as facts, conventions, preferences or decisions; repeatable multi-step how-tos can be saved as `-k procedure`. Write decisions as `subject: value` (`queue: SQS, not Kafka`): a later value for the same subject replaces the old one, and so do "X instead of Y" and "switched from Y to X".

Exit codes: 0 success, 1 not found or a failed check, 2 usage error. `SAM_DEBUG=1` shows stack traces.

### Configuration

Set values in `~/.sam/config.json` or with env vars: the key in upper snake case with a `SAM_` prefix (`budgetPrompt` → `SAM_BUDGET_PROMPT`). Precedence: env > `config.json` > default. Values are type-checked; a bad value falls back to the default with a warning, and `sam doctor` lists config problems and unknown keys.

| Key | Default | Meaning |
|---|---|---|
| `budgetSessionStart` | 320 | max tokens of the session card |
| `budgetPrompt` | 160 | max tokens of per-prompt recall |
| `maxPromptHits` | 3 | per-prompt recall cap |
| `minPromptCoverage` | 0.2 | gate: share of the prompt's IDF mass a memory must cover |
| `relPromptFloor` | 0.5 | gate: drop hits scoring below this fraction of the best hit |
| `rareConceptShare` | 0.15 | gate: evidence must be this selective (share of memories its words match together) |
| `gateMinConcepts` / `singleConceptCoverage` | 1 / 0.4 | gate: rare concepts a hit must cover / coverage that is enough on its own |
| `weakPromptCoverage` | 0.25 | if nothing passes, the single best selective hit still passes at this coverage (0 = off) |
| `absentTermWeight` | 0.7 | weight of prompt words that occur nowhere in memory (1 = stricter gate) |
| `gateMode` | `coverage` | `rrf` restores the v1.1 score floor (`minPromptScore`, 0.012) |
| `expandQuery` / `expansionWeight` | true / 0.7 | EN/TR alias expansion, Turkish stems, typo correction, and their RRF weight |
| `decayFloor` | 0.75 | important decisions/conventions/preferences never decay below this |
| `globalFactor` | 0.85 | score multiplier for global memories inside a project |
| `cardCoreMax` / `cardGlobalMax` / `cardGistMax` / `cardDiverse` | 14 / 3 / 80 / true | card: core lines, unpinned global lines, gist length, one line per area first |
| `cardGistMaxDurable` | 120 | gist length for convention/decision/preference/procedure lines (cut at a clause boundary, never inside a `code span` or flag) |
| `specGate` | true | project-specificity gate: no recall for prompts about a sibling project or a stack this project never uses |
| `smallStore` / `smallStoreMax` / `smallStoreTokens` | true / 40 / 1500 | a project with at most 40 live memories gets them all as a deterministic dump |
| `nativeDedup` | true | drop card lines the host already loads (CLAUDE.md, AGENTS.md, GEMINI.md, rules); note contradictions once |
| `budgetProfile` / `turkishBudgetBoost` | `''` / 1.25 | per-host budget multipliers (e.g. `claude-4.7`); extra budget for Turkish-heavy stores |
| `fixPush` / `fixPushMax` / `budgetFix` / `cardFixMax` | true / 2 / 70 / 3 | after a failed command, push the matching past fix (per session, tokens); fix lines on the card |
| `guard` / `agentCapSession` / `agentCapDay` / `reviewAgentRules` / `reviewExpireDays` | true / 6 / 30 / false / 14 | poisoning guard, caps on agent-written rows (excess → pending), review inbox |
| `sourceTags` / `gateLog` | true / true | `-a`/`-t`/`-i` provenance bullets; per-prompt gate features for later calibration |
| `redactPII` | true | mask e-mail, phone, IBAN and TCKN before storing |
| `handoff` / `handoffMaxTokens` / `handoffMaxAgeDays` | true / 60 / 14 | agent-to-agent handoffs |
| `actr` / `demote` / `sleep` / `skillDrafts` | false | experimental: ACT-R ranking factor, demotion instead of archiving, daily `sam sleep` consolidation, skill drafts from repeated fixes |
| `recentSessions` / `hotFiles` | 2 / 6 | session digests and recently edited files on the card |
| `embedUrl` / `embedModel` / `embedKey` | off | any OpenAI-compatible `/v1/embeddings` (Ollama, LM Studio, OpenAI). Adds a semantic RRF signal; `sam embed` backfills. A non-localhost URL needs `embedUrl` in `config.json` or `"allowRemoteEmbed": true` there |
| `embedInHooks` / `minPromptCosine` | false / 0.6 | also use embeddings in hooks (adds latency); cosine that clears the gate on its own |
| `captureDirectives` / `captureCommands` / `captureEdits` / `harvestMarkers` | true | capture switches |
| `eventRetentionDays` / `vaultRetentionDays` / `vaultMaxBytes` | 21 / 14 / 2000000 | raw event and vault expiry, max stored output per command |
| `dbPath` | `~/.sam/sam.db` | database file |

Environment variables: `SAM_HOME` (DB, config and launcher folder, default `~/.sam`; the value at install time is baked into the launcher), `SAM_NODE` (Node binary for the launcher), `SAM_SHELL` and `SAM_VAULT_ENCODING` (`sam run` on Windows), `SAM_ALLOW_SHARED_FS=1` (keep WAL on a network or synced folder), `SAM_PROJECT_DIR` (pin the MCP server to a project), `SAM_SESSION`, `SAM_DEBUG=1`. Development only: `SAM_INSTALL_HOME`, `SAM_TEST`, `SAM_SELFTEST`, `SAM_CLAUDE_VERSION`.

### Privacy

Everything stays on your machine. API keys, tokens, JWTs, private keys and `password=` patterns are masked before anything is written, personal data (e-mail, phone, IBAN, TCKN) is masked too (`redactPII`), and `<private>…</private>` spans are dropped. `sam purge` erases a memory, a query match or a whole project from every table. Nothing leaves the machine unless you configure an embedding endpoint yourself.

---

## Development

```bash
npm test                 # 184 tests (store, search, retrieval, capture, vault, hooks per host, MCP, installers,
                         #   security, robustness/chaos, workflow, platform, CLI, schema/privacy, guard, gate,
                         #   injection, sharing, integration); SAM_SLOW=1 adds the long chaos run
npm run bench            # token benchmark (with a pure-BM25 baseline)
npm run bench:retrieval  # retrieval-quality benchmark (no embeddings or Python needed)
npm run bench:v2         # blind EN/TR benchmark + knowledge-update, poisoning, dedup and latency suites
npm run bench:latency    # per-prompt hook latency
npm run bench:coding     # memory-necessary coding eval (needs an OpenRouter key)
npm run e2e              # install into a temp home and run every installed hook command through sh
```

Requires Node.js 22.16+ (22.x) or 24+ (the built-in `node:sqlite` with FTS5). See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [CHANGELOG.md](CHANGELOG.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | install, wire your agents, verify, upgrade, uninstall |
| [Concepts](docs/concepts.md) | scopes, kinds, provenance, markers, supersession, card, recall, ledger, guard, handoffs, team file, vault |
| [CLI reference](docs/cli.md) | every command and flag |
| [MCP server](docs/mcp.md) | the four tools, limits, protocol details |
| [Configuration](docs/configuration.md) | every setting with its default, environment variables, embeddings |
| [Integrations](docs/integrations.md) | what is written for each host, Windows, other MCP clients, containers |
| [Benchmarks](docs/benchmarks.md) | methodology and how to reproduce every number above |
| [Architecture](docs/ARCHITECTURE.md) | data model, write path, retrieval, injection, hygiene |
| [FAQ and troubleshooting](docs/faq.md) | common questions and fixes |

## Credits

SAM stands on ideas proven by the projects in [docs/RESEARCH.md](docs/RESEARCH.md), especially claude-mem (progressive disclosure), context-mode and openwolf (output sandboxing), engram (topic keys), agent-memory and ai-memory (lexical-first, budgeted briefs), ReMe and OpenViking (no repeats), pro-workflow (inline learn markers) and obsidian-mind (degrading budgets).

MIT License.
