# Group 3 — Agent-memory repo review (repos 21–30)

Method: each repo's README read; every repo shallow-cloned locally (all 10 clones succeeded) and 2–4 key source files read per repo. File paths below are relative to each repo root. Numbers are only those found in README/source; "not stated" means none was found.

---

## 1. plastic-labs/honcho (7.5k★, AGPL-3.0)

**Summary.** A server-side "reasoning-first" memory service: you store messages and background LLM workers derive atomic conclusions, summaries, peer cards and "dreams" about each peer. Python FastAPI + Postgres/pgvector + Redis. Managed cloud or self-hosted.

**Architecture.** Two halves (README "Architecture"): sync *Storage* (workspaces → peers → sessions → messages, `src/models.py`) and async *Insights* run by a queue-consuming `deriver` (`src/deriver/consumer.py`, `queue_manager.py`). Observations are vector-embedded "documents" in collections keyed by `(observer, observed)` peer pairs, which is how it models what peer X knows about peer Y. Pluggable vector stores: `src/vector_store/{lancedb,qdrant,chroma,turbopuffer}.py`.

**Capture.** `session.add_messages()` via SDK, or the per-agent plugins (separate repos: claude-honcho, codex-honcho, cursor-honcho, opencode-honcho) that wire hooks + MCP. `src/deriver/prompts.py::minimal_deriver_prompt` extracts "explicit atomic facts" with strong rules: one fact per conclusion, resolve relative dates against the message `time` attribute, no pronouns, nothing derived from other peers' messages, messages wrapped in `<message idx peer target time>` tags with tag-forgery escaping.

**Retrieval/Ranking.** `src/utils/search.py`: hybrid Postgres `ts_rank`/`to_tsvector` FTS + pgvector semantic, fused by `reciprocal_rank_fusion(k=60)`. `peer.chat()` (the "dialectic", `src/dialectic/`) runs an agentic tool loop with reasoning levels minimal…max, each with its own model and `MAX_TOOL_ITERATIONS`.

**Context injection & token cost.** `session.context(summary=True, tokens=N)`; `routers/sessions.py::_select_summary_for_context` gives 40% of the budget to the best-fitting summary (long vs short) and the rest to recent messages after the summary's coverage point. Summaries every 20 messages (short, ≤1000 tok) and 60 messages (long, ≤4000 tok) (`config.py SummarySettings`). `GET_CONTEXT_MAX_TOKENS` defaults to 100k.

**Compression/Consolidation.** "Dreams" (`src/dreamer/`): triggered after ≥50 new documents + 60 min idle, ≥8 h apart (`DreamSettings`). `DeductionSpecialist`, `InductionSpecialist`, `CardRefreshSpecialist` (`dreamer/specialists.py`) reason over observations; `dreamer/surprisal.py` picks *anomalous* observations using geometric surprisal over embedding trees (`dreamer/trees/{covertree,lsh,rptree}.py`) to focus deduction.

**Integrations.** Claude Code plugin, Codex, Cursor, OpenCode, OpenClaw, Hermes, DeepSeek Harness, remote MCP (`mcp.honcho.dev`); a shared `~/.honcho/config.json` so several agents can share one workspace.

**Dependencies.** Postgres+pgvector, Redis, LLM keys (defaults: Gemini for deriver/summary, Anthropic for dialectic/dream, OpenAI embeddings), Docker for local.

**Benchmarks claimed.** LongMemEval / LoCoMo "Pareto frontier" — numbers only on the external evals page/blog, not in the repo.

**Strengths to steal.** Atomic fact extraction prompt rules; summary/messages 40/60 budget split; idle- and threshold-triggered consolidation; surprisal-based sampling so consolidation spends LLM calls only on novel facts; observer/observed scoping.

**Weaknesses to beat.** Heavy (Postgres+Redis+worker+3 LLM providers); every message costs LLM derivation; eventual consistency ("may take a moment"); AGPL; agent plugins live in separate repos so hook logic isn't auditable here.

---

## 2. SuanmoSuanyangTechnology/MemoryBear (7.4k★, Apache-2.0)

**Summary.** Enterprise "cognitive" memory platform (FastAPI + Celery + Neo4j + Elasticsearch + Postgres + Redis + React UI) with extraction, graph storage, hybrid search, ACT-R-style forgetting and nightly reflection. Not aimed at coding CLIs.

**Architecture.** `api/app/core/memory/` split into `storage_services/{extraction_engine,forgetting_engine,reflection_engine,clustering_engine}` and `read_services/search_engine`. 7+ Celery queues (README table: memory_tasks ×100 threads, document, periodic, reflection, graphrag, …).

**Capture.** API/SDK ingestion; LLM extraction to triples + statements + temporal anchors (`extraction_engine/extraction_pipeline_orchestrator.py`). Entity dedup is two-layer: exact/alias matching (`deduplication/deduped_and_disamb.py::accurate_match`, `deduplicate_entities_and_edges`, guards against merging user vs assistant entities `_would_merge_cross_role`) then LLM dedup (`entity_dedup_llm.py`, `second_layer_dedup.py`).

**Retrieval/Ranking.** `read_services/search_engine/content_search.py::_rerank`: min-max-normalised ES keyword score + embedding score, `base = 0.6*emb + 0.4*kw`, plus agreement bonus `min(1-base, 0.1*kw*emb)`; per-node-type quotas; optional model rerank and an LLM "relation agent" for graph queries (`_run_relation_agent`).

**Context injection & token cost.** Not specified for agents; results returned via API. No token budgeting found.

**Compression/Consolidation.** `forgetting_engine/actr_calculator.py`: R = offset + (1−offset)·exp(−λ·t / Σ I·t_k^−d) (d=0.5, λ=0.3, offset=0.1) combining recency, frequency and importance. `forgetting_strategy.py` finds Statement+Entity pairs with activation < 0.3 and `merge_nodes_to_summary` replaces them with a `MemorySummary` node (LLM or concatenation) preserving provenance ids. Daily self-reflection engine checks conflicts and re-weights edges.

**Integrations.** Generic MCP market/tool layer (`services/mcp_market_service.py`); no Claude Code/Codex hooks.

**Dependencies.** Neo4j 5 + APOC, ES 8, Postgres, Redis, LLM + BERT-style embeddings, Python 3.12 only.

**Benchmarks claimed.** LoCoMo-style: vector version 72.90±0.19%, graph version 75.00±0.20% overall; "retrieval accuracy 92%, +35% over single-mode"; "<50 ms, 1000 QPS"; "redundancy <8%". No reproduction scripts seen.

**Strengths to steal.** ACT-R activation formula (recency × frequency × importance) as a decay score; *forget-by-merge* (low-activation facts collapse into a summary node with provenance instead of deletion); score fusion with agreement bonus; role-aware entity dedup.

**Weaknesses to beat.** Five servers to run; claims unaudited; in `_rerank` the per-type-quota list `res` is computed and then discarded (`results = results[:limit]` is returned instead) — quotas silently don't apply; Chinese-only comments in core; no agent-CLI integration.

---

## 3. Gentleman-Programming/engram (7.1k★, MIT)

**Summary.** Single Go binary, one SQLite file with FTS5, exposed as MCP stdio + CLI + HTTP + TUI. The agent curates what it saves; Engram stores and retrieves with progressive disclosure. The most "coding-agent native" repo in this group.

**Architecture.** `internal/store/store.go` (13.6k lines: schema, FTS, all ops), `internal/mcp/mcp.go` (23 tools), `internal/server/server.go` (HTTP :7437), `internal/setup/` (per-agent installers via go:embed), `plugin/{claude-code,codex,opencode,pi}`. Optional Git-sync chunks and Postgres cloud.

**Capture.** Explicit: `mem_save` (title, type, What/Why/Where/Learned content, `topic_key`, scope project/personal/global), `mem_session_summary` (Goal/Discoveries/Accomplished/Next/Files), `mem_save_prompt`, `mem_capture_passive`. Claude Code hooks (`plugin/claude-code/hooks/hooks.json`): SessionStart (startup/resume/clear/fork), SessionStart `compact` → `post-compaction.sh`, UserPromptSubmit, SubagentStop (async), PreToolUse guard on write tools, SessionEnd.

**Retrieval/Ranking.** FTS5 with `tokenize='trigram'` over title/content/tool_name/type/project/topic_key (store.go:1334). `buildSearchFTSQueryWithColumns`: `bm25(title 5.0, content 1.0, topic_key 3.0)` × (1 + 0.10 pinned + 0.06·recency with 30-day half-score + repetition boost from revision_count+duplicate_count). No embeddings (an `embedding BLOB` column is reserved only).

**Context injection & token cost.** `FormatContextWithOptions` renders "## Memory from Previous Sessions": 5 recent sessions (summary truncated to 200 chars), 10 recent prompts (200 chars), pinned, 20 recent observations (`MaxContextResults: 20`). Search returns previews `substr(content,1,300)`; docs claim ~100 tokens/result; 3-layer `mem_search → mem_timeline → mem_get_observation`. MCP *profiles* (agent vs admin) hide admin tools to shrink tool-schema tokens.

**Compression/Consolidation.** No LLM. Rolling-window exact dedupe on hash+project+scope+type+title increments `duplicate_count`; `topic_key` upserts increment `revision_count`; soft delete; `review_after`/`needs_review` lifecycle; conflict tools `mem_judge`/`mem_compare`.

**Integrations.** `engram setup` for Claude Code, OpenCode, Gemini CLI, Codex, Antigravity CLI, Cursor, Windsurf, VS Code Copilot, Kiro, Qwen, Kimi, Kilo, Pi, CommandCode.

**Dependencies.** None at runtime (pure Go, SQLite).

**Benchmarks claimed.** None.

**Strengths to steal.** Zero-dep binary; trigram FTS (substring + CJK-friendly); column-weighted BM25 × recency × reinforcement in one SQL expression; topic_key upsert to stop memory sprawl; post-compaction re-injection hook; preview-first retrieval; tool profiles.

**Weaknesses to beat.** No semantic recall (paraphrase misses); capture depends entirely on the agent remembering to call `mem_save`; SessionStart dump is recency-based, not relevance-based; trigram can't match terms <3 chars (`hasShortFTSTerm`); store.go monolith.

---

## 4. breferrari/obsidian-mind (4.9k★)

**Summary.** An Obsidian vault template + deterministic TypeScript hooks that make Claude Code (and Codex/Gemini via same scripts) maintain a linked markdown "brain". Notable for rigorous token budgeting of the eager layer and a cross-repo MCP server.

**Architecture.** Markdown folders (`brain/`, `work/`, `org/`, `perf/`, `thinking/`), `vault-manifest.json` config, hook scripts in `.claude/scripts/` (`session-start.ts`, `classify-message.ts`, `validate-write.ts`, `pre-compact.ts`, `stop-checklist.ts`), MCP servers `om-mcp.ts` and `qmd-mcp.mjs`. Retrieval via optional QMD (local embeddinggemma-300M + 1.7B query-expansion + Qwen3-Reranker-0.6B).

**Capture.** Agent writes notes guided by `CLAUDE.md`; `UserPromptSubmit` classifies each message (decision/incident/win/1:1/person…) with regex signals (`lib/signals.ts`) and injects ~100-token routing hints; `PostToolUse` validates frontmatter/wikilinks, blocks misplaced memory files, flags oversized notes; `PreCompact` backs up transcript; `om` MCP `remember`/`record_work` from other repos.

**Retrieval/Ranking.** QMD `search` (BM25, no model) / `vsearch` / `query` (hybrid + expansion + rerank); fallback grep. Writes are indexed synchronously, embeddings generated in background. `reason` tool spins a second Claude session over notes.

**Context injection & token cost.** SessionStart budget `eager_layer_budget_bytes: 9100` (under Claude Code's 10,000-char hook cap); `session-start.ts::applyInjectionBudget` drops sections by `priority` to pointer `fallback`s ("Over budget — run git log on demand"); North Star degrades full → focus → headlines → top-N → pointer; resume/compact re-inject only volatile sections; folders past a threshold collapse to a count; every injection ends with a size meter.

**Compression/Consolidation.** `lib/memory-similarity.ts`: deliberately lexical write-time near-duplicate guard (no embedding on hot path); `lib/memory-supersede.ts` marks superseded notes; `memory-recall.ts::isVisibleTo` enforces scope/projects/platforms facets; confidence `verified/inferred/unverified`.

**Integrations.** Claude Code (hooks + "mod" plugin delivering context as an instruction file that survives compaction and reaches subagents), Codex (`.codex/hooks.json`, AGENTS.md), Gemini (`.gemini/settings.json`, GEMINI.md).

**Dependencies.** Node 22+, Obsidian 1.12 CLI, optional QMD (~2.2 GB of local models).

**Benchmarks claimed.** None numeric; one anecdotal measurement: without a repo-side instruction a session made zero vault calls.

**Strengths to steal.** Byte-budgeted, priority-ordered injection with graceful degradation to pointers + visible meter; source-aware re-injection on compact; write-time lexical dedupe; scope declared at write time; observation that MCP *prohibitions* propagate while positive "go consult" instructions get skipped.

**Weaknesses to beat.** Personal-work-journal oriented, not code-fact memory; full experience needs Obsidian + 2 GB models; relies on the LLM to file notes correctly; markdown scale limits.

---

## 5. eugeniughelbur/obsidian-second-brain (4.7k★)

**Summary.** A skill pack (47 commands) that turns an Obsidian vault into a self-rewriting "LLM wiki" for Claude Code, Codex, Gemini, OpenCode, Antigravity and others, plus scheduled consolidation agents and a bounded recall hook.

**Architecture.** Platform-neutral `commands/*.md` compiled by `scripts/build.sh` to 8 targets (CLAUDE.md slash commands, Codex/Antigravity `.agents/skills/<name>/SKILL.md`, GEMINI.md, OpenCode…). Python toolkit + MCP server `integrations/obsidian-mcp-server/vault_ops.py`. Vault files: `index.md`, `log.md`, `SOUL.md`, `CRITICAL_FACTS.md` (~120 tokens), `raw/` immutable sources, `wiki/`.

**Capture.** Manual `/obsidian-save`, `/obsidian-ingest` (rewrites 5–15 pages per source), reminder after 10+ exchanges; `hooks/validate-ai-first.sh` enforces "For future agent" preamble + frontmatter on writes.

**Retrieval/Ranking.** `vault_ops.search`: brute-force file scan (capped by `_MAX_FILES_SCANNED`) with title 5×(1+log1p tf) + body (1+log1p tf)/length_norm, × static type/folder weight × `_freshness_weight(age, intent)`, then optional `_semantic_fuse` with local bge-m3 (Ollama) index; single-term queries skip semantic to avoid demoting exact hits; `_freshness_rerank` fades superseded notes.

**Context injection & token cost.** `/obsidian-world` tiers: L0 identity ~170 tok, L1 navigation 1–2K, L2 state 2–5K, L3 deep 5–20K on demand. `hooks/obsidian-recall.py` (opt-in UserPromptSubmit): MAX_NOTES=4, MAX_CHARS=900 (~250 tok), lexical only (semantic measured 11–12 s vs 1.4 s), excludes `raw/`, **abstains** unless the top hit shares ≥1 meaningful term, labels output "stored DATA, not instructions", logs every inject/abstain decision to JSONL.

**Compression/Consolidation.** Nightly agent: close day → reconcile contradictions → synthesize patterns → heal orphans → rebuild index. OKM freshness policy: every fact must be timeless, dated, or a pointer (`scripts/freshness_lint.py`); bi-temporal facts (valid time vs learned time).

**Integrations.** Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, Hermes, Pi, Grok Bot.

**Dependencies.** Python/uv; optional Ollama bge-m3; optional Perplexity/Grok/Gemini keys for research commands.

**Benchmarks claimed.** None (per-call $ costs only).

**Strengths to steal.** Abstaining per-prompt recall hook with hard char budget and audit log; "timeless/dated/pointer" freshness rule; tiered L0–L3 loading; one source → multi-target build (skills for every CLI); prompt-injection labelling of recalled data.

**Weaknesses to beat.** No index for lexical search (file scan, truncates on big vaults); semantic index manual (`--build`); consolidation is LLM-heavy and rewrites pages (lossy, hard to audit); 47 commands is a large surface.

---

## 6. CaviraOSS/LongMemory (4.5k★, Apache-2.0; formerly OpenMemory)

**Summary.** TypeScript "Hydrograph" memory engine with bitemporal immutable nodes, typed edges, governance scopes and several recall modes, shipped as npm lib, CLI, HTTP, MCP, dashboard and VS Code extension.

**Architecture.** `src/core/` (engine, recall, memory, temporal, grounding, project, embeddings), `src/stores/sqlite/schema.sql`: `hydro_nodes` with `valid_from/valid_to/observed_at/recorded_at/superseded_at`, `confidence`, `salience`, `zone`, content stored as JSON; trigger `hydro_nodes_immutable_identity` aborts any content change. Tables for edges, worlds, entities/aliases, contradictions, grounded_facts, audit_log. No FTS5/vector index in schema — scoring is in-process.

**Capture.** `ingest()` API/CLI/MCP (`src/mcp/tools/ingest.ts`, `remember_decision.ts`, `update_task_state.ts`); claim/facet extraction (`core/engine/claim_extractor.ts`); a *session porter* imports Claude Code/Codex/OpenCode/Gemini CLI/Copilot/Cline logs read-only.

**Retrieval/Ranking.** Modes strict / historical / associative / world_grounded (`core/recall/*`). `recall/fusion.ts`: RRF (k=60, depth 64) + MMR-style `select_diverse` (λ=0.75); activation spreading, Hopfield recall, contract & contradiction gates (`mode_gates.ts`, `contract_gate.ts`).

**Context injection & token cost.** `recall/context_builder.ts::build_context_packet` greedily packs evidence lines under a token budget (multilingual token counter, fallback chars/4); bundles same-conversation neighbours but drops the bundle first when over budget; benchmarks use a 2,048-token budget. `getProjectContext` merges decisions/tasks/failures/skills under one budget.

**Compression/Consolidation.** `core/memory/decay_engine.ts`: tiered exponential decay (hot λ 0.005, warm 0.02, cold 0.05) with floor; explicit reinforce; consolidation/reconsolidation that never rewrites content (supersede instead).

**Integrations.** Claude Code plugin, Codex/ChatGPT plugin, Gemini CLI extension, 13 MCP tools + resources + prompts; n8n, Cline, Continue, LangGraph etc.

**Dependencies.** Node; embeddings via OpenAI-compatible/Gemini/Bedrock/Ollama (official scorecards refuse to run without a real embedding model).

**Benchmarks claimed.** Honest: README forbids smoke scores as claims; small retrieval samples (33/32/18 questions, nemotron-embed, K=5, 2,048 tok) report recall 67–84% with feature on.

**Strengths to steal.** Immutability enforced by DB trigger + supersession; bitemporal columns; RRF + diversity selection; budget packer that degrades bundles before dropping items; fail-closed benchmarking discipline; session porter for importing other CLIs' history.

**Weaknesses to beat.** No on-disk FTS/ANN index (scales poorly); very large conceptual surface (worlds, zones, contracts); English-centric heuristics (admitted); no full-dataset benchmark yet.

---

## 7. FlowElement-xinliuyuansu/m_flow (4.5k★)

**Summary.** Python graph-RAG memory where vectors only find entry points and a four-level "cone graph" (Episode → Facet → FacetPoint → Entity) scores Episodes by their cheapest evidence path. Strong LoCoMo/LongMemEval claims.

**Architecture.** `m_flow/` (cognee-derived layout: adapters, pipeline, retrieval), DB adapters for LanceDB, Neo4j, Kùzu, pgvector, Chroma, Pinecone; `m_flow-mcp/src/server.py` (FastMCP); `coreference/` module.

**Capture.** `add()` + `memorize()` pipeline: LLM builds Episodes/Facets/FacetPoints/Entities with natural-language `edge_text`; coreference resolution before indexing; procedural-memory extraction; MCP `save_interaction`.

**Retrieval/Ranking.** `retrieval/episodic/bundle_scorer.py` + `config.py`: wide vector search (top 100 per collection) incl. edge texts, 1-hop expansion, path cost = anchor distance + edge distance + `hop_cost 0.05`; unmatched edge `edge_miss_cost 0.9`; Episode score = min path cost; direct Episode-summary hits get `direct_episode_penalty 0.3`; near-perfect Facet matches discount hop cost; `adaptive_scoring.py` weights collections by match strength/discrimination; exact-number/keyword bonuses (0.12/0.15); hybrid lexical when ≤3 core words.

**Context injection & token cost.** Returns top_k=10 Episodes as summaries or details (`max_facets_per_episode 4`, `max_points_per_facet 8`), or `highly_related_summary` (only relevant paragraphs). README admits summarization "at the cost of lower compression — context will be longer". Procedural injection gated: `gating/procedural_trigger.py` rule layer (zero cost) then optional LLM; `injection/procedural_injector.py` max 2 procedures.

**Compression/Consolidation.** Episode summaries are the compression; no decay/forgetting found.

**Integrations.** MCP server, OpenClaw skill; no Claude Code/Codex hooks.

**Dependencies.** LLM for ingestion (heavy), embedding model, a graph + vector DB.

**Benchmarks claimed.** LoCoMo-10 LLM-judge 81.8% (top-k 10, gpt-5-mini/gpt-4o-mini, cat-5 excluded) vs Cognee 79.4%, Zep 73.4%; LongMemEval 89% (temporal 93%, multi-session 82%) on a subset (60+40 questions shown); scripts in external `mflow-benchmarks` repo.

**Strengths to steal.** Granularity-aligned anchors + min-path scoring ("one strong chain is enough"); penalising broad summary hits; searchable edge descriptions; ingest-time coreference; zero-cost rule gate before any LLM-gated injection.

**Weaknesses to beat.** Expensive LLM ingestion per item; many tunable magic constants; large context per hit; LongMemEval on a subset; no coding-agent lifecycle integration.

---

## 8. basicmachines-co/basic-memory (4.1k★, AGPL-3.0)

**Summary.** Markdown files as the source of truth, indexed into SQLite (FTS5 + sqlite-vec) or Postgres, exposed via MCP; humans and agents co-edit. Mature, well-engineered search stack.

**Architecture.** `src/basic_memory/` — markdown parser, sync/watch, `repository/` (SQLite: `sqlite_search_repository.py` + `sqlite_vec_index.py`; Postgres: `postgres_search_repository.py`, `pgvector_index.py`, Milvus), `mcp/tools/` (write_note, edit_note, read_note, search, build_context, recent_activity, schema_*…), `plugins/claude-code`, `skills/`, `integrations/{hermes,openclaw}`.

**Capture.** Agent calls `write_note`/`edit_note`; file grammar: entity per file, observations `- [category] text #tag (context)`, relations `- relation_type [[Target]]`. Claude Code plugin hooks: SessionStart briefing, PreCompact checkpoint (`plugins/claude-code/hooks/hooks.json`, fail-open launchers calling `basic-memory hook session-start`); opt-in capture output style.

**Retrieval/Ranking.** `repository/search_reader.py::hybrid` runs FTS (relaxed AND for question-form queries) and vector legs; `fuse()` = `max(vec, fts) + FUSION_BONUS·min(vec, fts)` on normalised scores with an FTS gate threshold, keyed on (type,id); FastEmbed embeddings; optional cross-encoder rerank (`jinaai/jina-reranker-v1-tiny-en` or LiteLLM/Cohere) that fails fast rather than silently. Search traces explain candidate rejection.

**Context injection & token cost.** `build_context` traverses `memory://` URLs with depth/timeframe; results include matched chunk text. No fixed budget found in hook launcher (logic in package). MCP tool annotations (readOnly/destructive/idempotent) support progressive discovery and Codex auto-approval of read tools.

**Compression/Consolidation.** None automatic; schema infer/validate/diff tools; temporal index (`memory_time_index_repository.py`).

**Integrations.** Claude Desktop/Code, Codex, Cursor, VS Code, ChatGPT (search/fetch), Obsidian, Hermes, OpenClaw, shared SKILL.md.

**Dependencies.** Python/uv, FastMCP 4 pre-release, optional FastEmbed models; cloud product optional.

**Benchmarks claimed.** None.

**Strengths to steal.** Plain-markdown truth + rebuildable SQLite index; observation/relation micro-grammar (cheap to parse, graph for free); sqlite-vec + FTS5 in one file; score fusion with agreement bonus; search trace for debugging; tool annotations.

**Weaknesses to beat.** No automatic capture/consolidation — relies on agent writing notes; FastMCP pre-release pin friction; AGPL + upsell; whole-note reads can be token-heavy.

---

## 9. OSU-NLP-Group/HippoRAG (4.0k★)

**Summary.** Research framework (NeurIPS'24, ICML'25) for "non-parametric continual learning": OpenIE triples build a KG over passages and Personalized PageRank does multi-hop retrieval. Now ships an MCP server and Claude Code plugin.

**Architecture.** `src/hipporag/HippoRAG.py` (igraph graph of entity, fact and passage nodes), `embedding_store.py` (parquet vectors; Chroma/Qdrant/Milvus optional), `information_extraction/` (OpenIE), `rerank.py` (DSPy-optimised LLM fact filter), `mcp_server.py`. `index_manifest.json` binds stored vectors to the exact embedding/LLM identity and rejects mismatches.

**Capture.** `index(docs)` → LLM OpenIE per passage → triples → `add_fact_edges`, `add_passage_edges`, `add_synonymy_edges` (embedding kNN, top 2047, sim ≥0.8). MCP tools `retrieve`, `rag_qa`, `index`, `delete`, `index_stats`.

**Retrieval/Ranking.** `retrieve()`: query-to-fact embedding match (`linking_top_k` 5) → `DSPyFilter` LLM recognition-memory filter → seed entity nodes + dense passage scores × `passage_node_weight 0.05` → `run_ppr(damping 0.5)` → top passages (`qa_top_k` 5).

**Context injection & token cost.** Returns top-k raw passages; no budgeter.

**Compression/Consolidation.** None (graph grows; delete by text/source_id).

**Integrations.** MCP (stdio/HTTP, unauthenticated HTTP — loopback only), Claude Code plugin marketplace with skill + `/hipporag:index-folder`.

**Dependencies.** LLM for OpenIE (indexing) and fact filter (query time), embedding model (NV-Embed-v2/OpenAI/etc.), optional vLLM/GPU.

**Benchmarks claimed.** Papers: better than RAPTOR/GraphRAG/LightRAG on MuSiQue, 2Wiki, HotpotQA, NQ, PopQA, NarrativeQA (figure only in README; no agent-memory benchmark).

**Strengths to steal.** PPR from query-linked entities for multi-hop associativity; synonymy edges from embedding kNN; index-identity manifest preventing silent mixing of embedding models; fact-level (triple) matching as the entry point.

**Weaknesses to beat.** Document-QA oriented, not conversational/agent memory; LLM call at query time; no temporal/update semantics; parquet + igraph rebuilds; no decay.

---

## 10. aiming-lab/SimpleMem (3.8k★)

**Summary.** Research memory stack centred on "semantically lossless compression": LLM turns dialogue windows into atomic, coreference-resolved, absolute-timestamped memory units, then intent-planned multi-view retrieval. Adds a cross-session module for coding agents and EvolveMem retrieval-tuning.

**Architecture.** `simplemem/core/` (`memory_builder.py`, `hybrid_retriever.py`, `answer_generator.py`, LanceDB `database/vector_store.py`); `cross/` (SQLite sessions + LanceDB, `context_injector.py`, `consolidation.py`, `hooks.py`, `api_mcp.py`); `MCP/` server (cloud + Docker); `OmniSimpleMem/`, `EvolveMem/`.

**Capture.** Sliding windows `WINDOW_SIZE=40`, `OVERLAP_SIZE=2` turns → LLM "semantic density gating" emits memory units with three views (dense 1024-d embedding, BM25-style lexical, symbolic metadata: time/entities/persons); online synthesis merges same-session fragments at write time. `cross/hooks.py` defines framework-agnostic SessionStart/UserMessage/… hook classes (not shipped Claude Code hook configs).

**Retrieval/Ranking.** `hybrid_retriever.py`: LLM `_analyze_query` → per-view queries (`SEMANTIC_TOP_K 25`, `KEYWORD_TOP_K 5`, `STRUCTURED_TOP_K 5`) in parallel → ID dedup → LLM adequacy check and up to `MAX_REFLECTION_ROUNDS=2` follow-up searches.

**Context injection & token cost.** `cross/context_injector.py`: greedy packing in tiers (recent session summaries → observations → semantic matches for the prompt) within `max_tokens=2000`, rendered for system prompt at 1500. Paper claim: ~30× fewer inference tokens than full context.

**Compression/Consolidation.** `cross/consolidation.py`: importance decay ×0.9 per period, merge entries with cosine ≥0.95, prune below importance threshold (soft delete).

**Integrations.** MCP (Claude Desktop, Cursor, LM Studio, Cherry Studio), SKILL package, Python SDK.

**Dependencies.** OpenAI-compatible LLM mandatory for both building and retrieval; Qwen3-Embedding-0.6B; LanceDB.

**Benchmarks claimed.** LoCoMo: +26.4% avg F1 over prior systems, 43.24% F1 with ~30× fewer tokens; Omni F1 0.613; EvolveMem +25.7% relative on LoCoMo; cross-session LoCoMo score 48 vs claude-mem 29.3 ("+64%").

**Strengths to steal.** Write-time normalisation (coref + absolute time) so stored units are self-contained; multi-view index incl. symbolic time/person filters; tiered greedy budget packer; offline tuning of retrieval knobs on a dev set (EvolveMem idea).

**Weaknesses to beat.** Multiple LLM calls per *query* (plan + reflection) — latency and cost; LLM call per 40-turn window at write; cross-session hooks are library classes, not wired into CLIs; benchmark comparison vs claude-mem methodology unclear.

---

## Top 15 ideas from this group (ranked by impact on token savings × memory quality)

1. **Byte/token-budgeted injection with priority-ordered degradation to pointers + visible meter** (obsidian-mind `session-start.ts::applyInjectionBudget`, LongMemory `build_context_packet`, SimpleMem `ContextInjector`). Hard cap the eager layer (e.g. ≤2K tokens), drop lowest-priority sections to one-line "fetch on demand" pointers, never silently truncate.
2. **Abstaining per-prompt recall**: inject ≤4 items / ~250 tokens only when the top hit clears a confidence gate, otherwise nothing; log every inject/abstain (obsidian-second-brain `hooks/obsidian-recall.py`). Biggest steady-state token saver vs dumping memory every session.
3. **Progressive disclosure tools**: search returns 300-char previews + IDs, then timeline, then full record (engram `buildSearchPreviewFTSQuery`, `mem_timeline`, `mem_get_observation`).
4. **Write-time normalisation of facts**: atomic, self-contained, coreference-resolved, absolute dates (Honcho `minimal_deriver_prompt`, SimpleMem memory units, m_flow coreference). Makes each stored unit short and retrievable without surrounding context.
5. **Topic-key upsert + exact-hash dedupe with reinforcement counters** (engram `topic_key`, `duplicate_count`, `revision_count`) plus a lexical near-duplicate guard at write time (obsidian-mind `memory-similarity.ts`). Stops memory sprawl with zero LLM cost.
6. **Single-file SQLite with FTS5 (trigram) + sqlite-vec, column-weighted BM25 × recency × reinforcement in SQL** (engram composite rank: title 5, topic 3, content 1; 30-day recency; basic-memory sqlite-vec). Zero-server baseline.
7. **Hybrid fusion that rewards agreement**: `max(a,b)+bonus·min(a,b)` (basic-memory `fuse`) or `α·emb+(1−α)·kw + 0.1·kw·emb` (MemoryBear), or RRF k=60 + MMR diversity (Honcho, LongMemory). Skip the semantic leg for single-term queries (obsidian-second-brain).
8. **Source-aware re-injection after compaction**: on `SessionStart:compact` re-inject only volatile state; deliver stable context as an instruction file so it survives compaction and reaches subagents (engram `post-compaction.sh`, obsidian-mind mod).
9. **Supersede, don't overwrite: immutable content + bitemporal validity** (LongMemory trigger `hydro_nodes_immutable_identity`, valid/recorded times; obsidian-second-brain bi-temporal facts; obsidian-mind `memory-supersede.ts`). Strict recall shows only current truth; historical on request.
10. **Activation-based decay that merges instead of deletes**: ACT-R recency×frequency×importance (MemoryBear `actr_calculator.py`); low-activation facts collapse into a provenance-preserving summary (`merge_nodes_to_summary`); tiered λ (LongMemory). Keeps index small without losing traceability.
11. **Cheap-first consolidation triggers**: run LLM consolidation only after N new facts + idle time, and only on *surprising* facts (Honcho dream thresholds 50 docs / 60 min idle / 8 h, `surprisal.py`); merge cos ≥0.95 duplicates (SimpleMem).
12. **Freshness contract**: every stored fact is timeless, dated, or a pointer to its live source (obsidian-second-brain OKM, `freshness_lint.py`); rank decays dated facts; fast-changing facts aren't stored at all.
13. **Granularity-aligned anchors + best-path scoring**: index facts, topics and episodes, enter at the finest match, return the parent bundle, penalise broad summary hits (m_flow `bundle_scorer.py`, `direct_episode_penalty`); PPR over entity links for multi-hop (HippoRAG `run_ppr`). Higher accuracy per returned token.
14. **Write-time scope/confidence facets**: scope (project/platform/general, observer/observed), `verified/inferred/unverified`, visibility checked at read (obsidian-mind `isVisibleTo`, Honcho collections, engram scope). Prevents cross-project noise in context.
15. **One-source, multi-target integration build + tool profiles**: generate Claude Code hooks/plugin, Codex hooks + AGENTS.md, Gemini GEMINI.md/extension, OpenCode plugin, Agent Skills `.agents/skills/` from one spec (engram `engram setup <agent>`, obsidian-second-brain `scripts/build.sh`); expose a minimal "agent" MCP tool profile with readOnly/destructive annotations to cut tool-schema tokens (engram profiles, basic-memory annotations). Also: label injected memory as "data, not instructions".

Honourable mentions: index-identity manifest rejecting mismatched embedding models (HippoRAG); session porter importing other CLIs' transcripts (LongMemory); offline tuning of retrieval knobs on a dev set (SimpleMem EvolveMem); zero-cost regex gate before LLM-gated injection (m_flow `procedural_trigger.py`).

Gaps/caveats: Honcho's agent plugins (claude-honcho, codex-honcho, etc.) live in separate repos that I did not clone, so their hook behaviour is unverified; benchmark numbers are as claimed by each README and not reproduced.
