# Audit 2 — six perspectives on v1.1.0, fixed in v1.2.0

On 2026-10-07 SAM v1.1.0 (`66f45b6`) was audited from six independent perspectives. Each audit ran on its own copy of the repo; the fixes were then made on two branches (`fix-core`: engine, security, robustness, workflow; `fix-platform`: installer, Windows, packaging), merged, and followed by the retrieval work and this documentation pass for **v1.2.0**.

Reports: [platform](audit2/platform.md) · [workflow](audit2/workflow.md) · [packaging](audit2/packaging.md) · [retrieval](audit2/retrieval.md). The security and chaos reports were not available when the fixes and these docs were written; their findings are known from the reproduction scripts and harness they shipped with and from the fix-branch reports, and are summarized below from those sources. Line numbers in the reports refer to v1.1.0.

## Summary

| Perspective | Findings | Fixed in v1.2.0 | Deferred |
|---|---|---|---|
| Security | 20 items (S1–S20), 26 reproductions (r01–r26) plus a 34-case redaction matrix; severity grades not available | all 20 | — (one residual risk documented) |
| Robustness (chaos) | items numbered #1–#13 (#7 is not described in the available sources); severity grades not available | all described items | 1 sub-item (#6b) |
| Multi-agent workflow | 17: 1 P0 · 8 P1 · 6 P2 · 2 P3 | P0, all P1, 5 of 6 P2, 1 of 2 P3 | 2, plus 6 smaller simulation failures |
| Cross-platform | 19: 2 Critical · 4 High · 6 Medium · 7 Low | both Critical, all High, all Medium, 3 Low | 4 Low |
| Packaging and docs | 15: 7 P0 · 6 P1 · 2 P2 | all P0, all P1 | P2 maintainability refactors |
| Retrieval quality | 9 weaknesses (ungraded) + 7 recommendations | 7 weaknesses, 4 recommendations | implicit-task recall, dump mode for tiny stores, a "precise" profile |

Test suite: 22 tests in v1.1.0 → **93** in v1.2.0 (plus `SAM_SLOW=1` long chaos runs and `npm run e2e`).

## Security

Sources: the reproduction scripts r01–r26 and the fix-branch report (the original report was not available).

**Fixed (all 20 items, every reproduction now fails to reproduce):**
- **Untrusted repo content.** `.sam-project` must be a small regular file (no symlink/FIFO/device), is ignored in shared or world-writable directories, and can no longer collide project ids (S1, S2, S17 name injection, S19). A team file is imported only after a human review in a terminal (`sam trust` shows a preview and asks `[y/N]`, or `--yes`), and trust is pinned to the reviewed content hash (S12, r18 "agent can self-trust", r25). `export --team` writes atomically and refuses symlinks (S7).
- **Provenance** (S4, S15). Rows record `source` (`user|agent|auto|team|import`). Only the user pins; agents cannot overwrite or supersede the user's or pinned values; MCP `pin` was removed; JSONL imports are untrusted by default.
- **Prompt-injection hygiene** (S3, S11, S6). NFKC + removal of invisible/bidi/tag characters; every card field escaped; harvest only from an allow-list of assistant-message formats, never tool output, compaction summaries, reasoning, quotes or code; fix gists carry no command output.
- **Scoping and DoS** (S5, S20, S14, S9). MCP `mem_get`/`mem_forget` are scoped to the project + global with size caps; `--grep` takes only a backtracking-safe regex subset with a time budget; redaction is linear time (2 MB adversarial input in milliseconds instead of minutes).
- **Secrets** (S10). 0 of 34 redaction-matrix cases leak (19 leaked in v1.1.0).
- **Data at rest** (S8, S16). 0700/0600 permissions; `secure_delete`; `forget --hard` purges FTS and WAL.
- **Platform-owned items** (S13, S17, S18). `sam run` refuses a single argument with shell operators unless `--shell`; the installer never writes through symlinks; a remote embedding URL needs the user's own `config.json`.

**Residual risk (documented, not fixable in SAM):** approving `sam run` in a host approves whatever follows `--`.

## Robustness (chaos)

Sources: the chaos harness (now under `test/chaos/`) and the fix-branch report.

**Fixed:** poison markers (`__proto__`, junk) and per-item isolation with a transcript offset that always advances (#1); quadratic redaction (#2, as S9); FIFO/device/huge transcripts (#3); corrupt DB → moved aside, fresh DB, `sam doctor --repair` salvage (#4); read-only/disk-full DB still serves cards and search (#5); MCP reopens a replaced DB file (#6); hooks read before they write and survive a held write lock (#8); a light automatic gc once a day (#9); clock jumps (#10); resurrection of forgotten memories and resume deltas (#11); payload type checks and a 2 MB stdin cap (#12); Claude subagent hooks registered (#13). Harness results after the fix: 0 exceptions in 6 hook dialects, kill -9 ×30 with 0 failures, 60 concurrent hooks + 2 MCP servers + gc with 0 errors. A CI subset runs in `npm test`.

**Deferred:** #6b, deleting the `-wal` file under a running MCP server still loses the writes made after the deletion. Reopening or force-checkpointing would trade that for a corruption risk, and this is external tampering.

## Multi-agent workflow

Source: [audit2/workflow.md](audit2/workflow.md) (8 scripted multi-day, multi-host scenarios).

**Fixed:** marker floods (≤8 per turn, junk filter, agent lines capped on the card) (P0 #1); supersession by negation and by replacement phrases, dated decisions listed newest first (#2); Codex harvest of non-assistant text (#3); parent-folder sessions no longer write to `global` (#4); team export merges instead of overwriting, deletions propagate, team lines never inherit pins (#5); Cursor ledger poisoning (#6); subagent ledgers and a subagent mini-card (#7); Turkish directive forms and ephemeral "tomorrow" todos (#8); the save rules now reach Claude Code and Cursor through the card footer, and the installed rules teach `subject: value` (#9); fix-gist quality (#10); exact duplicates without a fingerprint (#11); empty and current-session digests hidden (#12, partly); the card is re-sent after Gemini compression (#13); estimator recalibrated on real cards, cards packed to 94% of budget (#14); `cd X &&` stripped from commands (#16).

**Deferred:** cross-repo digest attribution when one session `cd`s between repos (#15); inflated "inline markers" stats (#17). Smaller simulation failures left: a personal style rule said in repo A not reaching repo B, flaky-test handling, command-only fixes, cross-session fixes, and a mid-session notice when another terminal changes a decision. Five more simulation failures are the intended new trust policy (they pass with a review step).

## Cross-platform

Source: [audit2/platform.md](audit2/platform.md).

**Fixed:** Windows hook commands per host shell, with a real-shell self-test (C1); the Node floor is 22.16 (22.x) or 24+, refused cleanly elsewhere (C2); a stable launcher so Node upgrades do not break hooks (H1); CRLF team files (H2); canonical project paths (H3); unsafe filesystems: warnings in `doctor`/`install`, and since v1.2.0 the rollback journal instead of WAL there, `SAM_ALLOW_SHARED_FS=1` to override (H4); `sam run` shell choice and quoting on Windows (M1); console code-page decoding (M2); remote parsing (M3); `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_CONFIG_HOME` (M4); `claude.cmd` probing without the current directory on PATH (M5); a Windows/macOS/Linux × Node 22.16/24 CI matrix (M6); `detect()` without `which` (L2); Deno `run -A` (L3); `shortPath` edge cases (L4).

**Deferred (Low):** Turkish folding for an explicit `--topic` and `--grep` (L1); git edge cases such as `GIT_DIR`, bare repos and `include.path` (L5); Codex running hooks through a login shell (L6); the cosmetic ExperimentalWarning filter (L7). Real-host execution of every Windows shell form is still unverified outside CI.

## Packaging and docs

Source: [audit2/packaging.md](audit2/packaging.md).

**Fixed:** tests never run the real `claude` CLI or touch the real home (P0 #1); `--version` (#2); POSIX-only tests skipped on Windows (#3); Turkish README parity (#4, in v1.2.0); stale numbers in README/AUDIT/ARCHITECTURE and code comments (#5, in v1.2.0); a `files` whitelist that ships no research or audit notes, and scrubbed internal paths in `docs/` (#6); `repository`/`homepage`/`bugs`/`author`/`exports` (#7, with the `GITHUB_OWNER` placeholder kept until the repo is public); one-line user errors and consistent exit codes (#8); CLI and MCP validate input the same way (#9); the `sam-memory` alias for the AWS SAM CLI collision (#10); type-checked config with warnings (#11); order-independent, leak-free tests (#12); CHANGELOG, SECURITY, CONTRIBUTING, templates, CI and release workflows (#13).

**Deferred:** the P2 maintainability items (#14 code duplication beyond the single `VERSION` source, #15 the long `cli.main` switch and long lines). They carry no user-visible risk.

## Retrieval quality

Source: [audit2/retrieval.md](audit2/retrieval.md); the eval set is now `bench/retrieval/` (`npm run bench:retrieval`).

**Fixed:** paraphrase gap (bilingual alias table), Turkish↔English (Turkish stems, aliases), stemming/prefix false friends (alias matching limited to short inflections), IDF oddities (IDF over live rows in scope; absent and generic words down-weighted), card decay of important decisions (decay floor, global cap, one line per area), temporal intent, and the rank-based gate (now evidence-based). The prototype's known weakness, an absolute IDF threshold for "rare" concepts, was replaced by a **store-size-relative** test plus **joint selectivity** (the concepts a hit covers must together match at most 15% of the searchable memories, at least one row), so the gate also works in a 2-memory store and on templated corpora. Gate settings were tuned only on the odd-numbered half of the prompts.

| | v1.1.0 | v1.2.0 |
|---|---:|---:|
| R@3 / MRR | 0.771 / 0.749 | 0.886 / 0.852 |
| Turkish↔English R@3 | 0.495 | 0.848 |
| zero-overlap R@3 | 0.091 | 0.500 |
| answer injected / false injections | 0.775 / 0.750 | 0.845 / 0.500 |
| held-out half: answer injected / false injections | 0.750 / 0.938 | 0.868 / 0.500 |
| tokens per prompt | 103 | 85 |
| card coverage of the must-know set | 0.16 | 0.35–0.37 |
| `npm run bench` (templated) | 20/20, ≈2,670 tokens | 20/20, ≈2,170 tokens |

**Deferred:** implicit-task recall ("add a price field…" should surface the money-as-kuruş decision; needs semantic or file-anchored recall), stale values reworded without a shared subject or replacement phrase, an automatic compact-dump mode for very small stores, and a packaged "precise" gate profile (the keys are documented; on the held-out half the stricter settings did not lower false injections). Embeddings stay optional; the local server in `bench/retrieval/embed_server.py` is the recommended path for Turkish users who want them.
