# Coding eval (`npm run bench:coding`)

An end-to-end test of whether SAM's injected memory changes coding outcomes. It is the P0-8 item of ROADMAP-v2 and
is what decides the fix-card and push policy. A model gets a small coding task, writes an ES module, and a
deterministic node test grades it. The same task runs under several memory arms. Each arm is compared with
no memory on the same tasks (paired).

The design follows the red-team sample-size note. A general "SWE-bench resolution" study needs about 1,300 tasks
to see +3 pp. The VibeMemBench (111 targets) and ReasoningBank (WebArena-Shopping, single run) results are
underpowered or not about coding. So this eval uses **memory-necessary task pairs**: session 1 plants a fact that
cannot be inferred, and session 2 needs it. The effect there is large enough to measure at about 30 pairs. A
**harm set** sits next to them: tasks whose prompt fully specifies the answer while a near-miss or contradicting
memory sits in the store.

## What is in here

| file | what |
|---|---|
| `tasks.mjs` | 34 pairs + 10 harm tasks (EN/TR). Each task has the session-1 memory it leaves (`mem`), the session-2 `prompt`, a node `test`, a `ref` solution (must pass) and a `naive` memory-less solution (must fail). Fix tasks also carry `err`: the realistic failure the environment shows when the remembered fix is missing. `FILLER` holds 15 other memories of the same project. |
| `stubs.mjs` | The fictional `shop` repo's own modules (`money.js`, `log.js`, `ids.js`, `http.js`, `config.js`, `errors.js`, `flags.js`, `analytics.js`, `text.js`). They are written next to every solution, so their APIs are knowable only from memory. |
| `grade.mjs` | Extracts the code block and runs `test.mjs` with node in a temp dir (10 s timeout, `TZ=America/New_York` so timezone bugs show). |
| `validate.mjs` | Grader self-check: every `ref` passes and every `naive` fails. |
| `contexts.mjs` | Builds a **real SAM store** in a temp `SAM_HOME` through `src/store.js` `saveMemory` (oldest first, ages back-dated, so supersession runs as in production). It then renders each arm's injected text with `src/inject.js` `sessionContext` + `promptContext`, exactly as the hooks build it. It also exposes read-only `mem_search`/`mem_get` twins of `src/mcp.js` and the push-after-failure `fixCard()`. |
| `run.mjs` | Calls an OpenRouter chat model for every task × arm × temperature, grades the reply, and appends to `results/runs.jsonl` (resumable; cost logged per call from `usage.cost`). `--retry` adds the push-after-failure phase. |
| `analyze.mjs` | Tables: pass rate per arm, paired task-cluster bootstrap 95% CI vs no memory, harm rate, tokens, pull behaviour, push-after-failure. |

## Arms

| arm | what the model sees |
|---|---|
| `none` (a) | the prompt only |
| `irr` (d) | memory lines from another project (`bench/retrieval` pulsar corpus), cut to the same token count as `samPush` for that task |
| `dump` (c) | every live memory of the project, one labelled line each (no budget) |
| `samPush` (b1) | SAM SessionStart card + UserPromptSubmit recall (`hint: 'none'`, i.e. no MCP server), wrapped as `<system-reminder>` hook context before the prompt |
| `sam` (b) | the same push (`hint: 'mcp'` footer) **plus** the `mem_search`/`mem_get` tools (SAM's real schemas and output format) and the MCP server instructions in the system prompt; up to 6 tool rounds |
| `top1` (e) | `sam` + "1-experience push": the top-1 `fix`/`bug` memory for the prompt is always pushed (no gate) unless already shown. The API has no such switch, so this approximates it with `search(prompt, {kind:'fix'|'bug', k:1})` |

**Push-after-failure (`--retry`).** A fix task whose first attempt failed (arms none/irr/samPush/sam) is continued
twice from the same conversation:
- *plain*: the failure output only;
- *card*: the failure output plus one compact fix line found by searching **the error text alone** for `fix`/`bug`
  rows, sent as `PostToolUseFailure` hook context.

The two retries are paired.

**Stores.** `small` (default) holds 50 live rows: the pair memories, 3 stale predecessors and the filler.
`SAM_CE_STORE=large` adds about 220 rows from the `bench/retrieval` kervan/atlas/global/noise corpora, relabelled into
the project, for 270 live rows. Rows on any topic a task tests are filtered out so the world stays consistent.

## Run

```
# key: the runner sends Authorization: Bearer $OPENROUTER_API_KEY (behind an injecting proxy use NODE_USE_ENV_PROXY=1 and any value)
node bench/coding-eval/validate.mjs
node bench/coding-eval/run.mjs --retry                                   # gemini-3.8-flash, temps 0 and 0.7, all arms, small store
SAM_CE_STORE=large node bench/coding-eval/run.mjs --retry                # large store
node bench/coding-eval/run.mjs --model deepseek/deepseek-v4-flash --max-tokens 16000 --retry
node bench/coding-eval/analyze.mjs --json bench/coding-eval/results/summary.json > bench/coding-eval/results/tables-<ver>.md
```

Options:
- `--model`, `--temps 0,0.7`, `--arms none,irr,dump,samPush,sam,top1`, `--tasks id,id`
- `--reasoning low` (OpenRouter reasoning effort), `--max-tokens 8000`, `--concurrency 8`
- `--budget 8`: the USD stop is checked against the whole results file
- `CE_CALL_TIMEOUT_MS`: per-call timeout

A cached key (`model@effort#store|temp|arm|task|phase`) is never re-run. Delete lines from `runs.jsonl` to redo them.
`npm run bench:coding` runs validate, the default run, and analyze.

## Statistics

- The unit of resampling is the **task**. Each task's pass rate is averaged over its runs (temperatures, and in the
  pooled table models and stores too).
- Δ = arm − no memory, with a paired bootstrap over tasks (10,000 resamples, fixed seed).
- Harm rate = share of harm-set runs that no memory passed and the arm failed.
- Context tokens use SAM's own estimator (`src/text.js tokens`, o200k-calibrated). Prompt tokens per call and cost come
  from the provider and include tool rounds.

## Limits (read before quoting a number)

- The pairs are memory-necessary **by construction**: the prompt points at "our way" and the test checks an arbitrary
  planted fact. So the +55 to +80 pp gaps are upper bounds on what such facts are worth. They are not a general task
  resolution gain, and should not be compared with SWE-bench-style numbers.
- One author wrote the memories, the prompts, the tests and the fix-task error messages. Retrieval is therefore
  probably optimistic, especially error-text → fix lookup. A blind, independently written set and a replay corpus of
  real failures are needed before treating the retrieval numbers as field numbers.
- The harm set has only 10 tasks, so a ±10 pp harm difference is not resolvable. Its CIs are reported, not tested.
- Single-turn tasks with no repo browsing: the model cannot `cat ids.js`, so "read the code" cannot stand in for memory.
  Real agents can sometimes recover a convention from the code. This exaggerates the value of memory relative to an
  agent with file access.
- Two cheap models (`google/gemini-3.8-flash`, `deepseek/deepseek-v4-flash`) at low reasoning effort.
