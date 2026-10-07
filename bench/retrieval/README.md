# Retrieval benchmark (`npm run bench:retrieval`)

A realistic benchmark for SAM's retrieval quality and token efficiency. It complements the templated
`bench/tokens.js` corpus (which flatters lexical search) with hand-written memories and prompts in English
and Turkish. It needs nothing beyond Node: no embeddings, no Python. Both are optional.

```
npm run bench:retrieval                                   # this repo's src/, label "current"
node bench/retrieval/run.mjs --src /path/to/sam/src --label v1.1.0   # any other build (e.g. a `git archive` of a tag)
node bench/retrieval/run.mjs --full                       # also the gate/card parameter sweeps (slower)
node bench/retrieval/tune.mjs key=v1,v2 ...               # gate tuning on the tuning half only (held-out stays hidden)
node bench/retrieval/compare.mjs v1.1.0 current           # markdown table from results/*.json
```

- Each run uses a fresh temporary `SAM_HOME`; nothing touches `~/.sam`.
- Any config key can be overridden per run with `SAM_*` env vars (e.g. `SAM_GATE_MODE=rrf`, `SAM_EXPAND_QUERY=0`).
- **Tokens:** with `python3` + `tiktoken` installed, counts are exact `o200k_base`. Without them, SAM's own estimator is
  used and the summary says so (it reads 0.94–0.99× tiktoken on this set). `SAM_BENCH_TIKTOKEN=0` forces the estimator.
- **Embeddings (optional):** `pip install fastembed && python3 bench/retrieval/embed_server.py 8089`, then add
  `--embed http://127.0.0.1:8089/v1`. A local multilingual MiniLM, no cloud.
- Results are written to `results/<label>.json` (git-ignored). The committed `results/*.txt` are the reference summaries.

## Data (`data/`)

| file | what |
|---|---|
| `memories_kervan.txt` | 95 memories: Next.js/Prisma/Neon/fly.io/iyzico storefront (Turkish team) |
| `memories_pulsar.txt` | 84 memories: FastAPI/ClickHouse/Celery/GKE+ArgoCD ingestion API |
| `memories_atlas.txt` | 71 memories: Expo/React Native/EAS/Supabase travel app |
| `memories_global.txt` | 30 cross-project preferences, rules and machine facts |
| `memories_noise.txt` | 132 generated distractors in SAM's auto-capture formats (session digests, command→fix records); `node bench/retrieval/gen-noise.mjs` regenerates it |
| `queries.txt` | 239 prompts: 207 with graded labels + 32 negatives. Types: para 121, xl-tr 25, xl-en 10, typo 10, ident 11, task 11, old 6, multi 5, stale 4, lex 4. `q4xx` were written after the alias table was frozen |
| `session40.txt` | a scripted 40-turn session in `kervan` for the ledger test |
| `core.json` | per-project "must know at session start" set for the card |

Memory line: `key | kind | ageDays | tags (@pin, @impX) | files | text [|| body]`. Query line: `qid | project | type | prompt | key:grade ...`
(3 = the answer, 2 = strongly relevant, 1 = related, `x` = a stale memory that must not outrank the answer).
Curated memories load as `source: user`, the generated distractors as `source: auto`.

## Splits

- **Tuning half** = odd query numbers, **held-out half** = even. `tune.mjs` prints only tuning-half numbers unless you pass
  `--show-heldout`; v1.2.0's gate defaults were chosen on the tuning half alone (and with `npm run bench` kept at 20/20).
- `q4xx` + `n29–n32` are a second, smaller held-out set (written after the alias table was frozen).
- Caveat: one author wrote memories and prompts, so neither held-out set is blind. The blind set is bench v2 (below).

## Metrics

Recall@k = share of grade-3 targets in the top k (multi-hop queries get partial credit); MRR on the first grade≥2 hit;
nDCG@5 with gains 2^g−1. Prompt injection: hit = share of grade-3 targets injected, FIR = share of negatives that got any
injection, precision = share of injected lines with grade ≥1. Card coverage = share of `core.json` in the SessionStart card.
Random memory ids change token packing slightly, so card coverage and token figures jitter by about ±0.02 / ±0.3 between runs.

## Reference results (estimator tokens)

| | v1.1.0 | v1.2.0 |
|---|---|---|
| search R@3 / MRR | 0.771 / 0.749 | **0.886 / 0.852** |
| R@3 Turkish↔English (35 q) | 0.495 | **0.848** |
| R@3 zero word overlap (22 q) | 0.091 | **0.500** |
| prompt hit rate | 0.775 | **0.845** |
| false-injection rate (32 negatives) | 0.750 | **0.500** |
| tokens per prompt | 103.4 | **85.1** |
| card coverage of must-know set | 0.16 | **0.35–0.37** |
| held-out half: search R@3 / MRR | 0.760 / 0.728 | **0.902 / 0.849** |
| held-out half: prompt hit / FIR | 0.750 / 0.938 | **0.868 / 0.500** |
| q4xx: search R@3 / prompt hit | 0.633 / 0.667 | **0.833 / 0.733** |
| 40-turn session tokens | 3,479 | **2,365** |

## Bench v2 and the project-specificity gate

`npm run bench:v2` (see [`../retrieval-v2/README.md`](../retrieval-v2/README.md)) adds a blind set over this corpus
(539 positives + 858 negatives, EN + TR, written by one LLM and checked by another from a different vendor, dev/held-out
split by stable hash), plus knowledge-update, poisoning, dedup and latency suites, with bootstrap CIs and a pure BM25
baseline next to every SAM number.

The v2 **project-specificity gate** (`specGate`, on by default) was tuned on bench v2's dev split only. On this v1 bench
it changes nothing (hit 0.845, FIR 0.500, search R@3 0.886 / MRR 0.852: the v1 negatives are generic, not other-stack
or other-project). On bench v2 held-out it takes FIR from 0.275 to 0.144 at an unchanged hit rate (0.699).
