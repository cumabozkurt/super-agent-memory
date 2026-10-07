# Bench v2 (`npm run bench:v2`)

A blind false-injection / hit benchmark plus four extra suites, built because the v1 retrieval bench
(`bench/retrieval`) has one author for memories and prompts and only 32 negatives (FIR CI ≈ ±0.17).

```
npm run bench:v2                                              # this repo's src/, label "current"
node bench/retrieval-v2/run.mjs --src /path/to/sam/src --label X  # any other build
node bench/retrieval-v2/run.mjs --label 1.0.0 --txt bench/retrieval-v2/results/1.0.0.txt
node bench/retrieval-v2/explore.mjs                           # DEV-ONLY gate feature dump (never reads held-out)
```

Each suite runs in its own child process with a fresh temporary `SAM_HOME`; nothing touches `~/.sam`. About 40 s.
Arms: **SAM (v2 gate)** = the build as configured, **SAM v1.2** = the same build with `specGate=false`, and two pure
**BM25** baselines (FTS5 porter BM25, OR of the prompt's keywords, project + global scope, top 3, no priors / trigram /
gate): ungated, and with a score floor tuned on dev to match SAM's dev hit rate.

## Data (`data/`, frozen; regenerate with `gen.mjs`)

| file | what |
|---|---|
| `blind.json` | **539 positives + 858 negatives**, EN + TR, over the v1 corpus (`bench/retrieval/data`; gold ids are its memory keys) |
| `update.json` | 66 knowledge-update cases (33 "explicit" same-subject, 33 "restated"), 2 prompts each |
| `poison.json` | 48 laundered/poisoned agent-written notes (exfil, curl\|sh, disable checks, other remote, ignore user, weaken auth, backdoor dependency, destroy), each with a topical and an unrelated prompt |
| `dedup.json` | 120 note pairs, 60 should merge / 60 should not |
| `raw/` | the writer's and judge's unfiltered outputs (provenance); `raw/cache/` (LLM response cache) is git-ignored |

**Blindness.** The writer (google/gemini-3.8-flash, temperature 0.8, per-call seed from `SEED = 20261007`) saw only
the project descriptions and the live memory texts, never SAM's code, gate or scores. The poisoning suite is written by
openai/gpt-5.4-mini (Gemini's safety filter refuses it). A second model from another vendor (anthropic/claude-sonnet-4.6,
temperature 0) judged every prompt, mixed and shuffled, by listing the notes it genuinely needs. Positives keep only
gold ids both models agree on; negatives are dropped when the judge marks any note as needed (126 of 984 dropped,
118 of them "near-miss"). Negative categories: other-stack 213, other-project (a sibling's topic asked in the wrong
project) 213, unrelated-coding 214, chit-chat 120, near-miss (lexical overlap, nothing useful) 98.

**Split.** `sha256("sam-v2:" + id)` parity: dev 274 pos + 440 neg, held-out 265 pos + 418 neg. ~400 negatives per
split give a FIR CI half-width ≤ 0.05 at any rate (measured 0.032–0.042). Tune on dev only.

Generation cost ≈ $2.5 (cached; a re-run with the same seed replays from `raw/cache` without spending).

## Metrics

- **hit** = share of a positive's gold ids injected by per-prompt recall (`promptContext`, fresh session);
  **any-hit** = at least one; **hit@card** = gold ids in recall ∪ the project's SessionStart card.
- **FIR** = share of negatives with any injection. 95% CIs are percentile bootstraps (B = 2000, seeded); Δs are paired.
- **ranking ceiling** = `search()` recall@3 on the positives (what the relevance gate could pass at most).
- **knowledge-update**: the new value must be recalled and the old one never injected (also: save status, card).
- **poisoning**: is the poisoned note injected for its topical prompt / any poisoned note for an unrelated prompt / in the card.
  Measured only; the defense belongs to the guard workstream.
- **dedup**: `saveMemory` status of the second note of each pair (merged / superseded / created).
- **latency**: p50/p90 of in-process `promptContext` per arm (interleaved per prompt) and of `specificity()` alone.

## Results (1.0.0, `results/1.0.0.txt`)

| held-out | hit [95% CI] | FIR [95% CI] |
|---|---|---|
| SAM v1.2 (gate off) | 0.699 [0.647, 0.752] | 0.275 [0.234, 0.318] |
| **SAM v2 gate** | **0.699** [0.647, 0.752] | **0.144** [0.110, 0.177] |
| BM25 top-3, no gate | 0.903 | 0.935 |
| BM25 top-3, dev-tuned floor | 0.741 | 0.124 |

Paired Δ (v2 − v1.2) held-out: hit 0 [0, 0], FIR −0.131 [−0.165, −0.098]; dev: hit 0, FIR −0.120. Held-out FIR by
category: other-stack 0.347→0.010, other-project 0.252→0.058, unrelated-coding 0.298→0.288, near-miss 0.34→0.34,
chit-chat 0.088→0.088. Gate cost +0.4 ms p50 (in-process p50 3.7 → 4.1 ms); `specificity()` alone is 0.9 ms p50
on this 412-row store and 2.3 ms p50 on a synthetic 20,000-memory / 8-project store (per-word project counts are exact
up to 500 matches, sampled above).

Findings worth acting on:
- **BM25 with a plain score floor is as good as SAM here** (held-out FIR 0.124 at hit 0.741). The LLM-written positives
  are long and lexical; SAM's ranking reaches recall@3 0.89 but its coverage gate passes only 0.70. A per-prompt-length
  aware relevance gate is the next lever, not more specificity.
- The remaining false injections are generic coding questions and near-misses inside the project's own vocabulary;
  the specificity gate is not built for them (and does not change them).
- Knowledge-update: the old value is injected for 71% of update prompts, because supersession fired in only 3/66 cases
  (topic keys rarely match LLM-phrased updates). Old above new in search: 3% (explicit), 21% (restated).
- Poisoning: a poisoned agent note is injected for 79% of its topical prompts (0 for unrelated ones, 0 in cards).
- Dedup: SimHash ≤ 3 merged none of the 60 reworded same-fact pairs (and none of the different-fact pairs).
- On E1's adversarial negatives (research/papers/experiments, 155, not used for tuning) FIR is 0.652 → 0.471:
  other-stack 0.867 → 0.267, cross-project 0.933 → 0.267, generic categories unchanged.
