# Group 5 — Repo analysis (repos #41–#50)

Method: README read in full; each repo shallow-cloned locally (all 10 clones succeeded) and 2–4 key source files read. File paths below are relative to each repo root. Numbers are quoted from the repos only; "not stated" means the repo gives none.

---

## 1. tigerless-labs/agent-memory (2.4k★, Python, MIT)

**Summary.** A file-first memory runtime: Markdown files are the truth, and SQLite FTS5 is a cache you can rebuild. Recall returns *paths and one-line abstracts*, not pasted text. Hosts: Claude Code, Codex CLI, Muse Code.

**Architecture.** The store is `~/agent-memory-store/<type>/<group>/<name>.md`, laid out by per-type schemas (`schemas/`). Frontmatter holds the abstract, `valid_from`/`invalid_at`, links, weight and provenance. `.index/` holds the FTS5 index, a content-hash manifest and the access log. The repo's own test enforces that `rm -rf .index && mem rebuild` loses nothing. `archive/sessions/` keeps full trace copies; `dream-reports/` keeps one report per sleep pass. Packages: `core`, `adapters`, `cli`, `executor`.

**Capture.** Hooks fire at boundaries: `SessionStart` injects, `Stop`/`SessionEnd` distil, `PreCompact` evicts (`adapters/hook_entry.py`). `core/distill.py` batches the transcript under a watermark and asks the host's own CLI for judgement (`executor/hosts.py` runs `claude -p` with Haiku 4.5 by default). The raw trace is copied first, so "missed by the distiller" never means "lost".

**Retrieval/Ranking.** `core/recall.py` checks eligibility first (scope, as-of validity), then scores `relevance × weight × recency`. BM25 weights abstract hits and body hits separately. Recency is `0.5^(age/180d)` with a floor of 0.25. An optional FastEmbed `bge-small-en-v1.5` vector index is fused with BM25 by RRF (k=60, `fuse_candidates`). `recall --as-of` answers as of a past date.

**Context injection & token cost.** `core/injection.py` injects a byte-prefix of `MEMORY.md`, capped at `injection_budget_bytes = 8192` (about 2k tokens) and cut at a newline. `memory_md.py` keeps only the heaviest lines, one per memory: `- [name](path) — abstract`. On-demand reads go up a ladder: L0 list (8 hits) → `read --level abstract|outline|full` → `trace` to the raw messages. Each step costs roughly ten times the one before.

**Compression/Consolidation.** `core/manage.py` runs `sleep()`. It merges exact duplicates via a JSON key, merges near-duplicate groups with Jaccard on abstracts, settles weights (−0.1 after 30 idle days), adds co-occurrence links and clusters. Authority is tiered: T0 applies unattended, while merge/split/delete only become *proposals* (`mem proposals`, `mem decide`). Supersede keeps the version chain.

**Integrations.** `mem setup --host claude-code|codex|muse-code` writes the hooks and a skill. `mem-mcp` exposes 9 tools. The CLI is the universal fallback.

**Dependencies.** Python 3.12 and uv. No API key; the LLM work borrows the host CLI. Vectors are optional.

**Benchmarks claimed.** LongMemEval-S, bounded to 12 sessions and 120 episodes: 52.9% vs MemCore 35.8% vs no memory 5.8%. Vector fusion raised Recall@5 from 79.0% to 86.6% and median latency from 5.1 to 139 ms, with no proven end-to-end gain.

**Strengths to steal.** Path-first recall plus a read-depth ladder. A hard byte budget on the index. Files as truth with a rebuildable index. Bitemporal validity. Proposals-only deletion. An honest A/B protocol.

**Weaknesses to beat.** Not on PyPI. Distillation spends the host's subscription quota. Near-duplicate detection is only lexical Jaccard. The MCP surface lacks `context`/`sleep`. No Cursor, Gemini or OpenCode adapters.

---

## 2. cytostack/openwolf (2.4k★, TypeScript, AGPL-3.0)

**Summary.** A per-project `.wolf/` folder plus lifecycle hooks. Its main lever is *token waste control* (blocking duplicate reads, condensing Bash output) rather than semantic memory. Hooks for Claude Code and Codex, a plugin for OpenCode, context files for Cursor, Gemini and Antigravity.

**Architecture.** `.wolf/` holds:
- `anatomy-index.json`: a file/symbol/import map built by `scanner/anatomy-scanner.ts` and `anatomy/ts-symbol-extractor.ts`
- `cerebrum.md`: preferences and Do-Not-Repeat rules
- `STATUS.md`, `memory.md` (session log), `buglog.json` (searched with Node's built-in SQLite)
- `handoff/` checkpoints, `cache/bash/` originals, `token-ledger.json`

There is also a daemon with cron and a dashboard (`src/daemon`, `src/dashboard`).

**Capture.** Hooks in `src/hooks/`: `session-start`, `pre-read`, `post-read`, `pre-write`, `post-write`, `pre-bash`, `post-bash`, `post-batch`, `precompact`, `stop`, `user-prompt-submit`. `precompact.ts` saves a task checkpoint (objective, done, open problems, next action). `post-write.ts` updates the anatomy index and the bug log. No LLM calls.

**Retrieval/Ranking.** No ranking engine. `openwolf find` looks up the symbol/file index, and `bug search` uses SQLite text matching with a simpler fallback matcher. Retrieval is mostly the agent grepping `.wolf` files on its own.

**Context injection & token cost.** `session-start.ts::buildSessionDigest` caps the digest at a per-agent budget, default 1,500 tokens and clamped to `min(budget, 400 + budget/4)`, which aims for about 400 tokens. It holds STATUS lines, the top 3 Do-Not-Repeat rules, `always:` files (40 lines each) and an index of `.wolf` files with their token sizes. After a compaction it adds "files already modified, do not re-read". `rule-reinjection.ts` repeats approved rules every 25 tool batches, within a budget.

**Compression/Consolidation.** Two token levers:
- `pre-read.ts` hashes each full read. A repeated read of an unchanged file gets a warning, or in `deny` mode is blocked with the cost (~N tokens), and `denied_tokens_saved` is tracked. Deny never fires after a compaction or for subagents.
- `bash-output-governor.ts` condenses output above 2,000 tokens structurally: grep results grouped per file, git diffs reduced to per-file stats, head 80 + tail 30 for anything else. The original goes to `cache/bash/`, and it falls back to the raw output when savings are under 30%.

`memory archive` moves old notes out with restore pointers.

**Integrations.** `src/agents/{codex,opencode,cursor,gemini,antigravity,grok}.ts` write AGENTS.md/GEMINI.md blocks between markers. The OpenCode plugin template is in `src/templates/opencode-plugin/`.

**Dependencies.** Node ≥ 20. No model and no embeddings.

**Benchmarks claimed.** None as numbers. `openwolf bench` runs paid A/B tasks (`scripts/benchmark/tasks/*.md`). The README says local estimates "do not prove a fixed amount of token savings".

**Strengths to steal.** Blocking duplicate reads by hash. Structural tool-output condensing with a cache to recover the original. Per-agent injection budgets. A provider-usage ledger that measures real cache/fresh tokens. Checkpoints before compaction.

**Weaknesses to beat.** No semantic or ranked recall. AGPL. Memory is project-local, so nothing crosses projects. Its knowledge files (`cerebrum`, `memory.md`) are append-heavy and depend on the agent reading them. Heavy feature sprawl (dashboard, cron, updater).

---

## 3. moorcheh-ai/memanto (2.3k★, Python, MIT)

**Summary.** A "memory agent" CLI/SDK over Moorcheh's proprietary "information-theoretic" semantic engine. That engine runs as a cloud service or a local Docker container; the open repo is a client/service layer. It adds typed memories, expiry policies, conflict detection and `--as-of` recall.

**Architecture.** `memanto/app` is a FastAPI service with `services/memory_{read,write,policy,export}_service.py`, `daily_analysis_service.py` and `okf_export_service.py`. `app/clients/{moorcheh,onprem}.py` wrap `moorcheh-client`; the on-prem default is `http://localhost:8080`. Each agent gets its own namespace. There are 13 memory types (instruction, fact, decision, goal, commitment, preference, …).

**Capture.** Explicit `memanto remember` (CLI/MCP/SDK). `remember --from-conversation` asks the backend LLM to extract memories (`conversation_memory_extraction_service.py` calls `client.answer.generate`, with prompt-injection escaping). Hooks (`cli/connect/assets/hooks/hooks.json`):
- `SessionStart` runs `memanto memory sync`
- `PreCompact` re-syncs
- `PostToolUse` on `Bash(memanto *)` sends a notification

There is no automatic transcript capture.

**Retrieval/Ranking.** `memory_read_service.search_memories` calls `similarity_search.query(top_k, threshold, kiosk_mode)` on the opaque engine. It over-fetches a candidate pool for post-filters (type, date, confidence), re-ranks the union and paginates. `search_as_of` reconstructs validity at a timestamp. No BM25 or hybrid visible client-side.

**Context injection & token cost.** `session_start.py` regenerates a project `MEMORY.md`, which `memory_export_service.format_memory_md` groups by type with metadata lines. `memory sync --limit` defaults to 10 memories. The agent is told via a CLAUDE.md/AGENTS.md template (`cli/connect/templates.py`) to call `memanto recall`. Token cost is not quantified.

**Compression/Consolidation.** A nightly `schedule enable` job runs the daily summary, conflict detection (`memanto conflicts`, LLM-based) and a policy sweep. Policies are YAML (`~/.memanto/policies/<agent>.yaml`): per-type retention, first-match rules and pins. Expired memories still show up in recall marked `[EXPIRED]`, and `restore` puts them back.

**Integrations.** `memanto connect` for 13+ tools, including Claude Code, Codex, Cursor, Windsurf, Antigravity, Gemini CLI, OpenCode and Cline. MCP server in `integrations/mcp`. Framework adapters for LangGraph, CrewAI, ADK, AG2 and others. Migration from Mem0, Letta, Zep and Supermemory. OKF Markdown export.

**Dependencies.** A Moorcheh cloud key, or Docker plus Ollama for on-prem. An LLM is needed for extraction, answers and conflicts.

**Benchmarks claimed.** LongMemEval 89.8% and LoCoMo 87.1% (arXiv 2604.22085). The README admits the reader/judge configuration is not stated in it.

**Strengths to steal.** Declarative expiry policies (per-type TTL, pins, confidence-based rules) that are auditable and reversible. `--as-of` and `--changed-since` queries. A typed taxonomy. A portable Markdown interchange format (OKF). Importers from rival systems.

**Weaknesses to beat.** The core retrieval engine is closed. Docker or cloud is required. Capture is manual or explicit-extraction only. Injection is a static top-10 export, not relevance-gated per prompt. Conflict detection requires an LLM.

---

## 4. codejunkie99/agentic-stack (2.3k★, Python/shell, Apache-2.0)

**Summary.** A portable `.agent/` "brain" folder (memory layers, skills, protocols) with adapter shims for 13 harnesses. Learning goes through *staged candidate lessons* that the host agent must graduate with a written rationale.

**Architecture.** Memory layers are `memory/working/`, `memory/episodic/` (JSONL), `memory/semantic/` (`lessons.jsonl` is the truth, rendered to `LESSONS.md`) and `memory/personal/PREFERENCES.md`. There is a skills manifest (`skills/_manifest.jsonl`) with progressive disclosure, and `protocols/permissions.md` enforced by `harness/hooks/pre_tool_call.py`.

**Capture.** Claude Code `PostToolUse` on Bash/Edit/Write/Task runs `harness/hooks/claude_code_post_tool.py`, which logs episodes with pain/importance scores. `Stop` runs `memory/auto_dream.py`. `tools/learn.py` teaches a lesson in one shot.

**Retrieval/Ranking.**
- `harness/salience.py`: `recency(10 − 0.3·days) × pain/10 × importance/10 × min(recurrence,3)`.
- `tools/recall.py`: plain lexical overlap of the intent against lesson claims and conditions, top 3. Its own docstring says "NOT semantic relevance".
- Optional FTS5 (`memory/memory_search.py`), falling back to ripgrep and then grep.
- Superseded lessons are filtered out via `superseded_by_map`.

**Context injection & token cost.** The CLAUDE.md template has the agent read five files at session start (AGENTS.md, PREFERENCES, REVIEW_QUEUE, LESSONS, permissions), with no size limit. It must also run `recall.py` before risky task keywords (deploy, migration, timezone…). The standalone conductor `harness/context_budget.py::build_context` assembles within 88k tokens, of which lessons get 8,000 chars.

**Compression/Consolidation.** `auto_dream.py`:
1. `cluster.py` single-linkage Jaccard clustering (threshold 0.3, min size 2)
2. `extract_pattern` picks the canonical episode with the highest salience
3. `promote.py` stages candidates
4. `validate.py` heuristic prefilter (length plus exact duplicate)
5. `decay.py` archives old low-salience episodes

Promotion to semantic memory needs `graduate.py --rationale`. `retract_lesson.py` retracts append-only.

**Integrations.** Adapters for Claude Code (CLAUDE.md plus settings hooks), Cursor `.mdc`, Windsurf rules, OpenCode/Codex/Hermes/Pi (AGENTS.md), Gemini (`gemini.md`), Copilot CLI hooks and `ANTIGRAVITY.md`. A transfer wizard exports and imports with a SHA-256-verified bundle. Optional external "Brain" MCP.

**Dependencies.** Python 3 only, with no LLM inside the library.

**Benchmarks claimed.** None.

**Strengths to steal.** Pain×importance×recurrence salience. Recurrence-gated promotion (a lesson needs ≥2 similar episodes). Human or agent graduation with rationale and audit history. Conditions attached to lessons. A permissions hook. Breadth of harness shims.

**Weaknesses to beat.** Recall is lexical-overlap only. Session-start injection is unbounded and depends on the agent obeying CLAUDE.md. Clustering is O(n²) on Jaccard. Graduation costs agent turns. Big surface area (dashboards, loops, flywheel) relative to the memory core.

---

## 5. cortexkit/magic-context (2.3k★, TypeScript/Bun, MIT)

**Summary.** A *context manager plus memory* plugin for OpenCode, Pi and OMP. It replaces host compaction with a background "historian" that compresses old turns into tiered compartments, extracts durable memories as it goes, and keeps the prompt cache stable. A "dreamer" consolidates offline.

**Architecture.** One SQLite DB at `~/.local/share/cortexkit/magic-context/context.db` holds tags, compartments, memories, notes, a message FTS index and embeddings. Local embeddings use `Xenova/all-MiniLM-L6-v2` (~90 MB ONNX); OpenAI-compatible or Ollama backends are optional. The code is in `packages/plugin/src/{hooks,features,tools,v2}`.

**Capture.** The historian (`hooks/magic-context/compartment-runner-*.ts`, using a cheap model set in `historian.<host>.model`) summarizes old raw history into compartments with an importance score, and in the same pass promotes memories in 5 categories (PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING). The agent can also write explicitly with `ctx_memory`, and `ctx_note` records deferred intentions.

**Retrieval/Ranking.** `features/magic-context/search.ts::ctx_search` covers memories, the FTS message history (bm25), git commits, notes and primers. Scoring is `0.7 × semantic(cosine) + 0.3 × FTS` (`SEMANTIC_WEIGHT`/`FTS_WEIGHT`), with RRF for multi-probe path queries. Results leave out anything already visible in `<project-memory>` or the live tail.

**Context injection & token cost.**
- Active memories are injected every turn as `#id: fact` in `<project-memory>`, with `memory.injection_budget_tokens` defaulting to 4,000 (range 500–20,000).
- `decay-curve.ts` picks the paraphrase tier P1–P5 for each compartment deterministically from age, importance and budget pressure. Measured tier costs are 322/109/35/20/5 tokens, and the half-life is 24 compartments at importance 50.
- Auto-search hints are capped at about 200 tokens, 80 chars per fragment (`auto-search-hint.ts`).
- Mutations are deferred until the provider's cache TTL expires (`cache_ttl` defaults to 5 min, 30 min for GPT-5.6+), so the cached prefix stays valid.

**Compression/Consolidation.** Dreamer tasks: map memories to files, verify them against the code (incremental and broad), curate/merge/archive, classify importance, retrospective, maintain ARCHITECTURE.md, promote user profile and primers, and evaluate smart notes. Optional "caveman" compression (`caveman.ts`) strips articles and filler from old text deterministically while protecting file paths. `ctx_reduce` lets the agent queue stale tool outputs for removal.

**Integrations.** OpenCode, Pi and OMP only, with no Claude Code or Codex. They share one DB across hosts.

**Dependencies.** A historian LLM (required), a dreamer LLM (optional), the embedding model and Bun for development.

**Benchmarks claimed.** None numeric. A cache-bust sentinel and latency sentinels are the evidence instead.

**Strengths to steal.** Deterministic age×importance tier decay with measured tier costs. Cache-TTL-aware deferred mutation. "Search returns only what is not already in context". Memory verification against code with file mapping. `ctx_expand` to recover the original transcript. A hard-capped "vague recall" hint.

**Weaknesses to beat.** Requires disabling host compaction and owning the whole context, so it is intrusive and conflicts with other plugins. An LLM must run continuously. Hosts are limited. Very complex (sentinels, profiles, v2 rewrite). An injection budget of 4k tokens every turn is large.

---

## 6. microsoft/kernel-memory (2.2k★, C#/.NET, MIT, **archived**)

**Summary.** A reference RAG service: document ingestion pipelines, chunking, embedding, a vector store and `AskAsync` answers with citations. It is document memory, not agent episodic memory, and is now an archived research project (a KM² rewrite also sits archived under `archived/v2`).

**Architecture.** `service/Core`: `Pipeline/` orchestrator; `Handlers/` (TextExtraction, TextPartitioning, GenerateEmbeddings[Parallel], SaveRecords, Summarization[Parallel], Delete*); `Search/SearchClient.cs` and `AnswerGenerator.cs`. Runs serverless (in-process `MemoryServerless`) or as a web service with queues (Azure Queues/RabbitMQ). The `extensions/` folder has connectors:
- vector stores: Azure AI Search, Postgres, Qdrant, Redis, Elasticsearch, SQL Server, MongoDB
- models: OpenAI, Azure OpenAI, Ollama, ONNX, LlamaSharp, Anthropic
- storage: S3, Blob

**Capture.** Explicit `ImportDocumentAsync`/`/upload` of files, URLs and text, with tags (`user:`, `collection:`) for security filtering. Custom handlers can be added to the pipeline.

**Retrieval/Ranking.** `SearchClient.SearchAsync` runs `memoryDb.GetSimilarListAsync(index, query, filters, minRelevance, limit)`, which is pure vector similarity plus tag filters (hybrid only where the backend supports it). `MaxMatchesCount` defaults to 100.

**Context injection & token cost.** Via RAG `AskAsync`: facts are rendered with `FactTemplate` into a prompt bounded by `MaxAskPromptSize − AnswerTokens` (300 by default) and filled until the token budget runs out (`SearchClientResult`, `tokensAvailable`). Responses carry a token-usage report; the README example shows 24,356 tokens in and 103 out. Partitions default to `MaxTokensPerParagraph = 1000`.

**Compression/Consolidation.** "Synthetic memory": `SummarizationHandler` makes LLM summaries of documents and stores them as extra searchable records. No dedup, decay or consolidation.

**Integrations.** Semantic Kernel plugin, ChatGPT/Copilot plugin, REST/OpenAPI, Docker, Aspire. No coding-agent hooks and no MCP in the main tree.

**Dependencies.** An embedding model and an LLM (OpenAI/Azure by default), a vector DB and optionally queues. Heavy .NET stack.

**Benchmarks claimed.** None. `applications/evaluation` has a RAGAS-style test-set generator and evaluator.

**Strengths to steal.** A pipeline of pluggable handlers with retry/queue semantics. Tag-based ACL filters on every query. Citations with `SizeInTokens` and `Relevance` per partition. A token-budgeted fact packing loop. Summaries indexed alongside chunks.

**Weaknesses to beat.** Archived and unsupported. Vector-only retrieval. Every query or answer costs an LLM call. No episodic or agent memory concepts, no lifecycle, no coding-agent integration. Heavy infrastructure.

---

## 7. memorax-ai/memorax-code (2.1k★, TypeScript/Node, MIT)

**Summary.** A local Node "Backend" plus adapters for Codex, Claude Code, CodeBuddy, WorkBuddy, DeepSeek Harness, OpenCode, Trae and Cursor. It writes turns back to the **MemoraX cloud** memory API and injects bounded reminders. It defines four memory boundaries: Coding, Repo, Personal and Procedure.

**Architecture.** `packages/ts/memorax-code-backend` is a modular monolith with a local HTTP service and the `memorax-cli`. `packages/ts/memorax-code-adapter-common` holds hooks, locks and Repo Memory helpers. Personal and Procedure memory are local Markdown under `~/.memorax-code/personal-memory/` (`user-profile/preferences.md`, `procedure-memory/<topic>.md`). Coding memory lives in the cloud (`provider/memorax/adapter.ts`: `/v1/memories/search`, `/v1/memories/add`).

**Capture.** Automatic writeback after each completed turn: `memory/automatic-writeback.ts` and `writeback-buffer.ts`, plus `writeback-chunk.ts`, which chunks by `maxChars` with an overlap ratio and redacts payloads. Turns are read from each client's native store (Claude transcript, Codex rollout, Cursor SQLite DB). Repo Memory is built by an agent subagent from git commits and GitHub/GitLab issues/PRs (`repo-memory/*-facets.ts`).

**Retrieval/Ranking.** Server-side and opaque. The client sends `topK = 6`, `kDense`, `kSparse`, `minScore` (`provider/memorax/config.ts`), which implies dense+sparse hybrid in the cloud. Search runs only when the agent invokes the skill. An optional "Jev" classifier (a separate model) decides per request whether a search is worthwhile.

**Context injection & token cost.** Results render as `<memories><facts memory_type=…>`, truncated to `maxContextChars = 4000` and `maxItemChars = 1000` (`renderMemoraxContextBlocks`). Hooks inject the Profile on the first turn and Procedure reminders at turns 1, 6, 11, then every 5 (`memory-skill-reminder-policy.mjs`). After a verified compaction, the Profile is restored.

**Compression/Consolidation.** Server-side, not visible. For personal memory, the agent compares meaning before writing: no-op if equivalent, update and drop the superseded wording otherwise. The "memory impact" rule makes the agent mention memory only when it materially changed the answer.

**Integrations.** Per-client plugins and hooks plus one shared Skill. Trae needs the user to switch hooks on manually.

**Dependencies.** A MemoraX cloud account (a 90-day guest mode exists), network access, Node ≥ 20 (22.13+ for Cursor) and an OS keychain.

**Benchmarks claimed.** None in the repo.

**Strengths to steal.** Reading turns from each client's native store, so the agent never has to "remember to save". Cadenced reminder injection instead of every turn. A Profile/Procedure/Coding/Repo split. An LLM gate deciding when search pays. Repo Memory built from commits and PRs, shared across worktrees.

**Weaknesses to beat.** Memory and retrieval are cloud-locked and not inspectable. Writeback ships full turns, a privacy and egress cost. Huge installer and lifecycle complexity. Search depends on the agent following long skill prompts.

---

## 8. MemTensor/memmy-agent (2.1k★, TypeScript, MIT)

**Summary.** A desktop app plus agent runtime plus a local Memory service (from the MemOS team). It ingests transcripts from many agents into a layered memory (L1 traces, L2 policies, L3 world model, Skills) and serves hybrid retrieval with an LLM filter.

**Architecture.** `Memory/` is a Node HTTP service on `127.0.0.1:18960`. Storage is SQLite plus `sqlite-vec` (`storage/sqlite-vec-store.ts`), with PolarDB as an option. Services are in `Memory/src/service/`:
- `retrieval/`
- `evolution/` (reward, policy-induction, skill-cluster, L3 world model, negative-experience pipelines)
- `work-memory/`, `user-memory/`, `memory-token-budget-ledger.ts`

Agent-source adapters (`src/agent-source/adapters/{claude-code,codex,cursor,opencode,hermes,pi,...}`) read native session JSONL, with a secret redactor.

**Capture.** Two paths. The service scans agent session files. Hooks also run the turn lifecycle: Claude Code `UserPromptSubmit`/`SessionStart`/`PostCompact`/`SessionEnd` (`integration/claude-code/target.ts`) run `memmy-resume-hook.ts`, which calls `turn start`, `turn complete` and `openRuntimeSession`. Every capture runs an LLM summary, with inputs clipped to 8,192 tokens.

**Retrieval/Ranking.** `retrieval-service.ts`, with defaults in `config/index.ts`:
- tiered topK (skills 3, episodes/traces 5, world model 2) from a candidate pool ×4
- score = `0.6·cosine + 0.4·priority`, plus a keyword channel (topK 20) fused by RRF (k=60)
- query rewrite (RRF constant 8)
- relative threshold floor 0.2, `minRecallScore` 0.12
- an **LLM filter** keeps up to 8 hits
- then MMR (λ=0.7)

**Context injection & token cost.** `turn start` returns `injectedContext.markdown` as `additionalContext` inside `<memmy_memory_context>`. The resume hook caps it at `RESUME_CONTEXT_MAX_CHARS = 24000` (about 6k tokens), with search limit 20 and display limit 5. Skills are injected as 200-char summaries (`skillInjectionMode: "summary"`) and loaded in full on demand.

**Compression/Consolidation.** The evolution pipelines turn episodes into rewards and policies, cluster skills from repeated successful traces, and build an L3 "world model". Session follow-ups are merged within a 2 h gap. All of this is LLM-driven.

**Integrations.** Claude Code, Codex, Cursor, OpenCode, Hermes, OpenClaw, DeepSeek Harness, Pi, WorkBuddy and QwenWork, via hooks, plugins and a skill (`cli/agent_inject.md`). An OpenAI-compatible API at `:18990`.

**Dependencies.** An LLM for capture, reflection, reward and filtering. An embedding model (local or OpenAI). Node ≥ 20/22, systemd user services, and a desktop app.

**Benchmarks claimed.** None in the README.

**Strengths to steal.** Ingesting from the native transcript stores of 10+ agents. Skill summaries injected with full text on demand. Tiered per-type topK. MMR diversity after the filter. A token-budget ledger. Prompt-injection framing (`<current_user_request>` is authoritative).

**Weaknesses to beat.** An LLM call per turn for capture and filtering, adding latency and cost. A heavy stack (desktop app, systemd, gateway). Up to about 6k tokens injected per prompt. The layering (L1/L2/L3/Skill) is complex and hard to audit.

---

## 9. VictorTaelin/OptMem (2.0k★, Python single file)

**Summary.** "Permanent memory in a 426-token prompt and one script". It is an append-only log of one-line memories plus a binary merge tree of summaries, *written by the agent itself* on demand. `memo wake` prints a log-scale view, recent memories verbatim and old ones summarized.

**Architecture.** `~/.optmem/memo`, 859 lines with no dependencies. `memory/LOG.txt` uses fixed-width 320-byte records (`LOG_REC`), so position is identity and every lookup is an O(1) seek. `TREE/<size>` files hold 288-byte summary records for aligned power-of-two blocks. The tree is a cache that can be rebuilt from the log. It is about 608 MB for a million memories, and `wake` takes 0.03 s.

**Capture.** The agent must call `memo note "<≤280 bytes>"` (instructed by the AGENTS.md/CLAUDE.md block). There are no hooks. Subagents are told never to write.

**Retrieval/Ranking.** No ranking. `memo recall <regex>` scans the full log word for word, and `memo zoom a-b` expands a tree node into its two halves (`cmd_zoom`).

**Context injection & token cost.** `cover(T, WAKE_LINES)` tiles `[0,T)` with aligned blocks, keeping a block whole iff `size ≤ α·age`. It binary-searches α until there are ≤ `WAKE_LINES` blocks (default 96 lines, "≈8k tokens") and spends any leftover on the most recent ones. Detail therefore decays logarithmically with age, and if everything fits nothing is compressed. Output is paginated into parts under 20 kB / 500 lines to survive harness truncation (Claude Code cuts the middle at 30k chars, Codex at 10k tokens), and the footer always says how to continue.

**Compression/Consolidation.** Lazy and agent-paid. `pending()` lists unbuilt blocks smallest first, and `note` or `wake` hands the agent *one* compression prompt at a time ("Compress #a–b into one line ≤280 bytes … Invent nothing", `nap_prompt`). `wake` refuses only when a summary it needs is missing. `memo forget a-b` drops a bad summary so it gets rebuilt. No dedup beyond the instruction "do not register redundant memories".

**Integrations.** Any agent that can run a shell and read AGENTS.md/CLAUDE.md. That is the whole integration.

**Dependencies.** Python 3. No server, embeddings or external LLM (it uses the host agent).

**Benchmarks claimed.** None, apart from the 426-token prompt and the 0.03 s wake at 1M memories.

**Strengths to steal.** A log-scale age-decay view with a fixed line budget. An immutable log with a rebuildable hierarchical summary tree. Zoom-to-drill navigation. Fixed-width O(1) records. Truncation-safe pagination. A minimal prompt surface.

**Weaknesses to beat.** No relevance: wake shows the same timeline for every task. Regex-only recall. Global, not per project. Depends on agent discipline to note and nap. Compression costs agent turns at random moments. A wake of about 8k tokens is expensive for small tasks.

---

## 10. doobidoo/mcp-memory-service (2.0k★, Python, Apache-2.0)

**Summary.** A mature self-hosted memory backend reachable over MCP, REST, OAuth, CLI and a dashboard. SQLite-vec with local ONNX MiniLM embeddings, BM25 hybrid, a knowledge graph, consolidation with decay, and Claude Code hooks for automatic injection.

**Architecture.** Backends in `src/mcp_memory_service/storage/`: `sqlite_vec.py`, `cloudflare.py`, `hybrid.py` (local reads with background cloud sync), `milvus.py` and `graph.py` (typed edges: causes, fixes, contradicts). Mixins for hybrid search and migrations. Memories carry a `content_hash`, which drives dedup. Consolidation is in `consolidation/` (decay, associations, clustering, compression, forgetting, contradictions, belief, insights, quarantine, scheduler).

**Capture.** MCP `memory_store`/`memory_store_session`/`memory_harvest`, REST, and `claude-hooks/core/`:
- `session-start.js`, `mid-conversation.js`, `topic-change.js`
- `session-end.js`: regex extraction of topics, decisions and insights, e.g. "decided to|going with"
- `auto-capture-hook.js`, `session-end-harvest.js`

An `X-Agent-ID` header auto-tags the writing agent.

**Retrieval/Ranking.** `storage/mixins/hybrid.py`: FTS5 `bm25()` (normalized `1 + rank/10`) plus vector cosine, combined by a weighted average (`MCP_HYBRID_KEYWORD_WEIGHT`/`SEMANTIC_WEIGHT`) or by `_fuse_rrf` with a consensus boost. Hook-side scoring (`claude-hooks/config.template.json`) weighs timeDecay 0.5, tagRelevance 0.2, contentRelevance 0.15, contentQuality 0.2 and conversationRelevance 0.25, with `minRelevanceScore` 0.4. `recentFirstMode` gives a 60% share to the last week.

**Context injection & token cost.** The SessionStart hook injects up to `maxMemoriesPerSession = 8`, truncating each to 200–400 chars, grouped by category with project detection (git, package files). That is roughly 1–2k tokens (inferred from the limits). Mid-conversation and topic-change hooks can inject more. The MCP surface has **19 tools** whose schema file (`tools/registry.py`) is about 60 KB, so tool definitions alone carry a large standing token cost.

**Compression/Consolidation.** `consolidation/decay.py`: `exp(−age/retention_period[type])` × base importance × access boost, plus an association retention boost. Clustering and `compression.py` produce statistical/extractive thematic summaries (no LLM). Also forgetting/archival, contradiction detection, insight cards and a scheduler. Quality scoring can use a local ONNX model or an OpenAI-compatible endpoint.

**Integrations.** MCP for Claude Code/Desktop, Gemini CLI, Codex, Cursor, Windsurf and Zed. An OpenCode plugin. Remote MCP with OAuth for claude.ai and ChatGPT. Framework guides for LangGraph, CrewAI and AutoGen.

**Dependencies.** Python, sqlite-vec and an ONNX MiniLM model (local). Zero LLM calls in the base path.

**Benchmarks claimed.** From `docs/BENCHMARKS.md`, all retrieval-only with zero LLM calls:
- LongMemEval-S, session ingestion: R@5 86.0%, R@10 93.0%, NDCG@10 82.9%
- LongMemEval-S, turn ingestion: R@5 80.4%
- DevBench: R@5 91.1%
- LoCoMo: R@5 49.7%, with temporal at 33.5%

**Strengths to steal.** Local ONNX hybrid with RRF and a consensus boost. Type-specific retention half-lives. Content-hash dedup. A "session vs turn" ingestion finding (session granularity raises R@5 by 5.6 points). Recent-first quota mixing. Retrieval benchmarks with run commands.

**Weaknesses to beat.** The 19-tool, 60 KB MCP schema bloats the context. Hook capture relies on regex heuristics. Weak temporal reasoning (LoCoMo temporal 33.5%). Sprawling feature set maintained by one person. Push injection is not query-aware at session start (no prompt yet).

---

## Top 15 ideas from this group (ranked by impact on token savings × memory quality)

1. **Path-first, depth-laddered recall.** Return `name · path · 1-line abstract · score` (L0) by default, and let the agent escalate to outline, then full, then raw trace only when needed. Each rung costs about 10× the previous one. *(agent-memory `recall`/`read --level`/`trace`; Memmy's skill summaries with full text on demand.)*
2. **A hard byte/token budget on the always-injected index, filled by weight.** Use one line per memory and drop the lightest lines first. About 2k tokens is a sane default, with per-agent budgets. *(agent-memory `memory_md.py` 8 KB; openwolf per-agent `budgets`, ~400-token digest.)*
3. **Block duplicate reads of unchanged files and condense large tool output structurally, caching the original.** Hash each read, deny re-reads unless there was a compaction, condense grep/diff output, and fall back when savings are under 30%. This is the biggest direct token saver in the group. *(openwolf `pre-read.ts`, `bash-output-governor.ts`.)*
4. **Deterministic age×importance tier decay with measured tier costs.** Store each history summary at several fidelities and pick one per item from age, importance and budget pressure, with no LLM at render time. *(magic-context `decay-curve.ts`: P1–P5 at 322/109/35/20/5 tokens.)*
5. **A log-scale timeline view over an immutable log plus a rebuildable summary tree, with zoom.** Recent items stay verbatim, old ones collapse into aligned power-of-two summaries under a fixed line budget, and `zoom` drills down. Use it for session and episode history. *(OptMem `cover()`/`zoom`.)*
6. **Never re-send what is already in context.** Search results exclude memories already injected and the live tail. Pair this with stable ids (`#id: fact`) so the agent can refer to memories without re-quoting them. *(magic-context `ctx_search` filtering.)*
7. **Cache-aware injection.** Keep the injected memory block byte-stable and defer mutations until the provider cache TTL expires, so memory never busts the prompt-cache prefix. *(magic-context `cache_ttl` deferral.)*
8. **Local hybrid retrieval: BM25 (FTS5) plus a small ONNX embedding model, fused by RRF, then multiplied by weight × recency.** Make vectors optional and measure the latency trade-off. *(agent-memory RRF k=60 with recall +7.6 pp; mcp-memory-service `_fuse_rrf` with consensus boost; Memmy keyword+cosine RRF plus MMR.)*
9. **Capture at boundaries from the host's native transcript store, archiving the raw trace first.** Distil asynchronously at Stop/SessionEnd/PreCompact so coverage does not depend on agent discipline, and an LLM miss is never data loss. *(agent-memory distill plus `archive/sessions`; memorax-code and Memmy native-store readers.)*
10. **Bitemporal validity and supersede chains.** Use `valid_from`/`invalid_at`, `--as-of` and `--changed-since`, and only exclude superseded items from current recall instead of deleting them. *(agent-memory, memanto, agentic-stack `superseded_by_map`.)*
11. **Declarative retention policies.** Per-type TTLs, pins and rules like "low confidence plus inferred expires in 14 days", applied as an auditable, reversible "expired" state, with type-specific half-lives in ranking. *(memanto policies YAML; mcp-memory-service `decay.py` with retention_period per type.)*
12. **Sleep-time consolidation with authority tiers.** Unattended passes may dedup (content hash, near-duplicate), adjust weights and link. Deletes, merges and splits become proposals, and every pass writes a dream report. *(agent-memory `manage.py`; agentic-stack graduate/reject with rationale.)*
13. **Recurrence-gated promotion with salience.** An episode becomes a durable lesson only after ≥2 similar occurrences. Rank by recency × pain × importance × min(recurrence, 3). This cuts noise, so fewer memories are injected. *(agentic-stack `salience.py`, `cluster.py`.)*
14. **Cadenced, not per-turn, reminder injection, plus a cheap gate for whether to search at all.** Inject the profile once, procedure reminders at turns 1/6/11, a ≤200-token "vague recall" hint, and full search only when a gate says it pays. *(memorax-code reminder policy and Jev gate; magic-context auto-search hint cap.)*
15. **Verify memories against the codebase and keep the tool surface tiny.** Map each memory to backing files and re-verify on change (drop stale facts). Expose about 3–5 tools or a CLI instead of 19 schema-heavy MCP tools (~60 KB), and paginate CLI output to survive harness truncation limits. *(magic-context dreamer verify; mcp-memory-service as the counter-example; OptMem `PART_CHARS` pagination.)*
