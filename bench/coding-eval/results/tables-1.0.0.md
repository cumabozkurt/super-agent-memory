## Pass rates by condition

### gemini-3.8-flash · small store
34 pair tasks + 10 harm tasks × 2 run(s) (temperature/condition) per arm. Δ = arm − no memory, percentage points, paired task-cluster bootstrap 95% CI (10000 resamples).

| arm | pairs pass % | Δ pairs vs (a) [95% CI] | harm-set pass % | Δ harm vs (a) [95% CI] | harm rate % | ctx tokens added (pairs/harm) | prompt tok/call | cost $/task |
|---|---|---|---|---|---|---|---|---|
| (a) no memory | 22.1 | — | 100.0 | — | — | 0 / 0 | 106 | 0.00307 |
| (d) irrelevant control | 25.0 | +2.9 [-2.9, +11.8] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 366 / 344 | 496 | 0.00080 |
| (c) full dump | 94.1 | +72.1 [+57.4, +86.8] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 2023 / 2023 | 2238 | 0.00212 |
| (b1) SAM push only | 76.5 | +54.4 [+38.2, +70.6] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 368 / 344 | 479 | 0.00101 |
| (b) SAM push + pull tools | 94.1 | +72.1 [+57.4, +86.8] | 90.0 | -10.0 [-30.0, +0.0] | 10.0 | 368 / 348 | 1141 | 0.00180 |
| (e) SAM + 1-experience push | 94.1 | +72.1 [+57.4, +86.8] | 95.0 | -5.0 [-15.0, +0.0] | 5.0 | 422 / 411 | 1233 | 0.00182 |

| comparison (pairs) | Δ [95% CI] | harm-set Δ [95% CI] |
|---|---|---|
| pull tools on top of push: sam − samPush | +17.6 [+4.4, +32.4] | -10.0 [-30.0, +0.0] |
| 1-experience push on top of SAM: top1 − sam | +0.0 [+0.0, +0.0] | +5.0 [+0.0, +15.0] |
| full dump vs SAM: dump − sam | +0.0 [-11.8, +11.8] | +10.0 [+0.0, +30.0] |
| SAM vs same-size irrelevant: sam − irr | +69.1 [+54.4, +83.8] | -10.0 [-30.0, +0.0] |
| irrelevant text vs nothing: irr − none | +2.9 [-2.9, +11.8] | +0.0 [+0.0, +0.0] |

### gemini-3.8-flash · large store
34 pair tasks + 10 harm tasks × 2 run(s) (temperature/condition) per arm. Δ = arm − no memory, percentage points, paired task-cluster bootstrap 95% CI (10000 resamples).

| arm | pairs pass % | Δ pairs vs (a) [95% CI] | harm-set pass % | Δ harm vs (a) [95% CI] | harm rate % | ctx tokens added (pairs/harm) | prompt tok/call | cost $/task |
|---|---|---|---|---|---|---|---|---|
| (a) no memory | 17.6 | — | 100.0 | — | — | 0 / 0 | 106 | 0.00386 |
| (d) irrelevant control | 23.5 | +5.9 [+0.0, +14.7] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 402 / 370 | 532 | 0.00083 |
| (c) full dump | 91.2 | +73.5 [+55.9, +88.2] | 90.0 | -10.0 [-30.0, +0.0] | 10.0 | 9764 / 9764 | 10702 | 0.00668 |
| (b1) SAM push only | 76.5 | +58.8 [+41.2, +76.5] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 400 / 373 | 508 | 0.00085 |
| (b) SAM push + pull tools | 94.1 | +76.5 [+61.8, +91.2] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 402 / 372 | 1110 | 0.00200 |
| (e) SAM + 1-experience push | 91.2 | +73.5 [+58.8, +88.2] | 100.0 | +0.0 [+0.0, +0.0] | 0.0 | 444 / 421 | 1144 | 0.00201 |

| comparison (pairs) | Δ [95% CI] | harm-set Δ [95% CI] |
|---|---|---|
| pull tools on top of push: sam − samPush | +17.6 [+5.9, +32.4] | +0.0 [+0.0, +0.0] |
| 1-experience push on top of SAM: top1 − sam | -2.9 [-8.8, +0.0] | +0.0 [+0.0, +0.0] |
| full dump vs SAM: dump − sam | -2.9 [-14.7, +5.9] | -10.0 [-30.0, +0.0] |
| SAM vs same-size irrelevant: sam − irr | +70.6 [+52.9, +85.3] | +0.0 [+0.0, +0.0] |
| irrelevant text vs nothing: irr − none | +5.9 [+0.0, +14.7] | +0.0 [+0.0, +0.0] |

### deepseek-v4-flash · small store
34 pair tasks + 10 harm tasks × 2 run(s) (temperature/condition) per arm. Δ = arm − no memory, percentage points, paired task-cluster bootstrap 95% CI (10000 resamples).

| arm | pairs pass % | Δ pairs vs (a) [95% CI] | harm-set pass % | Δ harm vs (a) [95% CI] | harm rate % | ctx tokens added (pairs/harm) | prompt tok/call | cost $/task |
|---|---|---|---|---|---|---|---|---|
| (a) no memory | 10.3 | — | 85.0 | — | — | 0 / 0 | 126 | 0.00029 |
| (d) irrelevant control | 13.2 | +2.9 [-2.9, +8.8] | 90.0 | +5.0 [-10.0, +20.0] | 5.9 | 370 / 347 | 544 | 0.00060 |
| (c) full dump | 98.5 | +88.2 [+77.9, +97.1] | 95.0 | +10.0 [-10.0, +30.0] | 5.9 | 2021 / 2021 | 2275 | 0.00033 |
| (b1) SAM push only | 63.2 | +52.9 [+36.8, +69.1] | 85.0 | +0.0 [-15.0, +15.0] | 17.6 | 372 / 349 | 513 | 0.00029 |
| (b) SAM push + pull tools | 91.2 | +80.9 [+67.6, +91.2] | 95.0 | +10.0 [+0.0, +25.0] | 5.9 | 370 / 350 | 7762 | 0.00095 |
| (e) SAM + 1-experience push | 89.7 | +79.4 [+66.2, +91.2] | 90.0 | +5.0 [+0.0, +15.0] | 0.0 | 422 / 411 | 6844 | 0.00063 |

| comparison (pairs) | Δ [95% CI] | harm-set Δ [95% CI] |
|---|---|---|
| pull tools on top of push: sam − samPush | +27.9 [+14.7, +42.6] | +10.0 [-10.0, +30.0] |
| 1-experience push on top of SAM: top1 − sam | -1.5 [-8.8, +5.9] | -5.0 [-20.0, +10.0] |
| full dump vs SAM: dump − sam | +7.4 [+0.0, +17.6] | +0.0 [-15.0, +15.0] |
| SAM vs same-size irrelevant: sam − irr | +77.9 [+64.7, +89.7] | +5.0 [-10.0, +20.0] |
| irrelevant text vs nothing: irr − none | +2.9 [-2.9, +8.8] | +5.0 [-10.0, +20.0] |

### Pooled over all conditions (task = cluster; each task averaged over every model/store/temperature)
34 pair tasks + 10 harm tasks × 6 run(s) (temperature/condition) per arm. Δ = arm − no memory, percentage points, paired task-cluster bootstrap 95% CI (10000 resamples).

| arm | pairs pass % | Δ pairs vs (a) [95% CI] | harm-set pass % | Δ harm vs (a) [95% CI] | harm rate % | ctx tokens added (pairs/harm) | prompt tok/call | cost $/task |
|---|---|---|---|---|---|---|---|---|
| (a) no memory | 16.7 | — | 95.0 | — | — | 0 / 0 | 113 | 0.00241 |
| (d) irrelevant control | 20.6 | +3.9 [-0.5, +9.8] | 96.7 | +1.7 [-3.3, +6.7] | 1.8 | 379 / 353 | 524 | 0.00074 |
| (c) full dump | 94.6 | +77.9 [+64.7, +89.7] | 95.0 | -0.0 [-10.0, +8.3] | 5.3 | 4603 / 4603 | 5072 | 0.00304 |
| (b1) SAM push only | 72.1 | +55.4 [+40.2, +69.1] | 95.0 | +0.0 [-5.0, +5.0] | 5.3 | 380 / 355 | 500 | 0.00072 |
| (b) SAM push + pull tools | 93.1 | +76.5 [+63.2, +88.7] | 95.0 | -0.0 [-10.0, +6.7] | 5.3 | 380 / 357 | 3321 | 0.00159 |
| (e) SAM + 1-experience push | 91.7 | +75.0 [+62.3, +87.7] | 95.0 | +0.0 [-5.0, +5.0] | 1.8 | 430 / 414 | 3074 | 0.00149 |

| comparison (pairs) | Δ [95% CI] | harm-set Δ [95% CI] |
|---|---|---|
| pull tools on top of push: sam − samPush | +21.1 [+10.3, +33.3] | -0.0 [-10.0, +8.3] |
| 1-experience push on top of SAM: top1 − sam | -1.5 [-5.9, +2.0] | +0.0 [-6.7, +6.7] |
| full dump vs SAM: dump − sam | +1.5 [-5.9, +9.3] | +0.0 [-5.0, +5.0] |
| SAM vs same-size irrelevant: sam − irr | +72.5 [+59.3, +85.3] | -1.7 [-11.7, +6.7] |
| irrelevant text vs nothing: irr − none | +3.9 [-0.5, +9.8] | +1.7 [-3.3, +6.7] |

## Pairs by task type (pooled, pass %)

| type | n tasks | none | irr | dump | samPush | sam | top1 |
|---|---|---|---|---|---|---|---|
| fix | 10 | 38.3 | 43.3 | 95.0 | 90.0 | 96.7 | 100.0 |
| convention | 18 | 10.2 | 13.9 | 98.1 | 67.6 | 88.9 | 85.2 |
| library | 2 | 0.0 | 8.3 | 100.0 | 41.7 | 100.0 | 100.0 |
| quirk | 1 | 0.0 | 0.0 | 33.3 | 100.0 | 100.0 | 100.0 |
| update | 2 | 0.0 | 0.0 | 100.0 | 41.7 | 100.0 | 100.0 |
| decision | 1 | 0.0 | 0.0 | 66.7 | 66.7 | 100.0 | 83.3 |
| lang=en | 26 | 9.0 | 14.1 | 93.6 | 76.3 | 91.6 | 89.1 |
| lang=tr | 8 | 41.7 | 41.7 | 97.9 | 58.3 | 97.9 | 100.0 |

## Per-task pass counts (passes / runs, pooled)

| task | set | type | none | irr | dump | samPush | sam | top1 |
|---|---|---|---|---|---|---|---|---|
| vitest-forks | pair | fix | 0/6 | 0/6 | 6/6 | 4/6 | 6/6 | 6/6 |
| config-get | pair | convention | 0/6 | 0/6 | 4/6 | 0/6 | 0/6 | 0/6 |
| logger | pair | convention | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| valibot | pair | library | 0/6 | 0/6 | 6/6 | 0/6 | 6/6 | 6/6 |
| esm-js-ext | pair | fix | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| billing-cursor | pair | fix | 2/6 | 2/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| retry-policy | pair | convention | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| kargo-grams | pair | quirk | 0/6 | 0/6 | 2/6 | 6/6 | 6/6 | 6/6 |
| feature-flag | pair | convention | 0/6 | 0/6 | 6/6 | 2/6 | 6/6 | 3/6 |
| cutoff-istanbul | pair | convention | 0/6 | 1/6 | 6/6 | 6/6 | 6/6 | 5/6 |
| tr-error-prefix | pair | convention | 0/6 | 0/6 | 6/6 | 0/6 | 5/6 | 6/6 |
| tr-sqlite-busy | pair | fix | 6/6 | 6/6 | 5/6 | 6/6 | 6/6 | 6/6 |
| tr-phone-e164 | pair | convention | 5/6 | 4/6 | 6/6 | 4/6 | 6/6 | 6/6 |
| soft-delete | pair | convention | 0/6 | 0/6 | 6/6 | 3/6 | 1/6 | 0/6 |
| analytics-events | pair | convention | 0/6 | 4/6 | 6/6 | 4/6 | 6/6 | 6/6 |
| tr-name-sort | pair | convention | 5/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| cache-key-update | pair | update | 0/6 | 0/6 | 6/6 | 5/6 | 6/6 | 6/6 |
| iso-no-ms | pair | convention | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| tr-upper-city | pair | fix | 4/6 | 4/6 | 6/6 | 5/6 | 6/6 | 6/6 |
| dev-api-ipv4 | pair | fix | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| lint-update | pair | update | 0/6 | 0/6 | 6/6 | 0/6 | 6/6 | 6/6 |
| tr-date-format | pair | convention | 0/6 | 0/6 | 6/6 | 1/6 | 6/6 | 6/6 |
| h-docs-npm | harm | override | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| h-sku-sort | harm | near-miss | 5/6 | 6/6 | 6/6 | 6/6 | 5/6 | 6/6 |
| pnpm | pair | convention | 0/6 | 0/6 | 6/6 | 5/6 | 6/6 | 6/6 |
| h-github-retry-after | harm | near-miss | 6/6 | 6/6 | 6/6 | 5/6 | 6/6 | 6/6 |
| h-cli-english-error | harm | override | 6/6 | 5/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| h-iso-date-filename | harm | near-miss | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| h-chunk | harm | generic | 5/6 | 6/6 | 6/6 | 5/6 | 6/6 | 5/6 |
| table-naming | pair | convention | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| date-only-local | pair | fix | 0/6 | 3/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| h-parse-kv | harm | generic | 5/6 | 5/6 | 6/6 | 5/6 | 6/6 | 5/6 |
| h-usd-format | harm | near-miss | 6/6 | 6/6 | 5/6 | 6/6 | 6/6 | 6/6 |
| h-queue-retry | harm | near-miss | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| h-session-purge | harm | override | 6/6 | 6/6 | 4/6 | 6/6 | 4/6 | 5/6 |
| parasut-retry-after | pair | fix | 0/6 | 0/6 | 6/6 | 6/6 | 5/6 | 6/6 |
| money-type | pair | convention | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| ids | pair | convention | 0/6 | 0/6 | 6/6 | 0/6 | 6/6 | 6/6 |
| ky-client | pair | library | 0/6 | 1/6 | 6/6 | 5/6 | 6/6 | 6/6 |
| tr-currency-format | pair | convention | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| migration-lock | pair | fix | 0/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| app-error | pair | convention | 1/6 | 0/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| vat-half-even | pair | decision | 0/6 | 0/6 | 4/6 | 4/6 | 5/5 | 5/6 |
| bigint-json | pair | fix | 5/6 | 5/6 | 4/6 | 3/6 | 5/6 | 6/6 |

## Pull (MCP tools) behaviour in tool arms

| condition | arm | calls with ≥1 tool use % | mean tool calls | mem_search share | pulls that returned the task's own memory % | tool-result tokens/call |
|---|---|---|---|---|---|---|
| gemini-3.8-flash · small store | sam | 53.4 | 0.68 | 31.7 | 87.9 | 48 |
| gemini-3.8-flash · small store | top1 | 47.7 | 0.65 | 35.1 | 91.1 | 50 |
| gemini-3.8-flash · large store | sam | 39.8 | 0.51 | 40.0 | 88.9 | 59 |
| gemini-3.8-flash · large store | top1 | 35.2 | 0.47 | 41.5 | 90.2 | 58 |
| deepseek-v4-flash · small store | sam | 97.7 | 5.20 | 83.0 | 70.3 | 698 |
| deepseek-v4-flash · small store | top1 | 98.9 | 4.65 | 79.5 | 82.8 | 709 |

## Push-after-failure: compact fix card on retry (fix tasks, first-attempt failures)

Each failed first attempt on a fix task (arms none/irr/samPush/sam, every condition; none/irr also at temperatures 0.35 and 1 for more failures) is retried twice from the same conversation: plain (error output only) and card (error output + the top-1 fix memory found by searching the error text, rendered as one `<memory fix>` line). n = 109 paired retries over 8 tasks.

| | retry pass % | |
|---|---|---|
| plain retry | 54.1 | |
| retry + fix card | 78.9 | Δ +19.7 [+4.5, +38.8] (task-cluster bootstrap) |
| discordant pairs | card-only pass 29, plain-only pass 2 | exact McNemar p = 0.0000 |
| card retrieved the task's own fix | 73.4 | mean card size ≈ 50 tokens |

- card retrieved the task's own fix: n = 80 (8 tasks), plain 57.5% → card 90.0% (card-only 27, plain-only 1, McNemar p = 0.0000)
- card retrieved another fix (miss): n = 29 (7 tasks), plain 44.8% → card 48.3% (card-only 2, plain-only 1, McNemar p = 1.0000)

| task | n | plain pass | card pass | card = own fix |
|---|---|---|---|---|
| vitest-forks | 20 | 20 | 20 | 10 |
| bigint-json | 9 | 5 | 5 | 4 |
| migration-lock | 18 | 7 | 16 | 16 |
| dev-api-ipv4 | 18 | 0 | 12 | 18 |
| parasut-retry-after | 19 | 18 | 19 | 18 |
| date-only-local | 14 | 0 | 5 | 5 |
| billing-cursor | 8 | 7 | 7 | 7 |
| tr-upper-city | 3 | 2 | 2 | 2 |

| arm | condition | n | plain % | card % |
|---|---|---|---|---|
| none | gemini-3.8-flash · small store | 23 | 43.5 | 65.2 |
| none | gemini-3.8-flash · large store | 24 | 45.8 | 58.3 |
| none | deepseek-v4-flash · small store | 15 | 46.7 | 80.0 |
| irr | gemini-3.8-flash · small store | 18 | 61.1 | 100.0 |
| irr | gemini-3.8-flash · large store | 21 | 66.7 | 100.0 |
| samPush | gemini-3.8-flash · small store | 1 | 100.0 | 100.0 |
| samPush | gemini-3.8-flash · large store | 2 | 100.0 | 100.0 |
| samPush | deepseek-v4-flash · small store | 3 | 33.3 | 66.7 |
| sam | deepseek-v4-flash · small store | 2 | 100.0 | 50.0 |

## 1-experience push: runs where it added a line

- small store: the push added a line on 31/44 tasks (2 the task's own fix, 29 unrelated). Own-fix tasks: sam 100.0% → top1 100.0%. Unrelated-push tasks: sam 90.4% → top1 87.9%.
- small store retrieval: task's own memory in the card 8/34, in per-prompt recall 18/34, in card ∪ recall 26/34; recall lines on harm prompts 5 over 10 prompts; stale row shown 1 time(s); live rows 50.
- large store: the push added a line on 27/44 tasks (1 the task's own fix, 26 unrelated). Own-fix tasks: sam 100.0% → top1 100.0%. Unrelated-push tasks: sam 96.2% → top1 92.3%.
- large store retrieval: task's own memory in the card 2/34, in per-prompt recall 22/34, in card ∪ recall 24/34; recall lines on harm prompts 8 over 10 prompts; stale row shown 1 time(s); live rows 270.

## Spend

| model | calls | prompt tokens | completion tokens (reasoning) | cost $ |
|---|---|---|---|---|
| google/gemini-3.8-flash | 1332 | 1884650 | 416926 (253997) | 2.823 |
| deepseek/deepseek-v4-flash | 567 | 1643549 | 783411 (693412) | 0.296 |
| total | 1899 | | | 3.119 |
