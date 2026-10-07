# CLI reference

`sam --help` prints the short version of this page. The same CLI is installed as `sam`, `sam-memory` and `super-agent-memory`. All three are identical; use `sam-memory` where `sam` is the AWS SAM CLI.

## Conventions

- **Project scope.** Most commands act on the project of the current directory. A project is the nearest parent folder with a `.git` (identified by its `origin` remote, else `upstream`, else the first remote, else its path, so every clone of a repo shares memory) or with a one-line `.sam-project` file naming it. Outside any repo you are in the `global` scope. In a folder that holds several repos you are in `unscoped`, which no repo's card shows.
- **Scope flags.** `-g` / `--global` targets user-wide memories (shown in every project). `-p <name|id>` / `--project <name|id>` targets another known project. `--all-projects` (where supported) reads every project.
- **Flags.** `--flag value` and `--flag=value` both work. Short flags: `-k` kind, `-n` count, `-p` project, `-g` global, `-j` JSON.
- **Kinds.** `-k` takes a kind or an alias: `convention` (C), `procedure` (R), `preference` (P), `decision` (D), `fact` (F), `fix`, `bug`, `todo`, `note` (N). Turkish aliases work too (`karar`, `kural`, `tercih`, `bilgi`, `not`, `hata`, `düzeltme`, `yapılacak`, `prosedür`, …). See [Concepts → Kinds](concepts.md#memory-kinds).
- **Ids.** Memory ids print as `#abc123`; the `#` is optional when you type them. Output-vault ids start with `o`.
- **Exit codes.** `0` success · `1` failure, "not found", or a failed check · `2` usage error. Errors print one line on stderr (`sam: …`); `SAM_DEBUG=1` prints the stack.

## Setup

### `sam install [agent…|--all] [--dry-run] [--no-self-test]`

Wires hooks, the MCP server and rules into the named agents (`claude`, `codex`, `gemini`, `antigravity`, `opencode`, `cursor`), into every detected agent when none is named, or into all of them with `--all`. `--dry-run` prints the plan and writes nothing. After installing it runs every installed command through its host's shell (`self-test: N/N …`); `--no-self-test` skips that. Exits 1 if anything failed. See [Integrations](integrations.md) for what is written where.

### `sam uninstall [agent…|--all] [--dry-run]`

Removes exactly what `sam install` added (tracked in `~/.sam/install-manifest.json`). Memories are kept.

### `sam doctor [--repair]`

Health report: Node version, DB path and schema, live and held memory counts, tombstones, PII-redaction state, detected agents, token budgets with the native-tokenizer estimate, MCP schema size, embeddings state, team-file trust state, config warnings, DB-location warnings, broken install paths and a self-test of every installed hook and MCP command. Exits 1 when a check fails.

`--repair` rebuilds the search indexes, or, if the database is damaged, moves it aside (`sam.db.corrupt-*`) and salvages every readable row into a fresh one.

### `sam --version`

Prints the version (also `sam -v`, `sam version`).

## Recall and save

### `sam q "<words>" [-k kind] [-n 8] [--json] [--all-projects] [--include-quarantined]`

Aliases: `search`, `find`. Hybrid search (BM25 + trigram + EN↔TR expansion, plus vectors when embeddings are configured). It prints one `[kind] gist #id` line per hit, with age. Default 8 hits. `--json` prints full rows with scores. Held (quarantined/pending) memories are hidden unless you pass `--include-quarantined`.

### `sam get <id…> [--include-quarantined] [--grep re] [--tail N] [--lines A:B]`

Alias: `show`. Full detail of memories (gist, body, files, date, source, supersession) or of vault outputs (ids starting with `o`; the `--grep/--tail/--lines` options apply to those). Ids may be space- or comma-separated. Held memories show only their status unless `--include-quarantined` is given.

### `sam add "<text>" [options]`

Aliases: `remember`, `save`. Saves one self-contained sentence (at least 6 characters) as a user memory.

| Option | Meaning |
|---|---|
| `-k, --kind <kind>` | memory kind (default `note`) |
| `--pin` | always include it in the session card |
| `--files a,b` | related files; edits to them can surface this memory |
| `-g, --global` | user-wide instead of this project |
| `-p, --project <name>` | another project |
| `--body "<text>"` | longer detail stored with the gist |
| `--topic <key>` | topic key for supersession (a newer memory with the same topic replaces the older one) |
| `--valid-from <date>` / `--valid-to <date>` | validity window: a date string, or epoch seconds/ms. Outside the window the memory is invisible |
| `--force` | re-add content that was purged or forgotten with a tombstone |
| `--source <agent>` | agent label recorded with it (default `cli`) |

Prints the outcome and the id: `created #id`, `merged #id` (an exact or near-duplicate of an existing memory), or `superseded #id` with `(replaces #…)` when it retires an older memory on the same subject. Exits 1 when a tombstone blocks the content.

### `sam ls [-k kind] [-n 50] [--all] [--all-projects]`

Alias: `list`. Lists memories of this project (and global ones), newest first, with 📌 for pinned ones. `--all` also shows superseded and held rows, marked `(→id)` or `(status)`.

### `sam forget <id> [--hard [--no-tombstone]] [--tombstone]`

A soft forget retires the memory. `--hard` deletes the row with secure delete and purges it from the search indexes; by default it keeps a fingerprint (tombstone) so the same text is not captured again, and `--no-tombstone` skips that. `--tombstone` adds a fingerprint to a soft forget. Copies in raw events, the vault or digests are removed by `sam purge`.

### `sam pin <id>` / `sam unpin <id>`

Pinned memories are always in the session card (inside the budget).

### `sam context [--prompt "<text>"] [--hint mcp]`

Prints the session card an agent would receive here, with its token count, and with `--prompt` the per-prompt recall for that prompt. Nothing is recorded.

### `sam handoff [--to agent] [--files a,b] [--from agent] "<note>"`

Leaves a note that the next session of another agent in this project receives once (or the named agent with `--to`). The sender defaults to `$SAM_AGENT`, else `cli`.

### `sam handoff --list [--all] [-n 20]`

Alias: `sam handoffs`. Open handoffs of this project; `--all` includes consumed ones.

## Token savers

### `sam run [--shell] [--lines 40] -- <command…>`

Runs a command, stores its full output (ANSI colors and progress bars stripped, up to `vaultMaxBytes`) in the output vault and prints a digest of at most 40 lines (change with `--lines`): the status header (`exit N · L lines`), error lines with context, and the tail. The exit code is the command's. Pass the command as separate words after `--`. A single string containing shell operators (`; & | < > ` `` ` `` `$(`) is refused unless you add `--shell`, so a host's "always allow `sam run`" rule can't approve a whole shell program unseen.

```bash
sam run -- npm test
sam run --shell -- "npm test && npm run lint"
```

### `sam out <id> [--grep re] [--tail N] [--lines A:B]`

Reads a vault output: everything, matching lines (`--grep`, with one line of context), the last N lines, or a line range. Vault entries expire after `vaultRetentionDays` (default 14).

## Maintenance

### `sam stats [--all-projects]`

Live memories by kind; saved, merged, auto-detected fixes and harvested markers; tokens injected (o200k, with estimates for Claude 4.6/4.7 and Gemini 3 tokenizers) split by session cards, prompt recalls, file notes and fix pushes; native-memory duplicates skipped; output-vault bytes captured vs shown.

### `sam gc [--dry-run] [--force]`

Hygiene pass, LLM-free: expires raw events (`eventRetentionDays`), vault outputs (`vaultRetentionDays`) and 7-day injection ledgers; merges near-duplicates that slipped in; archives stale session digests and abandoned todos; reinforces memories the agents keep fetching; drops expired held rows. It also runs automatically at session start, at most once a day. If the clock looks like it jumped more than a year past the newest activity, time-based expiry is skipped; `--force` runs it anyway. `--dry-run` only counts. Prints a JSON summary.

### `sam purge <id…> | --query "<words>" | --project <name|id> | --all-matching "<text>"`

Erases content from every table (memories and their older versions, raw events, first prompts, vault outputs, digests, ledger rows, handoffs, the team file), then runs `VACUUM`. It always shows a preview first, and asks for confirmation in a terminal.

| Option | Meaning |
|---|---|
| `--yes` | do not ask (required when there is no terminal) |
| `--dry-run` | show the preview only |
| `--include-backups` | also delete `sam.db.corrupt-*` copies that still hold old content |
| `--no-tombstone` | do not keep fingerprints (by default purged text is not re-captured) |
| `--all-projects`, `-n 20` | scope and hit limit for `--query` |

Files you exported yourself and host-agent transcripts are outside SAM's reach; the command says so.

### `sam review [ls] [--status pending|quarantined] [--json] [--all-projects]`

The inbox of held memories. The write guard checks every non-user write (agent markers, `mem_save`, auto-captured fixes, team files, imports): **quarantined** rows matched injection heuristics (pipe-to-shell, exfiltration, "ignore previous", hiding things from the user, role imitation, hidden unicode, …); **pending** rows went over the per-session/per-day cap for agent writes, or are agent-written rules while `reviewAgentRules` is on. Each line shows the reason. Held memories are never shown to agents, and are deleted after `reviewExpireDays` (default 14) unless approved.

- `sam review approve <id…>`: activate them.
- `sam review reject <id…> [--hard]`: retire them (`--hard` deletes).
- `sam review approve-all [--quarantined]`: approve every pending one (`--quarantined` includes quarantined ones).

### `sam audit [--days 30] [-n 10] [--json] [--all-projects]`

Counts by source, status and kind, the most injected memories, the follow-up rate of injections and the quarantine reasons over the last N days.

### `sam sleep [--dry-run] [--days 14] [--event-days 7] [--drafts]`

Consolidation pass: merges near-duplicate clusters (SimHash distance `sleepHamming`), folds session digests older than `--days` into one digest per week, prunes raw events of ended sessions older than `--event-days`; `--drafts` also writes skill drafts. Runs automatically once a day when `sleep: true`. Prints a JSON summary.

### `sam skills draft [--min 3] [--dry-run] [--all-projects]`

Turns fix patterns that repeated at least `--min` times into `SKILL.md` drafts under `~/.sam/drafts`. Drafts are never installed; review them and copy them into a skills folder yourself.

### `sam export [--md|--jsonl] [--team] [--sessions] [--all-projects] [-o file]`

- Markdown (default): live memories of this project, grouped by kind. `--sessions` adds session digests.
- `--jsonl`: a lossless backup of every row of this project (or every project with `--all-projects`), including supersession, status and validity windows.
- `--team`: writes or updates `<repo>/.sam/memory.md`, the team file you commit. It holds this project's live memories except preferences and session digests; lines teammates wrote are kept, lines retired here are dropped, and a line a teammate deleted is not re-added.
- `-o file` writes to a file instead of stdout.

### `sam import <file.md|file.jsonl> [--trusted]`

Imports Markdown or JSONL. Untrusted by default: everything lands in this project with `import` provenance, unpinned, re-redacted and checked by the write guard. Use `--trusted` for your own backups: JSONL rows then keep their project, pin and provenance. Rows whose id already exists are skipped.

### `sam trust [--yes] [--off]`

Shows this repo's `.sam/memory.md` and, after you confirm in a terminal (or pass `--yes`), imports it and trusts that exact content. A later change to the file needs a new review. `--off` stops importing it. See [Concepts → Team file](concepts.md#team-file).

### `sam embed`

Backfills embeddings for active memories that have none, using the configured endpoint. Nothing embeds at save time, so re-run it after adding memories. Exits 1 with a hint when embeddings are off. See [Configuration → Embeddings](configuration.md#optional-embeddings).

### `sam snippet`

Prints a generic MCP server entry plus a rules block for MCP clients SAM does not wire itself.

### `sam skill`

Prints the `SKILL.md` text SAM installs for agents.

### `sam tokens [text]`

Prints SAM's o200k token estimate for the text, or for stdin.

## Internal

These are what the hooks and MCP entries run; you do not normally call them.

- `sam hook <Event> --agent <name> [--hint <h>]` reads the host's hook JSON on stdin and prints the host's response JSON. It never fails the host: errors are swallowed (`SAM_DEBUG=1` prints them).
- `sam mcp [--agent <name>]` runs the stdio MCP server. See [MCP server](mcp.md).
