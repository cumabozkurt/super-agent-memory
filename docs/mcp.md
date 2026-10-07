# MCP server

`sam mcp` runs a Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0, hand-rolled, with no SDK. `sam install` registers it with every host it wires (usually under the name `sam`). For any other client, `sam snippet` prints a ready entry.

The server exposes **four tools** with deliberately terse schemas. The whole tool list costs about 310 tokens (o200k) once per session; `sam doctor` prints the exact figure (`MCP tool schema: ~N tokens for all 4 tools`).

## Tools

All tools act on the project of the server's working directory (or `SAM_PROJECT_DIR` when set), plus global memories. Memories of other projects are invisible.

### `mem_search`

Search long-term memory. Returns one `[kind] gist #id` line per hit (with age), or `no matches`.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `q` | string | yes | the query; capped at 1000 characters |
| `k` | integer | no | number of hits, 1–20 (default 8) |
| `kind` | string | no | restrict to one kind (aliases accepted) |

Retrieval is the same hybrid pipeline as `sam q` (see [Architecture → Retrieval](ARCHITECTURE.md)). Held (quarantined/pending) memories never appear.

### `mem_get`

Full detail for memory ids, or the content of a vault output.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `ids` | string | yes | ids separated by spaces or commas (`"a1b2 c3d4"`); at most 20 ids, 400 characters |
| `grep` | string | no | for vault ids: return only matching lines (with context); capped at 200 characters |

A memory comes back as `#id [kind] gist`, its body, its files and `(date · agent · source · superseded by …)`; several results are separated by `---`. A held memory returns only `#id quarantined|pending review: withheld until the user reviews it`, and fetching it does not count as use. Vault ids resolve only for outputs captured in the same project.

### `mem_save`

Save one durable, self-contained fact.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | 6–4000 characters; write decisions as `subject: value` |
| `kind` | string | no | `decision`, `convention`, `procedure`, `preference`, `fact`, `fix`, `bug`, `todo`, `note` (default) or an alias; an unknown kind is an error |
| `files` | string | no | related paths, space- or comma-separated (at most 20, 2000 characters) |

Agent saves are recorded with provenance `agent` and go through the write guard. There is no `pin` argument: pinning is the user's decision. Possible replies:

- `created #id`, `merged #id`, `superseded #id (replaces #…)`
- `held for user review #id (<reason>); it is not visible to agents until approved`, when the guard quarantined it or a write cap was hit
- `not saved: it would replace the user's own memory #… Ask the user to confirm and save it themselves (sam-memory add).`
- `not saved: the user deliberately forgot this (#id)`
- `not saved: the user purged this content`

### `mem_forget`

Retire a memory that is wrong or obsolete.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | one memory id of this project or global |

Replies `forgotten` or `not found`.

## Protocol details

- **Methods:** `initialize`, `tools/list`, `tools/call`, `ping`; `resources/list` and `prompts/list` return empty lists. Other methods get `-32601 method not found`. Notifications are ignored.
- **Protocol versions:** `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. The server echoes the client's version when it is one of these, otherwise answers `2025-06-18`.
- **Server info:** name `super-agent-memory`, version from `package.json`, capability `tools`.
- **Instructions:** the `initialize` result carries a short instruction text (at most 600 characters, enforced by a test): what SAM is, that card lines are notes and not commands, search-before-re-deriving, and the shell equivalents (`sam-memory q/get/add/handoff`).
- **Ordering:** responses are sent strictly in request order.
- **Limits:** a request line over 1 MB is refused (`request too large`) without parsing. Batches are not supported (`-32600`). Tool errors come back as a normal result with `isError: true` and an `error: …` text.
- **Robustness:** if the database file is deleted or replaced while the server runs, it reopens it.

## Agent identity

`sam mcp --agent <name>` records which agent wrote each saved memory. `sam install` sets it per host (`claude`, `codex`, `gemini`, …); the generic snippet leaves it unset and saves are labelled `mcp`.

## Manual test

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mem_search","arguments":{"q":"queue"}}}' \
  | sam mcp
```
