# Configuration

SAM works with no configuration. Every setting has a default (in [`src/config.js`](../src/config.js)) and can be changed in two places:

1. **`~/.sam/config.json`**, a JSON object (`$SAM_HOME/config.json` when `SAM_HOME` is set).
2. **Environment variables**: the key in upper snake case with a `SAM_` prefix. `budgetPrompt` becomes `SAM_BUDGET_PROMPT` and `embedUrl` becomes `SAM_EMBED_URL`.

**Precedence:** environment > `config.json` > default.

Values are checked against the type of the default:

- **Numbers** must be finite and ≥ 0.
- **Booleans** accept `true/false`, `1/0`, `yes/no` and `on/off`.
- **Strings** accept anything.

A bad value falls back to the default with a warning, and unknown keys are reported too. Warnings print on stderr for CLI commands (never inside hooks or the MCP server), and `sam doctor` lists them under `config:`.

```json
{
  "budgetSessionStart": 400,
  "budgetProfile": "claude-4.7",
  "redactPII": true
}
```

The configuration is read once per process. Hooks and the MCP server pick up changes on their next start (a new session).

## Token budgets

Budgets are in o200k tokens, measured with SAM's built-in estimator (calibrated against tiktoken's o200k_base; `sam tokens` shows it).

| Key | Default | Meaning |
|---|---|---|
| `budgetSessionStart` | `320` | maximum tokens of the session card |
| `budgetPrompt` | `160` | maximum tokens of per-prompt recall |
| `maxPromptHits` | `3` | maximum memories in one per-prompt recall |
| `budgetProfile` | `''` | per-host multipliers: a preset (`claude-4.7`, `claude-5` = Claude ×1.6; `claude-4.6` = ×1) or a list such as `claude=1.6,codex=1` (each multiplier >0 and ≤4) |
| `turkishBudgetBoost` | `1.25` | budget multiplier for Turkish-heavy stores (`1` = off) |
| `turkishShare` | `0.5` | share of Turkish gists that makes a store "Turkish-heavy" |

`sam doctor` shows each host's budget converted to its native tokenizer with the measured ratios (Claude 4.6 ×1.15, Claude 4.7 ×1.6, Gemini 3 ×1.06).

## Session card

| Key | Default | Meaning |
|---|---|---|
| `cardCoreMax` | `14` | lines in the card's core section |
| `cardGlobalMax` | `3` | unpinned global lines in the core section |
| `cardDiverse` | `true` | one line per area (first tag) before a second line on the same area |
| `cardGistMax` | `80` | gist length on the card (full text via `mem_get`) |
| `cardGistMaxDurable` | `120` | gist length for convention/decision/preference/procedure lines; cut at a clause boundary, never inside a `code span` or flag |
| `cardFixMax` | `3` | past-fix lines on the card |
| `recentSessions` | `2` | recent session digests on the card |
| `hotFiles` | `6` | recently edited files on the card |
| `smallStore` | `true` | small projects get a deterministic full dump instead of a ranked selection |
| `smallStoreMax` | `40` | at most this many live (non-session) memories in scope to qualify |
| `smallStoreTokens` | `1500` | token budget of the full dump |
| `smallStoreChars` | `9000` | hard character cap of the dump (Claude Code cuts hook output at 10,000 characters) |
| `sourceTags` | `true` | mark agent/team/import lines with `-a`/`-t`/`-i` bullets (user and auto lines keep `-`) |

## Native host memory

SAM reads, but never writes, what the host already loads: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, rules files, Claude auto memory and Antigravity knowledge.

| Key | Default | Meaning |
|---|---|---|
| `nativeDedup` | `true` | drop card lines the host already loads; note contradictions once per session |
| `nativeDedupJaccard` | `0.6` | token Jaccard (same polarity) at or above which a line counts as already present |
| `nativeConflictMax` | `2` | at most this many contradiction notes per card |

## Retrieval and the relevance gate

Per-prompt recall is injected only when a hit passes the gate. These keys tune it. The defaults were tuned on the tuning half of `bench/retrieval` (see [Benchmarks](benchmarks.md)).

| Key | Default | Meaning |
|---|---|---|
| `gateMode` | `coverage` | `coverage` (IDF coverage + rare-concept evidence) or `rrf` (the legacy score floor) |
| `minPromptCoverage` | `0.2` | share of the prompt's IDF mass a memory must cover |
| `relPromptFloor` | `0.5` | drop hits scoring below this fraction of the best hit |
| `weakPromptCoverage` | `0.25` | if nothing is strong, the single best hit still passes at this coverage (`0` = off, precise mode) |
| `absentTermWeight` | `0.7` | IDF weight of prompt words that occur nowhere in memory (`1` = stricter) |
| `rareConceptShare` | `0.15` | a concept is "rare" when it occurs in at most this share of searchable memories |
| `gateMinConcepts` | `1` | rare prompt concepts a hit must cover |
| `singleConceptCoverage` | `0.4` | …unless the hit alone covers this share of the prompt's IDF mass |
| `minPromptScore` | `0.012` | RRF score floor, used only with `gateMode: "rrf"` |
| `specGate` | `true` | project-specificity gate: no recall for prompts about a sibling project or a stack this project never uses |
| `expandQuery` | `true` | EN/TR developer-vocabulary aliases, Turkish stems, typo correction |
| `expansionWeight` | `0.7` | RRF weight of the expansion list relative to the user's own words |
| `decayFloor` | `0.75` | important decisions/conventions/preferences never decay below this factor |
| `globalFactor` | `0.85` | score multiplier for global memories inside a project |
| `gateLog` | `true` | record per-prompt gate features in the DB for later calibration |

## Fix push

After a failed command, SAM can push one matching past fix into the conversation.

| Key | Default | Meaning |
|---|---|---|
| `fixPush` | `true` | enable fix pushes |
| `fixPushMax` | `2` | at most this many per session |
| `budgetFix` | `70` | token budget of one push |

## Capture

| Key | Default | Meaning |
|---|---|---|
| `captureDirectives` | `true` | save "remember…", "from now on…", "always/never…" (and Turkish equivalents) from user prompts |
| `harvestMarkers` | `true` | save `⟦mem kind: …⟧` markers from assistant replies |
| `captureCommands` | `true` | record shell commands (fail→fix detection) |
| `captureEdits` | `true` | record edited files (hot files, file notes) |

## Write guard and review

| Key | Default | Meaning |
|---|---|---|
| `guard` | `true` | quarantine non-user writes that match injection heuristics (hidden from agents until `sam review`) |
| `agentCapSession` | `6` | max new active agent-sourced rows per kind per session; the excess is held as pending (`0` = off) |
| `agentCapDay` | `30` | max new active agent-written rows per kind per project per day; the excess is held as pending (`0` = off) |
| `reviewAgentRules` | `false` | agent-written convention/preference/procedure rows start as pending until you approve them |
| `reviewExpireDays` | `14` | held rows not approved within this many days are deleted |

## Handoffs

| Key | Default | Meaning |
|---|---|---|
| `handoff` | `true` | write a handoff at the end of a session and surface it once to the next other agent |
| `handoffMaxTokens` | `60` | maximum tokens of the surfaced handoff line |
| `handoffMaxAgeDays` | `14` | older unconsumed handoffs are not surfaced |

## Privacy

| Key | Default | Meaning |
|---|---|---|
| `redactPII` | `true` | mask e-mail addresses, phone numbers, IBANs (mod-97 checked) and Turkish ID numbers (TCKN, checksum checked) before anything is stored |

Secrets (API keys, tokens, JWTs, private keys, `password=` patterns) are always masked, and `<private>…</private>` spans are always dropped, independent of this switch.

## Retention

| Key | Default | Meaning |
|---|---|---|
| `eventRetentionDays` | `21` | raw events (commands, edits) and first prompts are deleted after this many days |
| `vaultRetentionDays` | `14` | `sam run` outputs are deleted after this many days |
| `vaultMaxBytes` | `2000000` | maximum stored output per command |

## Optional embeddings

SAM is fully lexical by default (BM25 + trigram + expansion). With an OpenAI-compatible `/v1/embeddings` endpoint (Ollama, LM Studio, vLLM, OpenAI…) vectors become an extra signal in the rank fusion.

| Key | Default | Meaning |
|---|---|---|
| `embedUrl` | `''` | base URL (`/embeddings` is appended unless already present), e.g. `http://localhost:11434/v1` |
| `embedModel` | `''` | model name sent in the request |
| `embedKey` | `''` | sent as `Authorization: Bearer …` when set |
| `embedInHooks` | `false` | also embed the prompt inside the per-prompt hook (adds network latency to every prompt) |
| `minPromptCosine` | `0.6` | with vectors in hooks: a hit at or above this cosine clears the gate without lexical coverage |
| `allowRemoteEmbed` | `false` | **`config.json` only**: permit a non-localhost `embedUrl` set by environment variable |

How it works:

- Embeddings are on only when both `embedUrl` and `embedModel` are set.
- **Nothing is embedded when a memory is saved**, because hooks never call the network. Run `sam embed` to embed active memories that have no vector yet (up to 2000 per run, in batches of 32). Re-run it after new memories arrive, for example from a cron job.
- `sam q` and `mem_search` embed the query when embeddings are on. The per-prompt hook does so only with `embedInHooks: true`.
- Requests time out after 8 seconds. If the query embedding fails, search continues with the lexical signals.
- **Remote endpoints:** prompts and memories are sent to `embedUrl`. An environment variable alone (which a repo's host settings, a direnv file or a devcontainer could inject) may only point at this machine (`localhost`, `*.localhost`, `127.x.x.x`, `::1`, `0.0.0.0`). For a remote endpoint put `embedUrl` itself in your `config.json`, or set `"allowRemoteEmbed": true` there.

Example with Ollama:

```json
{ "embedUrl": "http://localhost:11434/v1", "embedModel": "nomic-embed-text" }
```

```bash
sam embed   # → embedded N memories (nomic-embed-text @ http://localhost:11434/v1)
```

## Experimental (off by default)

| Key | Default | Meaning |
|---|---|---|
| `actr` | `false` | ACT-R base-level activation as an extra ranking factor |
| `actrDecay` | `0.5` | the decay `d` in ln(Σ t_j^-d) |
| `actrWeight` | `0.15` | factor range 1 ± `actrWeight` |
| `demote` | `false` | `sam gc` lowers unused memories to a low-importance tier instead of archiving them |
| `demoteAfterDays` | `90` | unused this long → demoted |
| `sleep` | `false` | run `sam sleep` automatically, at most once a day (with the automatic gc) |
| `sleepDigestDays` | `14` | session digests older than this are folded into one digest per week |
| `sleepEventDays` | `7` | raw events of ended sessions older than this are pruned |
| `sleepHamming` | `5` | SimHash distance for near-duplicate clusters (gc uses 3) |
| `skillDrafts` | `false` | `sam sleep` also writes skill drafts from repeated fixes to `~/.sam/drafts` |
| `skillDraftMin` | `3` | a fix pattern must repeat at least this often |

## Storage

| Key | Default | Meaning |
|---|---|---|
| `dbPath` | `~/.sam/sam.db` | database file (default follows `SAM_HOME`) |

Keep the database on a local disk. On a network or cloud-synced folder SQLite's WAL is unsafe, so SAM switches to the slower rollback journal and `sam install` / `sam doctor` warn about it (`SAM_ALLOW_SHARED_FS=1` keeps WAL if you know the mount is local).

## Environment variables that are not config keys

| Variable | Meaning |
|---|---|
| `SAM_HOME` | folder for the DB, `config.json`, launcher and drafts (default `~/.sam`). The value at install time is baked into the launcher |
| `SAM_NODE` | Node binary the launcher should use (otherwise: `PATH`, the Node that ran `sam install`, Homebrew, nvm, Volta…) |
| `SAM_SHELL` | shell for `sam run` on Windows: `bash` (Git Bash, the default when found), `pwsh`/`powershell`, or `cmd`. On POSIX `/bin/sh` is used, or Git Bash with `bash` |
| `SAM_VAULT_ENCODING` | decoding for command output that is not valid UTF-8 (otherwise the Windows console code page, then CP857 / windows-1254, else latin1) |
| `SAM_ALLOW_SHARED_FS=1` | keep WAL journaling on a folder SAM thinks is shared |
| `SAM_PROJECT_DIR` | resolve the MCP server's project from this directory instead of its working directory |
| `SAM_SESSION` | session id that `sam run` records its output under |
| `SAM_AGENT` | sender name for `sam handoff` (default `cli`) |
| `SAM_DEBUG=1` | print stack traces; hooks print their swallowed errors on stderr |
| `SAM_NO_COMPILE_CACHE=1` | do not enable Node's compile cache for the CLI |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` | honored by `sam install` to find Claude Code, Codex and OpenCode config folders |

Development only: `SAM_INSTALL_HOME` (sandbox home for install tests), `SAM_TEST`, `SAM_SELFTEST`, `SAM_CLAUDE_VERSION`, `SAM_SLOW` (enables the slow chaos tests).
