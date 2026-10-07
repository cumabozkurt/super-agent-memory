# Group 1 — Deep review of 10 agent-memory repos

Scope: each repo's README plus source read in local shallow clones (cloned 2026-10-07). **claude-mem** could not be cloned (HTTP 502 on blob fetch, twice), so its files were read one by one from `raw.githubusercontent.com/thedotmack/claude-mem/main/...`. **hindsight** was cloned without large blobs. All numbers below come from the repos' own READMEs or docs. None of them were reproduced here.

---

## 1. thedotmack/claude-mem (≈97K★)

**Summary.** A Claude Code plugin (it now also installs into about 15 other harnesses) that records every tool call. A side LLM (the "observer") turns those calls into typed XML "observations". The plugin injects a compact timeline at SessionStart and offers progressive-disclosure search through MCP.

**Architecture.** A local Bun "worker" HTTP service. SQLite with FTS5 (`src/services/sqlite/SessionStore.ts`, `SessionSearch.ts`, `infrastructure/FtsMaintenance.ts`) is the system of record. Chroma, spawned through `uv`, is optional, though `CLAUDE_MEM_CHROMA_ENABLED='true'` by default (`ChromaSync.ts`). There is a web viewer, and an optional hosted "CMEM Pro" observer and cloud sync.

**Capture.** `plugin/hooks/hooks.json` wires Setup, SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop and SessionEnd. Each PostToolUse payload goes to the observer model (default `claude-haiku-4-5`, `SettingsDefaultsManager.ts`). Each tool field is truncated head-and-tail (`truncateObservationField`, `src/sdk/prompts.ts`). The observer must return `<observation><type|title|subtitle|facts|narrative|concepts|files_read|files_modified>` or `<skip_summary reason="noise"/>`. `<private>` tags are stripped.

**Retrieval/Ranking.** `SearchOrchestrator` sends filter-only queries to SQLite. Text queries go to Chroma, with a fallback to FTS5. `HybridSearchStrategy.findByFile` takes the metadata hits and re-orders them by Chroma rank (`intersectWithRanking`). There is no score fusion. SessionStart ranking can optionally use ACT-R base-level activation: `score = ln(1 + age^-0.5 + α·Σ age_reinf^-0.5)` (`src/services/reinforcement/rank.ts`). The newest quarter is always kept (`recencyHeadSize`). This is off by default (`CLAUDE_MEM_REINFORCE_ALPHA='0'`).

**Context injection & token cost.** SessionStart renders the last 50 observation *titles* and 10 session summaries, plus the last summary. `fitContextToBudget` (`ContextBudget.ts`) measures the rendered string against Claude Code's 10,000-character hook-stdout limit. When it is over, it drops whole items in a fixed order: full narratives, then the last summary, then the last message, then halves sessions, then halves observations. Tokens are estimated at 4 characters each (`TokenCalculator.ts`). Each observation records `discovery_tokens` (the cost of producing it), so the UI can show "savings %". MCP search runs in three layers: `search` returns an index at about 50–100 tokens per hit, then `timeline`, then `get_observations` at about 500–1,000 tokens per hit. The README claims this saves "~10x". A PreToolUse "File Read Gate" (`src/cli/handlers/file-context.ts`) injects past observations for a file the agent is about to Read. It denies whole-file Reads of files ≥32 KB in favour of tree-sitter `smart_outline`. Their own eval found that denial costs tokens on smaller files: +20% on Opus for a 19 KB file, and −32 to −35% for a 49 KB file.

**Compression/Consolidation.** Compression is LLM-based: raw tool I/O becomes an observation. Dedup is deterministic (`src/services/dedup/nearDuplicate.ts`). Tier-0 auto-merges exact normalised titles. Tier-1 marks a pair as a merge *candidate* (never merged automatically) when IDF-weighted cosine passes a threshold, the pair shares at least 2 tokens, and a rare-token veto does not fire. The authors report simhash failed on their 7,651-observation DB.

**Integrations.** Claude Code plugin, Codex plugin (`.codex-plugin`), Cursor, Windsurf, Antigravity CLI, Kimi, OpenCode plugin (`src/integrations/opencode-plugin`), Pi, OMP, T3 Code, Grok Bot (log-file watcher), OpenClaw, DeepSeek Harness. Each has an installer under `src/services/integrations/*Installer.ts`.

**Dependencies.** Node ≥20, Bun, uv/Python for Chroma, and an LLM call for every tool use (Claude by default; Gemini and OpenRouter providers exist).

**Benchmarks claimed.** None on LongMemEval or LoCoMo. Only the "~10x" progressive-disclosure claim and per-session savings % in the UI.

**Strengths to steal.** Measured, item-granular budget fitting against the real hook limit. The 3-layer index → timeline → details pattern. Typed observations with `files_read`/`files_modified`, which enable a file-keyed lookup. Injecting memory on PreToolUse for the file being touched. A per-observation `discovery_tokens` ledger. Reinforcement-date lists without embeddings. Dedup that marks candidates instead of merging silently.

**Weaknesses to beat.** One LLM call per tool event (cost, latency, and Haiku quota). A heavy runtime stack (Node + Bun + uv + Chroma + worker daemon). The hybrid is re-ordering, not fusion. The default SessionStart dump of 50 titles is query-agnostic. The codebase is sprawling and commercial upsells (Pro, trial) leak into installation.

---

## 2. mem0ai/mem0 (≈67K★)

**Summary.** A general memory-layer SDK, self-hosted server, and cloud. The "v3" algorithm (April 2026) does single-pass, ADD-only LLM fact extraction with entity linking and additive hybrid scoring. Coding-agent plugins sit on top of the hosted platform.

**Architecture.** `mem0/memory/main.py` (3.9K lines) contains `Memory` and `AsyncMemory`. A pluggable vector store (28 adapters in `mem0/vector_stores`, Qdrant by default) holds memories. A second collection stores entities (`entity_store`, `_upsert_entity`). A SQLite history DB holds messages and history.

**Capture.** `add()` runs `_add_to_vector_store` in phases. Phase 0 loads the last 10 messages for the session scope. Phase 1 fetches the top-10 existing memories by embedding. Phase 2 makes one LLM call (`ADDITIVE_EXTRACTION_PROMPT`, `mem0/configs/prompts.py:468`, JSON mode), with existing memories remapped to integer ids to prevent hallucinated ids. Phase 3 batch-embeds. Phase 5 runs MD5-hash dedup against the batch and the retrieved set. Phase 6 persists. Phase 7 links entities, which are extracted with spaCy when `mem0ai[nlp]` is installed. `infer=False` stores raw messages.

**Retrieval/Ranking.** `mem0/utils/scoring.py: score_and_rank`. A semantic score gates candidates first (`threshold`). The final score is then `(semantic + sigmoid-normalised BM25 + 0.5·entity_boost) / max_possible`. The BM25 sigmoid midpoint and steepness adapt to query length (`get_bm25_params`). BM25 runs on lemmatised text (`lemmatize_for_bm25`). An optional reranker is available (Cohere, HF, sentence-transformer, LLM, ZeroEntropy). Temporal reasoning (`reference_date`, `timestamp`) is **platform-only**; the OSS raises `get_temporal_feature_error_message`.

**Context injection & token cost.** The library leaves injection to the caller. The Claude Code plugin (`integrations/claude-code-plugin`) runs one automatic search on the first prompt (≥20 characters), injects up to 5 memories, and returns 3 per explicit `search_memories` call.

**Compression/Consolidation.** v3 dropped UPDATE/DELETE: "memories accumulate; nothing is overwritten". The only dedup is exact hash. Contradictions are left for retrieval and temporal ranking to sort out.

**Integrations.** `integrations/` contains Claude Code, Codex, Cursor, OpenCode, Antigravity, Kimi, DeepSeek, Pi, Hermes, OpenClaw, Vercel AI SDK, n8n, Zapier and Strands. The Claude plugin hooks SessionStart, UserPromptSubmit, Post/PostFailure, SubagentStart/Stop, Stop, PreCompact and SessionEnd. It runs a Python MCP server. Capture is local and needs no LLM. A detached worker flushes every 5 exchanges, on idle (5 min), and on PreCompact/SessionEnd, sending to the **Mem0 Platform API** (an `m0-` key is required). Memory is split into shared project memory (`agent_id`, per repo) and personal memory (`user_id`).

**Dependencies.** An LLM (default `gpt-5-mini`) and embeddings (`text-embedding-3-small`) for every add. Optionally spaCy `en_core_web_sm`. A vector DB.

**Benchmarks claimed.** LoCoMo 92.5, LongMemEval 94.4, BEAM-1M 64.1, BEAM-10M 48.6, at about 7K tokens per query and p50 around 1s. These are **managed-platform** scores; the README says OSS users should expect lower.

**Strengths to steal.** Integer-id remapping in extraction prompts. ADD-only extraction (simple, no destructive LLM updates). Query-length-adaptive BM25 normalisation. An entity side-index as a cheap boost. Batching capture into 5-exchange flushes with no LLM in the hook. A clean shared-project vs personal namespace split.

**Weaknesses to beat.** Headline numbers are not reproducible with the OSS. ADD-only means unbounded growth with no consolidation. The semantic threshold gates BM25 hits, so exact-keyword matches with low cosine are lost. Coding plugins depend on the cloud. Every write costs an LLM call plus embeddings.

---

## 3. MemPalace/mempalace (≈59K★)

**Summary.** Local-first verbatim memory: it never summarises; raw text is chunked into "drawers" and indexed by "wing" (person/project) and "room" (topic). It has hybrid vector+BM25 search, a temporal KG in SQLite, and a 4-layer wake-up stack.

**Architecture.** Python. The backend contract is `mempalace/backends/base.py`. Backends: Chroma (default), `sqlite_exact` (exact NumPy), `rust_exact` (native scan of the same SQLite file, `crates/`), Milvus, Qdrant, pgvector. Embeddings are local ONNX: `all-MiniLM-L6-v2` (~30 MB) or `embeddinggemma-300m` (multilingual). The temporal entity graph uses validity windows (`knowledge_graph.py`). There is an optional "closets" summary layer in the AAAK dialect (`dialect.py`, a lossy symbolic format that points back to drawers).

**Capture.** Batch mining (`mempalace mine <dir>`, `--mode convos` for `~/.claude/projects` JSONL) and `sweep` (one drawer per message, idempotent). Hooks (`hooks/mempal_save_hook.sh`): a Claude Code/Codex **Stop hook blocks the agent every N human messages**, telling it to file diary and palace entries itself. A PreCompact hook and Cursor hooks also exist. So classification is done by the main agent, not by a side LLM.

**Retrieval/Ranking.** `mempalace/searcher/`. The vector drawer query always runs. Okapi BM25 is computed *over the candidate set* (`ranking.py:_bm25_scores`, k1=1.5, b=0.75, Lucene-smoothed IDF) and blended 0.6 vector / 0.4 BM25 (`_resolve_hybrid_rank_weights`). Closet hits add a rank boost "never a gate" (`query.py:_closet_boosts`). There are neighbour expansion (`_expand_with_neighbors`), cross-source copy folding, and date windows. The README also mentions temporal-proximity and preference-pattern boosts in "hybrid v4".

**Context injection & token cost.** `layers.py`: L0 identity at about 100 tokens (`~/.mempalace/identity.txt`), L1 "essential story" at about 500–800 tokens (top drawers by `importance`, then recency), L2 wing/room recall on demand at about 200–500 tokens, L3 deep search. Wake-up is documented as about 600–900 tokens. Agents are discovered at runtime (`mempalace_list_agents`) so their definitions stay out of the system prompt.

**Compression/Consolidation.** None by design: verbatim storage plus `dedup.py`. AAAK closets are optional and lossy.

**Integrations.** An MCP server with 45 tools (`mcp_server/tools_*.py`); skills via `npx skills add`; hooks for Claude Code, Codex and Cursor; guides for Gemini CLI and Antigravity; Docker; a team hub/proxy.

**Dependencies.** Python 3.9+, chromadb/onnxruntime, about 80–300 MB of model. No LLM or API key for the core path.

**Benchmarks claimed.** LongMemEval R@5 is 96.6% in raw mode and 98.4% held-out for hybrid v4. LLM rerank reaches ≥99%. LoCoMo R@10 is 60.3% raw and 88.9% for hybrid v5. ConvoMem is 92.9%; MemBench R@5 is 80.3%. These are **retrieval recall, not QA accuracy**. `docs/HISTORY.md` records retractions: a "+34% palace boost", a "100% with Haiku" headline, and competitor numbers with no source.

**Strengths to steal.** Verbatim store plus metadata scoping is a strong no-LLM baseline. Candidate-set BM25 re-rank is cheap and backend-agnostic. A layered wake-up budget. A pluggable backend contract that includes an exact SQLite and a Rust scan. Unusually honest benchmark hygiene (held-out split, committed result files).

**Weaknesses to beat.** Chroma by default (heavy, HNSW drift issues; see `_hnsw_capacity_diverged`). A Stop hook that *blocks* the agent to make it save burns main-model tokens and turns. 45 MCP tools is a large tool-schema tax. Its own docs warn Claude transcripts expire after 30 days without the hooks. Verbatim chunks are token-expensive at injection time.

---

## 4. vectorize-io/hindsight (≈46K★)

**Summary.** A server-based "learning" memory: retain (LLM fact, entity and time extraction), recall (4-way parallel retrieval, then RRF, then cross-encoder rerank, then a token budget), reflect, plus background consolidation into evidence-backed "observations" and query-defined "mental models".

**Architecture.** `hindsight-api-slim/hindsight_api/engine/`. PostgreSQL with pgvector, BM25 via `pg_search`/tsvector (`migrations.py`), and an embedded Postgres "pg0" for local mode. Local embeddings default to `BAAI/bge-small-en-v1.5` and the reranker to `cross-encoder/ms-marco-MiniLM-L-6-v2` (`config.py:1222,1285`). Memory types: world facts, experiences, observations, mental models. Memory lives in isolated "banks".

**Capture.** `retain/` (fact_extraction, entity_processing, link_creation, causal_links). Claude Code plugin (`hindsight-integrations/claude-code/hooks/hooks.json`): SessionStart; UserPromptSubmit → `recall.py`; async Stop → `retain.py`; SessionEnd. `scripts/lib/content.py` **strips previously injected `<hindsight_memories>` blocks before retaining**, to stop memories feeding back into themselves. An optional "Memory Defense" policy applies 45 secret/PII patterns.

**Retrieval/Ranking.** `search/retrieval.py` runs semantic, BM25, graph (entity/temporal/causal) and temporal-range retrieval in parallel. `search/fusion.py: reciprocal_rank_fusion(k=60)` merges them. `search/reranking.py` then uses the cross-encoder score × `recency_boost` × `temporal_boost` × `proof_count_boost`, each `1 + α(x − 0.5)` (α = 0.2, 0.2, 0.1). This bounds the combined boost to about ±20%. Recency decay is linear over 365 days by default, or exponential with a 90-day half-life.

**Context injection & token cost.** `fact_budget.py: select_facts_within_budget` greedily packs ranked facts up to `max_tokens` using a real tokenizer (`token_encoding.py`). The Claude hook defaults are `recallMaxTokens=1024`, `recallBudget="mid"`, and injection is wrapped in `<hindsight_memories>`. Mental models are pre-computed answers, so reading one costs a DB read with no retrieval or LLM call.

**Compression/Consolidation.** `consolidation/consolidator.py` is a background job after retain. It creates or updates observations with `proof_count`, `source_memory_ids` and a JSONB `history`, refining rather than overwriting. Mental models are re-written in the background.

**Integrations.** About 60. Coding agents via `npx @vectorize-io/hindsight-coding-agents install all`: Claude Code, Codex, Cursor CLI, Copilot CLI, opencode, Kilo, Cline, Antigravity CLI, and more. A per-bank MCP endpoint `/mcp/{bank_id}/`. An LLM wrapper (`wrap_openai`, LiteLLM).

**Dependencies.** Postgres (or pg0), an LLM for retain, consolidation and reflect (25+ providers including Ollama), local embedding and cross-encoder models.

**Benchmarks claimed.** Docs blog (`hindsight-docs/blog/2026-03-23-agent-memory-benchmark.mdx`): LoCoMo 92.0%, LongMemEval 94.6%, LifeBench 71.5%, PersonaMem 86.6%. The README says results were independently reproduced by Virginia Tech and The Washington Post. Paper arXiv:2512.12818.

**Strengths to steal.** The full fusion pipeline: parallel retrievers, RRF, a *bounded* multiplicative cross-encoder boost. A greedy token-budget packer with a real tokenizer. Proof counts and evidence lists on consolidated beliefs. Stripping injected-memory tags before retain. Mental models as zero-cost pre-computed briefs.

**Weaknesses to beat.** It is a heavy service: Postgres, an LLM on every retain, a background worker. Recall in the UserPromptSubmit hook can be slow (the hook timeout is 45 s). Consolidation quality depends on the LLM. The bank-level model fits chat assistants better than file- or symbol-grounded coding memory.

---

## 5. DeusData/codebase-memory-mcp (≈46K★)

**Summary.** A pure-C, single-binary code-intelligence MCP server. It builds a tree-sitter (158–162 grammar) plus "Hybrid LSP" knowledge graph of symbols and edges in SQLite. It is code-structure memory, not conversational memory.

**Architecture.** `src/` holds `pipeline`, `graph_buffer`, `store` (SQLite), `cypher` (an openCypher read subset), `semantic` (`ast_profile.c`, `rotsq.c`), `simhash`, `watcher`, `daemon` and `ui`. Indexing is RAM-first: LZ4, in-memory SQLite, one dump at the end. Persistence is at `~/.cache/codebase-memory-mcp/`. A per-account coordination daemon is shared across agents. An optional team artifact `.codebase-memory/graph.db.zst` (indexes stripped, `VACUUM INTO`, zstd) lets teammates skip reindexing.

**Capture.** Captures code, not conversations: `index_repository`, an auto-index on session start, and a git-based background watcher for incremental reindex. `manage_adr` persists Architecture Decision Records. That is its only "decision memory".

**Retrieval/Ranking.** FTS5 BM25 with a `cbm_camel_split` tokenizer (camelCase/snake_case aware). Structural search (regex, labels, degree). Cypher. Semantic search uses bundled `nomic-embed-code` int8 768-d embeddings compiled into the binary, with "11-signal combined scoring" (TF-IDF, RRI, signatures, AST profiles, data flow, MinHash, module proximity, graph diffusion). `SIMILAR_TO` uses MinHash+LSH.

**Context injection & token cost.** Hooks are "fail-open and context-only". Claude Code PreToolUse on Grep/Glob/Bash injects matching graph symbols as `additionalContext`. PostToolUse on Read adds coverage notes for files that did not parse fully. It never denies a call. Model-facing responses use a **compact tree format instead of JSON** by default (`src/mcp/mcp.c: mcp_result_from_json → cbm_json_to_tree`, `compact_out.c`); `format:"json"` is opt-in. Results have explicit `limit`, `truncated`, `next_cursor` and truncation reasons. The README claims 5 structural queries used ~3,400 tokens vs ~412,000 by grep/read (99.2%). Subagent tool *profiles* (Scout: 7 tools, Analysis: 11) shrink the tool-schema surface.

**Compression/Consolidation.** Not applicable. Incremental reindex only.

**Integrations.** The README claims 45 client surfaces: Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Copilot, Qwen, Kiro, Junie and more. The installer writes MCP config, skills, hooks and instructions.

**Dependencies.** None at runtime (static binary). No LLM, no API key.

**Benchmarks claimed.** arXiv:2603.27277: 31 repositories, 83% answer quality, 10× fewer tokens, 2.1× fewer tool calls. Linux kernel indexed in 3 minutes. Cypher queries under 1 ms.

**Strengths to steal.** Compact non-JSON output for the model. Paginated, truncation-explicit results. Tool-profile allowlists per subagent. An embedding model compiled into the binary (zero setup). A camelCase-aware FTS5 tokenizer. Hook injection on Grep/Glob that adds facts without blocking. A git-committable compressed snapshot for teams.

**Weaknesses to beat.** It does not remember decisions, preferences or session history (beyond ADRs). The coordination-daemon version-lock rules are complex. The token claim is one 5-query anecdote. A large C surface (tens of thousands of lines in `mcp/` alone).

---

## 6. volcengine/OpenViking (≈39K★)

**Summary.** A "context database" exposing knowledge, memory and skills as a virtual filesystem (`viking://`). Every node has L0 abstract, L1 overview and L2 full tiers. Sessions are committed into Markdown memory files by an LLM extract loop. AGPLv3.

**Architecture.** A Python server (`openviking/`) plus a Rust CLI (`crates/ov_cli`). VikingDB vector storage (dense+sparse) via `storage/vikingdb_manager.py`. Directory `.abstract.md`/`.overview.md` files are generated by a VLM. Memory categories: profile, preferences, entities, events, experiences, cases, trajectories (`session/memory/constants.py`).

**Capture.** Claude Code plugin (`examples/claude-code-memory-plugin/hooks/hooks.json`): SessionStart, UserPromptSubmit → `auto-recall.mjs`, PostToolUse, PreToolUse (`uri-guard`), Stop → `auto-capture.mjs`, PreCompact, SessionEnd, SubagentStart/Stop. Session commit runs `session/compressor_v3.py`: one ExtractLoop with a patch-merge commit and no directory locks. `session/tool_output_externalizer.py` moves oversized tool outputs into a `tool-results/` store and leaves a deterministic preview (`ref`, `sha256`, `original_chars`).

**Retrieval/Ranking.** `retrieve/hierarchical_retriever.py` (now documented in code as "Global vector retrieval with optional reranking"; the directory-recursive search the README describes is done through TrieHI scope resolution before vector ranking). Rerank candidates are 2× the limit. Event time-decay is applied in the vector engine. `retrieve/memory_lifecycle.py: hotness_score = sigmoid(log1p(access_count)) × exp-decay (7-day half-life)` drives hot/warm/cold classification.

**Context injection & token cost.** `retrieve/context_assembler/` is a server-side kernel. Defaults are `max_tokens=1600` and `limit=10` (`params.py`). Per-category quotas (events 10, entities 10, preferences 3, experiences 0) and a per-category default tier (events → overview; entities, preferences, experiences → abstract) apply. `exclude_uris` (up to 200) and `dedup_turns` avoid re-sending what is already in context. The plugin uses `recallTokenBudget=2000`, `recallMaxContentChars=500`, `recallPreferAbstract=true`. When over budget it **degrades to URI-only hints** (`auto-recall.test.mjs`).

**Compression/Consolidation.** LLM patch-merge into existing memory files (`session/memory/merge_op`, `memory_updater.py`), experience lineage, and a streaming policy "trainer" for case memories.

**Integrations.** Claude Code, Codex, Cursor, TRAE (hooks + MCP); OpenCode plugin; Pi; OpenClaw; Hermes; an Agent Plugins 1.0 package (`agent-plugins/`, stdio→HTTP MCP proxy plus skills).

**Dependencies.** A server, a VLM and an embedding model (Volcengine, OpenAI, Ollama, ...). The LLM is required for summaries and extraction.

**Benchmarks claimed.** LoCoMo 80–83% across three agent integrations (vs 24–57% native), input tokens −34.3 to −91.0%, latency −58 to −66%. tau2-bench +6.87pp retail and +11.87pp airline.

**Strengths to steal.** L0/L1/L2 tiers chosen *per category* under a hard token budget. Fall back to URI pointers when over budget. `exclude_uris`/dedup-turns so the same memory is never re-injected. Externalising tool output with sha256 refs. Memories as human-editable Markdown files. Hotness = frequency × recency.

**Weaknesses to beat.** A heavy server plus VLM for every directory summary. AGPL. README and code have drifted (the "hierarchical" retriever is now global vector). Memories are processed in the background, so they do not appear right away. A complex multi-tenant surface for a single developer.

---

## 7. getzep/graphiti (≈31K★)

**Summary.** An OSS temporal (bi-temporal) knowledge-graph framework behind Zep: episodes become entities and fact-edges with validity windows, with hybrid search over a graph DB. It is a library and MCP server, not an agent plugin.

**Architecture.** `graphiti_core/` with drivers for Neo4j 5.26, FalkorDB, Neptune (+OpenSearch) and Kuzu (deprecated). Nodes: Entity, Episodic, Community. Edges: EntityEdge with `valid_at`, `invalid_at`, `expired_at`. Custom Pydantic ontologies.

**Capture.** `add_episode`: an LLM extracts nodes and edges (`utils/maintenance/combined_extraction.py`, prompts in `prompts/`). Entity dedup uses deterministic helpers first (`dedup_helpers.py`: exact normalisation, a Shannon-entropy gate for short names, then MinHash with 32 permutations and band 4, Jaccard ≥0.9), and the LLM only for unresolved entities. Edge contradiction handling in `edge_operations.py` sets `invalid_at`/`expired_at` on superseded facts instead of deleting them. Concurrency is capped by `SEMAPHORE_LIMIT=10` to avoid LLM 429s.

**Retrieval/Ranking.** `search/search.py` with recipes in `search_config_recipes.py`. Candidate sources: cosine, BM25 full-text, BFS. Rerankers (`search_config.py`): `rrf`, `mmr`, `node_distance` (graph distance from a centre node), `episode_mentions`, and `cross_encoder` (OpenAI, BGE, or Gemini log-prob reranker). Implemented in `search_utils.py: rrf, node_distance_reranker, episode_mentions_reranker, maximal_marginal_relevance`.

**Context injection & token cost.** None built in; the caller formats facts. MCP tools (`mcp_server/src/graphiti_mcp_server.py`): `add_memory`, `search_nodes`, `search_memory_facts`, `get_episodes`, `delete_*`, `summarize_saga`, `build_communities`. Facts are short triplet sentences, which keeps them naturally compact.

**Compression/Consolidation.** Entity summaries evolve. Community detection with summaries. Temporal invalidation instead of overwrite. Sagas.

**Integrations.** MCP server (Docker + Neo4j/FalkorDB) for Claude Desktop, Cursor and others. No Claude Code hooks in this repo.

**Dependencies.** A graph DB server, an LLM with structured output (OpenAI by default; Anthropic, Gemini, Groq), embeddings. The README warns small models cause schema failures.

**Benchmarks claimed.** None in the README. It cites the Zep paper (arXiv:2501.13956) for methodology.

**Strengths to steal.** Bi-temporal edges (valid vs recorded time) with invalidation rather than deletion. Deterministic-first entity resolution (entropy gate plus MinHash) that calls the LLM only on leftovers. Rich reranker menu (node-distance and episode-mention counts are cheap structural signals). Provenance from every fact to its episode.

**Weaknesses to beat.** Several LLM calls per episode (extract, dedup, contradictions), so ingestion is slow and costly. Needs Neo4j or FalkorDB. Kuzu, the embedded option, is deprecated. No agent-side capture or token budgeting.

---

## 8. topoteretes/cognee (≈31K★)

**Summary.** A graph+vector memory platform with remember, recall, improve and forget. Its pipelines turn text and code into knowledge graphs. It can now run without an LLM using GLiNER extraction and local embeddings. Session lessons can be distilled into permanent memory.

**Architecture.** `cognee/infrastructure/databases`. Graph default is `ladybug` (`graph/config.py:47`); others are Kuzu, Neo4j, Neptune, Turso and a Postgres demo. Vector default is LanceDB (`vector/config.py:32`), with pgvector and Turso also available. Relational store via SQLAlchemy/Alembic. Session cache/manager in `infrastructure/session/`.

**Capture.** `remember` (with or without a `session_id`). "Cognify" pipelines chunk, extract entities and relations, and summarise. `memify_pipelines/` covers `consolidate_entities`, `consolidate_entity_descriptions`, `cross_connect_entities`, `apply_feedback_weights`, `persist_sessions_in_knowledge_graph` and `global_context_index`. `session/feedback_detection.py` detects user feedback inside sessions.

**Retrieval/Ranking.** About 30 retrievers in `modules/retrieval/` (chunks, summaries, graph completion, CoT, decomposition, temporal, cypher, natural language, triplet, BM25, Jaccard, coding rules, skills, agentic). `hybrid_retriever.py` with `hybrid/ranking.py`: RRF over vector rank and summary rank, multiplied by `_importance_factor`, `truth_factor` ("truth subspace" alignment) and `personal_factor` (user preference weights). `merge.py` keeps a separate budget per channel (chunks, entities, facts).

**Context injection & token cost.** The library returns context or completions. The Claude Code and Codex plugins live in a separate repo (`topoteretes/cognee-integrations`, not reviewed). The MCP server (`cognee-mcp/src/server.py`) exposes `remember`, `recall`, `forget`, `improve` and `cognify_status`. No documented injection budget in this repo.

**Compression/Consolidation.** Strong: entity and description consolidation, triplet embeddings, feedback-weighted edges (`DEFAULT_FEEDBACK_ALPHA`), session-to-graph persistence.

**Integrations.** Claude Code plugin, Codex plugin (hooks), OpenClaw, MCP for Cursor and Cline, Python/TS/Rust SDKs, REST, and COGX import from Mem0, Letta, Zep and Graphiti.

**Dependencies.** Python 3.10–3.14, `cognee[gliner]` for keyless mode, OpenAI by default when a key is set. Docker for the UI and MCP.

**Benchmarks claimed.** BEAM 100K: 0.79 (20 questions, one held-out conversation). BEAM 10M: 0.67 ("exploratory", routing tuned on the same set). Both are reported with heavy caveats.

**Strengths to steal.** Keyless extraction with a small NER model (GLiNER) as the default path. Feedback-weighted retrieval (thumbs signal → edge weights). Per-channel budgets in hybrid merge. An interchange format (COGX) for importing other systems.

**Weaknesses to beat.** Very large surface (30 retrievers, many backends) and confusing for agent use. "Postgres as graph" is a demo and production is licensed. The benchmarks are tiny. Coding-agent integration lives outside the core repo. Heavy Python dependency tree (`dlt` is now a core dependency).

---

## 9. supermemoryai/supermemory (≈31K★)

**Summary.** A hosted memory+RAG API whose core engine is **not in this repo**. The repo contains the web app, docs, MCP server (`apps/mcp`), SDK tool wrappers (`packages/tools`) and framework adapters. It adds a user-profile abstraction (static vs dynamic facts) and automatic forgetting.

**Architecture.** The engine is closed. A local server, "Supermemory local", ships as a binary (`localhost:6767`, an embedded "graph engine", local `Xenova/bge-base-en-v1.5` embeddings, data in `./.supermemory`). Memories are scoped by `containerTag`.

**Capture.** Plugins (separate repos). `claude-supermemory/plugin/hooks/hooks.json` (fetched raw): SessionStart loads project memories; UserPromptSubmit → `recall-directive.js` (5 s); PreToolUse auto-approves read-only Supermemory MCP tools; async Stop → `capture.js`. Extraction, contradiction resolution and expiry ("exam tomorrow" expires after the date) happen server-side.

**Retrieval/Ranking.** Server-side and undisclosed. Client code (`packages/tools/src/shared/memory-client.ts`) calls `profile()` and `search(searchMode:"memories", threshold 0.6)` in parallel, and de-duplicates search hits already shown in the profile (`memory-client.test.ts`). `cache.ts` keeps an LRU per-turn cache keyed by namespace, thread, mode and normalised message, so tool-call loops within one turn do not re-query.

**Context injection & token cost.** `profile.static` + `profile.dynamic` + search results go into the system prompt, with modes `profile | query | full`. The claude-supermemory README describes **"reasoned recall"**: the UserPromptSubmit hook injects a directive and Claude decides whether to search at all ("every turn, once in a while, or not at all"), so no memory tokens are spent on turns that do not need them.

**Compression/Consolidation.** Server-side fact extraction, updates (e.g. "moved to SF" supersedes "NYC") and TTL forgetting. Not inspectable.

**Integrations.** Claude Code, Cursor, Codex, OpenCode, OpenClaw, Hermes, Muse plugins; hosted MCP (`https://mcp.supermemory.ai/mcp`) with `memory`, `recall`, `context` tools; Vercel AI SDK, Mastra, LangChain and others.

**Dependencies.** Cloud API key, or the local binary plus any LLM (Ollama possible).

**Benchmarks claimed.** "#1" on LongMemEval, LoCoMo and ConvoMem. LongMemEval: 95% Recall@15 with ~720 tokens of context (a "99.4% context reduction"). By category: knowledge updates 99%, temporal 91%, preference 90%. SMFS uses 3.0× fewer tokens on Claude over 110 xAFS questions. MemoryBench is an open harness.

**Strengths to steal.** The static/dynamic profile split as a tiny always-on block. Model-gated "reasoned recall" instead of blind per-prompt injection. Profile/search dedup. A per-turn retrieval cache. Expiry dates on time-bound facts. Auto-approval for read-only memory tools.

**Weaknesses to beat.** The core is closed, so the claims cannot be checked from source. Cloud-first. Each plugin lives in its own repo with its own drift. Profile quality is opaque.

---

## 10. rohitg00/agentmemory (≈29K★)

**Summary.** A TypeScript memory engine and MCP server built on the "iii" engine. Capture is hook-based. It runs triple-stream BM25+vector+graph retrieval with weighted RRF, has 4-tier consolidation with Ebbinghaus-style decay, and is keyless by default.

**Architecture.** `src/functions/*` are registered iii functions (`mem::search`, `mem::context`, ...). State is a KV store (file by default, or Redis) in `src/state/kv.ts`. In-process BM25 (`search-index.ts`, `stemmer.ts`, `synonyms.ts`, CJK segmenter) and vector index (`vector-index.ts`, bucketed persistence plus a pending-log replay so a crash does not force re-embedding). There is a viewer on :3113.

**Capture.** Hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PreCompact, SubagentStart/Stop, Stop, SessionEnd. Pipeline: SHA-256 dedup within a 5-minute window, a privacy filter, raw store, then **synthetic compression** by default (`compress-synthetic.ts`: rule-based type inference from tool names, no LLM), with LLM compression opt-in (`AGENTMEMORY_AUTO_COMPRESS`). Stop/SessionEnd produce a summary, plus optional graph extraction and slot reflection.

**Retrieval/Ranking.** `state/hybrid-search.ts`: RRF with k=60, weighted (BM25 0.4, vector 0.6, plus graph) and normalised by the best attainable score. A +5% agreement bonus per extra stream that matched. **At most 3 results per session** (`diversifyBySession`). Retention (`functions/retention.ts`): `min(1, salience·e^(−0.01·days) + reinforcementBoost(accesses))`, with hot/warm/cold tiers and auto-forget/evict.

**Context injection & token cost.** `mem::context` assembles pinned slots, project profile, lessons and search results under `TOKEN_BUDGET=2000`. **Hook-level injection is OFF by default since 0.8.10** (`src/config.ts: isContextInjectionEnabled`). The reason given: it was adding about 4,000 characters to every tool turn. Recall is model-pulled through MCP instead. Tool surface tiers: `AGENTMEMORY_TOOLS=core` exposes 8 tools vs 54. The README claims ~1,900 tokens vs 22K+ for CLAUDE.md at 240 observations, and ~170K tokens/year.

**Compression/Consolidation.** Working → episodic → semantic → procedural tiers. Supersession and versioning. Contradiction detection. Near-duplicate `similarTo` hints. TTL. A bidirectional "Claude bridge" to MEMORY.md. Git snapshots.

**Integrations.** Claude Code, Codex plugin, Copilot CLI, Cursor, Gemini CLI, OpenCode (`plugin/opencode`), Hermes, OpenClaw, pi, a skills pack, a standalone MCP shim (7 local tools when no server is running).

**Dependencies.** Node and the iii engine binary (pinned v0.22.1; a manual step on Windows). Optional local `all-MiniLM-L6-v2` (+8pp recall over BM25 alone, per the README). LLM optional.

**Benchmarks claimed.** LongMemEval-S R@5 95.2%, R@10 98.6%, MRR 88.2% (BM25-only: 86.2/94.6/71.5). An in-house 15-session corpus at R@5 1.0, where grep scores 0.967.

**Strengths to steal.** Keyless-by-default with rule-based compression. Weighted RRF with an agreement bonus and per-session diversity cap. Turning auto-injection off after measuring the token burn. Core/full tool tiers. Crash-safe vector index persistence. Lessons as a separate fast index.

**Weaknesses to beat.** Exotic runtime dependency (iii engine). Feature sprawl (54 tools, leases, mesh, routines). The README is 127 KB. The comparison tables mix metrics across systems (R@5 vs LoCoMo QA). The KV store has no SQL or FTS, so scaling relies on in-memory indexes.

---

## Top 15 ideas from this group
Ranked by expected impact on **token savings × memory quality** for a cross-CLI "super agent memory".

1. **Measured budget fitting that drops whole items, with tiered fallback down to pointers.** Render, measure against the real limit (Claude's 10,000-character hook stdout), then drop whole items cheapest-loss-first (claude-mem `fitContextToBudget`). If still over budget, degrade entries from full to overview to abstract to URI-only (OpenViking `context_assembler`, `auto-recall` URI hints). This guarantees a hard cap and never sends truncated garbage.
2. **Progressive disclosure as the main recall API.** `search` returns an id+title index (~50–100 tokens per hit), then `timeline`, then `get(ids)` for full details (claude-mem 3-layer MCP; OpenViking L0/L1/L2). Default to the index; the agent pays for details only on what it picks.
3. **Model-gated ("reasoned") recall instead of injecting on every prompt.** Inject only a one-line directive or tiny profile, and let the model decide whether to call search (supermemory `recall-directive.js`). agentmemory measured about 4,000 characters per turn from always-on injection and turned it off by default. Biggest single saving on turns that need no memory.
4. **Never re-inject what is already in context.** Track injected ids per session (`exclude_uris`, `dedup_turns` in OpenViking; profile/search dedup and per-turn LRU cache in supermemory) and strip injected-memory blocks before capture so memories do not feed back into storage (hindsight `content.py`).
5. **Fusion via weighted RRF (k=60), then a *bounded* multiplicative rerank.** BM25, vector and graph/entity ranked in parallel. RRF normalised by the attainable max, with a small agreement bonus (agentmemory). Then cross-encoder × (1 ± α/2) recency, temporal and proof boosts capped at about ±20% (hindsight `reranking.py`). Robust, tunable, and does not let decay swamp relevance.
6. **Keyless-first pipeline: FTS5/BM25 + small local embeddings, with the LLM optional.** MemPalace reports 96.6% R@5 raw with no LLM; agentmemory reports 86.2% BM25-only and 95.2% with MiniLM; codebase-memory compiles its embedding model into the binary. Make capture and recall work with zero API calls and use an LLM only for optional consolidation.
7. **Typed, file-anchored observations plus memory injection at PreToolUse for the touched file or symbol.** Store `files_read`/`files_modified` and `type` (decision/bugfix/...). When the agent Reads, Edits or Greps a path, inject the 3–15 relevant past notes as `additionalContext` (claude-mem File Read Gate in context-only mode; codebase-memory Grep/Glob hook). It is retrieval with a perfect query (the path) at near-zero cost. Do not *deny* reads below about 32 KB; their own eval shows it costs tokens.
8. **Per-category quotas and per-category detail tiers.** For example, preferences ≤3 entries at abstract level, events ≤10 at overview level, all under one max_tokens (OpenViking `DEFAULT_QUOTAS`/`DEFAULT_TIER_BY_CATEGORY`; cognee per-channel budgets). This prevents one noisy category from eating the budget.
9. **A tiny always-on core: identity, then a static/dynamic profile, then everything else on demand.** About 100 tokens for L0 identity, plus a few hundred for stable facts and current work (MemPalace L0/L1 ~600–900 tokens; supermemory `profile.static/dynamic`; hindsight mental models read with no LLM). Precompute it at session end, not at session start.
10. **Deterministic-first dedup and entity resolution; the LLM only adjudicates candidates.** Exact normalised-title merge; IDF-cosine plus rare-token veto produces *candidates* (claude-mem `nearDuplicate.ts`); entropy gate plus MinHash/LSH Jaccard ≥0.9 for entity names (graphiti `dedup_helpers.py`); hash dedup in a 5-minute window (agentmemory) and in batch (mem0).
11. **Bi-temporal facts with supersession, not deletion.** `valid_at`/`invalid_at`/`expired_at` on facts (graphiti); supersession chains removed from the search index but kept in history (agentmemory "recall hygiene"); TTL for time-bound facts (supermemory). This fixes knowledge-update questions without growing what gets injected.
12. **Embedding-free strength signals: an ACT-R or hotness score from access and confirmation dates.** `ln(1 + age^-0.5 + α·Σ reinf^-0.5)` with a protected recency head (claude-mem `rank.ts`); `sigmoid(log1p(access)) × exp-decay` (OpenViking); salience × e^(−λt) + reinforcement (agentmemory). Use it for query-less SessionStart selection and eviction.
13. **Batched, LLM-free capture in hooks with async flushes.** Hooks only append to a local spool. A detached worker extracts every N exchanges, on idle, on PreCompact and on SessionEnd (mem0 plugin, hindsight async Stop). Avoid claude-mem's one LLM call per tool and MemPalace's Stop hook that blocks the main agent.
14. **Compact, paginated, truncation-explicit tool output, plus a small tool surface.** Indented tree or TSV instead of JSON for model-facing results (codebase-memory `cbm_json_to_tree`); `truncated` + `next_cursor`; a "core" profile of about 8 tools vs 54 (agentmemory), per-subagent allowlists (codebase-memory Scout/Analysis). This cuts schema and result tokens on every turn.
15. **Consolidated beliefs with evidence and proof counts, plus externalised large tool outputs.** Background consolidation into observations that keep `source_memory_ids`, `proof_count` and history (hindsight). Large tool outputs stored by sha256 ref with a deterministic preview (OpenViking `tool_output_externalizer.py`). Higher-quality, deduplicated recall units, and raw evidence is still one `get` away.

### Notes / gaps
- claude-mem: no local clone (502). Source was read file by file from raw GitHub; a few files (SessionStore, SQLiteSearchStrategy) were not inspected.
- supermemory: the core engine is not open source in this repo. Ranking and extraction claims cannot be verified from code.
- cognee: the coding-agent plugins live in `topoteretes/cognee-integrations` (not reviewed).
- hindsight: the README benchmark figure is an image; the numbers above come from the docs blog in the repo.
- No benchmark was re-run. All figures are self-reported unless the text says otherwise.
