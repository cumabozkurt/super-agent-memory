# SAM host-integration audit (checked against official docs and source, 2026-10-07)

Repo audited: `super-agent-memory` at commit `670b9b4`.
Files read: `src/install.js`, `src/hooks.js` (`normalize()`, `reply()`, `runHook()`), `src/capture.js` (`EDIT_TOOLS`/`CMD_TOOLS`/`READ_TOOLS`, `pathsFromInput`, `cmdFromInput`, `outputText`, `outcome`, `harvestTranscript`), `plugins/opencode/sam-memory.js`, `src/cli.js` (how hook output is printed: an empty `{}` reply prints **nothing**).

Verdicts: **OK** = matches the current spec. **WRONG** = wrong, deprecated, or silently fails. **UNVERIFIED** = no official source found; nothing assumed.
All sources were fetched on 2026-10-07. "src:" means a file in the host's GitHub repo on its default branch.

---

## 1. Claude Code

Sources: hooks reference https://code.claude.com/docs/en/hooks · tools reference https://code.claude.com/docs/en/tools-reference · MCP https://code.claude.com/docs/en/mcp · skills https://code.claude.com/docs/en/skills

| Item | What SAM does | Official spec | Verdict | Exact fix |
|---|---|---|---|---|
| Hook config file | `~/.claude/settings.json` → `hooks.{Event}[{matcher?, hooks:[{type:"command",command,timeout}]}]` | Same three-level shape (hooks ref, "Configuration") | OK | — |
| Timeout units | `timeout: 10` | Seconds. Defaults: 600 for most events, 30 for UserPromptSubmit. SessionEnd shares a 1.5 s budget that grows to match a longer per-hook timeout, up to 60 s (hooks ref, "Common fields") | OK | — |
| Matcher semantics | `"Edit\|MultiEdit\|Write\|NotebookEdit\|Bash\|Read"` | A value made only of letters, digits, `_`, `-`, `,`, `\|` is matched as a list of exact names; anything else is an unanchored JS regex (hooks ref, "Matcher patterns") | OK | — |
| PostToolUse tool list | Has no `PowerShell`; has `MultiEdit` | Built-in tools today: `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `Read`, `Monitor`, … **There is no `MultiEdit`.** The docs say to "Match `Bash\|PowerShell` in hooks that inspect shell commands", and on Windows without Git Bash the Bash tool isn't registered at all (tools ref, PowerShell tool) | WRONG | Matcher → `"Edit\|Write\|NotebookEdit\|Bash\|PowerShell\|Read"`. In `capture.js` add `powershell` to `CMD_TOOLS`. `MultiEdit` is harmless dead weight. |
| Failed tool calls | Only `PostToolUse` is registered | `PostToolUse` fires **only after a tool succeeds**. A Bash command that exits non-zero fires **`PostToolUseFailure`**, with `error` = `"Exit code N\n<output>"` and `is_interrupt` (hooks ref, PostToolUseFailure) | **WRONG**: failed commands are never recorded on Claude, so `detectFix()` (error→fix memories) can never trigger | Register `PostToolUseFailure: [{matcher:"Bash\|PowerShell", hooks:[hook('claude','PostToolUseFailure')]}]`. In `normalize()` map `posttoolusefailure` → `'tool'`, set `ok=false` and `response={error:p.error}`. |
| SessionStart matcher | `startup\|resume\|clear\|compact` | `source` can also be **`fork`** (sessions created with `--fork-session`) | WRONG (minor) | Add `fork`, or drop the matcher. |
| Stdin fields | `session_id`, `cwd`, `transcript_path`, `source`, `prompt`, `tool_name`, `tool_input`, `tool_response` | Same names. `tool_response` is the tool's structured Output (for example `{filePath,type}` for Write; Bash has `stdout`/`stderr`/`interrupted`). Write/Edit/Read put an absolute path in `tool_input.file_path` | OK | — |
| Stop payload | Harvests markers from `transcript_path` | Stop and SubagentStop now carry **`last_assistant_message`**. The docs warn that "the transcript file isn't guaranteed to include the final message at Stop time" | WRONG (markers from the last turn can be missed) | In `runHook` `case 'stop'`, also run `harvestMarkersFromText(p.last_assistant_message)`; pass `p` or that field through `normalize()`. |
| Reply: SessionStart / UserPromptSubmit / PostToolUse | `{hookSpecificOutput:{hookEventName, additionalContext}}` | Matches. Capped at 10,000 characters; anything longer is written to a file and only a preview is passed (hooks ref, "Add context for Claude") | OK | — |
| Reply: Stop / PreCompact / SessionEnd | Prints nothing (an empty reply prints nothing) | On Stop, `additionalContext` or `decision:"block"` would **continue the turn**. Printing nothing is correct | OK | Never send context on Stop. |
| User-scope MCP | `claude mcp add --scope user sam -- node sam.js mcp …`, falling back to top-level `mcpServers.sam={type:"stdio",…}` in `~/.claude.json` | User scope is stored in `~/.claude.json` (top-level) (MCP doc, "User scope") | OK | (Optional) respect `CLAUDE_CONFIG_DIR`. |
| Skills dir | `~/.claude/skills/sam-memory/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` (skills doc) | OK | — |
| Transcript format | JSONL lines; skips objects whose `role`/`type` is `user` | Transcript is JSONL (`…/.claude/projects/…/<id>.jsonl`), written asynchronously | OK, with the caveat above | — |
| **Side effect in Cursor** | Claude hooks in `~/.claude/settings.json` | Cursor loads `~/.claude/settings.json` hooks **by default** ("Include Third-Party Plugins, Skills, and Other Configs", on by default) and maps them to its own events (https://cursor.com/docs/reference/third-party-hooks) | WRONG (misattribution) | See Cursor section: when `p.cursor_version` is present, treat the call as `agent='cursor'`. If native Cursor hooks are also installed, make the claude-tagged call a no-op. |

---

## 2. OpenAI Codex CLI

Sources: hooks https://developers.openai.com/codex/hooks · config reference https://developers.openai.com/codex/config-file/config-reference · skills https://developers.openai.com/codex/build-skills · AGENTS.md https://developers.openai.com/codex/agent-configuration/agents-md · generated schemas https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated · src: `codex-rs/core/src/tools/handlers/apply_patch.rs`, `codex-rs/core/src/tools/context.rs`, `codex-rs/core/src/tools/handlers/unified_exec.rs`, `codex-rs/ext/skills/src/host_roots.rs`

| Item | What SAM does | Official spec | Verdict | Exact fix |
|---|---|---|---|---|
| Feature flag | Writes `[features] codex_hooks = true` | "Hooks are enabled by default … Use `hooks` as the feature key. `codex_hooks` still works as a deprecated alias." Config ref: `features.hooks`; "`features.codex_hooks` is a deprecated alias" | WRONG (deprecated) | Write nothing (hooks default on). If a key is needed, use `hooks = true`. Leave a user's `hooks = false` alone. |
| Hook file | `~/.codex/hooks.json` `{hooks:{Event:[{matcher?,hooks:[{type,command,timeout}]}]}}` | `~/.codex/hooks.json` or inline `[hooks]` in `config.toml`, same three levels | OK | — |
| **Hook trust** | Nothing | "Non-managed hooks must be reviewed and trusted before they run … new or changed hooks are marked for review and skipped until trusted." Trust is recorded against the hook's hash; review is done in `/hooks` | **WRONG**: after `sam install codex`, **no SAM hook runs** until the user trusts them. Any change to the command (for example a new Node path) needs trust again | `install` should print: "Open Codex and run `/hooks` to trust the 5 SAM hooks." (`--dangerously-bypass-hook-trust` exists for one-off automation.) Keep the command string stable, e.g. a stable shim path instead of `process.execPath`. |
| Timeout units | `10` | Seconds; default 600. `SessionEnd`/`Interrupt` default to 1 s, maximum 3 s | OK | If SessionEnd is added, use `timeout ≤ 3`. |
| Matcher semantics | SessionStart `startup\|resume\|clear\|compact`; PostToolUse has no matcher | Regex. SessionStart sources are exactly `startup\|resume\|clear\|compact`. PostToolUse matches `tool_name` plus aliases (`apply_patch` also matches `Edit`/`Write`; `exec_command` matches `Bash`) | OK | (Optional) PostToolUse matcher `Bash\|apply_patch`, so SAM doesn't spawn Node for every MCP or function tool. |
| Events | SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop | Also `PostCompact`, `SessionEnd`, `SubagentStart/Stop`, `Interrupt`, `PermissionRequest` | OK (gap) | (Optional) add `SessionEnd` (timeout ≤ 3) so `endSession` runs once at the true end. |
| Common stdin | `session_id`, `cwd`, `transcript_path`, `source`/`trigger`, `prompt` | `session_id`, `transcript_path` (may be null), `cwd`, `hook_event_name`, `model`, plus `turn_id` and `permission_mode` | OK | — |
| PostToolUse `tool_name` | Regexes include `apply_patch`, `bash`, `exec_command`, `shell`, `local_shell` | Canonical names: **`Bash`** (both shell and unified exec) and **`apply_patch`**; MCP tools are `mcp__server__tool` | OK | — |
| **apply_patch `tool_input`** | `pathsFromInput()` looks at `file_path…`, then patch text only in `patch`/`input`/`content` | Source: `tool_input: json!({"command": <patch text>})` (`apply_patch.rs`). The docs agree: "`Bash` and `apply_patch` use `tool_input.command`" | **WRONG**: no edited paths are ever extracted on Codex, so there are no edit events, no `fileContext` injection, and no fix detection | In `capture.js` `pathsFromInput`, change `pick(input, ['patch','input','content'])` to `pick(input, ['patch','patchText','command','input','content'])`. The `*** Update/Add/Delete File:` regex then works. |
| Bash `tool_input` / `tool_response` | `cmdFromInput` reads `command`; `outcome()` parses text | `tool_input = {"command": "<string>"}`. `tool_response` is a **plain string** (truncated model output, no structured exit code; `context.rs`). No PostToolUse is sent while the process is still running (`process_id` set) | OK (heuristic exit detection) | — |
| Reply: SessionStart / UserPromptSubmit | `hookSpecificOutput.additionalContext` | Supported; added as developer context. Default spill limit about 2,500 tokens per handler (`additionalContextLimit`) | OK | (Optional) set `additionalContextLimit` on SAM handlers if the session card can be larger. |
| Reply: PostToolUse `additionalContext` | Sends `hookSpecificOutput{hookEventName:"PostToolUse",additionalContext}` | **Accepted**: the output schema has `additionalContext` (post-tool-use.command.output.schema.json), "added as extra developer context" | OK | — |
| Reply: Stop / PreCompact | Prints nothing | "Exit 0 with no output is treated as success." `decision:"block"` on Stop would start a new continuation prompt, and `continue:false` on PreCompact cancels compaction, so SAM must never send them | OK | — |
| MCP | `[mcp_servers.sam] command=… args=[…]` in `~/.codex/config.toml` | `mcp_servers.<id>.command` (string) and `.args` (array) | OK | — |
| Rules file | `~/.codex/AGENTS.md` block | Global: `$CODEX_HOME/AGENTS.md` (default `~/.codex`). **If `AGENTS.override.md` exists, only that file is used** | OK (caveat) | Respect `CODEX_HOME`. Warn, or also write to `AGENTS.override.md` when that file exists. |
| Skills dir | `~/.codex/skills/sam-memory/SKILL.md` | The documented user location is **`$HOME/.agents/skills`**. Source: `$CODEX_HOME/skills` is "Deprecated user skills location … kept for backward" compatibility (`host_roots.rs`) | WRONG (deprecated) | Write `~/.agents/skills/sam-memory/SKILL.md`. Gemini CLI and OpenCode read the same path, so one file covers three hosts. Remove the old copy on install. |
| Transcript | Harvested line by line; skips objects whose `role`/`type` is `user` | "the transcript format isn't a stable interface for hooks and may change" | UNVERIFIED | Prefer `last_assistant_message` on Stop (documented for Codex too) over parsing the rollout. Rollout lines that carry tool output or `user_message` events are not filtered by the `role==='user'` check, so example markers in tool output (for example a `cat` of SAM's own SKILL.md) can be harvested. |

---

## 3. Gemini CLI

Sources: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md · `docs/hooks/index.md` · src: `packages/core/src/hooks/types.ts`, `hooks/hookPlanner.ts`, `tools/definitions/base-declarations.ts`, `services/chatRecordingService.ts` · `docs/cli/skills.md` · `docs/reference/configuration.md`

| Item | What SAM does | Official spec | Verdict | Exact fix |
|---|---|---|---|---|
| Hook config | `~/.gemini/settings.json` `hooks.{Event}[{matcher, hooks:[{name,type,command,timeout}]}]` | Same; `name` is optional and used by `/hooks enable <name>` | OK | — |
| Timeout units | `10000` | **Milliseconds** (default 60000) | OK | — |
| Matcher `*` on lifecycle events | `matcher:"*"` | `hookPlanner.ts`: `if (matcher === '' \|\| matcher === '*') return true` | OK | — |
| AfterTool matcher | `write_file\|replace\|edit\|run_shell_command\|read_file` | Unanchored regex. Real names: `write_file`, `replace`, `read_file`, `read_many_files`, `run_shell_command` (`base-declarations.ts`). `edit` is not a tool | OK (`edit` is dead weight) | (Optional) add `read_many_files`. |
| Hooks enabled / trust | — | On by default; only **project** hooks need trust | OK | — |
| Events used | SessionStart, BeforeAgent, AfterTool, PreCompress, AfterAgent, SessionEnd | All exist (`HookEventName` enum) | OK | — |
| Stdin fields | `session_id`, `cwd`, `transcript_path`, `prompt`, `tool_name`, `tool_input`, `tool_response`, `source`/`trigger` | Base: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`. AfterTool: `tool_name`, `tool_input`, `tool_response{llmContent,returnDisplay,error}`. SessionStart `source` ∈ startup/resume/clear (**no `compact`**). PreCompress `trigger` | OK | — |
| Tool args | `pick(file_path, …)`, `command` | `file_path` (read_file, write_file, replace), `command` (shell). `read_many_files` takes `include` globs, not paths | OK | — |
| Reply: SessionStart / BeforeAgent / AfterTool | `hookSpecificOutput{hookEventName:'SessionStart'\|'BeforeAgent'\|'AfterTool', additionalContext}` | All three accept `hookSpecificOutput.additionalContext` (`types.ts` SessionStartOutput, BeforeAgentOutput, AfterToolOutput) | OK | — |
| Reply: AfterAgent | Prints nothing | `decision:"deny"` forces a retry; `continue:false` stops. Nothing is correct | OK | — |
| PreCompress / SessionEnd | Harvest + end | Both are advisory/asynchronous, and the CLI "will not wait" for SessionEnd | OK | — |
| Re-inject after compression | Relies on SessionStart with `source:"compact"` (Claude/Codex logic) | Gemini has no compact source and no post-compress event | OK (gap) | Accept, or emit the card again on the first BeforeAgent after PreCompress. |
| Marker harvest at turn end | Reads `transcript_path` | AfterAgent gives **`prompt_response`** (final text). Transcript is now **JSONL** (`chatRecordingService.ts` writes `session-*.jsonl`, `appendFileSync`); model messages have `type:'gemini'`, and tool results are in `toolCalls[].result` (functionResponse) | WRONG (tool-output text can be harvested as markers; the file can also be fully rewritten) | In `case 'stop'`, harvest from `p.prompt_response` for Gemini and skip the transcript, or skip `toolCalls` subtrees. |
| MCP | `mcpServers.sam={command,args,timeout:15000}` | `timeout` in ms | OK | — |
| Rules | `~/.gemini/GEMINI.md` block | Global context file `~/.gemini/GEMINI.md` | OK | Note: Antigravity also reads `~/.gemini/GEMINI.md`, so with both installed the rules block is loaded twice there. |
| Skills | None installed | User skills: `~/.gemini/skills/` or **`~/.agents/skills/`** (`docs/cli/skills.md`) | OK (gap) | Covered by moving the Codex skill to `~/.agents/skills`. |

---

## 4. Google Antigravity (2.0 / CLI / IDE)

Sources: https://antigravity.google/docs/hooks · https://antigravity.google/docs/mcp · https://antigravity.google/docs/rules · https://antigravity.google/docs/skills

| Item | What SAM does | Official spec | Verdict | Exact fix |
|---|---|---|---|---|
| Hook file | `~/.gemini/config/hooks.json` | Global for 2.0, CLI and IDE: `~/.gemini/config/hooks.json`. The CLI also accepts `~/.gemini/antigravity-cli/settings.json`; workspace hooks go in `.agents/hooks.json` | OK | — |
| Named-group format | `{"super-agent-memory":{PreInvocation:[handler], PostToolUse:[{matcher,hooks:[handler]}], Stop:[handler]}}` | Top level maps hook names to events. PreToolUse/PostToolUse use `{matcher,hooks:[…]}`. **PreInvocation, PostInvocation and Stop take a flat list of handlers**; `enabled` is optional | OK | — |
| Handler / timeout | `{type:"command",command,timeout:10}` | `type` optional (only `command`); `timeout` in **seconds**, default 30 | OK | — |
| PostToolUse matcher | `write_to_file\|replace_file_content\|multi_replace_file_content\|run_command\|view_file` | Regex; the documented tool names match exactly | OK | — |
| Common stdin (camelCase) | `conversationId`, `workspacePaths[0]`, `transcriptPath` | `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName` | OK | — |
| PostToolUse stdin | `toolCall.name`, `toolCall.args`, `error` → `ok=!error` | `toolCall{name,args}`, `stepIdx`, `error` (empty on success) | OK | — |
| Tool args | `TargetFile`, `AbsolutePath`, `CommandLine` | write_to_file/replace_file_content/multi_replace_file_content use `TargetFile`; view_file uses `AbsolutePath`; run_command uses `CommandLine` (+`Cwd`) | OK | — |
| Tool output | Only `error` is available | No output field is sent to PostToolUse | OK (limit) | — |
| PreInvocation stdin | `invocationNum` (session card injected when it is 0) | `invocationNum` ("0-indexed sequence number of the current model invocation") and `initialNumSteps` | UNVERIFIED | The docs don't say whether `invocationNum` resets on each user turn. If it does, the session card is re-injected every turn. Guard with a per-session "card sent" flag in the DB rather than `num===0`. |
| PreInvocation reply | `{injectSteps:[{ephemeralMessage:ctx}]}`; prints nothing when there is no context | `injectSteps` (optional) entries with `toolCall` / `userMessage` / `ephemeralMessage` | OK (empty stdout is UNVERIFIED) | For safety, print `{}` instead of nothing on Antigravity (cli.js skips empty objects). |
| PostToolUse reply | Prints nothing | "Returns an empty JSON object `{}`" | UNVERIFIED that empty stdout is accepted | Print `{}` for antigravity. |
| Stop | Skips when `fullyIdle===false`; replies `{decision:"allow"}` | `fullyIdle` is required. `decision:"continue"` re-enters the loop; "Any other value allows the stop" | OK | — |
| Transcript | `lastUserMessage()` / harvest guess fields (`role`, `type`, `userMessage`, …) | Path `<app_data_dir>/brain/<id>/.system_generated/logs/transcript.jsonl`; **the line schema is not documented** | UNVERIFIED | Inspect a real transcript before relying on prompt recall or marker harvest. |
| MCP | `~/.gemini/config/mcp_config.json` `mcpServers.sam={command,args}`; also the legacy `~/.gemini/antigravity/mcp_config.json` if that folder exists | Global file is `~/.gemini/config/mcp_config.json` (all surfaces); stdio uses `command` + `args` | OK (legacy copy UNVERIFIED) | (Optional) stop writing the legacy file to avoid a possible duplicate server. |
| Rules | `~/.gemini/config/rules/sam-memory.md` with `trigger: always_on` + `description` | Modular global rules in `~/.gemini/config/rules/*.md`, frontmatter required, `trigger` ∈ always_on/model_decision/glob/manual. `~/.gemini/GEMINI.md` is also always loaded | OK (duplicate with Gemini's GEMINI.md block when both are installed) | Skip the modular rule when the Gemini GEMINI.md block exists, or skip GEMINI.md and keep the rule. |
| Skills | None installed | Global: `~/.gemini/config/skills/<name>/` (2.0 and IDE; legacy `~/.gemini/antigravity/skills/`), and `~/.gemini/antigravity-cli/skills/<name>/` (CLI) | OK (gap) | Add `SKILL.md` to `~/.gemini/config/skills/sam-memory/` and `~/.gemini/antigravity-cli/skills/sam-memory/`. |

---

## 5. OpenCode

Sources: https://opencode.ai/docs/plugins/ · https://opencode.ai/docs/mcp-servers/ · https://opencode.ai/docs/rules/ · https://opencode.ai/docs/skills/ · https://opencode.ai/docs/config/ · src (repo moved: `sst/opencode` → **`anomalyco/opencode`**, branch `dev`): `packages/plugin/src/index.ts`, `packages/opencode/src/session/prompt.ts`, `session/status.ts`, `session/session.ts`, `session/compaction.ts`, `session/message-v2.ts`, `id/id.ts`, `tool/apply_patch.ts`, `tool/shell.ts`, `tool/shell/id.ts`, `tool/edit.ts`, `tool/write.ts`, `tool/read.ts`

| Item | What SAM does | Official spec | Verdict | Exact fix |
|---|---|---|---|---|
| Config file | `~/.config/opencode/opencode.jsonc` if present, else `opencode.json` | Global config `~/.config/opencode/opencode.json` (`.jsonc` accepted) | OK, but **JSONC comments are lost**: `readJson` strips comments and `writeJson` writes plain JSON | Edit JSONC surgically, or write SAM's server to a separate file and avoid rewriting the user's JSONC. |
| MCP entry | `mcp.sam={type:"local",command:[node,sam.js,"mcp","--agent","opencode"],enabled:true}` | `type:"local"` (required), `command` = **array** (required), `enabled`, `environment`, `timeout` (ms, default 5000 for fetching tools) | OK | (Optional) `timeout: 15000` in case SQLite cold start is slow. |
| Plugin location | `~/.config/opencode/plugins/sam-memory.js` | Global plugin dir `~/.config/opencode/plugins/` | OK | — |
| `chat.message` signature | `(input,output)`, reads `input.sessionID` and `output.parts`, pushes a text part | `input:{sessionID, agent?, model?, messageID?, variant?}`, `output:{message:UserMessage, parts:Part[]}`. It runs **before** parts are saved (`prompt.ts` triggers it, then `updatePart` for each part) | OK | — |
| Injected part | `{id:'prt_sam…', sessionID, messageID, type:'text', text, synthetic:true}` | IDs must start with `prt` (`id.ts`). Text parts reach the model unless `ignored` (`message-v2.ts`); `synthetic` only hides them in the UI | OK | — |
| `tool.execute.after` signature | Reads `input.tool`, `input.sessionID`, `input.callID`; args come from a `tool.execute.before` map; `output.output`, `output.metadata.exit` | `input:{tool, sessionID, callID, **args**}`, `output:{title, output, metadata}`; the shell sets `metadata.exit` | OK | (Simplify) use `input.args` and drop the before-map. |
| Tool names | `bash`, `edit`, `write`, `read`, `apply_patch`, `patch` | `bash` (ID kept as "bash" for pwsh/cmd too), `edit`, `write`, `read`, `apply_patch` | OK | — |
| **apply_patch args** | Patch text looked up in `patch`/`input`/`content` | `apply_patch` arg is **`patchText`** (`tool/apply_patch.ts`) | **WRONG**: edits made through apply_patch (the default for GPT models) record no paths | Add `'patchText'` to the `pick()` list in `pathsFromInput` (same edit as the Codex fix). |
| File args | `filePath` | `filePath` (edit/write/read) | OK | — |
| `experimental.session.compacting` | `output.context.push(card)` | `input:{sessionID}`, `output:{context:string[], prompt?}`. The `context` strings are **appended to the compaction prompt** given to the summariser; they are not kept as context afterwards | OK (semantics differ) | The re-inject on `session.compacted`, which clears `started`, is the part that actually restores the card. Pushing the card is optional. |
| Events | `session.idle {sessionID}`, `session.deleted {sessionID \| info.id}`, `session.compacted {sessionID}` | `Idle {sessionID}` (status.ts), `Deleted {sessionID, info}` (session.ts), `Compacted {sessionID}` (compaction.ts) | OK | — |
| **Marker harvest** | `Stop` is sent with only `{session_id,cwd}`, so there is no transcript | No transcript path exists for plugins | **WRONG**: ⟦mem⟧ markers are **never harvested** on OpenCode | On `session.idle`, fetch the last assistant text through the plugin `client` (session messages API) or collect text parts from `message.part.updated`, and send it as `last_assistant_message`. Teach `runHook` to harvest that field. |
| **Global rules** | Writes a block into `~/.config/opencode/AGENTS.md` (creating the file if missing) | "`~/.config/opencode/AGENTS.md` takes precedence over `~/.claude/CLAUDE.md`. The first matching file wins" | **WRONG (side effect)**: if the user had no OpenCode AGENTS.md, creating one **silently turns off their `~/.claude/CLAUDE.md`** in OpenCode | If `~/.config/opencode/AGENTS.md` doesn't exist, write `~/.config/opencode/sam-memory.md` and add it to `"instructions": [...]` in opencode.json(c) instead. |
| Skills | None for OpenCode | Global skills come from `~/.config/opencode/skills/`, `~/.claude/skills/` **and `~/.agents/skills/`** | OK | Already covered by the Claude skill and by the `~/.agents/skills` move. |
| Note | — | The site says "OpenCode v2 is now available". The plugin API above is current `dev` | — | Re-check on the v2 release notes when shipping. |

---

## 6. Cursor

Sources: hooks https://cursor.com/docs/hooks · third-party hooks https://cursor.com/docs/reference/third-party-hooks · MCP https://cursor.com/docs/mcp

| Item | What SAM does | Official spec | Verdict | Exact fix |
|---|---|---|---|---|
| MCP file | `~/.cursor/mcp.json` `mcpServers.sam={command,args}` | Global `~/.cursor/mcp.json`. The stdio field table lists **`type: "stdio"` as required**, although some examples on the same page leave it out | WRONG (minor; docs conflict) | Add `"type":"stdio"`. |
| Does Cursor have hooks that inject context? | SAM installs none (`normalize()` already has partial Cursor event names) | **Yes.** `~/.cursor/hooks.json` `{ "version": 1, "hooks": { "<event>": [ {command, matcher?, timeout(seconds), failClosed?, loop_limit?} ] } }`. Context injection: **`sessionStart` → `{"additional_context": "…"}`** (fire-and-forget, added to the initial system context), **`postToolUse` / `postToolUseFailure` → `{"additional_context":"…"}`** (added after the tool result). `beforeSubmitPrompt` **cannot** inject: its output is only `{continue, user_message}` | Gap | Add the config below. |
| Stdin (common) | Session read from `session_id`/`sessionId`/`conversationId`; cwd from `workspace_roots[0]` | Common fields: **`conversation_id`** (snake_case), `generation_id`, `hook_event_name`, `cursor_version`, `workspace_roots`, `transcript_path` (may be null), `model`. Only sessionStart/sessionEnd also carry `session_id` (= conversation_id) | **WRONG**: every Cursor event except session start/end gets `session=null` | In `normalize()`, add `p.conversation_id` to the `session` chain. |
| postToolUse stdin | `tool_name`, `tool_input`, `tool_output` | `tool_name` ∈ `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:<name>`; `tool_input` (object, e.g. `{command, working_directory}`); **`tool_output` is a JSON-stringified payload** such as `"{\"exitCode\":0,\"stdout\":…}"`; also `cwd`, `duration` | WRONG: `outcome()` regex doesn't match `exitCode` inside the string, and `outputText` treats it as plain text | `if (typeof p.tool_output==='string') try { response = JSON.parse(p.tool_output) } catch {}`. `outcome()` already reads `exitCode`. |
| Write/Read `tool_input` field names | `file_path`, `path`, … | Not documented for postToolUse (afterFileEdit and beforeReadFile use `file_path`) | UNVERIFIED | Keep the multi-key `pick`; check against a real payload. |
| afterShellExecution / afterFileEdit | Mapped in `normalize()` (`command`, `output`, `file_path`) | `afterShellExecution{command, output, duration, sandbox}`, `afterFileEdit{file_path, edits[]}` | OK | Prefer `postToolUse` with matcher `Shell\|Write\|Read` instead of both (avoids recording the same call twice). |
| Turn-end text | — | `afterAgentResponse{text}` gives the final assistant text; `stop{status, loop_count}`; never return `followup_message` | Gap | Use `afterAgentResponse` for marker harvest. |
| Claude-hook import | — | Cursor runs `~/.claude/settings.json` hooks by default and supports Claude's nested `hookSpecificOutput` replies (explicitly documented for PreToolUse and Stop; for SessionStart/PostToolUse `additionalContext` it is **UNVERIFIED**) | WRONG (double fire / misattribution) | In `runHook`: `if (agent==='claude' && p.cursor_version) agent='cursor'`. If native Cursor hooks are installed, return no-op for those claude-tagged calls. |

**Exact `~/.cursor/hooks.json` SAM can add** (merge into `hooks`, keep `version:1`). User hooks run from `~/.cursor/`, so use absolute paths:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":       [{ "command": "<NODE> <SAM_JS> hook sessionStart --agent cursor", "timeout": 10 }],
    "beforeSubmitPrompt": [{ "command": "<NODE> <SAM_JS> hook beforeSubmitPrompt --agent cursor", "timeout": 10 }],
    "postToolUse":        [{ "command": "<NODE> <SAM_JS> hook postToolUse --agent cursor", "matcher": "Shell|Write|Read", "timeout": 10 }],
    "postToolUseFailure": [{ "command": "<NODE> <SAM_JS> hook postToolUseFailure --agent cursor", "matcher": "Shell", "timeout": 10 }],
    "afterAgentResponse": [{ "command": "<NODE> <SAM_JS> hook afterAgentResponse --agent cursor", "timeout": 10 }],
    "preCompact":         [{ "command": "<NODE> <SAM_JS> hook preCompact --agent cursor", "timeout": 10 }],
    "stop":               [{ "command": "<NODE> <SAM_JS> hook stop --agent cursor", "timeout": 10 }],
    "sessionEnd":         [{ "command": "<NODE> <SAM_JS> hook sessionEnd --agent cursor", "timeout": 10 }]
  }
}
```

The `reply()` branch Cursor needs (flat snake_case):

- sessionStart / postToolUse / postToolUseFailure → `{"additional_context": ctx}`, or nothing when there is no context.
- beforeSubmitPrompt → nothing, or `{"continue": true}`. **Never** return `continue:false`. Capture the prompt only; per-prompt recall is not possible on Cursor.
- stop / preCompact / sessionEnd / afterAgentResponse → nothing.

`normalize()` additions:

- `session = p.conversation_id`
- `posttoolusefailure` → tool, `ok=false`
- `afteragentresponse` → harvest markers from `p.text`
- parse `tool_output` as JSON.

---

## Summary: all WRONG items and fixes

1. **Claude: failures not captured.** Register `PostToolUseFailure` (matcher `Bash|PowerShell`). Map `posttoolusefailure` → tool with `ok=false`, `response={error:p.error}`. Without this, `detectFix` never fires on Claude.
2. **Claude: PowerShell missing.** Matcher → `Edit|Write|NotebookEdit|Bash|PowerShell|Read`; add `powershell` to `CMD_TOOLS`. (`MultiEdit` no longer exists; harmless.)
3. **Claude: SessionStart matcher** is missing `fork`. Add it, or drop the matcher.
4. **Claude/Codex/Gemini: turn-end harvest.** Use `last_assistant_message` (Claude/Codex Stop) and `prompt_response` (Gemini AfterAgent) instead of, or in addition to, the transcript. The Claude docs warn the transcript may lag at Stop. Gemini's JSONL tool results can leak example markers.
5. **Codex: `apply_patch` paths never extracted.** `tool_input` is `{command: "<patch>"}`. Add `command` (and `patchText`) to the `pick()` keys in `pathsFromInput`.
6. **Codex: hook trust.** Hooks are skipped until the user trusts them in `/hooks`. `sam install codex` must say so, and should use a stable command path so trust survives Node upgrades.
7. **Codex: feature flag.** `codex_hooks` is a deprecated alias and hooks are on by default. Remove it, or write `hooks = true`.
8. **Codex: skills path.** `~/.codex/skills` is deprecated. Write `~/.agents/skills/sam-memory/SKILL.md`, which Codex, Gemini CLI and OpenCode all read.
9. **OpenCode: `apply_patch` arg is `patchText`.** Add it to `pathsFromInput`.
10. **OpenCode: markers never harvested** (no transcript is passed). Send the assistant text from `session.idle` through the plugin client.
11. **OpenCode: creating `~/.config/opencode/AGENTS.md` turns off `~/.claude/CLAUDE.md`.** When the file doesn't already exist, use `"instructions"` with a separate file instead.
12. **OpenCode: JSONC comments destroyed** when SAM rewrites `opencode.jsonc`.
13. **Cursor: session id not read.** Add `p.conversation_id` to `normalize()`.
14. **Cursor: `tool_output` is a JSON string.** Parse it so `exitCode` is used.
15. **Cursor: SAM's Claude hooks also run inside Cursor** (third-party import is on by default) tagged `--agent claude`. Detect `p.cursor_version`, re-tag as `cursor`, and avoid double-firing once native hooks exist.
16. **Cursor: MCP `type:"stdio"`** is listed as required in the field table. Add it.
17. **Cursor: hooks with context injection exist** (`sessionStart` and `postToolUse` → top-level `additional_context`). See the config and `reply()` branch above.

**UNVERIFIED** (needs a real payload or transcript):

- Antigravity transcript line schema.
- Whether Antigravity `invocationNum` resets on each turn.
- Whether Antigravity accepts empty stdout on PostToolUse/PreInvocation. Safer to print `{}`.
- Whether Antigravity still reads the legacy `~/.gemini/antigravity/mcp_config.json`.
- Field names in Cursor `tool_input` for Write/Read.
- Whether Cursor maps Claude-style `additionalContext` for SessionStart/PostToolUse.
- Format of Cursor `transcript_path`.
- Codex rollout format, which the docs call unstable.

**Duplication notes** (token waste, not breakage):

- `~/.gemini/GEMINI.md` block and `~/.gemini/config/rules/sam-memory.md` are both loaded by Antigravity.
- The Claude skill is also loaded by OpenCode (and possibly Cursor). This is fine.
