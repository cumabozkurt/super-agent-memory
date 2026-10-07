# Architecture

## Principles

1. **Tokens are the scarce resource.** Every byte SAM pushes into an agent's context is budgeted, deduplicated per session, and gated by relevance. Pulling detail is always the agent's choice (progressive disclosure: line → `get` → vault).
2. **No model calls in the hot path.** Capture, dedup, supersession, ranking, digests and hygiene are deterministic. Optional embeddings are the only network feature, and they are off by default.
3. **One engine, many hosts.** A single `sam hook <event> --agent <name>` entry point normalizes six hook dialects. MCP and the CLI expose the same operations.
4. **Never hurt the host.** Hooks swallow errors and exit 0 (also on an unsupported Node), run in about 50–60 ms, never block a tool or a stop, and never rewrite the host's prompts. Hooks read before they write: a card is computed even when the DB is locked, read-only or full.
5. **Local, inspectable, reversible.** One SQLite file per environment. Forgetting, archiving and merging set `superseded_by`; nothing useful is hard-deleted unless you ask (`sam forget --hard`, which also purges the FTS index and the free pages).
6. **Memory is data, provenance decides.** Every row records who wrote it (`user`, `agent`, `auto`, `team`, `import`). Only the user can pin or overrule the user.

## Runtime and launcher (`bin/sam.js`, `src/platform.js`)

* Node.js **22.16+ (22.x) or 24+**: `node:sqlite` without FTS5 (22.13–22.15, every 23.x) is refused with one line; hooks stay silent and exit 0.
* `sam install` writes a launcher, `$SAM_HOME/bin/sam` (POSIX sh, also used by Git Bash) and on Windows `sam.cmd` + `sam.ps1`. Hooks and MCP entries call it, and it finds Node at run time (`SAM_NODE`, PATH, the install-time node, Homebrew `opt`, nvm `current`, Volta; nvm-windows `NVM_SYMLINK`, `%ProgramFiles%\nodejs`). A too-old node on PATH exits 86 and the launcher tries the next one. `SAM_HOME` at install time is baked in as the default.
* Per-host command forms: Claude Code ≥ 2.1.139 uses exec form (no shell); older Claude, Gemini CLI and Cursor get a quoted launcher command for their shell (PowerShell `& '…\sam.cmd'` on Windows); Codex gets cmd quoting on Windows; Antigravity gets one argument-free wrapper per event; OpenCode's plugin spawns the launcher (Windows: `node.exe` + `sam.js`, because hosts that spawn without a shell cannot run `.cmd`).
* `sam install` / `sam doctor` run every installed command once through its host's real shell (`SAM_SELFTEST=1`, nothing written) and report broken paths.
* **One database per environment.** WAL needs shared memory on one kernel. On WSL `/mnt/<drive>`, NFS/SMB/9p/FUSE mounts and cloud-sync folders, `openDb()` uses the rollback journal instead of WAL (`SAM_ALLOW_SHARED_FS=1` forces WAL) and `sam doctor` / `sam install` warn.

## Data model (`src/db.js`)

| Table | Purpose |
|---|---|
| `memories` | typed memory: `kind`, `gist` (≤110 chars, the injected unit), `body`, `files`, `tags`, `topic`, `importance`, `pinned`, `source` (provenance), `agent` (which host wrote it), `simhash`, optional `embedding`, `superseded_by`, access stats |
| `mem_fts` | FTS5 external-content index, `porter unicode61 remove_diacritics 2`; weights gist 4, body 1, tags 2, files 2 |
| `mem_tri` | FTS5 trigram index for identifiers, substrings, typos |
| `events` | short-retention raw capture (prompt / edit / cmd / read / tool), used for fixes, digests and hot files |
| `sessions` | per-host session, first prompt, transcript path and harvest offset, rolling digest id |
| `injections` | the per-session ledger: what was already shown (keyed `session/agent_id` for subagents) |
| `vault` | deflated full command outputs (redacted) |
| `stats` | daily counters per project (tokens injected, vault savings, merges…) |

Schema version 2 added `source` and renamed the first schema's `source` to `agent`; schema version 3 (1.0.0) added `status` (`active` | `quarantined` | `pending`), `valid_from` / `valid_to`, and the `tombstones` and `handoffs` tables. Migrations run automatically; a binary older than the DB's schema opens it read-only. **Every read path uses one live-row predicate**, `liveSql()` / `liveArgs()` in `store.js`: not superseded, `status = 'active'`, inside the validity window (`includeHeld` drops only the status test, for the human's `sam q --include-quarantined`). Files are 0600 under a 0700 `~/.sam`; `secure_delete` is on. A corrupt DB is moved aside to `sam.db.corrupt-<ts>` and recreated; `sam doctor --repair` salvages every readable row.

Projects are keyed by a hash of the git remote (origin, then upstream, then the first; `url` only, never `pushurl`), falling back to the canonical root path (symlinks resolved, NFC, drive letter upper-cased), so clones and worktrees share memory. A `.sam-project` file names a repo (its id is the name *plus* the remote or root, so two repos cannot share an id by picking the same name); it must be a small regular file and is ignored in `$HOME`, `/`, temp and world-writable directories. A parent folder holding several repos is `unscoped`, never `global`. `global` holds cross-project preferences.

## Write path (`src/store.js`)

`saveMemory` → NFKC + invisible-character stripping → redact secrets and `<private>` → compute gist → forgotten guard (a non-user write that matches something the user forgot is not re-created) → **exact and near-duplicate merge** (SimHash over word 2-shingles, Hamming ≤ 3 within project+kind and equal polarity; newest wording wins) → **supersession**: the same `subject: value` topic, a negation with ≥75% keyword overlap, or a replacement ("X instead of Y", "switched from Y to X", "Y → X", "artık Y değil X", "Y yerine X") retires the old value → insert. Identifiers are also indexed as their parts (`useAuthStore` → `use auth store`), and Turkish `ı/İ` words as folded twins.

Provenance rules: only `source: user` pins; a non-user write cannot supersede or rewrite a pinned or user row (MCP answers "ask the user"). One exception: an agent marker may update a non-pinned user value when the user named the new value in their last prompts of the same session.

Per-kind defaults:

| kind | importance | recency half-life |
|---|---|---|
| convention, preference | 0.80 | 365 d |
| decision | 0.75 | 240 d |
| fact | 0.60 | 180 d |
| fix | 0.60 | 120 d |
| bug | 0.55 | 60 d |
| note | 0.45 | 90 d |
| todo | 0.50 | 30 d |
| session | 0.30 | 14 d |

1.0.0 additions to the write path: tombstoned content returns `{ id: null, status: 'tombstoned' }` (callers skip it); PII is masked when `redactPII` is on; `src/guard.js` classifies every write first (`guardOnSave`: active, quarantined by injection heuristics, or pending over the per-session / per-day agent caps), and a held row never merges into, rewrites or supersedes a live one; the near-duplicate test is two-stage (SimHash candidate, then `sameMeaning`: word Jaccard + polarity/negation); an additive cue ("also", "ayrıca") skips topic supersession.

## Capture (`src/capture.js`)

* **Prompts:** stored as events (with our own `<memory>` blocks stripped). **Directives** in English and Turkish ("remember…", "from now on…", "always/never…", "unutma…", "bundan sonra…", "artık … değil …", "sakın…") become conventions, preferences or decisions — only from short, unquoted user text. Time words ("tomorrow", "yarın") make an ephemeral todo that expires after 2 days.
* **Tools:** edit tools of all six hosts → file events. Shell tools → normalized command (`cd X &&`, env prefixes and `sam-memory run --` stripped) + outcome + first error line. Read tools → read events.
* **Error→fix:** when a command that failed earlier in the session passes and code files were edited in between, SAM writes a `fix` memory. The gist carries no command output and no timings; docs-only edits are never a fix.
* **Inline markers:** agents write `⟦mem kind: text⟧`. The transcript harvest is an **allow-list per host format** (Claude assistant text blocks, Codex assistant `output_text`, Gemini model parts, generic `role: assistant`); compaction summaries, reasoning and tool I/O are never harvested, and markers inside code, inline code and blockquotes are ignored. At most 8 markers per turn; junk ("done", "see above") is dropped. The final reply the host hands over (`last_assistant_message`, `prompt_response`, `afterAgentResponse`, OpenCode `session.idle`) is harvested directly.
* **Session digest:** one rolling digest per session, written atomically on every Stop.

## Retrieval (`src/search.js`, `src/lexicon.js`)

1. Keywords: Unicode-aware, stop-worded in English and Turkish, up to 16 terms.
2. **Query expansion** (`expandQuery`): a bilingual dev-vocabulary alias table (deploy/ship/release/canlı, database/db/veritabanı, cart/basket/sepet…), a light Turkish suffix stripper (only for Turkish-looking prompts, never below 4 characters), and typo correction against the FTS vocabulary for words that occur nowhere in memory.
3. Candidate lists: BM25 over `mem_fts` (the user's words, prefix-matched), BM25 over `mem_tri` (trigram), BM25 over the expansion terms at RRF weight 0.7, the 3 newest session digests when the prompt has temporal intent ("yesterday", "dün", "where did I leave off"), and cosine over embeddings when configured.
4. **Reciprocal Rank Fusion** (k = 60).
5. Re-weighting: `score = RRF × prior × (0.35 + 1.3 × coverage)`
   * IDF is computed over the rows this search can return (live, in scope).
   * `coverage` is per concept (a query word with its stem, aliases and correction): full weight in gist/tags, 0.5 in file paths, 0.35 in the body; an alias match earns 0.8. Generic instruction words count 0.3, words absent from memory `absentTermWeight`.
   * `prior` = (0.55 + 0.45 × decay) × (0.7 + 0.6 × importance) × pin 1.25 × same-project 1.0 vs global 0.85 × usage (≤ +15%). Important decisions, conventions and preferences never decay below `decayFloor` (0.75).

## Injection (`src/inject.js`)

* **Session card** (`SessionStart`, Antigravity `PreInvocation #0`, OpenCode first message): spelled-out sections worded as facts, not instructions — conventions the user recorded, how-to steps the user recorded (procedures), user preferences, decisions (newest wins, dated), facts, past fixes, open todos, recent sessions, recently edited files — packed to 94% of `budgetSessionStart` so the real tokenizer count stays within budget. Core lines rank by pin, provenance, importance and decay in whole UTC days (with the floor), ties broken by id; read counters (`access_count`) do not move card lines, so the card is byte-stable for a day and the host's prompt cache survives; at most 3 unpinned global lines; one line per area before a second one; agent-marker lines capped at 6 of the core lines; gists cut to 80 characters (`cardGistMax`); convention/decision/preference/procedure lines get 120 (`cardGistMaxDurable`) and a clause-boundary cut that never splits a `code span`, flag or quoted token. `#id` appears only when `mem_get` has more. The footer teaches the save format. A resumed session gets only what its ledger has not seen.
* **Prompt recall** (`UserPromptSubmit`, Gemini `BeforeAgent`, Antigravity, OpenCode `chat.message`): a **relevance gate** on evidence, not rank. A hit is injected when it scores ≥ `relPromptFloor` × the best hit, covers ≥ `minPromptCoverage` of the query's IDF mass (or `singleConceptCoverage` alone), and its evidence is **selective**: the concepts it covers occur together in at most `rareConceptShare` of the searchable rows (independence estimate, at least one row). Both thresholds are shares, so the gate behaves the same with 5 or 50,000 memories. At most `maxPromptHits` lines under `budgetPrompt`, excluding anything in the ledger. `gateMode: "rrf"` restores the v1.1 score floor.
* **File notes** (`PostToolUse` on read/edit; whole-path or `/<path>` suffix match): memories anchored to that file, at most 3 and about 90 tokens, once per session.
* **Subagents** (Claude `SubagentStart`): a ≤140-token mini-card keyed on the subagent's own ledger.
* **Compaction:** `PreCompact`/`PreCompress` harvests markers and resets the ledger; the card is re-sent (`SessionStart(source=compact)`, Gemini's first `BeforeAgent` after `PreCompress`, OpenCode's compaction context).

* **1.0.0 injection additions:** the project-specificity gate (`specificity()` in `search.js`, veto in `promptContext`: a naive-Bayes LLR over sibling projects and a foreign-stack test, with per-project signatures cached in `meta`); native-memory dedup (`src/native.js`, read-only); small-store mode (≤40 live memories → deterministic full dump); host budget profiles and a Turkish budget boost (`effectiveBudget`); the compact fix card pushed once after a failed command (`fixContext`, ≤`fixPushMax` per session); provenance bullets (`-a`/`-t`/`-i`, `guard.bulletOf`) with one legend line; per-prompt gate features logged for calibration (`recordGate`, `gateLog`); a one-time handoff from another agent appended to the session card (`src/handoff.js`).

## Output vault (`src/vault.js`)

`sam run -- <cmd>` runs the command and keeps up to 2 MB of output, deflated and redacted. The digest strips ANSI codes and progress bars, collapses similar lines, keeps error lines with ±1–2 lines of context, and always keeps the summary tail, then prints `[full output: sam-memory out <id> --grep … | --tail N | --lines A:B]`. On Windows the shell is Git Bash, then PowerShell, then cmd (`SAM_SHELL` overrides); non-UTF-8 console output is decoded with the console code page. One argument containing shell operators needs `--shell`. `--grep` accepts only a backtracking-safe regex subset (else a literal match) with a 500 ms budget.

## MCP (`src/mcp.js`)

Hand-rolled JSON-RPC over stdio (no SDK). Tools: `mem_search{q,k?,kind?}`, `mem_get{ids,grep?}` (memories and vault ids), `mem_save{text,kind?,files?}`, `mem_forget{id}` — about 310 tokens of schema (`sam doctor` prints the exact figure). `mem_get`/`mem_forget` are scoped to the current project + global, at most 20 ids per call; arguments are length-capped and request lines over 1 MB are refused. Agents cannot pin (`pin` is not in the schema). The server reopens the DB if the file was replaced.

## Hygiene (`src/gc.js`)

Expires events and vault entries past retention and trims ledgers older than 7 days. Archives session digests beyond the newest 30 per project and abandoned todos (older than 60 days, unused for 30). Sweeps near-duplicates with LSH buckets (4×16-bit bands), skipping pairs whose negation/temporal words differ. Reinforces memories with at least 5 fetches in total whose last fetch was within 30 days (+0.05 importance, at most once per 30 days, capped at 0.95). Optimizes both FTS indexes and checkpoints the WAL. A light gc runs automatically at most once a day at SessionStart; future timestamps are clamped and expiry is skipped after a large clock jump (`sam gc --force` overrides).

## Privacy and review (`src/gc.js` purge, `src/review.js`)

`sam purge` deletes by id (with superseded chains), by text match or by project from every table, scrubs memory-derived text from events, first prompts, vault, handoffs, digests and the team file, writes tombstones, then runs FTS optimize, VACUUM and a WAL checkpoint. `sam review` approves or rejects held rows (approval runs the supersession the row skipped); unreviewed rows expire after `reviewExpireDays`. `sam audit` reports counts by source/status/kind, injection hit statistics and quarantine reasons. gc also prunes per-session and orphaned `meta` keys. Experimental, behind flags: ACT-R activation as a ranking factor (`actr`, lazily imported), demotion instead of archiving (`demote`), `sam sleep` consolidation and skill drafts (`src/sleep.js`, `src/skilldraft.js`).

## Extending to a new host

Add the host's event names to `normalize()` in `src/hooks.js`, its reply shape to `reply()`, and an installer function plus a command form in `src/install.js`. Every other part of the engine is shared.

## Correctness notes

* **Query plan:** FTS queries use `CROSS JOIN` so SQLite drives from the match (v1.0: 47 s at 20k memories; now tens of ms).
* **Near-duplicates keep polarity:** "We should not use Redis" never merges into "We should use Redis".
* **Generic prefixes are not topics:** `Note:`, `Important:`, `TODO:`, `Önemli:` … do not trigger supersession.
* **Turkish folding:** queries and coverage fold `İ/I/ı → i` and strip diacritics.
* **Outcome detection:** exit codes win; text heuristics are trusted only for known test/build/lint runners.
* **Concurrency:** `busy_timeout` is set before WAL; 60 concurrent hooks + 2 MCP servers + gc run without errors.
* **Hooks never hang:** stdin is read until a complete JSON document, EOF, or 1.5 s (capped at 2 MB); transcripts are opened only if they are regular files.
* **Redaction is linear time** (bounded quantifiers, single-pass PEM/`<private>` scanners).
* **Token estimator:** within about ±5% of tiktoken o200k per text class; 0.94–0.99× on the text SAM injects (cards, recall, dumps), and cards are packed to 94% of budget.
