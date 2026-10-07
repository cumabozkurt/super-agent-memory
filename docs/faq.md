# FAQ and troubleshooting

## General

### Does SAM send my code or prompts anywhere?

No. SAM never calls a model, and everything stays in `~/.sam/sam.db` on your machine. The only network feature is optional embeddings, and those go only to an endpoint you configure yourself. A non-localhost endpoint must be set in your own `config.json`, never by an environment variable alone. See [Configuration → Optional embeddings](configuration.md#optional-embeddings).

### Does it replace `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`?

No. Those files stay yours, and SAM only reads them. Card lines that your host already loads from them are skipped, and contradictions are noted once per session (`nativeDedup`). SAM's own rules go into a clearly marked block (`<!-- sam:start -->…<!-- sam:end -->`) or a separate file, and `sam uninstall` removes them.

### Do I need embeddings or a GPU?

No. Retrieval is lexical by default: BM25, trigram, an English/Turkish alias table, Turkish stemming and typo correction. Every benchmark number in the README is without embeddings.

### Does it work in Turkish?

Yes. Directives ("unutma", "bundan sonra", "artık X değil Y", "her zaman / asla"), kind aliases (`karar`, `kural`, `tercih`, …), query expansion between Turkish and English, Turkish-aware folding (`İ/I/ı`), and a budget boost for Turkish-heavy stores are all built in.

### Why are there three command names?

`sam` is short. `sam-memory` exists because `sam` is also the AWS SAM CLI, and `super-agent-memory` matches the package name. All three run the same CLI, and the rules SAM installs for agents always use `sam-memory`.

### Why doesn't `npm i -g super-agent-memory` work?

The package is not published to the npm registry yet. Install from GitHub with `npm i -g github:cumabozkurt/super-agent-memory`, or from a clone with `npm link`. See [Getting started](getting-started.md#install).

### Can I share memory with my team?

Yes, through a committed team file: `sam export --team` writes `.sam/memory.md`, and each teammate reviews and imports it with `sam trust`. Personal preferences and session digests are not exported. See [Concepts → Team file](concepts.md#team-file).

### Can I use it on several machines?

Keep one database per environment and move memories with `sam export --jsonl` / `sam import --trusted`. Never share one database file over a network or sync folder. See [Integrations → One database per environment](integrations.md#one-database-per-environment).

### What about MCP clients SAM does not install into?

Run `sam snippet` and paste the output into the client. You get MCP search and save plus the rules. See [Integrations → Any other MCP client](integrations.md#any-other-mcp-client).

## Troubleshooting

### `sam: Node.js 22.16+ (22.x) or 24+ is required`

Your Node lacks `node:sqlite` with FTS5 (Node 22.13–22.15 and all 23.x). Install Node 22.16+ or 24+. If several Node versions are installed, point the launcher at the right one with `SAM_NODE=/path/to/node`, or make sure the right one comes first on `PATH`, then run `sam install` again. Hooks stay silent on an unsupported Node instead of breaking your agent.

### Hooks don't seem to fire

1. Restart the agent after `sam install`.
2. **Codex:** run `/hooks` inside Codex once to approve the hooks.
3. Run `sam doctor`. It self-tests every installed hook and MCP command through its host's shell and lists entries that point at missing paths (`BROKEN: … → run sam install`), which happens after a Node upgrade or moving the package.
4. Check that the card is not simply empty: `sam context` in the project shows exactly what an agent would get.
5. Run a hook by hand with debug output:

   ```bash
   echo '{"cwd":"'"$PWD"'"}' | SAM_DEBUG=1 sam hook SessionStart --agent claude
   ```

### Nothing is injected on my prompts

That is often correct. Per-prompt recall is gated, and it injects only when a memory clearly covers the prompt's rare words. Check what a prompt would get:

```bash
sam context --prompt "your prompt here"
sam q "your prompt here"   # what search finds, without the gate
```

If search finds the right memory but the gate rejects it, you can loosen the gate a little: lower `minPromptCoverage`, or raise `weakPromptCoverage` (see [Configuration](configuration.md#retrieval-and-the-relevance-gate)). Agents can always pull with `mem_search`. On Cursor, per-prompt recall only goes through MCP because Cursor has no hook that can inject per prompt.

### An agent saved something wrong

```bash
sam ls                    # find it
sam forget <id>           # retire it
sam add "<correct value>" # your version wins: agents cannot overwrite a user memory
```

To keep wrong text from coming back through re-harvested transcripts, `sam forget --hard <id>` leaves a fingerprint, and `sam purge <id>` also removes the copies in raw events, the vault and digests.

### A memory disappeared

It was probably superseded by a newer value on the same subject, merged as a near-duplicate, or archived by gc. `sam ls --all` shows retired rows with `(→id)`. If an agent or a team file wrote it, it may also be held for review: check `sam review`.

### `sam doctor` says "N held for review"

The write guard held agent or team writes that looked like prompt injection, or that went over the write caps. Look at them with `sam review`, then `sam review approve <id>` or `sam review reject <id>`. Unapproved rows are deleted after 14 days.

### "DB problem" or "database disk image is malformed"

Run `sam doctor --repair`. It rebuilds the search indexes, or moves the damaged file aside (`sam.db.corrupt-<ts>`) and salvages every readable row into a fresh database.

### "DB schema N is NEWER than this SAM"

A newer SAM wrote this database. The older one opens it read-only so nothing is damaged: searches and cards work, but nothing is saved. Upgrade SAM and run `sam install` again.

### "journal: rollback (not WAL)" or a shared-filesystem warning

The database is on a network, WSL `/mnt/…` or cloud-sync folder, where SQLite's WAL mode is unsafe. Move `SAM_HOME` to a local disk (one per environment). If you know the mount is local, set `SAM_ALLOW_SHARED_FS=1`.

### `sam run` refuses my command

A single argument containing `; & | < >` or `$(` is a whole shell program. Pass the command as separate words (`sam run -- npm test`), or opt in explicitly with `sam run --shell -- "npm test && npm run lint"`.

### `sam embed` says embeddings are off

Set both `embedUrl` and `embedModel`, in `~/.sam/config.json` or with `SAM_EMBED_URL` / `SAM_EMBED_MODEL` for a localhost endpoint. Embeddings are not created at save time, so re-run `sam embed` after adding memories.

### Config changes have no effect

Hooks and the MCP server read the configuration when they start, so changes apply from the next session. Run `sam doctor` to see config warnings (unknown keys, wrong types). Remember that environment variables override `config.json`.

### How do I remove everything?

Run `sam uninstall --all` to remove every host entry, then delete `~/.sam` (or your `SAM_HOME`) to remove the database. Finally remove the package (`npm rm -g super-agent-memory`, or `npm unlink` in your clone). To erase specific content but keep the rest, use `sam purge`.

## Still stuck?

Open an issue with the output of `sam doctor` and `sam --version`: <https://github.com/cumabozkurt/super-agent-memory/issues>. Report security issues privately as described in [SECURITY.md](../SECURITY.md).
