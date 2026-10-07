# SAM v1.1.0: packaging, developer experience, docs and maintainability review

> Audit report on SAM **v1.1.0** (`66f45b6`), written 2026-10-07 as part of the six-perspective audit summarized in [../AUDIT2.md](../AUDIT2.md). Line numbers refer to v1.1.0. Experiments ran on throw-away copies of the repo; repro scripts and simulation drivers mentioned here were working files and are not shipped, except the retrieval eval set, which now lives in [`bench/retrieval/`](../../bench/retrieval/).

- **Repo reviewed:** `super-agent-memory/` at `66f45b6` (v1.1.0). All experiments ran in a copy of the repo, with `SAM_HOME` and `SAM_INSTALL_HOME` pointed at temp dirs.
- **Environment:** Linux x64, 2 vCPU (shared with other jobs), Node 22.23.3 / npm 10.9.9, plus Node 24.21.0 fetched via `npx node@24`. **Windows and macOS were not run.** Statements about them come from reading the code and are marked as such.
- **Ready-to-commit files:** `the packaging proposal files (merged in v1.2.0)/` (listed in §10).

---

## 0. Prioritized summary

**P0: fix before publishing**

1. **`npm test` changes the developer's real Claude Code config.** `install.js` runs the real `claude` CLI (`claude mcp remove/add --scope user sam`), and `SAM_INSTALL_HOME` does not redirect it. Reproduced with a logging fake `claude` on PATH: the test suite ran `claude mcp add --scope user sam -- /usr/bin/node <copy>/bin/sam.js …` twice and then `claude mcp remove --scope user sam` against `HOME=/home/sandbox`. On a contributor's machine that removes their real `sam` MCP registration, and the suite never asserts on it. (§5.3)
2. **`sam --version` and `sam -v` print the full help instead of the version.** `parse()` treats them as flags before the `switch` sees them, so they never reach the `case '--version'`. `sam -h`/`--help` only work by accident. (§2)
3. **The CI matrix will almost certainly fail on `windows-latest`** (from reading the code; not run). Two tests assume POSIX:
   - `sh -c "printf %s <quoted>"` checks POSIX quoting, but on win32 `shellQuote` produces cmd.exe double quotes, which `sh` expands. `$(touch …)` would actually run, and the assert fails.
   - `sam run -- printf …` runs through `cmd.exe`, which has no `printf`.
   
   Launching with a red Windows badge undercuts the cross-platform claim. (§5.2)
4. **The README's "Security and safety" section has no Turkish counterpart.** README.tr.md also lacks the configuration table, How it works, Development and Credits sections. A paste-ready translation is in `README.tr.missing-sections.md` (proposal, merged in v1.2.0). (§3.2)
5. **Stale or false numbers in the docs:**
   - README says "14 tests". There are 22.
   - README and AUDIT say "about one run in 40 lands at 19/20". Measured: **14 of 140 runs (~1 in 10)**.
   - `mcp.js` says the tool schema is "~480 tokens". It measures 314.
   - `text.js` cites `bench/calibrate-tokens.md`, which does not exist.
   - The estimator accuracy is stated three different ways: README ±3%, ARCHITECTURE +1%/−2%, JSDoc ±5% with hex −15% and JSON +15%.
   
   Full list in §3.1.
6. **The tarball ships about 260 kB of internal research and audit notes,** and they contain internal workspace paths (`<workspace>`, `/tmp/audit-copy`), references to repro scripts that are not in the repo, and agent narration ("someone else was changing the working tree"). Narrowing `files` takes the package from 168.5 kB to 64.1 kB packed (449 → 185 kB unpacked). Scrub `docs/audit/*.md` before the repo goes public. (§1, §6)
7. **package.json has no `repository`, `homepage`, `bugs` or `author`.** Without `repository`, the relative links in the README (docs/…) are broken on npmjs.com. There is no `exports` either, so every `src/*.js` becomes de facto public API the moment it is published. (§1)

**P1: first-week DX**

8. **User errors print raw stack traces** (`sam add` with no text, `sam import` with no path, `-p unknown`, `sam trust` outside a repo, `sam run` with no command, `sam embed` with the endpoint down). Exit codes are inconsistent:
   - "not found" exits 0;
   - `sam install bogusagent` prints `✔ … Done` and exits 0;
   - installer `ERROR` lines exit 0;
   - unknown commands print the help to stdout, not stderr.
   
   (§2)
9. **The CLI and MCP validate input differently:**
   - `sam add "hi"` is accepted, but MCP rejects anything under 6 characters;
   - `sam add … -k weird` silently becomes a `note`, but MCP returns an error;
   - `--flag=a=b` drops everything after the second `=` (`sam out <id> --grep=KEY=val5` greps for `KEY`).
   
   (§2, §4)
10. **The `sam` binary name collides with the AWS SAM CLI,** which installs `/usr/local/bin/sam`. Hooks are safe because they use absolute paths. The rules and skill text tell agents to run `sam q`, `sam run -- …` and `sam out`, so on a machine with AWS SAM those calls hit the wrong binary. At minimum, say so in the README and have the rules fall back to `super-agent-memory`. Better, have the installer write the absolute command into the rules. (§1)
11. **Config typos and errors fail silently** (§7):
    - a malformed `config.json` is ignored with no warning;
    - unknown keys are ignored (`budgetSesionStart`);
    - a non-numeric env var becomes `NaN`, which turns the budget check off (`SAM_BUDGET_SESSION_START=abc` → 309-token card);
    - `autoProjectCard` is dead config;
    - half the config keys and five env vars (`SAM_HOME`, `SAM_DEBUG`, `SAM_PROJECT_DIR`, `SAM_SESSION`, `SAM_INSTALL_HOME`) are undocumented.
12. **The tests depend on their order** (§5.3):
    - `--test-name-pattern "hybrid search"` and `"markdown export"` fail when run alone;
    - a 6 s `setTimeout(kill)` that is never cleared adds about 5 s to every run (8.5 s total, 3.3 s of actual tests);
    - each run leaks four `/tmp/sam-*` dirs.
13. **The missing hygiene files are drafted:** CHANGELOG, SECURITY, CONTRIBUTING, issue and PR templates, `.gitattributes`, `.editorconfig`, an improved CI (fail-fast off, Node 22.13.0 floor, pack + global-install smoke job) and a release workflow.

**P2: maintainability**

14. **Code duplication:**
    - the vault/memory id routing and formatting is copied between `cli get` and `mcp mem_get`;
    - shell quoting is copied between `cli run` and `install.js`;
    - `VERSION` is defined in three places;
    - the ExperimentalWarning filter is copied in three places;
    - the `meta` upsert is written out six times.
15. **Code structure:**
    - `cli.main` is a 163-line switch;
    - there are 90 exports and 28 JSDoc blocks;
    - about 40 lines are over 160 characters (the longest is 399);
    - about 20 tunable numbers are inline.
    
    The top 10 refactors are ranked in §4.4.

**What is good.** Zero dependencies. A global install works from any directory. Hooks run in about 50–55 ms (median, matching the README's "≈50–90 ms"). The MCP handshake is clean. No ExperimentalWarning leaks on Node 22 (the filter works) or Node 24 (where none is emitted). The benchmark reproduces the README table almost exactly. The package name `super-agent-memory` is free on npm. The architecture docs are accurate in nearly every formula and constant I checked.

---

## 1. npm packaging

### 1.1 `npm pack`, global install, smoke run

| Step | Result |
|---|---|
| `npm pack --dry-run` / `npm pack` | OK. `super-agent-memory-1.1.0.tgz`, 32 files, **168.5 kB packed / 449.2 kB unpacked**. Note: the tarball is named `super-agent-memory-*.tgz`, not `sam-*.tgz`. |
| `npm i -g --prefix /tmp/x ./super-agent-memory-1.1.0.tgz` | OK. Two shims, `sam` and `super-agent-memory` → `bin/sam.js` (git mode 100755, shebang present). |
| `sam doctor` from `/tmp/anywhere` | OK, exit 0. Prints node, DB path, memory count, detection, budgets, "MCP tool schema ~314 tokens". |
| `sam install --dry-run` | Prints "No supported agents detected…" with **exit 0**. `--all --dry-run` lists every file it would write. Minor inaccuracy: it says "would write ~/.claude.json" even when the `claude` CLI is present, which the real run would use instead. |
| `sam hook SessionStart / UserPromptSubmit / Stop`, including garbage stdin and an unknown event | Always exit 0. Output is JSON or empty, stderr is empty. Median latency 50–55 ms (bare `node -e 0` takes 16 ms). |
| MCP handshake (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`) | OK. Protocol echo `2025-06-18`, 4 tools, errors come back as `isError: true` content. |
| `sam run -- ls /nonexistent` | Prints the digest. **Exit code 2 is propagated** (correct). A 101-line loop collapses to 3 lines plus a pointer. |
| ExperimentalWarning | Node 22.23 emits `ExperimentalWarning: SQLite is an experimental feature` for a raw `require('node:sqlite')`. `bin/sam.js` filters it, and `sam` output was clean. Node 24.21 emits no warning. The same filter is copied into `test/sam.test.js` and `bench/tokens.js`; move it into one tiny module. |

### 1.2 package.json fields

| Field | Status | Recommendation |
|---|---|---|
| `name: super-agent-memory` | **Available.** `registry.npmjs.org/super-agent-memory` → 404. `sam` is taken (200, "Lightweight framework for the SAM pattern", 0.0.7, last modified 2022), as are `sam-cli` and `agent-memory`. `sam-memory` is free. | Publish as `super-agent-memory`. Consider reserving the scoped `@<owner>/sam`. |
| `bin` | `sam` and `super-agent-memory` | Keep both. Document `super-agent-memory` as the fallback when `sam` is shadowed by the **AWS SAM CLI** (its installer symlinks `/usr/local/bin/sam`, per https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Hooks and MCP entries use absolute `node …/sam.js` paths, so they are unaffected. The `RULES_BLOCK` and `SKILL` tell agents to type `sam q` / `sam run --`, which would run AWS SAM. Have the installer substitute the absolute command, or tell agents "`sam` (or `super-agent-memory`)". |
| `files` | Includes all of `docs/`: `docs/research/*` is 187 kB and `docs/audit/*` is 73 kB. | Narrow it to `bin, src, plugins, README*, LICENSE, CHANGELOG.md, SECURITY.md, docs/ARCHITECTURE.md, docs/AUDIT.md` → **64.1 kB packed / 184.6 kB unpacked, 26 files** (measured). `.npmignore` is then unnecessary: an allowlist is safer than a denylist. |
| `engines: >=22.13` | Matches the runtime guard in `bin/sam.js`. | Add `22.13.0` to CI so the floor is actually tested. |
| `type: module` | OK | — |
| `exports` / `main` | **Missing.** `import 'super-agent-memory'` fails, and every deep path `super-agent-memory/src/*.js` is importable. | For 1.x, declare the package CLI-only: `"exports": {"./package.json": "./package.json"}`. Add a curated `src/index.js` later if a programmatic API is wanted. |
| `keywords` | Good | Add `model-context-protocol` and `sqlite`. |
| `repository`, `homepage`, `bugs`, `author` | **Missing** | Required for npm page links, including the README's relative `docs/…` links. |
| `license: MIT` + LICENSE | OK ("Copyright (c) 2026 Cuma Bozkurt") | — |
| scripts | `test`, `bench` only | Add `test:coverage` and `prepublishOnly: npm test`. `node --test test/*.test.js` works on Windows because Node 22's test runner expands the glob itself. |
| `publishConfig` | — | `{"access":"public","provenance":true}` with the release workflow. |

A proposed manifest is in `package.json.proposed` (proposal, merged in v1.2.0) (valid JSON, packed and checked). `GITHUB_OWNER` is a placeholder because the GitHub account was not known yet.

---

## 2. First-run UX, help, errors, exit codes

**Every command in README.md and README.tr.md ran verbatim** after a global install, inside a fresh git repo with a remote:
`npm i -g`, `sam install`, `sam q "stripe webhook"`, `sam get 29on 17vc`, `sam add "deploy: fly.io via GH Actions" -k decision --pin`, `sam context --prompt "fix login"`, `sam run -- pnpm test`, `sam stats`, `sam export --team`, `sam trust`, `sam gc`, `sam context --prompt "login'i düzelt"`, `npm test`, `npm run bench`. All exited as expected.

Two of them only work in a specific context:
- `sam export --team` and `sam trust` need to run inside a repo. Elsewhere they fail with a stack trace (below).
- `git clone … && npm link` is a placeholder URL.

**CLI behaviors (globally installed `sam`, Node 22.23)**

| Invocation | Output | Exit | Verdict |
|---|---|---:|---|
| `sam --version`, `sam -v` | **full help text** | 0 | **Bug.** `parse()` puts them in `flags`, so `cmd` is undefined and the help prints. `sam version` works. |
| `sam -h`, `sam --help`, `sam` | help | 0 | OK, by accident of the same bug. |
| `sam frobnicate` | "unknown command" + full help **on stdout** | 2 | Exit code is right. The message belongs on stderr, with a one-line hint instead of the whole help. |
| `sam add` (no text) | `sam: Error: empty memory` **+ 3-line stack** | 1 | Print the message only. Keep stacks for `SAM_DEBUG`. |
| `sam add "hi"` | `created #…` | 0 | Inconsistent: MCP `mem_save` rejects under 6 chars. |
| `sam add "deploy: fly" -k weird` | saved as `note` silently | 0 | Inconsistent: MCP errors on unknown kinds. |
| `sam ls -p nosuchproject` | `Error: unknown project …` + stack | 1 | Message only. List the known projects. |
| `sam trust` / `sam export --team` outside a repo | `Error: not inside a project` + stack | 1 | Message only, plus a hint (`git init` or `.sam-project`). |
| `sam import` (no path) | `TypeError [ERR_INVALID_ARG_TYPE]` + stack | 1 | Usage error, exit 2. |
| `sam import /nonexistent.md` | `ENOENT` + stack | 1 | Friendly message. |
| `sam run` (no command) | `Error: usage: sam run -- <command>` + stack | 1 | Usage, exit 2. |
| `sam get zzzz`, `sam forget zzzz`, `sam pin` (no id), `sam out o1234` | "not found" | **0** | Exit 1 so scripts can tell. `sam forget`/`pin` with no id should print usage. |
| `sam q` (no words) | "no matches" | 0 | Usage, exit 2. |
| `sam install bogusagent` | `✔ bogusagent / unknown agent / Done. Restart your agents…` | **0** | Reject unknown agents up front (exit 2). Never print ✔ for a failure. |
| installer hits an `ERROR` (e.g. invalid JSONC) | `ERROR …` line | **0** | Set `exitCode = 1` when any agent logged `ERROR`. |
| `sam install` with nothing detected | hint | 0 | Acceptable. Exit 1 would be friendlier for scripts. |
| `sam install claude` (only) | "Codex: run /hooks once…" | 0 | Print the Codex note only when Codex was installed. |
| `sam embed` with the endpoint down | `TypeError: fetch failed` + undici stack | 1 | Message: "embedding endpoint unreachable: <url>". |
| `sam out <id> --grep=KEY=val5` | greps for `KEY` | 0 | **Bug:** `a.slice(2).split('=')` drops everything after the second `=`. Split on the first `=` only. |
| `sam ls -n -5` | `LIMIT -5` = unlimited | 0 | Validate numeric flags. |
| `sam ls --json` | flag ignored | 0 | Only `q` supports `--json`. Make it consistent or document it. |
| `sam context --prompt` (no value) | prompt becomes `"true"` | 0 | Minor. |
| `sam out` line count | "61 lines" for 60 lines | — | The trailing newline is counted as a line. |

**Help text gaps.** Undocumented but working: `sam skill`, `sam tokens`, `q --json`, `--all-projects`, `export -o FILE`, `export --sessions`, `add --body/--topic/--source`, `--hint`, `sam version`. Documented but a no-op: `export --md`, which is already the default.

**Uninstall is not quite "removes exactly what was added"** (fresh home, only `~/.claude/` dir present):
- `uninstall` leaves `~/.claude/settings.json` as `{}` and `~/.claude.json` as `{"mcpServers":{}}`. Both files were created by install.
- It also leaves `settings.json.sam-bak` and `.claude.json.sam-bak`. Because the originals did not exist, the "backup" is taken on the uninstall write, so it contains **SAM's own entries**. Restoring it re-installs SAM.

Fix: remember which files install created (e.g. in `meta`), delete them on uninstall when they are otherwise empty, and do not back up files SAM created.

---

## 3. Docs accuracy

### 3.1 Claims checked against code and measurements

Benchmark: 3 manual runs plus 140 automated runs of `npm run bench`.

| # | Claim (where) | Reality | Verdict |
|---|---|---|---|
| 1 | "`npm test` # 14 tests" (README, Development) | 22 `test()` cases, 22 pass on Node 22.23 and 24.21 | **Stale** |
| 2 | Benchmark table A 32,180 / B 29,464 / C 2,680, 20/20; "38 tokens on unrelated prompts" (README, README.tr) | A = 32,180 exactly. B 29,458–29,519. C 2,636–2,715 (mean 2,680). Unrelated prompts 38–41. "~91% fewer" ✓. Vault 18,848 → 81 ✓ | **Accurate** |
| 3 | "About one run in 40 lands at 19/20" (README, AUDIT known limits) | **14 of 140 runs** landed at 19/20 (3/40 and then 11/100), so about **1 in 10** | **False.** Say "about 1 run in 10", or make the bench deterministic (seeded ids). |
| 4 | "493-memory corpus" (README) vs "600 items" (bench header comment) | 600 saved, 493 live after near-dup merges. The bench prints 493 | README ✓. The bench header comment is misleading. |
| 5 | Estimator "±3% on prose, code and markdown" (README) / "+1% prose, −2% code" (ARCHITECTURE, AUDIT) / "±5%, hex −15%, JSON +15%, see bench/calibrate-tokens.md" (`text.js` JSDoc) | Three different statements. **`bench/calibrate-tokens.md` does not exist** | **Inconsistent, with a dangling reference.** Commit the calibration script and data, or drop the reference, and pick one number. |
| 6 | "~480 tokens per session" for the MCP surface (`mcp.js` header comment) | `toolSchemaTokens()` = 314 (doctor and bench) | **Stale comment** |
| 7 | Hooks "≈50–90 ms" (README) / "about 60 ms" (ARCHITECTURE) | Median 50–55 ms on SessionStart, UserPromptSubmit and PostToolUse (60-memory DB) | Accurate |
| 8 | Search 39 ms at 20k memories (AUDIT) / "~38 ms" (ARCHITECTURE) | 67 ms on a 20k synthetic corpus on a shared 2-vCPU box. Insert 1.31 ms (AUDIT: 0.78), gc 0.26 s (AUDIT: 0.18) | Same order of magnitude. AUDIT should state the machine and corpus. 38 vs 39 is a nit. |
| 9 | "Reinforces memories fetched 5 or more times in the last 30 days" (ARCHITECTURE, Hygiene) | Code: `access_count >= 5` (**all-time**) AND `last_access` within 30 days | **Inaccurate wording** |
| 10 | "raw lines are never harvested" (AUDIT H8) / "Markers are harvested only from the assistant's own prose" (README Security) | `harvestTranscript`: `catch { if (!/^\s*[{[]/.test(ln)) strings.push(ln); }`. A **non-JSON transcript line that contains a marker is harvested raw**, whatever its role | **False as written.** Either drop the raw fallback or document it (relevant to the security reviewers). |
| 11 | "`sam uninstall` removes exactly what was added" (README) | Leaves created files as `{}` / `{"mcpServers":{}}` plus `.sam-bak` copies of SAM's own config (§2) | **Overstated** |
| 12 | "Hooks swallow errors and exit 0" (ARCHITECTURE principle 4) | True inside `case 'hook'`. On Node < 22.13, `bin/sam.js` exits **1** before reaching it | Mostly true. Make the version guard exit 0 silently when `argv[2] === 'hook'`. |
| 13 | "Output is deterministic for a given memory state" (session card) | Depends on `Date.now()` (decay, 14-day hot-file window) | True per state, drifts over time. Fine. |
| 14 | `gist (≤110 chars)` (ARCHITECTURE) vs `<= ~100 chars` (db.js schema comment) | 110 for text, 140 for an explicit gist override | Nit: align the comment. |
| 15 | "Hook with a host that keeps stdin open → exits at ~1.5 s" (AUDIT) | Code is correct, but the test only covers the "complete JSON arrived" path (the test finished in about 0.5 s). The 1.5 s timeout path is untested | Claim plausible, **not covered by tests** |
| 16 | Data model, FTS weights (4/1/2/2), RRF k=60, 16 keywords, scoring formula, per-kind importance and half-life table, gc retention, LSH 4×16, ledger 7 d, digests 30, todos 60/30, vault 2 MB, ±1–2 context lines, MCP tool list, project keying | All match the code | Accurate |
| 17 | README integration table (Claude, Codex, Gemini, Antigravity, OpenCode, Cursor paths and events) | Matches `install.js`. Cursor also gets `preCompact` and `sessionEnd`, which are not mentioned | Accurate |
| 18 | Configuration table (README) | Every listed key exists. **Missing:** `recentSessions`, `hotFiles`, `vaultMaxBytes`, `dbPath`, plus `SAM_HOME` and the other env vars (§7) | Incomplete |
| 19 | "Real output, 222 tokens" session card (README) | Not reproduced (it would need the same memory set) | Unverified |
| 20 | docs/audit/*.md, docs/research/*.md | Contain internal paths (`<workspace>/super-agent-memory`, `/tmp/audit-copy`, `/tmp/rv/<repo>`), references to `research/audit/repro/*.mjs` and `research/readmes/` that are **not in the repo**, and narration ("someone else was changing the working tree") | **Scrub before launch** |

### 3.2 README.tr.md parity

| README.md section | README.tr.md |
|---|---|
| Intro, install, Why, problem table | ✓ |
| Benchmark table and caveats | ✓ table. Missing the variance caveat, the "baselines are archetypes, not re-implementations" nuance and the `bench/tokens.js` pointer (partly present) |
| How it works (diagram, sample card, tag legend) | **Missing** |
| Integrations table | Summary only, links to English. Acceptable. |
| **Security and safety** | **Missing entirely** |
| Using it (commands) | ✓, minus `sam gc`. `sam get 29on 17vc` shortened to `sam get 29on` |
| Configuration table | **Missing** |
| Privacy | Shorter. Missing "nothing leaves the machine unless you configure an embedding endpoint" |
| Development, Credits | **Missing**. "Gereksinim / Lisans" one-liner only |

A paste-ready Turkish version of Security, Configuration (with the full key list and env vars), Privacy, Development (22 tests) and Credits is in `README.tr.missing-sections.md` (proposal, merged in v1.2.0). It also has the corrected "about 1 run in 10" sentence.

---

## 4. Code quality

### 4.1 Maintainability assessment

**Overall: good for a 2,698-line, zero-dependency tool. It is not yet comfortable for outside contributors.**

Strengths:
- Small single-purpose modules with a clean dependency direction (text → config/db → store → search/inject → capture → hooks → cli/mcp).
- Comments explain *why*, often citing the bug they prevent.
- Defensive host-facing code.
- No build step.

Weaknesses:
- **Density.** About 40 lines over 160 characters (8 in `cli.js`; the longest is `capture.js:31` at 399 characters, the `NOT_DIRECTIVE` regex). Long one-line SQL and ternary chains are hard to review in PRs.
- **Singletons at module load.** The DB handle, config cache, project cache, and `install.js` reading `HOME` at import time make tests order-dependent and force env changes through subprocesses.
- **SQL scattered across 12 modules.** 98 `prepare()` calls, many inside loops (`getMemories`, gc reinforcement, supersede loop, team sync), with no statement cache.
- **Almost no types.** 28 JSDoc blocks for 90 exports. No `@typedef` for the Memory row, Project, or the hook payload.

### 4.2 Specific findings

**Duplicated logic**
- **Vault/memory id routing and memory formatting.** `cli.js case 'get'` and `mcp.js mem_get` repeat the same loop (`isVaultId(id) ? readVault(...) : null` → collect memory ids → `getMemories`) and the same 3-line `#id [kind] gist / body / files / (date · source · superseded by)` template. They have already drifted: the CLI prints "#x not found" per id and passes `--tail`/`--lines`, while MCP joins with `---` and only passes `grep`. Extract `fetchDetails(ids, opts) → [{type:'vault'|'memory'|'missing', text}]` in `store.js` or a new `detail.js`.
- **Shell quoting.** `cli.js run` (`shq`) is a verbatim copy of `install.js q`, which is already exported as `shellQuote`. Move it to `text.js` or `shell.js`.
- **`VERSION = '1.1.0'`** appears in `cli.js`, `mcp.js` and `package.json`. Read it once from package.json (`createRequire(import.meta.url)('../package.json').version`) or generate it.
- **ExperimentalWarning filter** in `bin/sam.js`, `test/sam.test.js` and `bench/tokens.js`.
- **`meta` upsert** (`INSERT INTO meta … ON CONFLICT(k) DO UPDATE`) written out 6 times (`portable.js` ×4, `gc.js`). Use `db.setMeta(k, v)` / `getMeta(k)`.
- **Decay and priority formulas** live in both `search.js` and `inject.js rankCore`, with different weights (intentional?). There is also a "usage" bonus in each. Put them in one `rank.js`.
- **`ago()` (text.js, dead) vs `agoShort()` (store.js)**.
- **Validation of kind, length and `session`** exists only in `mcp.js`. The CLI's `add` bypasses it (§2).

**Dead code and config**
- `config.autoProjectCard`: defined, never read.
- `text.ago`, `config.resetConfigCache`, `db.closeDb`: never called, not even by tests.
- `sessionContext({ projectName })`: no caller passes it.
- `case 'mcp': openDb(); …` and `doctor: openDb(); openDb().prepare(...)`: redundant calls.
- `portable.js` imports from `./db.js` on two separate lines. `cli.js` imports from `node:fs` on two lines.
- `isOurs`: `if (…) return true; return false;`.
- `reply()` handles `'postinvocation'`, which nothing installs.
- The `--md` flag is a no-op.

**Inconsistent naming**
- `forget`/`setPinned`/`listMemories`/`getMemories`/`saveMemory`. Pick `xMemory`/`xMemories` consistently.
- `line()` is a very generic export name for "format memory line".
- `q` (install) vs `shq` (cli) vs `shellQuote` (export).
- `hint: 'mcp'|'cli'|'none'`, a stringly-typed footer selector, but `--hint` is undocumented.
- `SAM_INSTALL_HOME` is used as "the user's home" in `project.js` and `hooks.js`, not just by the installer. Name it `SAM_USER_HOME`, or read it in one place.
- Kind aliases include `not` (Turkish "note"), which also appears in English polarity lists. Fine, but worth a comment.

**Overlong functions**
- `cli.main` (163 lines, one switch);
- `runHook` (96);
- `gc` (91);
- `search` (91);
- `saveMemory` (58);
- `sessionContext` (53).

The CLI should be a command table (`{ name, aliases, usage, run(flags,pos) }`). That gives per-command help, usage errors and exit codes for free.

**Missing JSDoc on public API.** `openDb`, `config`, `search` (options undocumented), `runHook`, `normalize`, `install`, `detect`, `callTool`, `serveMcp`, `gc`, `runCommand`, `readVault`, `exportMarkdown`/`importMarkdown`/`syncTeamFile`, `resolveProject` all lack parameter and return docs. A `// @ts-check` header plus JSDoc typedefs would let `tsc --noEmit --allowJs` run in CI without adding a runtime dependency (`typescript` would be a devDependency, or use `npx -p typescript tsc` in CI only).

**Magic numbers that belong in config (or at least named constants)**
- Make configurable: hot-file window 14 d; ledger retention 7 d; session digests kept 30; todo archive 60 d / unused 30 d; reinforcement threshold 5, +0.05, cap 0.95, 30 d; file-note budget 90 tokens / 3 notes; card section caps 12/3/3; near-dup Hamming 3.
- Name as constants: embed timeout 8 s; cosine floor 0.25; stdin timeout 1.5 s.
- Leave as constants: RRF k 60; candidate `LIMIT 60`; dedup scan `LIMIT 400`; transcript read caps 8 MB / 256 KB; gist 110/140; min prompt length 8; mcp `k` clamp 20; vault digest 40 lines, tail 10/12, grep output 200 lines; hook timeouts 10 s / 10000 ms.

**Error handling that swallows too much**
- `search.js`: `catch { /* malformed query: skip list */ }` around both FTS queries. A corrupted index, `SQLITE_BUSY` or a schema problem silently becomes "no matches", and recall quietly degrades. Catch only `SQLITE_ERROR` from MATCH syntax, or log under `SAM_DEBUG`.
- `config.js`: invalid `config.json` → `/* ignore bad config */`, with no warning anywhere, not even in `doctor`.
- `cli hook`: every error is swallowed unless `SAM_DEBUG` is set. That is right for the host, but users have no way to find out that hooks are failing. Append to `~/.sam/errors.log` (capped) and have `sam doctor` show the last error.
- `mcp.js`: `chain.then(() => handle(...)).catch(() => {})`. `handle` already catches, so this hides only bugs in `send`. Log them.
- `hooks.js start`: `try { syncTeamFile(project) } catch {}`. A broken team file is invisible.
- `install()`: catches per agent and logs `ERROR`, but the CLI still exits 0.
- `importJsonlInner`: skips corrupt lines silently. It should report the count.

### 4.3 Bugs found while reviewing (non-security)
- `--version`/`-v` broken (§2).
- `--k=v=w` truncation (§2).
- NaN budgets disable the budget check (§7).
- `sam out` line count off by one (§2).
- The CLI accepts invalid kinds and 2-character memories (§2).

### 4.4 Top 10 refactors, ranked by value/effort

| # | Refactor | Value | Effort |
|---|---|---|---|
| 1 | **Fix argv handling:** route `--version`/`-v`/`--help`/`-h` before `parse()`; split `--k=v` on the first `=` only; validate numeric flags. | Every new user's first command works | XS (10 lines) |
| 2 | **Never shell out to the real `claude` CLI from tests or when `SAM_INSTALL_HOME` is set:** `const useClaudeCli = !process.env.SAM_INSTALL_HOME && !process.env.SAM_TEST;`. Also have `detect()` skip `which` under the override. | Stops `npm test` from editing contributors' Claude config | XS |
| 3 | **CLI error and exit-code policy:** a `UsageError` class; `bin/sam.js` prints `sam: <message>` (stack only with `SAM_DEBUG`); exit 2 = usage, 1 = failure or not found; diagnostics to stderr; installer `ERROR`/unknown agent → non-zero. | Scriptable, professional CLI | S |
| 4 | **Single source for VERSION and the warning filter;** delete dead code (`autoProjectCard`, `ago`, `resetConfigCache` or use it in tests, `closeDb` or use it, `projectName`, `--md`). | Less drift, smaller surface | XS |
| 5 | **Shared `fetchDetails()` and shared `validateMemoryInput()`** used by both CLI and MCP (id routing, formatting, kind validation, minimum length). | Removes the CLI/MCP drift | S |
| 6 | **Config hardening:** typed schema (number/bool/string with ranges); reject NaN; warn on unknown keys and bad JSON (stderr for CLI, `doctor` for hooks); add `sam config` (prints effective values and their source); move the §4.2 tunables into config; document everything. | Silent misconfiguration becomes visible | S |
| 7 | **Test isolation:** split `sam.test.js` into per-area files, each with its own `SAM_HOME` (fresh process per file is the default in `node --test`) and its own fixtures; clean up temp dirs in `after()`; clear the 6 s timer; add `{ skip: win32 }` to POSIX-only assertions plus a cmd.exe quoting test. | Green Windows CI, tests runnable alone, suite 8.5 s → about 3.5 s | M |
| 8 | **Turn `cli.main` into a command table** with per-command usage strings (`sam help <cmd>`). | Readable, documented, testable CLI | M |
| 9 | **A thin data-access layer:** `db.js` exposes a prepared-statement cache (`stmt(sql)`), `getMeta`/`setMeta`, and named queries for the 10 most repeated statements. | Fewer one-line SQL blobs, faster loops, one place to migrate the schema | M |
| 10 | **Types without dependencies:** `// @ts-check`, JSDoc `@typedef Memory/Project/HookPayload`, JSDoc on every export, `tsc --noEmit --allowJs --checkJs` as a CI-only step; break lines over about 120 characters (or adopt a formatter via `npx` in CI only). | Lowers the contributor barrier, catches typos | M |

Honorable mentions:
- uninstall bookkeeping of created files (§2);
- a deterministic benchmark (seeded `newId` under `SAM_BENCH_SEED`), so README numbers are exact;
- an `errors.log` plus a `doctor` "last hook error" line.

---

## 5. Test suite

### 5.1 Coverage
Command: `node --test --experimental-test-coverage test/*.test.js`, Node 22.23. Subprocess coverage is included through `NODE_V8_COVERAGE`.

| File | Line % | Branch % | Funcs % | Notable uncovered |
|---|---:|---:|---:|---|
| **embed.js** | **25.9** | 100 | **0** | `embed()`, `backfill()`, `cosine()`, `packVec`/`unpackVec`: the whole optional embeddings path (testable with a local `http.createServer` stub) |
| **cli.js** | **57.8** | 22.4 | 29.4 | `q`/`get`/`add`/`forget`/`pin`/`ls`/`context`/`stats`/`trust`/`export`/`import`/`out`/`doctor`. Only `run`, `hook` and `uninstall` are exercised through subprocesses. |
| **mcp.js** | **59.1** | 21.7 | 40.0 | **`serveMcp()` (lines 84–127), the whole JSON-RPC loop**: initialize, protocol negotiation, unknown tool, parse error, batches, FIFO ordering. Plus `mem_search` and `mem_forget`. |
| portable.js | 81.0 | 76.2 | 69.2 | `exportJsonl`/`importJsonl` (the "lossless backup"), `writeTeamFile` |
| project.js | 81.9 | 56.0 | 80.0 | `.sam-project` marker, worktree/submodule `gitdir:`, `projectByName` |
| hooks.js | 83.9 | 76.1 | 78.6 | `lastUserMessage` (Antigravity transcript), the `compact`, `postcompact`, `harvest` and `end` branches, the readStdin 1.5 s timeout path |
| vault.js | 82.1 | 66.7 | 65.2 | `digest()` truncation path when more than `maxLines` remain after collapsing, `readVault --lines` |
| store.js | 85.3 | 75.5 | 75.0 | `forget` (soft and hard), `setPinned`, `listMemories` |
| search.js | 88.0 | 66.7 | 81.0 | vector branch |
| config.js | 89.1 | 72.7 | 66.7 | env-var parsing, config file |
| inject.js | 90.9 | 72.9 | 93.3 | `fileContext` happy path |
| gc.js | 93.1 | 79.0 | 66.7 | session-digest archival (> 30) |
| capture.js / install.js / db.js / text.js | 92.9–97.4 | 65–82 | 73–94 | — |
| OpenCode plugin | 86.4 | 51.5 | 75.0 | `tool.execute.*`, compaction hook |
| **All files** | **86.5** | **69.9** | **76.9** | |

**Highest-value missing tests:**
1. An MCP stdio session: spawn `sam mcp`, run the handshake, `tools/call` on each tool, check errors and ordering.
2. CLI golden tests for each documented README command, including exit codes.
3. Config parsing (env types, bad JSON, unknown keys).
4. JSONL export → import round-trip.
5. An embeddings path against a local stub server.
6. The readStdin timeout with an incomplete payload and an open pipe.
7. Uninstall leaving no created files.
8. `--version`.

### 5.2 Flaky or timing-dependent tests

| Test | Risk | Notes |
|---|---|---|
| "search stays fast at scale": per-search < 150 ms over 10 searches on 3k memories | **Low–medium** | Measured 8.7 ms per search idle and 26.6 ms with 4 busy loops on 2 vCPU, so about 6–17× headroom. Shared macOS and Windows runners can be 3–5× slower. Make it a relative guard (e.g. 3k must not be more than 20× slower than 300), or keep the absolute bound but run it only when `SAM_PERF=1`. |
| "security + robustness": hook must exit < 4 s with stdin left open | Low | It never exercises the 1.5 s timeout, because a complete JSON document arrives and the hook exits about 0.5 s later. So it is neither flaky nor testing what its name says. The **6 s `setTimeout(() => c.kill(), 6000)` is never cleared**, which keeps the runner alive about 5 s longer (suite 8.5 s; per-test times sum to 3.3 s). |
| "security": `vault.readVault(grep '^(a+)+$')` < 500 ms | Low | The literal fallback is O(n). |
| OpenCode plugin: polls up to 40 × 100 ms for an async hook | Low–medium | It depends on a spawned `node` finishing within 4 s. Await the plugin's promise instead (export it, or have `event()` return it). |
| 12 parallel hooks on a fresh DB | Low | `busy_timeout` is 5 s. On a slow Windows runner, 12 cold `node` starts are fine. |
| **Windows (code reading, not run)** | **High: deterministic failures** | (1) `spawnSync('sh', ['-c', 'printf %s ' + inst.shellQuote(nasty)])`: on win32 `shellQuote` uses `"…"`, so `sh` runs `$(touch /tmp/sam-pwned)` and backticks, the output differs, and the assert fails (it also really creates the file). (2) `sam run -- printf '%s|' …`: `shell: true` uses `cmd.exe`, which has no `printf`. (3) Possibly the `/tmp/sam-pwned` existence check, after (1) creates it. Fix: `{ skip: process.platform === 'win32' }` on these assertions, plus a win32 test that round-trips `shellQuote` through `cmd /c echo`. |

### 5.3 Test isolation
- **Real side effects outside the temp dirs.** `install()` runs `spawnSync('claude', …)` against the real user (reproduced, §0 P0-1), and `detect()` runs `which`/`where` on the real PATH. The env overrides only redirect file paths.
- **One shared DB and one module graph for all 22 tests.** Later tests depend on earlier ones (P, the `bun` memory, decision counts). Running alone, "hybrid search finds…" and "markdown export/import round-trip" **fail**. "session card…" and "MCP tools…" pass alone.
- **Import-time state.** `install.js` captures `HOME` at import, so the test has to spawn a subprocess to vary it (it says so in a comment). Config is cached and the project cache never resets.
- **Temp dirs are never removed.** `sam-test-*`, `sam-un-*`, `sam-oc-*` and `sam-conc-*` are left behind every run (59 accumulated during this review).
- **Relative paths.** `spawn(process.execPath, ['bin/sam.js', …])` assumes the cwd is the repo root. It breaks under `node --test` run from another directory. Use `new URL('../bin/sam.js', import.meta.url)`.
- CI runs on the latest 22.x, never the declared floor 22.13.0.

---

## 6. Repo hygiene for launch

| Item | Status | Action |
|---|---|---|
| LICENSE | ✓ MIT, 2026 Cuma Bozkurt | — |
| CONTRIBUTING.md | missing | `CONTRIBUTING.md` (proposal, merged in v1.2.0) |
| SECURITY.md | missing | `SECURITY.md` (proposal, merged in v1.2.0) (GitHub private reporting + email). **Enable "Private vulnerability reporting"** in repo settings. |
| CHANGELOG.md | missing | `CHANGELOG.md` (proposal, merged in v1.2.0) (Keep a Changelog: 1.0.0, 1.1.0, Unreleased) |
| Issue and PR templates | missing | `packaging-files/.github/ISSUE_TEMPLATE/{bug_report.yml, feature_request.yml, config.yml}`, `.github/pull_request_template.md` |
| CI | exists (`ubuntu/macos/windows × 22/24`, test + bench). No `fail-fast: false`, no permissions block, no floor version, no package smoke test. **Windows will fail** (§5.2). | Replacement `packaging-files/.github/workflows/ci.yml`: fail-fast off, `permissions: contents: read`, concurrency, 22.13.0 floor on Ubuntu, SQLite/FTS5/trigram probe, separate bench job writing to the step summary, and a **pack → global install → smoke** job on all 3 OSes × 22/24 (version, doctor, install dry-run, add/q, clean hook stderr, MCP handshake, `sam run` exit code). Plus `release.yml` (tag = version check, test, `npm publish --provenance`). |
| .gitignore | minimal | Add `*.sam-bak`, `*.tgz`, `coverage/`, `.env*`, editor dirs (`.gitignore` (proposal, merged in v1.2.0)) |
| .npmignore | none | **Do not add one.** Use the narrowed `files` allowlist (§1.2). |
| .gitattributes / .editorconfig | missing | Provided: LF everywhere, so Windows checkouts behave like POSIX. |
| `research/` | The project-level `research/` (JSON search dumps, cloned READMEs, `repos/`) is **outside the repo**. Good, keep it out: it holds third-party README copies and scratch data. Inside the repo, `docs/research/` (5 files, 187 kB) and `docs/audit/` (2 files, 73 kB) are tracked. | Keep `docs/RESEARCH.md` and the group reviews in git, since they are the project's "why". **Exclude them from npm.** **Scrub `docs/audit/*.md` and `docs/research/*.md`** of internal paths (`/workspace/projects/<uuid>/…`, `/tmp/audit-copy`, `/tmp/rv/…`), references to repro scripts and READMEs that are not in the repo, and agent narration. Either commit the repro scripts under `docs/audit/repro/` or reword. |
| Git history | Two commits. One author is `SAM <sam@local>` | Cosmetic. Consider re-authoring before the first public push, since GitHub shows it as an unknown user. |
| Badges / README top | none | After CI is green: CI badge, npm version, Node ≥ 22.13, license. |
| Default branch protection, Discussions | — | `config.yml` points questions to Discussions. Enable it, or remove that link. |

---

## 7. Config system (`src/config.js`)

**How it works.**
- Defaults are merged with `$SAM_HOME/config.json` (default `~/.sam/config.json`) and then with env vars.
- Precedence: env > file > default.
- Env names come from the camelCase keys (`budgetSessionStart` → `SAM_BUDGET_SESSION_START`, `dbPath` → `SAM_DB_PATH`).
- Types are coerced from the default's type: `Number(v)` for numbers, and `/^(1|true|yes|on)$/i` for booleans. Anything else is false, so `SAM_CAPTURE_EDITS=0` works as expected.
- The result is cached per process.

**Is it documented?** Partly. The README table covers 13 of the 19 keys and explains the env naming by one example. Missing:

| Undocumented | Notes |
|---|---|
| keys `recentSessions` (2), `hotFiles` (6), `vaultMaxBytes` (2,000,000), `dbPath` | used |
| key `autoProjectCard` | **dead**: never read |
| `SAM_HOME` | moves the DB and config. The most important env var, and not in the README. |
| `SAM_DEBUG` | prints swallowed hook errors |
| `SAM_PROJECT_DIR` | pins the MCP server to a project. This is the workaround for AUDIT known-limit L5, so it should be in the docs. |
| `SAM_SESSION` | `sam run` attributes vault events to a session |
| `SAM_INSTALL_HOME` | test/dev override of the user's home (also read by `project.js` and `hooks.js`) |
| precedence and the config file location under `SAM_HOME` | — |

**Problems (reproduced):**
- `SAM_BUDGET_SESSION_START=abc` → `NaN` → `used + tk > NaN` is always false → the budget is ignored. The card was 309 tokens instead of the default-bounded 287. Only the section caps stop it. A bad `SAM_BUDGET_PROMPT` is likewise bounded only by `maxPromptHits`.
- Invalid JSON in `config.json` is silently ignored. `sam doctor` does not show it.
- Unknown keys (e.g. a typo, `budgetSesionStart`) are silently accepted and have no effect.
- File values are not type-checked (`"budgetPrompt": "160"` happens to work through coercion; `"captureEdits": "false"` is truthy and **enables** capture).
- `embedUrl`/`embedModel`/`embedKey` read `process.env` both in `DEFAULTS` and in the generic env loop. Harmless, but confusing.
- `embedKey` in `config.json` is plain text. Document that, or prefer the env var.

Recommendation: refactor #6. A typed schema with ranges and errors on NaN, warnings for unknown keys and parse errors, a `sam config` command showing each effective value and its source, a doctor line for config problems, the full table in both READMEs (done for Turkish in `README.tr.missing-sections.md`), and removal of `autoProjectCard`.

---

## 8. Suggested patches for the P0 code items (sketches, untested against the repo)

```js
// src/cli.js: before parse()
export async function main(argv) {
  if (argv[0] === '--version' || argv[0] === '-v') return out(VERSION);
  if (argv[0] === '--help' || argv[0] === '-h') return out(HELP);
  const { pos, flags } = parse(argv);
// in parse(): keep everything after the first '='
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1);
```

```js
// src/install.js: claude(): never touch the real Claude CLI when HOME is overridden (tests, sandboxes)
const HOME_OVERRIDDEN = !!process.env.SAM_INSTALL_HOME || !!process.env.SAM_TEST;
if (!dry && !HOME_OVERRIDDEN && spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0) { … }
```

```js
// bin/sam.js: friendly errors
main(process.argv.slice(2)).catch((err) => {
  const usage = err?.name === 'UsageError';
  process.stderr.write(`sam: ${process.env.SAM_DEBUG ? err?.stack : err?.message || err}\n`);
  process.exit(usage ? 2 : 1);
});
```

```js
// test: POSIX-only assertions
const posix = process.platform !== 'win32';
test('installer hardening …', { skip: !posix && 'POSIX shell quoting' }, async () => { … });
```

---

## 9. What could not be established
- Windows and macOS behavior was not executed. The Windows CI failure is a code-reading conclusion, but a high-confidence one.
- The README's "222 tokens" sample card was not reproduced.
- AUDIT's absolute performance numbers (39 ms, 0.78 ms, 0.18 s) were not reproducible exactly on this shared 2-vCPU machine. Mine were within about 2×.
- The GitHub owner/repo URL is unknown, so the provided files use the placeholder `GITHUB_OWNER`.

## 10. Files written

- `docs/audit2/packaging.md`: this report.
- `the packaging proposal files (merged in v1.2.0)/`, ready to copy into the repo root:
  - `.github/workflows/ci.yml`: replacement CI (test matrix 3 OS × Node 22/24 + 22.13.0 floor, bench job, pack + global-install smoke job).
  - `.github/workflows/release.yml`: npm publish with provenance on GitHub Release (needs the `NPM_TOKEN` secret).
  - `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `config.yml`
  - `.github/pull_request_template.md`
  - `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`
  - `.gitignore` (replacement), `.gitattributes`, `.editorconfig`
  - `package.json.proposed`: the narrowed `files`, `exports`, repository/bugs/homepage/author, `prepublishOnly`, `publishConfig`.
  - `README.tr.missing-sections.md`: Turkish Security, Configuration, Privacy, Development and Credits sections, plus the corrected benchmark caveat sentence.

Notes:
- Replace `GITHUB_OWNER` everywhere before committing.
- The new CI's Windows leg stays red until the test changes in refactor #7 land.
- `SAM_TEST` in ci.yml is read only once refactor #2 lands.
