# SAM v1.1.0: retrieval quality and token efficiency on a realistic eval set

> Audit report on SAM **v1.1.0** (`66f45b6`), written 2026-10-07 as part of the six-perspective audit summarized in [../AUDIT2.md](../AUDIT2.md). Line numbers refer to v1.1.0. Experiments ran on throw-away copies of the repo; repro scripts and simulation drivers mentioned here were working files and are not shipped, except the retrieval eval set, which now lives in [`bench/retrieval/`](../../bench/retrieval/).

Everything here was measured on a copy of the repo. Token counts come from real tiktoken `o200k_base` unless a line says "est".
The eval set, harness, raw results and patch are in `bench/retrieval/`. Its `README.md` explains how to reproduce the runs.

## 1. Headline numbers

| | v1.1.0 | improved (default) | improved, precise mode | improved + local embeddings |
|---|---|---|---|---|
| search Recall@1 | 0.618 | **0.721** | 0.721 | 0.752 |
| search Recall@3 | 0.771 | **0.871** | 0.871 | 0.903 |
| search Recall@5 | 0.847 | **0.929** | 0.929 | 0.944 |
| search MRR | 0.749 | **0.845** | 0.844 | 0.873 |
| nDCG@5 | 0.750 | **0.846** | 0.845 | 0.870 |
| R@3, zero word overlap (22 q) | 0.091 | **0.455** | 0.455 | 0.545 |
| R@3, Turkish↔English (35 q) | 0.495 | **0.819** | 0.819 | 0.919 |
| R@3, held-out q4xx (30 q) | 0.633 | **0.833** | 0.833 | 0.867 |
| promptContext hit rate | 0.779 | **0.797** | 0.754 | 0.804 |
| false-injection rate (32 negatives) | 0.750 | **0.406** | 0.125 | 0.375 |
| precision of injected lines | 0.409 | **0.648** | 0.660 | 0.660 |
| tokens per prompt (all 239 prompts) | 106.4 | **68.5** (−36%) | 63.1 (−41%) | 67.5 |
| tokens per prompt, negatives only | 72.3 | 24.0 | 9.2 | — |
| SessionStart card: coverage of must-know set | 0.160 | **0.368** | 0.368 | 0.368 |
| card tokens | 305 | 320 | 321 | 321 |
| 40-turn session: total tokens | 3,562 | **2,173** (−39%) | 2,122 | 2,072 |
| 40-turn: answer visible somewhere in context | 0.891 | 0.859 | 0.813 | 0.844 |
| 40-turn: answer in this turn's recall or the card | 0.453 | **0.672** | 0.641 | 0.703 |
| shipped synthetic bench (`npm run bench`) | 20/20, 2,657 est | 19/20, 1,806 est | 10/20 | — |
| search latency (ms/query, 397 live memories) | 1.8 | 2.0–3.8 | 3.7 | 8.6–15 |

How the improved build was chosen:
- The default "balanced" setting (`weakPromptCoverage 0.25`, `absentTermWeight 0.7`) was picked so that the hit rate does not drop below v1.1.0, both here and on the shipped bench.
- "Precise mode" (`weakPromptCoverage 0`, `absentTermWeight 1`) is the setting that scored best on the dev split. Its catch is that it scores only 10/20 on the shipped synthetic bench (§6.4).

## 2. The eval set (`retrieval-eval/data/`)

**Memories: 411 in total**, of which 397 stay live after SAM's own supersession and merge logic. They are split across 3 projects plus global:
- kervan, 95 memories: Next.js, Prisma, Neon, fly.io, iyzico, Turkish team.
- pulsar, 84 memories: FastAPI, ClickHouse, Celery, GKE with ArgoCD.
- atlas, 71 memories: Expo, EAS, Supabase.
- global, 30 memories.
- 132 generated distractors in SAM's exact auto-capture formats: session digests and "`cmd` failed (…) → fixed via …" records.

By kind:

| kind | count |
|---|---|
| fix | 102 |
| session | 92 |
| fact | 83 |
| decision | 38 |
| convention | 34 |
| gotcha/note | 36 |
| preference | 13 |
| todo | 8 |
| bug | 5 |

What the corpus contains:
- 37 memories are in Turkish.
- 141 contain identifiers such as `useAuthStore`, `PG_POOL_MAX` or `RNMapboxMapsDownloadToken`.
- 345 carry file anchors.
- Near-duplicates exist both across wording and across scope. Examples: `k-dup-01` vs `k-deploy-02`, and the global "reply in Turkish" preference vs the project-level one.
- 5 values are superseded through SAM's topic keys (`PG_POOL_MAX: 20 → 40`, Node 18 → 20, Python 3.10 → 3.12, yarn → bun, Redux → zustand). Each is inserted oldest-first and backdated.
- 1 value is stale but was never superseded, because it was reworded rather than re-keyed (S3/CloudFront images vs R2).

**Queries: 239.** 207 are positive, with 302 graded labels (221 of them grade 3), and 32 are negatives. By type:

| type | count | what it tests |
|---|---|---|
| para | 121 | everyday phrasing |
| xl-tr | 25 | Turkish prompt, English memory |
| xl-en | 10 | English prompt, Turkish memory |
| ident | 11 | identifier fragment |
| task | 11 | implicit: "add a price field…" should surface the money convention |
| typo | 10 | misspellings |
| old | 6 | important old decisions |
| multi | 5 | multi-hop |
| stale | 4 | superseded values |
| lex | 4 | lexical control |

Splits used:
- **Word-overlap bucket**, computed objectively: does any content word of the prompt share a 5-character prefix with the answer's text?
  - zero overlap: 22 queries
  - one shared word: 70
  - two or more: 115
- **Dev/test split** by qid parity, used for gate tuning.
- **Held-out set q401–q430 plus n29–n32**, written after the alias table was frozen.

Also included:
- `session40.txt`: a scripted 40-turn refund-feature session. 34 of its turns need a memory.
- `core.json`: the per-project gold set of what an agent must know at session start.

**Limitations.** These should be read before trusting any decimal:
- One author wrote both the memories and the queries, so the held-out set is not blind.
- The alias table was written by the same person who wrote the paraphrases. The held-out gains (R@3 0.633 → 0.833) suggest it generalises within this domain, but not by how much.
- 32 negatives make the false-injection rate coarse: one negative is about 3 points.
- The gold card set reflects the author's judgement of what "important" means.
- Paraphrase queries were written naturally and often share one word with the memory. That is why the "para" type alone looks easy for lexical search (0.82 R@3), while the zero-overlap bucket shows the real gap (0.09).

## 3. v1.1.0 findings

### 3.1 search()

| bucket | Recall@3 | MRR |
|---|---|---|
| shares ≥2 words with the answer (115) | 0.941 | 0.899 |
| shares 1 word (70) | 0.705 | 0.699 |
| **shares no words (22)** | **0.091** | **0.119** |
| Turkish prompt → English memory (25) | 0.433 | 0.468 |
| English prompt → Turkish memory (10) | 0.650 | 0.617 |
| typo (10) | 0.900 | 0.808 |
| identifier (11) | 1.000 | 1.000 |
| implicit task (11) | 0.455 | 0.569 |

Lexical search does well when the user repeats the memory's words. It fails almost completely when they don't. For identifiers and typos, the trigram index does its job.

### 3.2 promptContext(): the relevance gate does not separate anything

- At the default `minPromptScore 0.012` and `maxPromptHits 4`, **24 of 32 negative prompts** (75%) inject memories. Examples include "write a haiku about refactoring" and "convert this JSON to YAML". Only 41% of injected lines are relevant.
- Why it fails: the floor sits on the RRF scale, and RRF is rank-only. Any query's top hit gets 1/61 + 1/61 = 0.0328 whenever both lists rank it first, however weak the match.
  - **12 of 25** negatives that matched anything had their top hit at that maximum. So did 117 true answers.
  - Final-score distributions overlap: negative top hits sit at p10/p50/p90 = 13.0/18.7/26.0 (×10⁻³), and true answers at p10/p25/p50 = 15.8/20.8/28.3.
  - The 0.012 floor is below the 10th percentile of negatives.
- The sweep (`results/tradeoffs.png`, middle panel) shows the trade-off at `maxHits 4`:
  - 0.016: hit 0.75, false injections 0.56.
  - 0.020: hit 0.66, false injections 0.34.
  - 0.024: hit 0.57, false injections 0.19.
  - **No floor value gets below 0.5 false injections without losing more than 8 points of hit rate.**
- **Equal-token baselines (left panel):** v1.1.0's gated hybrid is *below* plain BM25 top-k compact lines at every spend.
  - BM25 top-3: hit 0.779 at 97 tok/prompt.
  - v1.1.0 default: hit 0.779 at 106 tok/prompt.
  - Top-k verbose JSON is far worse: top-1 costs 97 tokens for hit 0.618, and top-3 costs 256 tokens for 0.771.
  - The full dump costs 4,984–6,657 tokens per project at session start. Its recall is 1.0 by construction.

### 3.3 SessionStart card

The card covers **16% of the must-know set** in about 305 tokens. Why:
- **Recency bias.** The ranking is `importance × (0.5 + 0.5·decay)`.
  - A 300-day-old core decision (`k-db-01`, importance 0.9, 240-day half-life) scores 0.9 × 0.71 = 0.64.
  - A 20-day-old preference about code-review style scores 0.8 × 0.98 = 0.78.
- **Global crowding.** Preferences (0.8) outrank decisions (0.75), so global preferences fill the card:
  - pulsar: **7 of 8** lines global.
  - atlas: 5 of 8.
  - kervan: 4 of 8.
- **Budget.** At about 30 tokens per full-gist line, 320 tokens holds 8 lines. The `fixes`, `open` and `recent` sections never get space, so the "recent sessions" part of the design never shows.
- **More budget barely helps.** At 480 tokens or more, coverage plateaus at 0.206 because of the ranking, not the budget.

### 3.4 Ledger over 40 turns

| | ledger on | ledger off |
|---|---|---|
| total tokens | 3,562 | 5,099 |
| duplicate lines | 0 | 64 |
| answer visible somewhere | 0.891 | 0.891 |

- The ledger saves 30% at identical visibility.
- SAM resets the ledger on compaction (`hooks.js` precompact/postcompact/SessionStart source=compact), so this is safe.
- The 0.891 is flattered by spray, though. In 14 of 34 turns the answer was "visible" only because an earlier, mostly irrelevant injection happened to contain it. The longest gap was 39 turns. Only 45% of turns had the answer in that turn's recall or in the card.
- **Equal-token dump:**
  - A priority-ordered dump of compact lines at the same 3,562 tokens covers 78% of the session's answers.
  - At this corpus size, a full compact gist dump of a project is 4.3–4.7k tokens (~36 tokens per memory) and covers everything.
  - SAM's per-session spend only beats a dump once a project holds more than about **100 memories** (v1.1.0) or about **60** (improved) for a 40-turn session. Shorter sessions move the break-even down.

### 3.5 Token estimator

SAM's `tokens()` comes out at 0.94–0.99× tiktoken o200k on everything it injects (card 0.94–0.98, prompt recall 0.97–0.98, dumps 0.96–0.99). That is within its documented ±5%, and the bias is slightly toward under-counting.

## 4. Concrete weaknesses (with evidence)

1. **Paraphrase gap.**
   - "how do we ship to prod?" returns `k-ship-02`, `k-ship-01` (cargo *shipping*) and `k-ui-04` (*Prod*uctCard). The deploy decision is missing. This is a lexical false friend made worse by prefix matching (`ship*` → shipping, `prod*` → productcard).
   - "where does the anonymous shopping basket live" never reaches the guest-cart memory: basket ≠ cart.
   - Zero-overlap R@3 is 0.09.
2. **Turkish ↔ English.**
   - Porter stemming is English-only. Turkish inflection breaks the FTS prefix match: query `veritabanında` does not match a stored `veritabanı`, and `fiyatları` does not match `fiyat`.
   - 5 of 25 Turkish prompts returned **nothing at all**: "fiyatları hangi tipte saklıyoruz", "müşteriden iki kez çekim yapıldı", "tablolara erişim politikalarını…", "commitleri nasıl imzalıyorum", "haritalar neden çevrimdışı çalışmalı".
   - Turkish → English R@3 is 0.43.
3. **Stemming and prefix heuristics.**
   - The coverage step's `stem = term.slice(0,-1)` plus unbounded prefix matching rewards false friends (prod/product, ship/shipping, db/`db:seed`).
   - It also does nothing for camelCase. `useAuthStore` is one FTS token, so "auth store" only works through trigrams.
4. **IDF coverage oddities.**
   - `df` is counted over every project and every superseded row, but `N` counts only live rows.
   - `df` uses prefix queries (`test*` counts testing, tests, testflight).
   - A query word that occurs nowhere ("misbehaving", "thanks", "looks") gets the maximum IDF. It drags coverage down for true answers, and is useless as evidence for negatives.
   - Generic instruction verbs (write, add, explain, fix) carry full topic weight.
   - In the improved build, the "strong concept" threshold is an absolute idf ≥ 1.5. That depends on corpus size and still needs to become relative (see §7).
5. **Recency bias and decay of important old decisions.**
   - In search, the lexical evidence dominates, so old decisions are still found ("old" R@3 = 1.0).
   - The card is where it bites: coverage 0.16, and ablating only the decay floor in the improved build halves card coverage (0.368 → 0.184).
6. **Stale values reworded instead of re-keyed** stay live.
   - `k-stale-01` (S3/CloudFront) sits in the same result list as the current R2 answer.
   - With alias expansion it now outranks the answer for one query (q025). Supersession only works when the agent writes the same "X: …" topic prefix.
7. **No temporal intent.** "what was I working on yesterday" returned k8s memories; the session digest from 2 days earlier was missing.
8. **Gate on rank, not evidence.** See §3.2.
9. **Lexical ceiling on implicit tasks.** "add a price field to the product variant model" should surface the money-as-kuruş decision. Every variant still misses it (task R@3 at most 0.55). Fixing this needs either semantic retrieval or file-anchored recall (`fileContext`, not evaluated here).

## 5. Improvements prototyped (zero dependencies, LLM-free)

All changes are in `improvements.patch`: 5 files, +354/−50, including the new `src/lexicon.js`. Every new behaviour is behind a config key. The existing 22 tests pass.

### 5.1 Query understanding (`src/lexicon.js`, used by `search.js`)
- **Bilingual dev-vocabulary alias table.** It holds 80 concept groups such as deploy/ship/release/prod/canlı/yayın, database/db/postgres/veritabanı, cart/basket/sepet and price/money/fiyat/kuruş.
  - Aliases go into a third FTS list with RRF weight 0.7, so the user's own words still lead.
  - Coverage is computed per concept: a memory covering the concept through an alias gets 0.8 credit.
  - Alias prefix matching is limited to a short inflection ("prod" must not hit "ProductCard").
  - Prefix entries only trigger on real inflections (`localization` must not map to `local`).
- **Light Turkish suffix stripper.** It removes up to two inflectional suffixes and never goes below 4 characters. It runs only when the prompt looks Turkish, and the stem is added next to the original word rather than replacing it.
- **Typo correction against the FTS vocabulary** (`fts5vocab`), only for words that occur nowhere in memory. It uses Damerau distance ≤ 2 for words of 6+ characters and ≤ 1 for 5 characters, with the same first letter.
- **Identifier twins at write time.** `useAuthStore` also gets the hidden tags `use auth store`, and `PG_POOL_MAX` gets `pg pool max`.
- **Temporal intent** ("yesterday", "what was I doing", "dün", "en son", "kaldığım") adds the 3 most recent session digests as an RRF list with a 2× boost. promptContext lets sessions through only in that case.
- **Coverage hygiene:**
  - File paths count 0.5 instead of full gist weight ("JSON to YAML" was matching `turbo.json` / `pnpm-workspace.yaml`).
  - Generic instruction words count 0.3.
  - Words absent from memory count `absentTermWeight` (0.7).

### 5.2 Relevance gate (`inject.js`, `gateMode: 'coverage'`)
A hit is injected when **all** of these hold:
1. Its score is at least 40% of the best hit's score.
2. It covers at least one rare concept.
3. One of these is true:
   - it covers ≥ 20% of the query's IDF mass **and** at least min(2, number of rare concepts in the prompt) rare concepts, or
   - it alone covers ≥ 40% of the mass.

There is also a **weak tier**: if nothing passes, the single best hit is still shown when it covers ≥ 25% of the mass, which costs one line.

With embeddings configured, a cosine ≥ 0.6 also clears the gate.

The legacy RRF floor is still available as `gateMode: 'rrf'`.

### 5.3 Card (`inject.js` sessionContext)
- **Decay floor of 0.75** for decisions, conventions and preferences with importance ≥ 0.7 or pinned. This applies in both the card and search: an important standing decision is retired by supersession, not by age.
- **At most 3 unpinned global lines** in the core section.
- **One line per area** (first tag) before a second line on the same area.
- **Card gists cut to 80 characters**, so more areas fit. The full text is one `mem_get` away.
- `cardCoreShare` can reserve room for fixes/open/recent. It is off by default, because on this set it lowered coverage and the fixes it shows are mostly auto-captured noise.

### 5.4 Ablations

These are measured against the precise configuration. Each row removes one piece.

| removed | R@3 | MRR | zero-overlap R@3 | Turkish↔English R@3 | prompt hit | FIR | card coverage |
|---|---|---|---|---|---|---|---|
| nothing (precise) | 0.871 | 0.844 | 0.455 | 0.819 | 0.754 | 0.125 | 0.368 |
| query expansion (aliases, TR stems, typo fix) | 0.796 | 0.768 | 0.091 | 0.562 | 0.607 | 0.125 | 0.368 |
| decay floor | 0.871 | 0.847 | 0.455 | 0.819 | 0.749 | 0.125 | **0.184** |
| card changes (global cap, diversity, short gists) | 0.871 | 0.844 | 0.455 | 0.819 | 0.754 | 0.125 | 0.324 |
| new gate (back to the RRF floor) | 0.871 | 0.844 | 0.455 | 0.819 | **0.849** | **0.719** | 0.368 |

What the ablations show:
- **Query expansion provides essentially all of the search gain.**
- **The decay floor provides most of the card gain.**
- The new search with the *old* gate reaches the highest hit rate (0.849), at v1.1.0's false-injection level and 112 tok/prompt. The gate is a pure precision/recall dial, and the paper trail is in the sweep.

### 5.5 Gate sweep on the improved build (maxHits 3)

| gate | hit | FIR | precision | tok/prompt |
|---|---|---|---|---|
| minConcepts 1 (any single concept ≥ 20%) | 0.845 | 0.500 | 0.545 | 83 |
| minConcepts 2, singleConcept 0.25 | 0.812 | 0.406 | 0.593 | 74 |
| minConcepts 2, singleConcept 0.40 (default) | 0.787 | 0.406 | 0.657 | 64 |
| minConcepts 2, single-concept rule off | 0.787 | 0.375 | 0.686 | 61 |

| maxHits (default gate) | 1 | 2 | 3 | 4 | 6 |
|---|---|---|---|---|---|
| hit | 0.707 | 0.768 | 0.787 | 0.797 | 0.797 |
| tok/prompt | 38 | 55 | 64 | 68 | 69 |

### 5.6 Local embeddings: the existing optional path, evaluated

Setup: fastembed ONNX `paraphrase-multilingual-MiniLM-L12-v2` (384-d, 220 MB) behind a 40-line OpenAI-compatible server (`harness/embed_server.py`), plugged into SAM's existing `embedUrl` path.

| | R@3 | prompt hit | Turkish↔English R@3 | zero-overlap R@3 |
|---|---|---|---|---|
| v1.1.0 + embeddings | 0.838 | 0.833 | — | — |
| improved + embeddings | 0.903 | 0.804 | 0.919 | 0.545 |

What this shows:
- **The alias table beats a multilingual MiniLM on its own** (0.871 vs 0.838 R@3), and the two stack.
- Embedding cosine helps the gate only a little: MiniLM gives paraphrase pairs like "ship to prod" / "deploy via fly.io" a cosine of about 0.29.
- Latency rises to 8–15 ms per query.
- A stronger model was tried (multilingual mpnet, 1 GB), but it did not come up in the sandbox, so it is untested.

### 5.7 Did not help (reverted or left off)
- `globalFactor` 0.85 → 0.95: no measurable effect.
- Limiting original-term prefix matching to +5 or +7 characters: no effect, because the FTS `prod*` list dominates.
- `cardCoreShare` 0.7: lower coverage.

## 6. Generalisation and regressions (read before merging)

1. **Held-out prompts (q4xx):**
   - Search gains hold: R@3 0.633 → 0.833, MRR 0.558 → 0.684.
   - **The gate does not generalise as well.** Held-out prompt hit is 0.667 in v1.1.0, 0.500 in the improved default and 0.400 in precise mode. It is offset by false injections falling 0.75 → 0.25.
   - Held-out paraphrases usually cover just one rare concept with low coverage, which is exactly the region where negatives live (e.g. n14 "explain python decorators" in a Python project). Lexical evidence alone cannot separate these.
2. **Main-set prompt hit:** 0.798 → 0.847 (default) or 0.814 (precise).
3. **Three search regressions** out of 207 queries: q004, q027, q232. All are cases where an alias pulls a near-topic memory above the answer.
4. **Shipped synthetic bench.**
   - The default (absentTermWeight 0.7) scores 19/20 at 1,806 est tokens, against v1.1.0's 20/20 at 2,657.
   - Precise mode scores **10/20**. The templated prompts contain several words that occur nowhere in memory, which pushes coverage just under the 0.2 floor.
   - The bench itself should be replaced or complemented by this set.
5. **Search latency** rises from about 1.8 ms to 2–4 ms. The extra cost is one FTS COUNT per concept (as before) plus one more FTS list, and an `fts5vocab` scan only when a word is absent from the corpus.

## 7. Recommendations

1. **Merge the alias, Turkish-stem, typo, ident-twin and temporal changes.** They give a large, consistent search gain that holds on held-out prompts, and cost no tokens.
2. **Merge the decay floor and the card changes.** Card coverage goes from 0.16 to 0.37 at the same budget, or 0.46 with 60-character gists (sweep in `cardSweep`). The global cap stops global preferences from squatting in project cards.
3. **Replace the RRF-floor gate with the coverage gate.** The default ships in balanced mode. Make it relative before merging:
   - Use a corpus-size-independent "rare concept" test, e.g. `df ≤ N/8`, instead of idf ≥ 1.5.
   - Compute `df` over live rows in scope.
4. **Offer a "precise" profile** for users who hate noise: 0.125 false injections at about 63 tokens per prompt.
5. **Retire stale values by more than topic keys.** When a new fact shares a file anchor and two or more rare concepts with an older fact of the same kind, mark the older one as `superseded?` and down-weight it, or ask through `mem_save`'s response.
6. **Treat the full gist dump as a legitimate mode for small stores.** Below about 60–100 memories (less for short sessions), a compact dump at session start is cheaper than SAM's per-prompt recall over a long session and has perfect recall. SAM could switch automatically.
7. **Keep embeddings optional,** but document `harness/embed_server.py` (fastembed, 220 MB, no cloud) as the recommended local path for Turkish users. It is the only thing that reliably closes the zero-overlap gap (0.455 → 0.545).

## Appendix A: the prototype patch

The prototype (`improvements.patch`) was ported by hand onto the merged v1.2.0 code and then changed: the fixed IDF threshold became a store-size-relative rare-concept and joint-selectivity test, and the gate was re-tuned on the tuning half. See [../AUDIT2.md](../AUDIT2.md) and the git history.
