# Group 4 — Repo Analysis (Acontext, ReMe, MIRIX, mnemosyne, cursor-memory-bank, MemMachine, memobase, pro-workflow, memsearch, ACE)

Method: full README read plus a local shallow clone (cloned 2026-10-07, default branch HEAD). File paths below are relative to each repo root. Numbers are only those stated in README/repo files; nothing is extrapolated unless marked "(est.)".

---

## 1. memodb-io/Acontext (3.7k★)

**Summary.** "Skill memory": learnings from agent runs are distilled into editable `SKILL.md`-format Markdown files that agents fetch by progressive disclosure, not top-k search. Server stack (Go API + Python core) with SDKs and a Claude Code plugin.

**Architecture.** Go API (`src/server/api/go`) + Python core (`src/server/core/acontext_core`) over PostgreSQL, S3, Redis, RabbitMQ; dashboard on :3000. Skills are stored server-side and synced to disk. Memory schema is itself a skill: templates in `src/server/api/go/configs/skill_templates/{user-general-facts,daily-logs}/SKILL.md` define file layout (e.g. one `[TOPIC].md` per topic, third-person bullets).

**Capture.** Messages stored per session; a task agent (`llm/agent/task.py`, tools in `llm/tool/task_lib/`: append/insert/update/finish/submit_preference) segments the stream into tasks. On task complete/failed, `service/skill_learner.py` runs two MQ consumers: (1) distillation — one LLM call (`llm/prompt/skill_distillation.py`) choosing `skip_learning` / `report_success_analysis` / `report_factual_content` / `report_failure_analysis`; messages truncated to 512 chars each; (2) a Skill Agent (`llm/agent/skill_learner.py`, max 5 iterations, Redis lock per learning space, batches queued contexts) that edits files with `create_skill`, `str_replace_skill_file`, `mv_skill_file`, etc. Claude Code plugin (`src/packages/claude-code/plugin/hooks/hooks.json`): SessionStart, PostToolUse, Notification, Stop hooks read the transcript incrementally and upload.

**Retrieval/Ranking.** None in the vector sense. Agent calls `list_skills`/`get_skill`/`get_skill_file` and reasons.

**Context injection & token cost.** Clever: `bridge.ts:syncSkillsToLocal()` incrementally downloads skills into `~/.claude/skills/`, so Claude Code's native skill loader only puts name+description in context until a skill is invoked. Cost ≈ one frontmatter line per skill at rest. Separately, `api/go/internal/pkg/editor/` provides context-editing strategies: `remove_tool_result` (placeholder for old tool outputs, keep N recent, `KeepTools`, `GtToken` threshold), `remove_tool_call_params`, `middle_out`, `token_limit` (drop oldest, keeping tool-call/result pairs).

**Compression/Consolidation.** Skill Agent merges into existing files ("update existing facts when corrections are provided"); `applies_when` field forces scoping; trivial tasks skipped.

**Integrations.** Python/TS SDKs, Claude Code plugin + MCP server (`src/packages/claude-code/src/mcp-server.ts`), OpenClaw, Claude Agent SDK, Vercel AI, Agno, smolagents.

**Dependencies.** LLM with tool-calling required (default `gpt-4.1`), Docker stack of 4 infra services; cloud offering.

**Benchmarks claimed.** None.

**Strengths to steal.** Memory-as-native-skills (zero-cost at rest); success/failure distillation schema with `applies_when` and `prevention_principle`; `skip_learning` gate; Stop+Notification double-capture to catch late transcript flushes; tool-result elision strategies.

**Weaknesses to beat.** Heavy infra (PG+S3+Redis+RabbitMQ) for what is file memory; every learning costs ≥2 LLM passes; no search at all — recall quality depends on the agent remembering to open the right skill; no benchmarks; skill sprawl with no decay.

---

## 2. agentscope-ai/ReMe (3.6k★)

**Summary.** Local-first, file-native Markdown knowledge base (frontmatter + wikilinks) with BM25 default, optional vectors fused via RRF, and an LLM "auto dream" consolidator. Strongest published LongMemEval number in this group (89.4%).

**Architecture.** Python service (`reme start`, :2333) exposing CLI/HTTP/MCP/Python. Workspace layering: `session/` (raw jsonl) → `daily/YYYY-MM-DD/*.md` (light cards) → `digest/{personal,procedure,wiki}/*.md` (long-term). `metadata/` holds rebuildable indexes. Own on-disk BM25 inverted index (`reme/components/keyword_index/bm25_index.py`, k1=1.5, b=0.75, numpy posting lists, lazy deletion); optional `embedding_store`; wikilink graph (`file_graph`); tag index.

**Capture.** `auto_memory` / `auto_memory_cc` (`reme/steps/evolve/`) — an inner agent distills a filtered conversation into daily cards, keeping the source record. Claude Code: a single Stop hook (`integrations/claude_code/reme/hooks/auto_memory.py`) double-forks and calls the server's `auto_memory_cc` with only the `session_id`; server reads the transcript itself. `auto_resource` turns dropped files into cards.

**Retrieval/Ranking.** `reme/steps/index/search.py`: BM25 + optional vector, `_rrf_merge` with K=60 and a `vector_weight`; returns **line-ranged chunks** (`path:start-end`) plus bounded wikilink neighbors (`max_links_per_direction=10`). Notable token savers: `_dedupe_tool_context` skips chunks already returned within the same `tool_context_id` (TTL 24h); `max_search_calls` per-context budget; tag filters; `strict_date_filter`.

**Context injection & token cost.** Pull-based via MCP/skill for Claude Code (no SessionStart injection); hosts like Hermes/OpenClaw get pre-call recall. Cost bounded by `limit` × chunk size; repeated searches don't re-pay for seen chunks.

**Compression/Consolidation.** `auto_dream` (config `reme/config/default.yaml`): scans last 2 days, extracts ≤5 units, then `dream_integrate_step` picks one of **CREATE / CORROBORATE / REFINE / CORRECT** against existing digest nodes; UPDATE is additive (never removes wikilinks). `compressor.yaml` provides lossless and query-guided transcript compression prompts.

**Integrations.** Claude Code plugin (MCP + Stop hook + skill), Codex/other CLIs via `skills/reme_memory/SKILL.md`, OpenClaw, DeepSeek Harness, Hermes, QwenPaw.

**Dependencies.** Python 3.11; LLM needed only for auto_memory/dream; embeddings off by default.

**Benchmarks claimed.** LongMemEval cleaned-s 89.4% (500 q, "agentic score"); BEAM 66.1% (100K), 65.0% (1M); π-Bench PROC 0.580.

**Strengths to steal.** Session-scoped "seen chunk" dedupe; line-range citations for follow-up reads; 4-verb consolidation (corroborate/refine/correct); raw→daily→digest tiering with rebuildable indexes; BM25-first, vectors optional.

**Weaknesses to beat.** Requires a running service for hooks; Claude Code capture only at Stop (lost on crash/compaction); inner-agent distillation is LLM-expensive; no proactive injection for Claude Code so the agent must decide to search; Python BM25 in pickle/numpy rather than SQLite FTS5.

---

## 3. Mirix-AI/MIRIX (3.4k★)

**Summary.** Letta-derived multi-agent memory server with six typed stores (Core, Episodic, Semantic, Procedural, Resource, Knowledge Vault), each managed by its own LLM agent; supports screen-capture ingestion. Heavy, server-centric.

**Architecture.** FastAPI server (`mirix/server/rest_api.py`) + PostgreSQL (pgvector) via Docker; dashboard :5173. Per-type managers in `mirix/services/*_memory_manager.py`; agents in `mirix/agent/` (`meta_memory_agent.py`, `episodic_memory_agent.py`, …, `auto_dream_agent.py`).

**Capture.** `client.add(messages)` → meta agent routes to type-specific memory agents which write via tools. Tool calls/errors are preserved to feed `session_experience_distiller.py` / `skill_experience_curator.py` (procedural "skills" evolution). Embeddings for summary+details computed on insert unless `BUILD_EMBEDDINGS_FOR_MEMORY=false` (`mirix/constants.py`).

**Retrieval/Ranking.** `retrieve_memory_with_conversation` (rest_api.py ~L2913): an LLM extracts topics **and a temporal expression** from the conversation (`extract_topics_and_temporal_info`, optional local model), `mirix/temporal/temporal_parser.py` turns it into a date range, then `retrieve_memories_by_keywords` runs `search_method="bm25"` per memory type (PostgreSQL `ts_rank_cd`, fallback `rank_bm25` in memory for SQLite) with `limit` per type, plus recent episodic items and all core blocks grouped by scope. Embedding search available but not the default here; no fusion.

**Context injection & token cost.** Returns up to `limit` items × 5 types + full core blocks; no token budgeting found. Every retrieval costs an extra LLM call for topic extraction.

**Compression/Consolidation.** `POST /memory/auto_dream` with modes core/episodic/semantic/resource/procedural/knowledge/experience; merges duplicates, resolves stale/conflicting entries, `dry_run` supported.

**Integrations.** Python client SDK and REST; MCP marketplace/tool registry (`services/mcp_tool_registry.py`) is for agent tools, not a coding-CLI memory plugin. No Claude Code/Codex hooks.

**Dependencies.** Postgres, LLM (README example Gemini 2.0 Flash), embedding model; manual SQL migrations on upgrade (README lists 8 scripts).

**Benchmarks claimed.** README: none (links paper arXiv:2507.07957). `evals/` contains a harness (`main_eval.py`, `mab/`) without published numbers in-repo.

**Strengths to steal.** LLM/local-model temporal-expression extraction → hard date filter before ranking; typed memory taxonomy (esp. Knowledge Vault for secrets/credentials separated from semantic facts); learning procedures from tool error→retry→fix sequences.

**Weaknesses to beat.** Six LLM agents per write = high cost/latency; retrieval needs an LLM call; no token budget; Postgres + migrations; no coding-agent integrations; BM25 only on separate fields without hybrid fusion.

---

## 4. mnemosyne-oss/mnemosyne (3.4k★)

**Summary.** Single-SQLite-file memory (FTS5 + sqlite-vec + binary vectors) with working/episodic tiers, temporal triple store, and MCP server; Hermes-first. Feature-rich but monolithic, with candid but mixed benchmark disclosures.

**Architecture.** `mnemosyne/core/beam.py` (13.7k lines) implements BEAM: working memory (hot, TTL), episodic memory (long-term, FTS5 + sqlite-vec), `TripleStore` (temporal KG with `valid_from`/`as_of`). `binary_vectors.py`: MIB binarization (384-dim float32 → 48 bytes, Hamming via XOR/popcount, no ANN index); default `MNEMOSYNE_VEC_TYPE=int8`. Banks for per-domain isolation; delta sync with client-side encryption (`sync.py`, `sync_server.py`).

**Capture.** Explicit `remember()` / MCP `mnemosyne_remember` with `importance`, `scope`, `valid_until`, optional entity extraction or LLM fact extraction (`extract=True`). Hermes provider has lifecycle hooks; for Claude Code/Cursor/Codex it is MCP-only (agent must call tools).

**Retrieval/Ranking.** Hybrid score = 0.5 vector + 0.3 FTS5 + 0.2 importance (env-tunable), recency half-life 168h (`MNEMOSYNE_RECENCY_HALFLIFE`), per-call `temporal_weight`/`temporal_halflife`. `polyphonic_recall.py`: 4 "voices" (vector, graph, fact, temporal) fused by RRF (`_combine_voices`), `_diversity_rerank`, and `_assemble_context(budget)` with `context_budget=4000` tokens default. Also `mmr.py`, `query_intent.py`, `temporal_parser.py`, `query_cache.py`.

**Context injection & token cost.** `get_context(limit=10)` auto-injects working memory in Hermes. **Tool-schema cost is large**: `tool_schemas.py` defines 41 tools in 42.7 KB (≈10k tokens (est.) if all are exposed via MCP).

**Compression/Consolidation.** `sleep()` (beam.py ~L12229): consolidates working memory older than TTL/2 into episodic summaries using a local LLM, falling back to **AAAK** (`aaak.py`) — a rule-based shorthand dialect (PREFERENCE→PREF, etc.) "LLMs parse without a decoder". Originals marked `consolidated_at`, not deleted; `pinned` rows exempt; `superseded_by` chains; veracity/conflict census.

**Integrations.** MCP (Claude Code, Cursor, Codex, Windsurf), OpenWebUI tool, OpenClaw provider, Pi extension, Hermes plugin, VS Code/Obsidian integrations.

**Dependencies.** Core pip-only (~50 MB); `[embeddings]` adds fastembed (bge-small-en-v1.5); `[all]` adds sentence-transformers + ctransformers local LLM. Default embedding API endpoint is OpenRouter if not local.

**Benchmarks claimed.** BEAM 100K end-to-end 65.2% (v3.0.0, different judge than competitors — caveated). BEAM pure retrieval Recall@10 = 20% flat from 100K to 10M; "9.4x" storage savings from episodic compression. LongMemEval 98.9% R@5 **withdrawn** (no methodology), yet the comparison table still says "87.4% LongMem" — inconsistent.

**Strengths to steal.** Everything in one SQLite file; binary/int8 vector quantization inside SQLite; importance + recency half-life in the scoring formula; token-budgeted context assembly with diversity penalty; non-destructive consolidation with `superseded_by`; temporal triples with validity windows; rule-based AAAK fallback when no LLM.

**Weaknesses to beat.** 13.7k-line god file; 41-tool MCP surface bloats every session; no automatic capture for coding CLIs; Recall@10 of 20% is low; benchmark claims inconsistent.

---

## 5. vanzan01/cursor-memory-bank (3.1k★)

**Summary.** Not a memory engine: a prompt/rules framework for Cursor 2.0 commands (`/van /plan /creative /build /reflect /archive`) that keeps state in `memory-bank/*.md`, with hierarchical lazy rule loading to save tokens.

**Architecture.** `.cursor/commands/*.md` (6 commands, 17 KB total) and `.cursor/rules/isolation_rules/**.mdc` (≈495 KB of rules, 62 files). State files: `memory-bank/tasks.md` (source of truth), `activeContext.md`, `progress.md`, `projectbrief.md`, `creative/`, `reflection/`, `archive/`.

**Capture.** Entirely LLM-driven by instructions: each command tells the model to update specific files; `/archive` writes `archive-[task_id].md` and resets `activeContext.md`.

**Retrieval/Ranking.** None; files are named and read explicitly by the command's "Load:" steps.

**Context injection & token cost.** Only `Core/memory-bank-paths.mdc` is `alwaysApply: true`. Each command loads a fixed set, e.g. `/van` loads `main.mdc` (8.2 KB) + 3 Core files + `van-mode-map.mdc` (33.5 KB) — roughly 45–50 KB ≈ 12k tokens (est.) before work starts. README claims "~70% token reduction" from hierarchical loading; `MEMORY_BANK_OPTIMIZATIONS.md` gives no measurement.

**Compression/Consolidation.** Complexity levels 1–4 scale how much documentation is written; tasks.md cleared after archive.

**Integrations.** Cursor only (commands); concept portable to any agent that reads files.

**Dependencies.** None (pure Markdown); recommends Claude 4 Sonnet/Opus.

**Benchmarks claimed.** "~70% token reduction" (unmeasured).

**Strengths to steal.** Lazy, phase-scoped instruction loading; complexity-gated documentation depth; explicit "active context" file reset at task end (keeps hot file small); archive pattern that moves finished work out of the hot path.

**Weaknesses to beat.** No search, no automatic capture, relies on model compliance; large rule files still cost ~10k+ tokens per phase; Cursor-only; no dedup/consolidation; hobby project with no issue tracker.

---

## 6. MemMachine/MemMachine (3.1k★)

**Summary.** Server-based memory layer with episodic (graph/vector) + semantic "profile" memory, pluggable rerankers including RRF hybrid, and an agentic retrieval router; framework integrations and an MCP server.

**Architecture.** `packages/server/src/memmachine_server/`: `episodic_memory/` (short_term, long_term, declarative_memory, event_memory with segmenter/deriver), `semantic_memory/` (features, categories, tags, clusters; storage backends pgvector/neo4j/vector-store), `common/vector_graph_store/` (Neo4j, NebulaGraph), `common/vector_store/` (Milvus, Qdrant, sqlite-vec, sqlite), `common/reranker/` (bm25, cohere, cross-encoder, embedder, bedrock, identity, `rrf_hybrid_reranker.py` k=60), `retrieval_agent/agents/` (tool_select, coq, split_query, rarag).

**Capture.** `add_memory` via REST/SDK/MCP. `declarative_memory.py:add_episodes` creates **derivatives** per episode (optionally one per sentence via `extract_sentences`, prefixed with speaker), embeds derivatives, links derivative→episode edges. Semantic ingestion (`semantic_ingestion.py`) runs LLM feature-update commands per set.

**Retrieval/Ranking.** `search_scored`: vector search over derivatives → source episodes as "nuclei" → `_contextualize_episode` pulls neighboring episodes (1/3 backward, 2/3 forward of `expand_context`) → rerank contexts (`_score_episode_contexts`) → unify/dedupe up to `max_num_episodes`. Retrieval agent (`tool_select_agent.py`) routes query to multi-hop chain-of-query, split-query, or direct retrieval (cites Agent Lightning).

**Context injection & token cost.** Caller decides; no built-in token budget seen beyond `max_num_episodes`. Short-term memory is a fixed-capacity deque with async LLM summarization of evicted messages.

**Compression/Consolidation.** `_consolidate_set_memories_if_applicable`: when a tag section has ≥`consolidated_threshold` (default 20) features, an LLM consolidation prompt merges them; handles context-length errors by skipping.

**Integrations.** LangChain, LangGraph, CrewAI, LlamaIndex, AWS Strands, n8n, Dify, FastGPT; MCP stdio/HTTP (3 tools: add/search/delete); `packages/skills/memmachine-memory/SKILL.md` for coding agents via `mem-cli` (instructs "query memory before grep").

**Dependencies.** Server + Neo4j (episodic) + SQL/pgvector; LLM and embedder; optional reranker APIs.

**Benchmarks claimed.** README: none. `evaluation/` has LoCoMo and LongMemEval harnesses (`evaluation/episodic_memory/locomo_*.py`, `longmemeval_*.py`) and retrieval-agent tests (HotpotQA, WikiMultihop, BEAM); no numbers in README.

**Strengths to steal.** Sentence-level derivatives pointing back to full episodes (index small, return context); temporal neighbor expansion around hits; query router (multi-hop vs split vs direct); threshold-triggered consolidation; tiny 3-tool MCP surface.

**Weaknesses to beat.** Neo4j + server is heavy for local CLIs; no hook-based auto-capture for coding agents; LLM required on ingest for semantic memory; no injection budgeting; no published scores in README.

---

## 7. memodb-io/memobase (2.9k★)

**Summary.** User-profile memory (topic/sub_topic/content slots) plus an event timeline with gists, batch-processed from a per-user buffer with a fixed 3 LLM calls per flush; `context()` API packs profile+events into a token-capped string. Predecessor of Acontext.

**Architecture.** FastAPI + Postgres + Redis (`src/server/api/memobase_server`). Controllers: `buffer.py`, `profile.py`, `event.py`, `event_gist.py`, `context.py`; LLM pipeline in `controllers/modal/chat/` (`extract.py`, `merge.py`, `merge_yolo.py`, `organize.py`, `summary.py`, `event_summary.py`).

**Capture.** Insert `ChatBlob`s into a buffer; flush when buffer > `max_chat_blob_buffer_token_size=1024` tokens or idle `buffer_flush_interval=3600s` (`env.py`), or manually. `process_blobs`: entry summary → extract topics → merge-or-validate against existing profile slots → organize (cap `max_profile_subtopics=15`) → re-summary; event tagging in parallel. Raw blobs deleted after processing by default.

**Retrieval/Ranking.** Profiles: no search by default — sorted by `updated_at`, `prefer_topics` priority, `only_topics`, `topic_limits` (`truncate_profiles`); optional `filter_profiles_with_chats` (LLM picks relevant profile items given recent chats). Events: embedding search over event gists with `similarity_threshold` (default 0.2) when `enable_event_embedding`.

**Context injection & token cost.** `get_user_context(max_token_size, profile_event_ratio, ...)` splits a hard token budget between profile and events; README example `u.context(max_token_size=500)`. Output is compact `topic::sub_topic: content` lines.

**Compression/Consolidation.** Slot-based merge is inherently dedup (one value per sub_topic); `max_pre_profile_token_size=128` caps each slot; organize step re-clusters when too many subtopics.

**Integrations.** Python/Node/Go SDKs, OpenAI-SDK wrapper, Ollama, MCP server (`src/mcp`).

**Dependencies.** Postgres, Redis, LLM, optional embeddings.

**Benchmarks claimed.** LoCoMo LLM-judge overall 75.78% (v0.0.37; temporal 85.05%) vs Mem0 66.88%, Zep 65.99% (`docs/experiments/locomo-benchmark/README.md`), with a note that Zep's corrected figure is 75.14%. v0.0.40: LLM calls per flush reduced from ~3–10 to fixed 3, "~40–50%" token-cost reduction.

**Strengths to steal.** Buffer-and-batch capture (amortize LLM cost; token or idle trigger); schema-slot profiles that dedupe by construction; hard token budget with profile/event ratio; fixed-cost pipeline (no open-ended agents); event gists with timestamps for temporal questions.

**Weaknesses to beat.** Built for chat-app user profiles, not coding agents (no project/procedure memory); Postgres+Redis; profile filtering by LLM per request adds latency; deleting raw blobs prevents re-derivation.

---

## 8. rohitg00/pro-workflow (2.9k★)

**Summary.** Claude Code plugin bundle (41 skills, 23 commands, 33 hook scripts on 22 events) with a SQLite+FTS5 store for correction "learnings" and research wikis, plus token-hygiene hooks. Memory is one part of a larger workflow kit.

**Architecture.** `~/.pro-workflow/data.db` (schema `src/db/schema.sql`: learnings + FTS5, sessions, wikis, wiki_pages + FTS5, wiki_claims, wiki_seeds, wiki_embeddings). TS sources `src/db/store.ts`, `src/search/fts.ts` (`bm25(learnings_fts, 1.0, 2.0, 1.0, 1.0)` — rule column weighted 2×), `src/search/embeddings.ts` (`reciprocalRankFusion`, k=60). Hooks in `scripts/*.js`, wired by `hooks/hooks.json`.

**Capture.** (a) `learn-capture.js` (Stop) regex-parses `[LEARN] Category: rule / Mistake: / Correction: / Wiki:` blocks from the assistant's response; (b) `/learn-rule` with user approval; (c) `prompt-submit.js` correction detection via an external fast classifier ("System One", 150 ms timeout, threshold 0.9, default disabled) that flags "user is correcting the assistant".

**Retrieval/Ranking.** FTS5 BM25 for learnings and wikis; optional hybrid BM25+vector RRF for wikis (`/wiki hybrid`, OpenAI/Voyage keys).

**Context injection & token cost.** `session-start.js` loads 5 most recent learnings for the project (prints 3) + previous-session stats + up to 5 wiki names; `prompt-submit.js` injects top-3 wiki hits only when prompt ≥3 words and index matches. Small, bounded. Token-hygiene hooks: `reread-tracker.js` (warns/blocks re-reading an unchanged file), `tool-call-budget.js`, `read-before-write.js`, `pre-compact.js`/`post-compact.js` (save & re-inject critical state across compaction), `mcp-audit` skill (MCP token overhead).

**Compression/Consolidation.** Minimal; no dedup/merge of learnings beyond FTS; wiki claims tracked with sources.

**Integrations.** Claude Code native plugin; Cursor, Codex, Gemini CLI, OpenCode, Antigravity and ~30 others via `npx skills add` (skills/commands only — hooks are Claude-Code-specific).

**Dependencies.** Node + better-sqlite3 build step; optional LLM keys for council/research/embeddings.

**Benchmarks claimed.** None (qualitative "correction rate near zero").

**Strengths to steal.** `[LEARN]` inline protocol (zero extra LLM call capture); correction classifier at UserPromptSubmit; re-read tracker; PreCompact/PostCompact state preservation; column-weighted BM25; STOP-file kill switch.

**Weaknesses to beat.** "Recent 5" learnings ≠ relevant learnings; regex capture depends on model emitting blocks; cross-agent install lacks hooks so no capture outside Claude Code; sprawling 41-skill surface itself costs tokens in skill listings; no consolidation.

---

## 9. zilliztech/memsearch (2.7k★)

**Summary.** Markdown-as-truth memory for coding agents with a rebuildable Milvus (Lite) shadow index, hybrid dense+BM25 sparse with RRF, per-turn haiku summaries via Stop hook, and 3-layer progressive recall. Best multi-CLI plugin coverage in this group.

**Architecture.** `src/memsearch/`: `chunker.py` (split by headings, `max_chunk_size=1500` chars), `store.py` (Milvus collection with dense vector + `SPARSE_FLOAT_VECTOR` generated by Milvus `FunctionType.BM25`, `RRFRanker`), `scanner.py`/`index_state.py` (SHA-256 per chunk → skip unchanged), `watcher.py` (live re-index), `compact.py`, `maintenance.py`, `skills.py`, `reranker.py`/`jev_reranker.py`. Data: `.memsearch/memory/YYYY-MM-DD.md` with `<!-- session:UUID -->` anchors.

**Capture.** `plugins/claude-code/hooks/stop.sh`: parse last turn, summarize with `claude -p` (haiku by default) using `prompts/summarize.txt` (2–10 third-person bullets, same language as user), append to daily file, index. Codex/OpenCode/OpenClaw/DSH plugins do the same with native summarizers or configured provider.

**Retrieval/Ranking.** Hybrid dense (default ONNX bge-m3 int8, 558 MB, CPU) + BM25 sparse, RRF; optional remote rerank (Jev, Voyage). Progressive: L1 `search` → L2 `expand <chunk_hash>` (full section) → L3 `parse-transcript` (raw dialogue).

**Context injection & token cost.** SessionStart injects a preview of the 2 most recent daily files capped at `RECENT_MEMORY_MAX_LINES=40` and `RECENT_MEMORY_MAX_BYTES=1800` (~450 tokens (est.)). UserPromptSubmit only emits `systemMessage: "[memsearch] Recall available if needed"` for prompts ≥10 chars; deep recall is pull-based via `memory-recall` skill.

**Compression/Consolidation.** Optional background maintenance of `PROJECT.md` and `USER.md` (`prompts/project_review.txt`, `user_profile.txt`), input-digest tracked so failures retry; `compact_chunks` LLM summarization; skill distillation into `.memsearch/skill-candidates/` (git-tracked, inert until user installs). Dedup only by content hash.

**Integrations.** Claude Code, Codex, OpenCode, OpenClaw, DeepSeek Harness plugins; CLI; Python API.

**Dependencies.** Milvus Lite (pymilvus), ONNX model download (~558 MB), LLM for per-turn summaries (uses the host CLI's own model by default).

**Benchmarks claimed.** Embedding selection eval on own data (955 chunks × 2172 queries, zh/en): bge-m3 R@5 0.783 zh / 0.815 en; ONNX int8 0.776 / 0.814 (`evaluation/README.md`); reranking eval in `evaluation/reranking-evaluation.md`. No LongMemEval/LoCoMo.

**Strengths to steal.** Byte-capped cold-start injection; L1/L2/L3 progressive disclosure keyed by chunk hash; SHA-256 chunk skip; session anchors linking summaries to transcripts; reuse the host CLI as summarizer (no extra key); candidate-then-install procedural skills.

**Weaknesses to beat.** One LLM call per turn (cost + latency, and summaries are lossy); Milvus + 558 MB model is heavy vs SQLite FTS5; no semantic dedup/conflict resolution across days; recall depends on model invoking the skill.

---

## 10. kayba-ai/agentic-context-engine (ACE) (2.6k★)

**Summary.** Implementation of the ACE paper: an evolving "Skillbook" of strategies curated by Reflector and SkillManager roles from execution traces, injected into the agent prompt. Procedural-learning focus, not factual memory.

**Architecture.** `ace/core/skillbook.py` (Skill with `section` ∈ {context, harness}, `keywords`, `insight`, `helpful_count`/`harmful_count`, sources, optional embedding sidecar; ops `ADD/UPDATE/TAG/REMOVE`), `ace/implementations/{reflector.py, skill_manager.py, rr/}` (Recursive Reflector writes/executes Python in a sandbox, `core/sandbox.py`, to mine traces), `ace/deduplication/` (embedding cosine, `similarity_threshold=0.85`, keep-decisions memoized), composable `pipeline/` (`AgentStep → EvaluateStep → ReflectStep → UpdateStep → DeduplicateStep`). Skillbook persisted as JSON.

**Capture.** From task runs, user feedback (`learn_from_feedback`), or offline traces (`TraceAnalyser`, `learn_from_traces`). All via PydanticAI/LiteLLM LLM calls.

**Retrieval/Ranking.** `implementations/skill_rendering.py:retrieve_top_k` — BM25 (`rank_bm25`) lexical + dense cosine fusion, section/keyword filters; renders `<strategy id section><issue/><insight/><keywords/></strategy>` XML.

**Context injection & token cost.** For external agents (`integrations/claude_code.py`, browser-use, LangChain) `wrap_skillbook_for_external_agent` injects **the entire skillbook** (`skillbook.as_prompt()`) with helpful/harmful counts — cost grows linearly with skill count unless the top-k path is used.

**Compression/Consolidation.** SkillManager adds/refines/removes; helpful/harmful tagging gives a utility signal; embedding dedup at 0.85.

**Integrations.** LiteLLM runner, LangChain, browser-use, Claude Code CLI wrapper (subprocess `claude` with injected prompt), Claude SDK, OpenClaw, MCP server (`ace-mcp`, handlers: ask, skillbook get/save/load, learn sample/feedback).

**Dependencies.** LLM calls for every learning step; optional embeddings (LiteLLM or sentence-transformers); sandbox for RR.

**Benchmarks claimed.** Tau2 airline: pass^4 doubled with 15 learned strategies (Claude Haiku 4.5); "49% token reduction" in browser automation over a 10-run learning curve; Claude Code Python→TS translation ~14k lines, ~$1.50 learning cost.

**Strengths to steal.** Helpful/harmful counters per memory as a utility score for ranking & pruning; context vs harness sectioning; Reflector→Manager split with structured delta ops (no full rewrites, avoids context collapse); learning from offline traces; code-executing reflector for long traces.

**Weaknesses to beat.** Whole-skillbook injection; Claude Code integration is a wrapper, not hooks; no factual/episodic memory; expensive multi-LLM learning loop; JSON file store without indexing.

---

## Top 15 ideas from this group (ranked by impact on token savings × memory quality)

1. **Memory-as-native-skills / progressive disclosure at rest (Acontext, memsearch skill candidates).** Write durable procedural memory into the host's native skill dir (`~/.claude/skills/`, Codex/OpenCode equivalents) so only name+description sit in context until invoked. Near-zero idle token cost.
2. **Hard token-budgeted injection with section ratios (memobase `max_token_size` + `profile_event_ratio`; mnemosyne `_assemble_context(budget)` + diversity penalty; memsearch 1800-byte SessionStart cap).** Never inject unbounded; split budget across profile/facts/recent episodes.
3. **Session-scoped "already seen" dedupe + search-call budget (ReMe `_dedupe_tool_context`, `max_search_calls`).** Repeated searches in one session never re-return the same chunk; cap retrieval loops.
4. **3-layer progressive recall keyed by stable IDs (memsearch L1 search → L2 expand → L3 transcript; ReMe line-range `path:start-end`).** Return short snippets with handles; let the agent pay for depth only when needed.
5. **Index small, return context (MemMachine sentence-level derivatives → parent episode + temporal neighbor expansion).** Better precision than chunk embeddings, and bounded context windows around hits.
6. **BM25-first local hybrid in one SQLite file, vectors optional & quantized (ReMe BM25 default; mnemosyne FTS5 + sqlite-vec int8/binary 48-byte vectors; RRF k=60 everywhere).** No servers, deterministic, multilingual via swappable embedder.
7. **Composite score = relevance ⊕ importance ⊕ recency half-life ⊕ utility (mnemosyne 0.5/0.3/0.2 + 168h half-life; ACE helpful/harmful counters).** Utility feedback lets memories that actually helped rise and harmful ones get pruned.
8. **Typed consolidation verbs with non-destructive history (ReMe CREATE/CORROBORATE/REFINE/CORRECT; mnemosyne `superseded_by`, `consolidated_at`, `pinned`; MemMachine threshold-triggered consolidation at ≥20 items).** Dedup and conflict resolution without losing provenance.
9. **Buffer-and-batch capture with token/idle triggers and fixed LLM-call count (memobase 1024 tokens / 1h, fixed 3 calls; Acontext task-completion trigger + `skip_learning`).** Cuts write-side LLM cost vs per-turn summarization (memsearch) or multi-agent writes (MIRIX).
10. **Zero-LLM capture paths: inline `[LEARN]` protocol + correction classifier (pro-workflow `learn-capture.js`, System One at UserPromptSubmit).** Capture high-value corrections without a summarizer call; reserve LLMs for batch consolidation.
11. **Success/failure distillation schema with explicit scope (Acontext `applies_when`, `prevention_principle`, `what_should_have_been_done`; ACE context vs harness sections).** Prevents over-generalized rules and makes procedural memory retrievable by condition.
12. **Temporal query parsing → hard date filter before ranking (MIRIX `extract_topics_and_temporal_info` + `temporal_parser`; mnemosyne `temporal_parser.py`, TripleStore `as_of`).** Big quality win on "last week / before X" questions; do it rule-based first, LLM only as fallback.
13. **Rebuildable shadow index over Markdown truth with SHA-256 chunk skip + file watcher (memsearch, ReMe `metadata/`).** Human-editable, git-diffable memory; re-embedding cost only on changed chunks.
14. **Context-hygiene hooks that save tokens outside memory proper (Acontext `remove_tool_result`/`middle_out` editors; pro-workflow `reread-tracker`, `PreCompact/PostCompact` state re-injection).** Memory system should also elide stale tool output and survive compaction.
15. **Minimal tool surface + query router (MemMachine 3 MCP tools and tool_select router; contrast mnemosyne's 41 tools ≈ 42.7 KB schema).** Keep MCP schema tiny (search/expand/remember), route complex queries (multi-hop/split) server-side instead of exposing many tools.

### Cross-cutting weaknesses to beat (group 4)
- Heavy infra (Postgres/Redis/RabbitMQ/Neo4j/Milvus) for single-user coding memory: Acontext, MIRIX, MemMachine, memobase, memsearch.
- Capture only at Stop (ReMe, memsearch) loses work on crash/compaction; PreCompact + incremental PostToolUse capture (Acontext, pro-workflow) is more robust.
- Pull-only recall depends on the model choosing to search (ReMe, memsearch, mnemosyne MCP); combine a tiny, budgeted push at SessionStart/UserPromptSubmit with pull for depth.
- Few reproducible benchmarks: only ReMe (LongMemEval 89.4%, BEAM) and memobase (LoCoMo 75.78%) publish concrete QA numbers; mnemosyne's are partially withdrawn/inconsistent; MemMachine/MIRIX have harnesses but no README numbers.
