# Concepts

This page explains what SAM stores, where it comes from, and what agents see. For the algorithms behind each step, see [Architecture](ARCHITECTURE.md).

## One memory, many agents

SAM keeps one SQLite database per environment (`~/.sam/sam.db`). Every wired agent (Claude Code, Codex CLI, Gemini CLI, Antigravity, OpenCode, Cursor) reads and writes the same rows through the same engine: hooks for automatic capture and injection, an MCP server for explicit search and save, and the `sam` CLI for you and for agents' shells. A decision you make with one agent is in the next session of every other.

SAM never calls a model. Capture, deduplication, supersession, ranking, digests and hygiene are deterministic code.

## Projects and scopes

Every memory belongs to one scope:

| Scope | What it is |
|---|---|
| a **project** | the repo you are in. Identified by its git remote (`origin`, then `upstream`, then the first remote), else by its root path, so every clone and worktree of a repo shares memory. A one-line `.sam-project` file can name a folder as a project. |
| **global** | user-wide memories (`sam add -g`), shown in every project, weighted 0.85 and capped at 3 unpinned lines on a card |
| **unscoped** | work started in a parent folder that holds several repos. Never shown in a repo's card. A prompt that names one of the repos ("in shop-api, …") is routed to that repo |

Memories of one project are invisible from another: search, `mem_get` and `mem_forget` are limited to the current project plus global.

## Memory kinds

| Kind | Tag | Typical content | Aliases |
|---|---|---|---|
| `convention` | C | how this project does things ("tests: vitest, never jest") | `c`, `conv`, `rule`, `kural` |
| `procedure` | R | a repeatable multi-step how-to ("release: bump, tag, publish") | `proc`, `howto`, `recipe`, `runbook`, `steps`, `prosedür`, `yöntem`, `tarif` |
| `preference` | P | how the user likes to work | `p`, `pref`, `tercih` |
| `decision` | D | a choice with a value that may change ("queue: SQS, not Kafka") | `d`, `dec`, `karar` |
| `fact` | F | a stable fact about the project | `f`, `bilgi` |
| `fix` | fix | a problem and what fixed it (often auto-detected) | `düzeltme` |
| `bug` | bug | a known bug | `b`, `error`, `hata` |
| `todo` | todo | open work | `t`, `task`, `yapılacak` |
| `note` | N | anything else; the default | `n`, `not`, `önemli` |
| `session` | S | a rolling digest of a session, written automatically | — |

Kinds carry different default importance and recency half-lives (conventions and preferences decay slowest, todos and sessions fastest); the table is in [Architecture → Write path](ARCHITECTURE.md#write-path-srcstorejs).

## Provenance

Every row records who wrote it:

| Source | Written by |
|---|---|
| `user` | you: `sam add` and directives in your prompts |
| `agent` | an agent: inline markers and `mem_save` |
| `auto` | SAM itself: detected fixes, session digests |
| `team` | your repo's trusted `.sam/memory.md` |
| `import` | `sam import` |

Provenance decides power. Only `user` rows can be pinned. A non-user write can never supersede or rewrite a pinned or user memory: `mem_save` answers "ask the user". The one exception is an agent marker that updates a non-pinned user value which you named in your last prompts of the same session. On the card, agent, team and import lines get `-a`, `-t` and `-i` bullets (`sourceTags`).

## How memories get in

1. **You say it.** In a prompt to any agent: *"remember that …"*, *"note: …"*, *"from now on …"*, *"always / never …"*, *"don't use …"*, *"we prefer …"*. In Turkish: *"unutma …"*, *"aklında tut …"*, *"bundan sonra …"*, *"artık X değil Y"*, *"her zaman / asla …"*, *"sakın …"*, *"önemli: …"*. These become facts, conventions, preferences or decisions with `user` provenance. Only short, unquoted text you typed counts: questions, pasted issues/logs/e-mails, quotes and code are skipped. Time words ("tomorrow", "yarın") make a todo that expires after two days.
2. **The agent marks it.** Agents end a reply with an inline marker:

   ```text
   ⟦mem decision: queue: SQS, not Kafka⟧
   [[mem convention: run pnpm lint before every commit]]
   ```

   Both spellings work; the kind is optional (default `note`) and must be a known kind or alias. SAM harvests markers from the assistant's own text only (never from tool output, reasoning, compaction summaries, code blocks, inline code or blockquotes), at most 8 per turn, and drops junk like "done" or "see above".
3. **The agent saves it** with the `mem_save` MCP tool or `sam-memory add`.
4. **SAM notices a fix.** When a command that failed earlier in the session passes after code files were edited, SAM writes a `fix` memory (no command output, no timings; docs-only edits never count).
5. **You import it** from a JSONL/Markdown file or a trusted team file.

Every write is cleaned first: Unicode normalization, invisible characters stripped, secrets masked, `<private>…</private>` dropped, and personal data masked (`redactPII`).

## Deduplication and supersession

- **Duplicates merge.** An exact or near-duplicate of a memory of the same kind in the same scope is merged instead of stored twice. Near-duplicates must also mean the same: "we should not use Redis" never merges into "we should use Redis".
- **New values replace old ones.** Write decisions as `subject: value`. A later `queue: Kafka` retires `queue: SQS`. Replacements such as "X instead of Y", "switched from Y to X", "Y → X", "artık Y değil X" and "Y yerine X", and a negation of an existing decision, also supersede. An additive cue ("also", "ayrıca") keeps both. Generic prefixes like `Note:` or `TODO:` are not subjects.
- **Nothing useful is hard-deleted.** Superseded, forgotten and archived rows keep their history (`sam ls --all`) until `sam forget --hard` or `sam purge`.
- **Validity windows.** `sam add --valid-from/--valid-to` bounds when a memory is live; outside the window it is invisible to every read path.

## What agents see

### Session card

At session start each agent gets a compact card inside a `<memory project="…">` block. It is worded as facts, not instructions, and stays within `budgetSessionStart` (320 tokens by default). For example:

```text
<memory project="demo">
conventions the user recorded:
- package manager: pnpm, never npm
decisions (newest wins):
- queue: SQS, not Kafka · 10-07
saved inline: ⟦mem decision: <subject>: <value>⟧ (same subject replaces the old value; no status notes) · more: mem_search → mem_get(#id)
</memory>
```

Sections, when they have content: conventions, procedures, preferences, decisions (dated, newest wins), facts, past fixes, open todos, recent sessions and recently edited files. Pinned memories always make it in. Lines the host already loads from `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or rules files are skipped, and contradictions with them are noted. The card stays byte-stable within a day so the host's prompt cache survives. A project with at most 40 live memories gets all of them as a deterministic dump instead (`smallStore`). A handoff from another agent, if any, is appended once.

Claude Code subagents get a smaller card (≤140 tokens). After a compaction the card is sent again.

### Per-prompt recall

On each prompt SAM searches memory and adds at most 3 lines (≤160 tokens) inside `<memory recall>`, **only when a relevance gate passes**. The gate asks for evidence, not just rank: the hit must cover enough of the prompt's rare words, and the words it covers must be selective in your store. Prompts about a sibling project or a stack this project never uses get nothing (`specGate`). When nothing passes, nothing is injected; that is by design.

### File notes and fix pushes

- When an agent reads or edits a file, memories anchored to that file (`--files`) are shown once per session (at most 3, about 90 tokens).
- After a failed command, one matching past fix is pushed (at most `fixPushMax` per session, ≤70 tokens).

### The ledger

Every injected line is recorded in a per-session ledger, so nothing is shown twice in a session; subagents have their own. A resumed session gets only what it has not seen. `sam stats` totals what was injected.

### Pulling more

Card and recall lines are short gists. Agents pull detail only when they need it: `mem_search` → `mem_get` (or `sam-memory q` / `get`). This progressive disclosure is why the always-on cost stays small.

## Write guard and review

Every non-user write (agent markers, `mem_save`, detected fixes, team files, imports) is classified before it is stored:

- **active**: normal.
- **quarantined**: it matched an injection heuristic (pipe-to-shell, exfiltration, "ignore previous instructions", hiding things from the user, tool-call or role imitation, hidden Unicode, instructions addressed to an AI, hidden comments). A plain shell command is not a signal by itself.
- **pending**: an agent went over the per-session or per-day write cap (`agentCapSession`, `agentCapDay`), or `reviewAgentRules` is on and an agent wrote a rule.

Held rows (quarantined or pending) are never shown to agents, in any card, recall, file note or MCP result. You see them with `sam review` and approve or reject them. Unapproved rows are deleted after `reviewExpireDays` (14). `sam audit` summarizes sources, statuses, injection hits and quarantine reasons.

## Handoffs

When a session stops, SAM derives a handoff from it: what was done, what is still open (todos saved in the session, commands whose last run failed) and the files touched. The next session in the same project by a **different** agent receives the newest unconsumed handoff once, as one factual line (≤60 tokens). You can write one by hand with `sam handoff [--to agent] "<note>"`. Handoffs older than `handoffMaxAgeDays` (14) are not surfaced. Held memories never leak into a handoff.

## Team file

`sam export --team` writes `<repo>/.sam/memory.md`, a Markdown list of the project's live memories (except preferences and session digests) to commit and share. A teammate's SAM does not import it on its own (`sam doctor` reports it as present but not trusted). The teammate imports it with `sam trust`: it previews the content, asks for confirmation in a terminal, and trusts **that exact content**. If the file changes later, the changes are not imported, the card notes that it changed, and a new `sam trust` is needed. Agents are told never to trust it themselves. Team rows have `team` provenance and pass through the write guard; symlinked team files are ignored.

## Output vault

`sam run -- <command>` runs a noisy command (tests, builds, logs), keeps the full output in the database (deflated, redacted, up to 2 MB) and prints a short digest: status, error lines with context, the tail, and a pointer such as `[full output: sam-memory out <id> --grep … | --tail N | --lines A:B]`. The agent pulls the parts it needs with `sam out` or `mem_get`. Outputs expire after `vaultRetentionDays` (14). `sam stats` reports how many bytes were captured versus shown.

## Hygiene

Once a day, at session start, a light `gc` runs: raw events and vault outputs past retention are deleted, near-duplicates that slipped in are merged, stale session digests and abandoned todos are archived, memories agents keep fetching are reinforced, and expired held rows are dropped. `sam sleep` (manual, or daily with `sleep: true`) consolidates further. See [CLI reference → Maintenance](cli.md#maintenance).

## Privacy

Everything stays on your machine. Secrets and (by default) personal data are masked before anything is written; `<private>…</private>` spans are never stored. `sam forget --hard` securely deletes a row, and `sam purge` erases content from every table, writes a tombstone so the text is not captured again, and vacuums the file. Nothing leaves the machine unless you configure an embedding endpoint yourself (see [Configuration → Optional embeddings](configuration.md#optional-embeddings)).
