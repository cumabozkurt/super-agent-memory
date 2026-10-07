# Benchmarks

Every number in the [README](../README.md#benchmarks) comes from a script in [`bench/`](../bench/). This page explains what each benchmark measures, how to reproduce it, and what it does **not** show. Result tables are kept in the README and the per-benchmark READMEs so they exist in one place only.

All benchmarks except the coding eval and the native-tokenizer measurement run offline with plain Node: no embeddings, no API key, no Python. They create a throwaway `SAM_HOME` in the temp folder and never touch your real database.

| Command | What it measures | Needs |
|---|---|---|
| `npm run bench` | tokens pushed into context per strategy, and whether the needed memory reached the agent | Node |
| `npm run bench:retrieval` | search quality, the relevance gate, card coverage, session tokens | Node |
| `npm run bench:v2` | blind hit / false-injection rates on held-out prompts, plus poisoning, updates, dedup and latency suites | Node |
| `npm run bench:latency` | per-prompt hook latency in a fresh process | Node |
| `npm run bench:coding` | whether injected memory changes coding outcomes | `OPENROUTER_API_KEY`, paid model calls |
| `node bench/native-tokens.mjs` | SAM's output measured with each provider's tokenizer | `OPENROUTER_API_KEY` |

## Token benchmark (`bench/tokens.js`)

**Setup.** A synthetic, templated project memory: 600 saves, 540 live after near-duplicate merges. A 30-prompt session replays against it: 20 prompts need one specific stored memory, and 10 are unrelated asks.

**Strategies compared.** These are archetypes seen across the reviewed memory projects, not re-implementations of specific projects:

- A: a full memory dump at session start;
- B: top-10 full-text recall on every prompt;
- D: pure BM25 top-3 on every prompt, with no gate and no ledger;
- C: SAM, with the card, gated recall and the ledger.

**Metrics.** Total tokens pushed into context over the session (SAM's o200k estimator), and how many of the 20 needed memories reached the agent.

**Caveats.**

- Memory ids are random, so repeated runs vary by a few dozen tokens.
- The templated corpus flatters lexical search, so treat the ratio as indicative.
- Token counts are o200k-equivalent; see the native-tokenizer table in the README for per-model factors.

## Retrieval benchmark (`bench/retrieval/`)

**Setup.**

- 411 hand-written memories across three fictional projects, plus global memories and auto-capture noise.
- 239 English and Turkish prompts with graded relevance labels; 32 of them are unrelated.
- A 40-turn session, and a must-know set per project.

**Split.** Gate settings were tuned only on the odd-numbered prompts (`bench/retrieval/tune.mjs`). The even half is held out and reported separately.

**Metrics.**

- Search Recall@3 and MRR, overall and for cross-language prompts (Turkish ↔ English) and for prompts sharing no word with the answer.
- Per-prompt recall: answer injected, and false injections on unrelated prompts.
- Tokens per prompt.
- Must-know coverage of the session card.
- Total tokens of the 40-turn session.

**Options.** `--embed <url>` adds a local embedding server (`bench/retrieval/embed_server.py`, needs `pip install fastembed`). `compare.mjs` diffs two result files. The details are in [bench/retrieval/README.md](../bench/retrieval/README.md).

**Caveats.**

- Memories and prompts share one author.
- There are only 32 negatives, so the false-injection rate has a wide confidence interval. That is why bench v2 exists.
- The three bench projects each hold 40 or fewer non-note memories, so 1.0.0's small-store mode gives them a full dump on the card.

## Blind benchmark (`bench/retrieval-v2/`)

**Setup.** 539 positive and 858 negative EN/TR prompts, written by one model vendor and judged by another.

- Negatives: other-stack, other-project, unrelated coding, chit-chat and near-miss prompts.
- A hash splits them into a dev half (used for tuning) and a held-out half (reported: 265 positives, 418 negatives).
- `explore.mjs` dumps gate features for the dev half only, and never reads held-out data.

**Metrics.** Answer injected and false injections, with 95% bootstrap confidence intervals, compared with:

- SAM without the specificity gate;
- BM25 top-3 with no gate;
- BM25 with a score floor tuned on dev to SAM's hit rate.

Extra suites cover poisoning (guard quarantine rate and how often a poisoned note reaches a topical prompt), knowledge updates and dedup, and in-process recall latency.

**Reproduce.**

```bash
npm run bench:v2                                                   # this checkout, label "current"
node bench/retrieval-v2/run.mjs --src /path/to/other/src --label X # any other build
```

The reference report is [`bench/retrieval-v2/results/1.0.0.txt`](../bench/retrieval-v2/results/1.0.0.txt). Details are in [bench/retrieval-v2/README.md](../bench/retrieval-v2/README.md).

**Caveats.**

- A tuned BM25 floor is a strong baseline on this set.
- SAM's advantage is that its gate needs no per-store tuning, and that it adds the card and the ledger.
- The known limitations found here (updates, dedup) are listed in the [CHANGELOG](../CHANGELOG.md).

## Coding eval (`bench/coding-eval/`)

**Setup.**

- 34 memory-necessary coding tasks (26 EN, 8 TR). Session 1 plants a fact that cannot be inferred; session 2 needs it.
- 10 harm tasks, where the prompt fully specifies the answer while a near-miss or contradicting memory sits in the store.
- A deterministic Node test grades each reply. `validate.mjs` checks that every reference solution passes and every memory-less solution fails.
- Each arm's context is built with SAM's real `saveMemory`, `sessionContext` and `promptContext`, exactly as the hooks build it.

**Arms.**

- no memory;
- irrelevant memory of the same size;
- SAM push only;
- SAM push + pull (read-only `mem_search` / `mem_get` twins);
- a full dump.

A retry phase tests the push-after-failure fix card.

**Statistics.** Pass rate per arm, with a paired task-cluster bootstrap 95% CI against no memory, harm rate, and tokens. The 1.0.0 run is in [`bench/coding-eval/results/1.0.0.md`](../bench/coding-eval/results/1.0.0.md), with raw rows in `runs.jsonl`.

**Reproduce.** This needs an OpenRouter key and costs money; `run.mjs` logs the cost per call.

```bash
OPENROUTER_API_KEY=... npm run bench:coding
```

**Caveats.**

- The tasks are built so that memory is necessary, so they measure whether SAM delivers the right fact, not general coding ability.
- The 1.0.0 run covers three model/store conditions.

## Hook latency (`bench/hook-latency.mjs`)

**Setup.** It spawns `sam hook UserPromptSubmit` the way a host does (a fresh process per prompt) against a throwaway store, and prints the median and p90 next to a bare `node -e ""` floor.

```bash
node bench/hook-latency.mjs [runs=30] [memories=60]
```

**Caveats.** Results depend heavily on the machine and Node version, and run-to-run noise is about ±10 ms. The README figure was measured on Linux x64 with Node 22.

## Native tokenizer counts (`bench/native-tokens.mjs`)

**Setup.** It measures SAM's real output (cards, recall, gists, MCP schemas) through each provider's tokenizer via OpenRouter `usage.prompt_tokens`, minus the chat-template overhead, and reports ratios to SAM's estimator. These ratios set the `budgetProfile` presets and the native estimates in `sam doctor` / `sam stats`.

```bash
OPENROUTER_API_KEY=... node bench/native-tokens.mjs [model …]
```

## Reproducing the README numbers

The offline benchmarks were re-run for this documentation on Linux x64 with Node 24:

- `npm run bench`: SAM 2,078 tokens at 20/20, dump 35,608 at 20/20, BM25 top-3 2,532 at 13/20.
- `npm run bench:retrieval`: search Recall@3 0.886, MRR 0.852.
- `npm run bench:v2`: held-out answer injected 0.699, false injections 0.144.

These match the README. `npm run bench:latency` gave a median of ≈93 ms on that machine (the README's ≈86 ms was measured on another one).

CI runs the token benchmark (`npm run bench`) on every push to `main` and every pull request, and posts its output in the job summary.
