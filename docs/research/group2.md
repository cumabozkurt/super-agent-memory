# Group 2: Agent-memory repo review (repos 11–20)

Reviewed 2026-10-07. Every repo was shallow-cloned locally (HEAD dates run from 2026-07-14 for memvid to 2026-10-07 for context-mode). READMEs were read in full. Paths below are relative to each repo root. All numbers are quoted from the repo's README or code; none are our own. Benchmark claims are **self-reported and unverified**.

Note: `letta-ai/letta` is now a stub README. Its V1 server moved to the `archive` branch, and active code lives in `letta-ai/letta-code`, which I cloned and reviewed instead.

---

## 11. TencentCloud/TencentDB-Agent-Memory (27.7k★, MIT)

**Summary.** A team-oriented "memory hub": an L0→L3 layered chat memory plus Skills, Wiki, and CodeGraph assets, served through an OpenAI/Anthropic-compatible **proxy** so agents need no plugin. It is heavy (Node 22 + core/hub/proxy services + LLM keys), with strong context-budget engineering.

**Architecture.** It ships three services: `MemoryCore` (TS), `MemoryKnowledge` (Wiki/CodeGraph), and `MemoryProxy`. Storage is pluggable (`MemoryCore/src/core/store/`): `sqlite/memory-store.ts` uses `node:sqlite` + `sqlite-vec` (`l1_vec`, `l0_vec` vec0 tables) + FTS5, with a TCVDB (Tencent cloud vector DB, native dense+sparse hybrid) backend and an experimental MongoDB backend. The layers are L0 raw conversation, L1 atoms (facts, preferences, constraints), L2 scenario blocks (`core/scene/*`), and L3 persona (`core/persona/persona-generator.ts`).

**Capture.** `core/hooks/auto-capture.ts` writes L0. An async pipeline extracts L1 with an LLM (`record/l1-extractor.ts`) every `everyNConversations` (default 5, with a 1→2→4 warm-up). Separately, `src/offload/hooks/after-tool-call.ts` buffers tool-call/result pairs for the "offload" compressor.

**Retrieval/Ranking.** `performAutoRecall` (`core/hooks/auto-recall.ts`) supports keyword (FTS5 BM25), embedding, or **hybrid with RRF k=60**. Defaults: `maxResults` 5, `minScore` 0.3, recall timeout 5 s (it fails open with a structured error).

**Context injection & token cost.** This is the key design point. Recall is split into `prependContext` (per-turn L1 hits, prepended to the user message) and `appendSystemContext` (persona, scene navigation, tools guide, all stable and **cache-friendly**). Budgets are `maxCharsPerMemory` and `maxTotalRecallChars` (default 0 = off), with a truncation suffix that points to the search tools. A `<memory-tools-guide>` caps agent-initiated searches at **3 per turn**.

**Compression/Consolidation.** `record/l1-dedup.ts` recalls top-5 candidates per new memory (hybrid), then makes **one batched LLM call** to decide store/update/merge/skip. The offload subsystem keeps a tiktoken-counted context and compresses in tiers: mild at 0.5, aggressive at 0.85, emergency at 0.95 → target 0.6 of window (`offload/types.ts PLUGIN_DEFAULTS`). It also maintains a **Mermaid task-graph** (`offload/pipelines/l2-mermaid.ts`) that replaces old tool output.

**Integrations.** Proxy base-URL swap for Claude Code, Codex, CodeBuddy, WorkBuddy, Hermes, OpenClaw, and DeepSeek Harness, plus OpenClaw/Hermes/pi plugins.

**Dependencies.** Two LLM configs (memory + proxy), an embedding provider, Docker, and Node ≥22.16.

**Benchmarks claimed.** PersonaMem 48% → 76% (README). No LoCoMo/LongMemEval figures.

**Strengths to steal.** Stable-vs-dynamic injection split for prompt caching. Per-memory and total char caps with a "use tool X for more" suffix. Batched LLM dedup over hybrid candidates. A hard per-turn tool-call cap in the guide. Ratio-based staged compaction.

**Weaknesses to beat.** The proxy MITMs all LLM traffic (trust, latency, needs two LLM keys). Heavy deployment. Char caps are off by default. L2 scene navigation is "full injection, LLM decides relevance". Much of the prompt text is Chinese-only.

---

## 12. gastownhall/beads (27.7k★, MIT)

**Summary.** "bd" is a Dolt-backed, dependency-aware **issue graph** used as agent working memory, plus a small key-value `bd remember` store injected by `bd prime`. It is memory as *task state*, not recall.

**Architecture.** A Go CLI (`cmd/bd/*`, `memoryops/`) on **Dolt** (version-controlled SQL with cell-level merge). It runs embedded by default (`.beads/embeddeddolt/`) or against a `dolt sql-server`. Hash IDs (`bd-a1b2`, hierarchical `bd-a3f8.1.1`) avoid merge collisions, and graph edges include blocks/parent-child/relates-to/duplicates/supersedes/replies-to. Sync uses `bd dolt push/pull` over git remote refs.

**Capture.** It is explicit only. Agents run `bd create/update --claim/close` and `bd remember "insight"`. The key is derived from the content (`internal/memoryapi.DeriveKey`) and stored verbatim under the `kv.memory.` prefix. Nothing is captured passively.

**Retrieval/Ranking.** `bd ready` returns unblocked work (graph query). `bd memories <kw>` is a **case-insensitive substring match** on key or value (`memoryops/memories.go` ListRequest.Search). There is no BM25, embeddings, or ranking.

**Context injection & token cost.** `bd setup claude|codex|gemini|cursor` installs **SessionStart + PreCompact** hooks that run `bd prime` (`cmd/bd/prime.go`). Prime prints workflow rules, a git/close protocol tailored to remote/ephemeral/stealth state, and **all memories alphabetically**. Caps `prime.max-memories` and `prime.max-memory-chars` default to **uncapped**. In compact/MCP mode each memory is truncated to 150 chars, and an elision banner tells the agent how to fetch the rest. `isMCPActive()` switches to a shorter MCP variant.

**Compression/Consolidation.** `bd compact` (`cmd/bd/compact.go`) does "semantic memory decay" of closed issues. Tier 1 applies after 30 days closed and claims 70% reduction. **`--apply --summary` accepts an agent-written summary, so no API key is needed.** Tier 2 (90 days) is not implemented.

**Integrations.** Claude Code, Codex (skill + AGENTS.md + hooks), Gemini, Cursor, Factory, Mux, and Copilot. There is also a `beads-mcp` Python MCP server and a Claude plugin under `plugins/beads`. `bd init` writes an AGENTS.md section.

**Dependencies.** A single Go binary with embedded Dolt. No LLM or embeddings.

**Benchmarks claimed.** None for memory quality. `BENCHMARKS.md` covers CLI performance.

**Strengths to steal.** **Agent-supplied summaries for compaction (zero API cost).** PreCompact re-priming. The elision banner ("showing N of M; browse with …"). Atomic claim semantics for multi-agent handoff. Mergeable, versioned storage. Ready-work queries as a token-cheap "what next".

**Weaknesses to beat.** Memories are unranked and unscoped: the whole set is injected alphabetically because "the memory store keeps no timestamps". There is no relevance, recency, dedup, or semantic search. Uncapped by default. Dolt is a heavy dependency for a KV store.

---

## 13. mksglu/context-mode (25.5k★, ELv2 source-available)

**Summary.** An MCP server + hook suite that keeps raw tool output **out** of context (sandboxed execution, FTS5 index-then-search) and rebuilds session state after compaction. It is the most token-focused repo in this group.

**Architecture.** TS/Node (`src/`), using `bun:sqlite`, `node:sqlite`, or `better-sqlite3`. `src/store.ts` holds a per-project content DB with **two FTS5 tables**: `chunks` (tokenize `porter unicode61`) and `chunks_trigram` (trigram). `src/session/db.ts` holds per-session event DBs, under `~/.context-mode/` or the adapter's directory. Markdown is chunked by heading with code blocks kept intact.

**Capture.** Hooks: PreToolUse (routing enforcement and denial markers), PostToolUse, UserPromptSubmit, Stop, PreCompact, and SessionStart (`hooks/*.mjs`). `src/session/extract.ts` (~3k LOC, regex/heuristic, no LLM) classifies events into P1–P4 categories: files, tasks, plans, rules, decisions ("use X instead"), git, errors, error→fix pairs, constraints, blockers, rejected approaches, env, subagent findings, and retry loops. Secrets in `mcp__*` args are redacted.

**Retrieval/Ranking.** Porter BM25 and trigram BM25 are fused with **RRF k=60** (`#rrfSearch`). Title/heading columns are weighted 5× (`bm25(chunks, 5.0, 1.0)`). Further passes: a proximity rerank (min-span), Levenshtein typo correction, and smart snippets (windows around matches rather than head truncation). `ctx_fetch_and_index` uses a TTL cache (24 h). **Progressive throttling:** calls 1–3 return 2 results/query, calls 4–8 return 1 plus a warning, and from call 9 searches are blocked and redirected to `ctx_batch_execute`.

**Context injection & token cost.** Tool outputs over 5 KB with an `intent` are auto-indexed, and only matching sections plus a "vocabulary" of searchable terms are returned. On compaction, `buildResumeSnapshot` (`src/session/snapshot.ts`) emits a **reference-based** XML snapshot. Each category gets a short summary plus a *runnable* `ctx_search(queries:[…])` call for details (max 10 files; recent prompts capped at 400 chars). The README says "≤2 KB priority-tiered", but the current code comment says "no priority dropping, no byte budget". **That is a doc/code drift.**

**Compression/Consolidation.** None semantic. Session data is deleted unless `--continue`. Content DBs older than 14 days are purged.

**Integrations.** The widest hook coverage seen: Claude Code (plugin marketplace), Gemini CLI, Codex, OpenCode/KiloCode (plugin via `experimental.chat.system.transform` and `experimental.session.compacting`), Cursor, Copilot (VS Code/JetBrains/CLI), Kiro, Pi/OMP, OpenClaw, Antigravity CLI (bounded), and Antigravity/Zed (instruction file only). Claimed compliance is ~98% with hooks vs ~60% with instruction files only.

**Dependencies.** Node ≥22.5 or Bun. No LLM or embeddings.

**Benchmarks claimed.** "315 KB → 5.4 KB" per session. Per-scenario examples: Playwright snapshot 56.2 KB → 299 B, 20 GitHub issues 58.9 KB → 1.1 KB, repo research 986 KB → 62 KB. No LongMemEval/LoCoMo.

**Strengths to steal.** Index-then-search for large outputs. Porter+trigram RRF. Weighted title BM25. Proximity rerank. **Reference-based resume snapshot with prebuilt queries.** Throttling. A per-agent hook capability matrix. Heuristic event taxonomy. A statusline that shows tokens saved.

**Weaknesses to beat.** It is session-scoped, not long-term memory: there are no cross-session facts, decay, or consolidation. No semantic/vector search. ELv2 license. Doc/code inconsistency on the snapshot budget. Re-injecting routing guidance every 10 calls costs ~250 tokens each time.

---

## 14. letta-ai/letta → letta-code (25.1k★, Apache-2.0)

**Summary.** MemGPT's successor. The V1 server (core memory blocks + archival/recall memory) is archived. Letta Code is now a full agent harness whose memory is a **git-backed markdown "MemFS"** that agents rewrite through background reflection ("sleeptime"/dreaming).

**Architecture.** TS/Bun (`letta-code/src/agent/memory-*.ts`). MemFS v2 (`memory-constraints.ts`, `subagents/builtin/reflection-v2.md`) has three parts:
- A required root `MEMORY.md` index.
- **Core memory**: root `.md` files with `name`/`description` frontmatter, always in context.
- **Deferred memory**: child dirs, each with its own `MEMORY.md`. Only names and descriptions are visible, and contents are fetched on demand.

Skills live under `skills/`. Everything is committed to git (`memory-git.ts`, pre-commit validation hooks), syncs to a custom remote, and is stored in Letta Cloud by default.

**Capture.** Background **reflection subagent** (Bash + Edit only). It reads the transcript (bounded reads: full only if ≤15 KB), then edits memory files or creates skills and commits. Triggers (`reflection-settings.ts`) are `off | step-count | compaction-event`. Multi-transcript "replay" slices are used for dedup and contradiction resolution ("prefer latest evidence").

**Retrieval/Ranking.** Core is always loaded. Deferred memory is chosen by the agent from name/description (progressive disclosure). Message search via `/search` plus a `recall` subagent. No documented hybrid ranking in the reviewed files.

**Context injection & token cost.** It enforces hard caps (`DEFAULT_MEMORY_CONSTRAINTS_CONFIG`): `maxDepth` 2, `maxFileCharacters` 20,000, and **`maxCoreMemoryCharacters` 65,536** for all root markdown. `readOnlyFiles` globs exist. Core memory is fully injected each turn, which is cacheable but potentially ~16k tokens.

**Compression/Consolidation.** The LLM reflection subagent merges, moves files between tiers (root ↔ child = in-context ↔ deferred), and prunes. `/sleeptime` schedules periodic dreaming. Automatic dreaming is off on native Windows.

**Integrations.** Its own CLI, desktop, web, and Slack/Telegram/Discord channels. It installs skills from GitHub, ClawHub, and Hermes. It is **not** a plugin for Claude Code/Codex; it replaces them.

**Dependencies.** An LLM for everything (cloud default, BYO keys via `/connect`). Optional Letta Cloud.

**Benchmarks claimed.** None in either README.

**Strengths to steal.** **Two-tier memory with name+description stubs for deferred files.** Git-versioned memory with validation hooks. A tier-move operation as compression. Reflection triggered on compaction events. Explicit core-memory char budget.

**Weaknesses to beat.** Harness lock-in. Every consolidation needs an LLM. A 64 KB core budget is generous and token-expensive. No lexical/vector retrieval over deferred files, so it relies on the agent choosing correctly. Cloud by default.

---

## 15. MemoriLabs/Memori (17.1k★, Apache-2.0)

**Summary.** An SDK that **wraps the LLM client** (`Memori().llm.register(client)`). It auto-persists conversations, extracts facts in the background ("Advanced Augmentation", cloud-side), and injects recalled facts into the system prompt. It also offers a hosted MCP endpoint.

**Architecture.** Python (`memori/`) + TS SDK (`memori-ts/`) + a Rust core (`core/src/{search,embeddings,storage,retrieval}`). BYODB storage through SQLAlchemy drivers (Postgres/MySQL/SQLite/TiDB/Mongo…). Memory is scoped by **entity** (user), **process** (agent), and **session**.

**Capture.** It intercepts chat-completion calls (`memori/llm/pipelines/post_invoke.py`, `conversation_injection.py`). Augmentation (attributes, events, facts, people, preferences, relationships, rules, skills) is posted to `cloud/augmentation` (`memory/augmentation/_handler.py`). Even BYODB extraction depends on Memori's API (rate-limited without a key).

**Retrieval/Ranking.** `memori/search/_core.py` does brute-force cosine over up to `recall_embeddings_limit` = 1000 embeddings per entity, with optional FAISS (`_faiss.py`). The candidate pool is max(limit, min(N, max(10·limit, 50))). A **linear dense+lexical blend** comes from `dense_lexical_weights`: `w_lex` = 0.15 by default and higher for queries of ≤2 tokens (`MEMORI_RECALL_LEX_WEIGHT`). The lexical side is stopword-filtered token overlap (`_lexical.py`). Local embedder: all-MiniLM-L6-v2 (ONNX via the Rust native module).

**Context injection & token cost.** `inject_recalled_facts` (`llm/pipelines/recall_injection.py`) appends `<memori_context>` ("Only use the relevant context if relevant…") with up to `recall_facts_limit` = 5 facts above `recall_relevance_threshold` = 0.1, plus dated summaries, **to the system prompt on every call**. That breaks prefix caching. The README claims 721 tokens/query on LoCoMo.

**Compression/Consolidation.** Server-side augmentation. Nothing local beyond embedding storage; dedup logic is not visible in the OSS client.

**Integrations.** OpenAI, Anthropic, Bedrock, Gemini, Grok, and DeepSeek clients; Agno, LangChain, and Pydantic AI; OpenClaw and Hermes plugins; a hosted MCP (`api.memorilabs.ai/mcp/`) for Claude Code, Cursor, Codex, Warp, and Antigravity.

**Dependencies.** A Memori API key for augmentation, plus an LLM key and a DB.

**Benchmarks claimed.** LoCoMo **87%** accuracy at **721 tokens/query** (2.8% of full context; ~67% fewer tokens than Zep; >36× cheaper than full-context). Paper arXiv 2603.19935.

**Strengths to steal.** Query-length-adaptive lexical weight. A reported tokens-per-query metric as a first-class KPI. Entity/process/session attribution. Timestamped facts ("Stated at …"). Relevance threshold before injecting.

**Weaknesses to beat.** Core extraction is closed/cloud. Brute-force recall is capped at 1000 vectors. Mutating the system prompt every call breaks caching. No coding-agent hooks (MCP only), so no passive capture of tool activity in Claude Code.

---

## 16. memvid/memvid (16.6k★, Apache-2.0)

**Summary.** A Rust library that packs content, BM25 (Tantivy), HNSW vectors, a time index, and a WAL into **one portable `.mv2` file** of append-only "Smart Frames". It is a storage engine, not an agent integration. (The v1 QR/video approach is deprecated.)

**Architecture.** `MV2_SPEC.md`: 4 KB header, embedded WAL (1–64 MB), compressed data segments, Tantivy lex index, HNSW vec index (384-d BGE-small, M=16, ef_construction=200), time index, and TOC footer, with no sidecar files. Modules: `src/memvid/{ask,search,timeline,mutation,sketch,mesh,enrichment}.rs`, `src/vec_pq.rs` (product quantization), and `src/triplet/` (entity-slot "memory cards").

**Capture.** Explicit `put_bytes_with_options` + `commit()`. Ingests PDF, CLIP images, and Whisper audio. Deterministic enrichment: `src/enrich/rules.rs` uses a regex-based RulesEngine to extract memory cards ("doesn't require any models"), and `triplet/extractor.rs` defaults to rules, with LLM optional.

**Retrieval/Ranking.** `ask.rs` builds several lexical-variant lists plus a vector list and fuses them with **RRF (RRF_K = 60)**. Analytical/temporal questions use the timeline directly. `sketch.rs` uses **SimHash + term-filter sketches** for sub-millisecond candidate prefiltering before BM25/vector rerank. `temporal_track` parses "last Tuesday". ACL enforcement modes exist.

**Context injection & token cost.** Library only: `snippet_chars` (e.g. 200) and `top_k` are caller-controlled. No agent injection layer in this repo.

**Compression/Consolidation.** Frame compression ("codec intelligence"), PQ vector compression, and immutable append-only frames with time-travel/replay (`replay/`). No semantic consolidation.

**Integrations.** Rust crate, Node/Python SDKs, and `memvid-cli`. No hooks, MCP, or agent adapters in this repo.

**Dependencies.** Feature-gated: Tantivy, ONNX (BGE/nomic/gte, downloaded manually), optional OpenAI embeddings, Whisper, and CLIP. No server.

**Benchmarks claimed.** "+35% SOTA on LoCoMo", "+76% multi-hop, +56% temporal vs industry average", 0.025 ms P50 / 0.075 ms P99, "1,372× higher throughput". The README gives no absolute accuracy figure; the claims are marketing-style.

**Strengths to steal.** **Single-file portable store with embedded WAL** (easy sync/backup per project). SimHash sketch prefilter. Model-binding guard (`set_vec_model` → `ModelMismatch`), which prevents mixing embedding models. Product quantization. Deterministic regex enrichment. Time index for temporal queries.

**Weaknesses to beat.** No capture or injection for coding agents. Embedding models must be fetched manually. Opaque binary format (not human-editable or diffable). Benchmark claims lack absolute numbers. Single-writer locking.

---

## 17. NevaMind-AI/memU (14.5k★, Apache-2.0)

**Summary.** "Personal memory stored as wiki". Scheduled sidecar binaries mine each host's **session log files** and hand self-contained jobs to the **host agent itself** to write memory and skill markdown. The service makes no LLM calls; it embeds and retrieves.

**Architecture.** Python (`src/memu/`). `MemoryService` is described as "core memory logic ~500 lines". Storage is SQLite (brute-force cosine), Postgres + pgvector, or in-memory (`database/*`), or MemU Cloud. The model has three layers: RecallFile → RecallFileSegment → resources/skills tracks.

**Capture.** Passive, with no hooks. A scheduled bridging task (`hosts/bridging/pipeline.py`, `hosts/scheduling/*`) slices new transcripts from `~/.claude/projects/*.jsonl`, `~/.codex/sessions/**`, Cursor agent-transcripts, Hermes/OpenClaw SQLite, and others. `prepare` writes job files from `MEMORY_JOB_TEMPLATE` / `SKILL_JOB_TEMPLATE` (`hosts/bridging/instructions.py`): read filenames first, then do nothing, patch, or create, with name/description frontmatter. The agent writes the files and `commit` → `commit_results` embeds the name+description.

**Retrieval/Ranking.** `progressive_retrieve` (`app/agentic.py`): one query embedding, segments ranked by cosine (top_k 5), files rolled up by max segment score, and resources ranked (top_k 5). Pure vector; "no intention routing, sufficiency checks, or summarization".

**Context injection & token cost.** Pull-based. The host instruction file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `SOUL.md`…) is patched to tell the agent to run `memu-<host> retrieve` before answering. Each lookup costs a shell tool call plus its output. There is no budget control beyond top_k.

**Compression/Consolidation.** Agent-judged patch-in-place ("last write wins"), explicit "do nothing is fine", and skill patching vs creation.

**Integrations.** Codex, Claude Code, Cursor, OpenClaw, Hermes, WorkBuddy, Cola, and pi. `memu-agent detect` sniffs unknown JSONL dialects. Install is "send your agent this SKILL.md URL".

**Dependencies.** An embedding API (OpenAI/Jina/Voyage/Doubao/OpenRouter) is required for self-hosting. A scheduler (cron, launchd, or Windows tasks).

**Benchmarks claimed.** None in the README.

**Strengths to steal.** **Mining existing transcript logs** (zero hooks, works retroactively). Delegating extraction to the host agent (no separate LLM bill; consolidation runs on the user's own model quota). A read-names-first protocol. A `TranscriptSource` abstraction per host. A per-host install verification gate (`doctor`).

**Weaknesses to beat.** Retrieval is vector-only brute force (no BM25 or recency). It depends on an instruction to self-retrieve (compliance varies; the README notes models refusing setup). Scheduled batch capture means stale memory within a session. No dedup beyond the agent's judgment. An embedding API is required even locally.

---

## 18. EverMind-AI/EverOS (13.4k★, Apache-2.0)

**Summary.** A local-first Python memory runtime. **Markdown is the source of truth**, with derived SQLite (state/queue) + LanceDB (vector + BM25) indexes. An Offline Memory Engine (OME) derives facts, foresight, profile, agent cases, and skills. It reports the highest benchmark numbers in this group.

**Architecture.** `~/.everos/<app>/<project>/users/<uid>/{user.md, episodes/episode-<date>.md, .atomic_facts/, .foresights/}`, `agents/<aid>/{.cases/, skills/skill_<name>/SKILL.md}`, and `knowledge/`. `.index/` is disposable (`everos cascade rebuild`). Storage patterns: daily-log append (one file per day), single-file rewrite (profile), and skill dirs (`docs/how-memory-works.md`).

**Capture.** HTTP `/api/v2/memory/add` buffers messages per session in SQLite. A boundary detector (or `/flush`) triggers **one LLM extraction** into a MemCell, and the episode `.md` is written synchronously. OME async strategies follow: `extract_atomic_facts`, `extract_foresight`, `extract_user_profile`, `extract_agent_case`, `extract_agent_skill` (clustering). The cascade daemon (watchdog) **re-embeds only changed entries keyed by content_sha256**. The Claude Code plugin (`use-cases/claude-code-plugin/hooks/hooks.json`) uses SessionStart, UserPromptSubmit (`inject-memories.js`), Stop (`store-memories.js`), and SessionEnd.

**Retrieval/Ranking.** `memory/search/manager.py` uses `everalgo.rank.fusion.rrf(sparse, dense)` with optional rerank. `llm_multiround.py` does iterative decider-guided retrieval: per-sub-query BM25+vector RRF blocks, core-first assembly, **max (not sum) RRF across sub-queries**. The code notes the cross-encoder "was measured net-negative" and was removed. Search is scoped by user/agent/app/project/session.

**Context injection & token cost.** The Claude plugin injects at most `MAX_MEMORIES = 5` per prompt. The server returns ranked items; no global token budget was found.

**Compression/Consolidation.** `reflect_episodes` (cron, off by default) merges episode clusters into one narrative, re-extracts facts, and sets `deprecated_by` on the originals (non-destructive). Profile and skill clustering. Strategies toggle in hot-reloaded `ome.toml`.

**Integrations.** DeepSeek Harness, Hermes, OpenClaw, Dify, and Raven. Claude Code via the use-case plugin (with MCP). Community MCP (`evermemos-mcp`).

**Dependencies.** An LLM (OpenRouter) is mandatory. Embedding is needed for hybrid search, reflection, and skills. A reranker is needed for agentic search and the Wiki. Python 3.12 and a running server.

**Benchmarks claimed.** `benchmarks/README.md`: **LoCoMo 94.42**, **LongMemEval 94.00**, EverMemBench 66.67, SubtleMemory 71.75 (micro accuracy, different decider and answer models per row, reproducible via `reproduce.sh`).

**Strengths to steal.** **Markdown truth + rebuildable index + sha256 entry-level re-embed.** Daily-log file sharding. Deprecate-not-delete consolidation. Per-sub-query RRF with max fusion. Evidence that a cross-encoder can hurt. Orthogonal scoping keys.

**Weaknesses to beat.** An LLM call on every flush. A server process plus eventual-consistency read lag (up to ~10–15 s). The best results need a multi-round LLM decider (expensive per query). Coding-agent integration is a side use-case. Benchmark rows mix models.

---

## 19. MemTensor/MemOS (11.7k★, Apache-2.0)

**Summary.** A "Memory OS" with two faces: a heavyweight research server (Neo4j + Qdrant, MemCubes, textual/activation-KV/parametric-LoRA memories, MemScheduler) and the more relevant **memos-local-plugin 2.0**, a local SQLite core with RL-flavoured trace→policy→world-model→skill evolution.

**Architecture.** Server: `src/memos/{mem_cube, memories/{textual/tree, activation/kv.py, parametric/lora.py}, mem_scheduler, graph_dbs, vec_dbs, mem_reader, dream}`. Local plugin (`apps/memos-local-plugin/ARCHITECTURE.md`): agent-agnostic `core/` behind an `agent-contract/` facade, with SQLite repos (traces, policies, world models, skills, episodes, feedback) and FTS5 + vector. Six embedding providers, including local MiniLM.

**Capture.** Adapter hooks per turn (`onTurnStart` / `onTurnEnd` / `onFeedback`). Episodes are finalized into L1 traces, with reflection extracted by adapter, regex, or optional LLM, plus an α-score. **Reward**: per-episode `R_human ∈ [-1,1]` via a rubric LLM (heuristic fallback), back-propagated: `V_t = α_t·R + (1-α_t)·γ·V_{t+1}`.

**Retrieval/Ranking.** Three tiers (`core/retrieval/`):
- Tier 1: skills (top 3).
- Tier 2: traces/episodes (top 5), with `score = 0.6·cos + 0.4·priority` and `priority = max(V,0)·0.5^(Δdays/30)`.
- Tier 3: world models (top 2).

These are fused with **RRF k=60**, then **MMR λ=0.7**. After that comes an **LLM filter** (keep ≤4, only if ≥2 candidates, 500-char bodies), with keyword top-20, `minTraceSim` 0.25, and a relative threshold floor of 0.2 (`config/defaults.ts`).

**Context injection & token cost.** `injector.ts` builds an `InjectionPacket`. Skills are injected in `summary` mode (200 chars). Five entry points: turnStart, toolDriven, skillInvoke, subAgent, and repair. The cloud plugin claims "72% lower token usage".

**Compression/Consolidation.** L2 policy induction from signature buckets (`primaryTag|secondaryTag|tool|errCode`, ≥N episodes → LLM `l2.induction`). L3 world-model abstraction by centroid clustering. Skill crystallization with a non-LLM verifier, plus a Beta(1,1) posterior η and probationary → active → retired lifecycle.

**Integrations.** OpenClaw, Hermes (JSON-RPC bridge), and DeepSeek Harness. Cloud API, plus a viewer dashboard. No Claude Code/Codex adapter seen.

**Dependencies.** Local: Node + SQLite, with an LLM for reward, induction, and filter. Server: Neo4j + Qdrant + LLM.

**Benchmarks claimed.** LoCoMo 88.83, LongMemEval 89.20, PersonaMem v2 40.58, HaluMem 80.91, BEAM-10M 56.75, others via OmniMemEval. OpenClaw task completion 36.63% → 50.87%.

**Strengths to steal.** **Outcome-weighted memory (value V × time decay) so successful past attempts outrank failed similar ones.** RRF + MMR diversity. Tiered skill/trace/world retrieval with small per-tier top-k. Summary-mode skill injection. Skill lifecycle with posterior confidence and retirement.

**Weaknesses to beat.** Very complex (many LLM-driven stages and hyperparameters). The LLM filter adds a call per turn. No coding-CLI adapters. The research server is infra-heavy. Brute-force vector scan by default (`vectorScanMaxAgeMs` 0).

---

## 20. akitaonrails/ai-memory (8.9k★, MIT)

**Summary.** A single Rust binary: a **git-backed markdown wiki as source of truth**, a derived SQLite FTS5 + entity + graph (+ optional local vector) index, hook-based silent capture across 20+ harnesses, and typed claim-once cross-agent handoffs. **Zero LLM calls by default.** It is the closest match to the target design.

**Architecture.** Crates: `ai-memory-{core, store, wiki, hooks, mcp, consolidate, llm, workstream, web, cli}`. Pages have tiers (Working/Episodic/Semantic/Procedural), supersession version chains, `page_evidence`, typed edges (`causes`/`fixes`/`contradicts`), and `_global` preference scope. It runs as a server (local, homelab, or team) with multi-user auth and an audit log.

**Capture.** Lifecycle hooks (SessionStart, UserPromptSubmit, tool events, session end) emit observations, **sanitized at a typed privacy boundary (2 KB excerpt cap)**. When the server is down, a local spool takes over. At session end the observations are consolidated into wiki pages (LLM-written optionally). `ai-memory bootstrap` backfills history. `ai-memory run <harness>` auto-wires hooks + MCP.

**Retrieval/Ranking.** `memory_query`: **FTS5 + entity-match + graph RRF + optional vector RRF**, then a bounded authority adjustment (kind/tier/pinned/tag, clamp [0.55, 1.50]) and an optional single LLM rerank pass. `explain=true` gives per-stream ranks and RRF contributions. `as_of` provides bi-temporal-lite queries. Access counters are bumped on hits.

**Context injection & token cost.** The SessionStart brief is bounded by `[briefing] max_chars` with **BRIEF_BUDGET_DEFAULT = 4,000** (clamped 1,500–20,000), up to 24 core pages, and titles-only for 10 recent pages (`crates/ai-memory-hooks/src/router.rs`). Pinned pages are capped at 10. The cross-project profile digest is `digest_max_bytes` 3,000 (clamped 1,500–12,000), "byte-stable" for caching. Then comes a pending handoff.

**Compression/Consolidation.** Retention is `salience·exp(−λΔt) + σ·log(1+access_count)·exp(−μ·days_since_access)` (`ai-memory-store/src/decay.rs`), with a half-life per tier. Opt-in zero-LLM features: **extractive tier-down** (keep abstract + first paragraph + regex keep-tokens such as paths, URLs, error codes, identifiers), DBSCAN near-duplicate cluster collapse, and contradiction flagging. An opt-in LLM "dream" pass merges cold clusters. Superseded versions are never deleted (`restore-page`). Read-time belief confidence uses distinct sessions, recency, and contradictions.

**Integrations.** Claude Code, Codex, Cursor, Gemini CLI, OpenCode V1/V2, Antigravity CLI (via PreInvocation), Copilot CLI, Kiro, Kimi, Grok, Devin, Pi/OMP, Hermes, OpenClaw, Zed/VS Code (MCP-only), and more.

**Dependencies.** One binary. Optional LLM and embedding providers; the default local embedder is all-MiniLM in-process.

**Benchmarks claimed.** LongMemEval-S retrieval **hit@5 0.815** (local embeddings) and 0.666 (FTS-only), with provenance and A/B harness reporting accuracy + latency + **context tokens** (`docs/benchmarks/`). It honestly cites agentmemory at 0.967 R@5 as higher.

**Strengths to steal.** Zero-LLM default. Markdown/git truth. Byte-budgeted, byte-stable SessionStart brief. Multi-stream RRF with an explain mode. Access-reinforced decay. Extractive keep-token compaction. Supersede-not-delete. **Claim-once handoffs.** An eval harness that tracks token cost as a regression gate.

**Weaknesses to beat.** Requires a running server (spool fallback). The 2 KB capture cap loses deep evidence (they admit it). Retrieval quality is mid-pack (0.815 hit@5). The big feature surface creates config complexity. Most aging features are off by default.

---

## Top 15 ideas from this group

These are ranked by expected impact on **token savings first, then memory quality**.

1. **Index-then-search instead of dumping (context-mode).** Route any tool output over a threshold (5 KB) into a local FTS index and return only intent-matched snippets plus a term vocabulary. This is the biggest single token lever (claimed 315 KB → 5.4 KB/session), and memory capture gets the raw data for free.

2. **Reference-based resume snapshots (context-mode `buildResumeSnapshot`).** After compaction or on resume, inject one-line summaries per category plus *pre-built runnable search calls* instead of content. The agent pays tokens only for what it expands. Enforce a hard byte budget with P1–P4 tier dropping, which the README promises but the code dropped.

3. **Split injection into a stable, cacheable block and a small dynamic block (TencentDB `appendSystemContext` vs `prependContext`; ai-memory's "byte-stable" digest).** Keep profile, rules, and index in a deterministic, sorted, byte-stable system block so prompt caching hits. Put per-turn recall in the user turn. Never mutate the system prompt per call, as Memori does.

4. **Hard, layered budgets with elision banners (beads, TencentDB, ai-memory).** Use per-item char caps, a total budget (e.g. 4 KB default, clamped), and an "N more not shown: use `mem search <kw>`" line. This makes cost predictable and keeps the agent aware that more memory exists.

5. **Two-tier progressive disclosure (Letta MemFS core vs deferred; memU read-names-first).** Inject only a compact index of name + one-line description for deferred memories. Bodies load on demand, and "moving a file between tiers" is itself the compression operation.

6. **Multi-stream lexical-first hybrid retrieval with RRF k=60 (context-mode, ai-memory, memvid, MemOS, EverOS).** Run Porter BM25 + trigram (substring and identifier match) + entity/graph + optional local vector, then fuse with RRF. Weight titles/headings (bm25 5:1), add a proximity rerank, and do Levenshtein typo repair. This works with zero LLM and no API key.

7. **Zero-LLM aging: access-reinforced decay + extractive keep-token compaction (ai-memory `decay.rs`).** Use `salience·e^(−λΔt) + σ·log(1+access)·e^(−μΔaccess)` with a per-tier half-life. Compact cold episodic notes to abstract + first paragraph + regex-mined keep-tokens (paths, error codes, identifiers). Supersede, never delete.

8. **Delegate summarization and consolidation to the host agent rather than a separate LLM (beads `compact --apply --summary`, memU self-evolve jobs, Letta reflection subagent).** Emit a self-contained job file (transcript path, existing memory names, a do-nothing/patch/create decision rule) and let the user's own agent do it during idle time or a PreCompact window. The result is LLM-quality consolidation with no extra API key.

9. **Outcome-weighted ranking (MemOS `score = 0.6·cos + 0.4·max(V,0)·0.5^(Δd/30)`).** Record whether an episode succeeded (tests passed, user accepted, error→fix pair) and boost memories from successful attempts over similar failed ones. This matters especially for coding fixes; context-mode's heuristic error→fix and rejected-approach events are a cheap source of the signal.

10. **Heuristic typed event capture from hooks (context-mode `extract.ts`).** Use regex/heuristic classification into files, tasks, decisions ("use X instead"), rules, errors, error→fix, constraints, blockers, rejected approaches, and env, with secret redaction. This gives high-signal, structured memory with no LLM on the hot path.

11. **Markdown source of truth + disposable index with sha256 entry-level incremental re-embedding (EverOS cascade, ai-memory).** Files are human-editable, git-diffable, and portable. The index rebuilds from them, and only changed entries are re-embedded. Use daily-log sharding (`episode-YYYY-MM-DD.md`) to avoid file explosion.

12. **Batched candidate-recall dedup (TencentDB `l1-dedup.ts`) plus deterministic near-dup clustering (ai-memory DBSCAN).** For new memories, recall the top-5 similar by hybrid search and resolve store/update/merge/skip in *one* call (or deterministically via SimHash/keep-token overlap when no LLM is available). This keeps the store small, so injected memory stays non-redundant.

13. **MMR diversity + relevance threshold + small per-tier top-k before injection (MemOS λ=0.7; Memori threshold 0.1; EverOS max-not-sum RRF across sub-queries).** Avoid injecting five paraphrases of the same fact. Note EverOS's finding that a cross-encoder reranker was net-negative, so make rerank opt-in and eval-gated.

14. **Tool-call budget and throttling inside the memory protocol (context-mode progressive throttling: 2 → 1 → blocked; TencentDB "≤3 memory searches per turn").** Encourage batched multi-query search (`queries: [...]`) and cap repeated lookups to stop agents burning tokens on search loops.

15. **Universal agent coverage via a per-host adapter matrix + transcript-mining fallback (context-mode/ai-memory hook matrices; memU `TranscriptSource` + `detect`).** Use native hooks where available (Claude Code, Codex `hooks.json`, Gemini, OpenCode plugin `experimental.chat.system.transform` / `session.compacting`, Cursor pre/postToolUse, Antigravity CLI PreInvocation). Fall back to an instruction file (AGENTS.md/GEMINI.md, ~60% compliance per context-mode) plus **post-hoc mining of session JSONL logs** for hosts without hooks. Add claim-once typed handoffs (ai-memory) for cross-agent continuity.

Honourable mentions:
- memvid single-file store + embedding-model binding guard + SimHash prefilter.
- beads mergeable Dolt store + atomic `--claim`.
- Memori query-length-adaptive lexical weight.
- ai-memory eval harness that reports accuracy + latency + **context tokens** as a regression gate.
