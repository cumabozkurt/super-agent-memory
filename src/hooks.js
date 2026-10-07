// One hook entry point for every agent: `sam hook <event> --agent <name>`.
// Each adapter maps the host's payload to canonical events and formats the reply
// the host expects. Hooks never fail the host: any error → empty, exit 0.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveProject } from './project.js';
import { ensureSession, recordPrompt, recordTool, endSession, harvestTranscript, readTranscriptTail } from './capture.js';
import { sessionContext, promptContext, resetLedger, fileContext, markInjected, fixContext } from './inject.js';
import { openDb, setBusyTimeout } from './db.js';
import { sha, tokens } from './text.js';
// portable.js and gc.js are loaded lazily: only SessionStart uses them, and the per-prompt hook is latency-bound.

export const MAX_STDIN = 2 * 1024 * 1024; // a 10 MB pasted prompt must not cost seconds of parsing/redaction

export async function readStdin(timeoutMs = 1500, maxBytes = MAX_STDIN) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    let finished = false;
    // Stop as soon as a complete JSON document arrived, at EOF, or at the timeout. Detach and
    // destroy stdin either way: a host that keeps the pipe open must not keep this process alive.
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      try { process.stdin.destroy(); } catch { /* noop */ }
      resolve(data);
    };
    const t = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      if (data.length >= maxBytes) { data = data.slice(0, maxBytes); return done(); } // truncated → not JSON → ignored
      if (/[}\]]\s*$/.test(data)) { try { JSON.parse(data); done(); } catch { /* incomplete */ } }
    });
    process.stdin.once('end', done);
    process.stdin.once('error', done);
  });
}

const str = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '');
const first = (...xs) => { for (const x of xs) { const v = str(x); if (v) return v; } return ''; };

/** Normalize the host payload into { event, session, cwd, prompt, tool, input, response, ok, transcript, source }. Every field is type-checked. */
export function normalize(agent, event, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  const ev = String(event || str(p.hook_event_name) || str(p.hookEventName) || '').toLowerCase();
  const cwd = [p.cwd, Array.isArray(p.workspacePaths) && p.workspacePaths[0], Array.isArray(p.workspace_roots) && p.workspace_roots[0]]
    .find((x) => typeof x === 'string' && x && x.length < 4096 && !x.includes('\0'));
  const base = {
    session: first(p.session_id, p.sessionId, p.conversation_id, p.conversationId, p.thread_id).slice(0, 200) || null,
    // Claude subagents share the parent's session_id; their "already shown" ledger must be their own
    subagent: first(p.agent_id, p.agentId, p.subagent_id).slice(0, 100) || null,
    cwd: cwd || process.cwd(),
    transcript: first(p.transcript_path, p.transcriptPath) || null,
    agentTranscript: first(p.agent_transcript_path) || null,
    source: first(p.source, p.trigger) || null,
    // final assistant text, when the host hands it over (Claude/Codex Stop, Gemini AfterAgent, Cursor afterAgentResponse)
    lastText: first(p.last_assistant_message, p.prompt_response, ev === 'afteragentresponse' ? p.text : ''),
  };
  const map = {
    sessionstart: 'start', session_start: 'start', start: 'start',
    userpromptsubmit: 'prompt', beforeagent: 'prompt', prompt: 'prompt', beforesubmitprompt: 'prompt',
    posttooluse: 'tool', posttoolusefailure: 'tool', aftertool: 'tool', afteragentresponse: 'harvest', tool: 'tool', aftershellexecution: 'tool', afterfileedit: 'tool',
    stop: 'stop', afteragent: 'stop', sessionend: 'end', session_end: 'end', end: 'end',
    precompact: 'compact', precompress: 'compact', compact: 'compact', postcompact: 'postcompact',
    preinvocation: 'invocation', invocation: 'invocation', subagentstart: 'substart', subagentstop: 'substop',
  };
  const canon = map[ev] || ev;
  if (canon === 'prompt') { const pr = p.prompt ?? p.user_prompt ?? p.text ?? ''; return { ...base, event: 'prompt', prompt: typeof pr === 'string' ? pr : '' }; }
  if (canon === 'tool') {
    const tc = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : {};
    let tool = first(p.tool_name, p.toolName, tc && tc.name);
    let input = p.tool_input || p.toolInput || (tc && tc.args) || p.args;
    let response = p.tool_response ?? p.toolResponse ?? p.tool_output ?? p.output ?? (p.error ? { error: p.error } : undefined);
    if (typeof response === 'string' && /^\s*\{/.test(response)) { try { response = JSON.parse(response); } catch { /* plain text */ } }
    let ok;
    if (agent === 'antigravity') ok = !p.error;
    if (agent === 'claude' && ev === 'posttooluse' && !p.cursor_version) ok = true; // Claude reports failures via PostToolUseFailure
    if (ev === 'posttoolusefailure') { ok = false; if (response == null) response = { error: p.error || 'failed' }; }
    if (ev === 'afterfileedit') { tool = 'edit'; input = { file_path: str(p.file_path) }; }
    if (ev === 'aftershellexecution') { tool = 'bash'; input = { command: str(p.command) }; }
    return { ...base, event: 'tool', tool, input, response, ok };
  }
  if (canon === 'invocation') return { ...base, event: 'invocation', num: typeof p.invocationNum === 'number' ? p.invocationNum : null };
  if (canon === 'stop' && agent === 'antigravity' && p.fullyIdle === false) return { ...base, event: 'noop' };
  return { ...base, event: canon };
}

// What each host accepts per model-visible hook string, with headroom:
//  Claude Code: additionalContext is cut at 10,000 chars (the rest spills to a file, 2,000-char preview, no override).
//  Codex: ≈2,500 tokens per hook message by default (additionalContextLimit), spilled with a head/tail preview.
//  Cursor sessionStart additional_context and Antigravity ephemeralMessage: no documented cap; kept at 8,000 chars.
export const HOST_LIMITS = {
  claude: { chars: 9000 },
  gemini: { chars: 9000 },
  codex: { chars: 9000, tokens: 2000 },
  cursor: { chars: 8000 },
  antigravity: { chars: 8000 },
  default: { chars: 9000 },
};

/**
 * Fit hook output to a host limit, cutting only at line boundaries and closing every <memory …> block that was
 * opened, so a cut card is still well-formed (memory text is escaped: a line starting with '<' is always SAM's tag).
 */
export function fitContext(text, { chars = 9000, tokens: maxTok = Infinity } = {}) {
  if (!text) return '';
  if (text.length <= chars && (maxTok === Infinity || tokens(text) <= maxTok)) return text;
  const CLOSE = '</memory>';
  const out = [];
  let depth = 0, len = 0, tk = 0;
  for (const line of text.split('\n')) {
    const opens = /^<memory\b[^>]*>$/.test(line) ? 1 : 0;
    const closes = line === CLOSE ? 1 : 0;
    const d = depth + opens - closes;
    const add = line.length + 1;
    const addTk = maxTok === Infinity ? 0 : tokens(line) + 1;
    // room for this line plus the closers still needed after it
    const closers = Math.max(0, d) * (CLOSE.length + 1);
    const closerTk = maxTok === Infinity ? 0 : Math.max(0, d) * (tokens(CLOSE) + 1);
    if (len + add + closers > chars || tk + addTk + closerTk > maxTok) {
      if (opens) break; // never start a block that cannot close
      if (closes) { out.push(line); depth = d; len += add; tk += addTk; continue; } // closers were reserved
      continue; // skip a body line that does not fit; a later closer still lands
    }
    out.push(line); depth = d; len += add; tk += addTk;
  }
  for (; depth > 0; depth--) out.push(CLOSE);
  // a block left with only its tags carries nothing
  return out.join('\n').replace(/^<memory\b[^>]*>\n<\/memory>(\n|$)/gm, '').trim();
}

function reply(agent, hostEvent, context) {
  if (context) context = fitContext(context, HOST_LIMITS[agent] || HOST_LIMITS.default);
  if (agent === 'antigravity') {
    const ev = String(hostEvent).toLowerCase();
    if (ev === 'stop') return { decision: 'allow' };
    if (ev === 'preinvocation' || ev === 'postinvocation') return context ? { injectSteps: [{ ephemeralMessage: context }] } : {};
    return {};
  }
  if (agent === 'cursor') {
    // Cursor: flat snake_case; only sessionStart and postToolUse(Failure) can inject.
    const ev = String(hostEvent).toLowerCase();
    if (context && ['start', 'sessionstart', 'posttooluse', 'posttoolusefailure'].includes(ev)) return { additional_context: context };
    return ev === 'beforesubmitprompt' || ev === 'prompt' ? { continue: true } : {};
  }
  if (!context) return {};
  const ev = String(hostEvent);
  const hookEventName = { start: 'SessionStart', prompt: agent === 'gemini' ? 'BeforeAgent' : 'UserPromptSubmit' }[ev] || ev;
  return { hookSpecificOutput: { hookEventName, additionalContext: context } };
}

function lastUserMessage(transcript) {
  const tail = readTranscriptTail(transcript); // regular files only, never a FIFO/device
  if (!tail) return '';
  const lines = tail.split('\n').reverse();
  for (const ln of lines) {
    try {
      const o = JSON.parse(ln);
      const role = o.role || o.type || o.message?.role || o.source;
      if (role === 'user' || role === 'USER' || o.userMessage || o.user_message) {
        const c = o.userMessage || o.user_message || o.content || o.message?.content || o.text;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ') : '';
        if (text.trim()) return text;
      }
    } catch { /* partial line */ }
  }
  return '';
}

// Cursor runs hooks from every source (user ~/.cursor, project .cursor, and ~/.claude / .claude while
// "Third-Party Imports" is on, its default; cursor-agent cannot turn it off), so check both Cursor scopes.
function cursorNativeInstalled(cwd) {
  const files = [join(process.env.SAM_INSTALL_HOME || homedir(), '.cursor', 'hooks.json')];
  if (typeof cwd === 'string' && cwd) files.push(join(cwd, '.cursor', 'hooks.json'));
  for (const f of files) {
    // the Windows (PowerShell) form quotes each argument: '--agent' 'cursor'
    try { if (/['"]?--agent['"]?\s+['"]?cursor\b/.test(readFileSync(f, 'utf8'))) return true; } catch { /* absent */ }
  }
  return false;
}

export async function runHook(event, { agent = 'claude', hint = 'mcp', payload } = {}) {
  let p = payload;
  if (!p) {
    const raw = await readStdin();
    try { p = raw ? JSON.parse(raw) : {}; } catch { p = {}; }
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  // Cursor imports ~/.claude/settings.json hooks by default: re-tag those calls, and
  // ignore them entirely once SAM's native Cursor hooks are installed (no double fire).
  // CLAUDE_PROJECT_DIR is set by Cursor too, so it cannot tell the hosts apart; cursor_version / CURSOR_VERSION can.
  if (agent === 'claude' && (p.cursor_version || process.env.CURSOR_VERSION)) {
    if (!p.cursor_version) p = { ...p, cursor_version: process.env.CURSOR_VERSION };
    const root = Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : p.cwd;
    if (cursorNativeInstalled(root)) return { out: {} };
    agent = 'cursor';
  }
  const n = normalize(agent, event, p);
  setBusyTimeout(1500); // a hook waits at most ~1.5 s per write for a lock (host timeouts are ~10 s)
  const project = resolveProject(n.cwd);
  const session = n.session ? `${agent}:${n.session}` : null;
  // "already shown" ledger: per subagent (a subagent's fresh context never saw the parent's card), while events,
  // digests and fix detection stay keyed on the session
  const ledger = session && n.subagent ? `${session}/${n.subagent}` : session;
  const hostEvent = event;
  let context = '';
  // Hooks read first and write second, with a short lock wait: when the DB is locked/read-only/full the host still
  // gets its context, and after the first failed write the remaining writes are skipped (#8).
  let writable = true;
  const w = (fn) => {
    if (!writable) return undefined;
    try { return fn(); } catch (e) {
      writable = false;
      if (process.env.SAM_DEBUG) process.stderr.write('sam: write skipped: ' + (e?.message || e) + '\n');
      return undefined;
    }
  };
  const ensure = () => w(() => ensureSession({ session, project, agent, transcript: n.transcript }));

  switch (n.event) {
    case 'start': {
      if (n.source === 'compact' || n.source === 'clear') w(() => resetLedger(ledger));
      const { syncTeamFile } = await import('./portable.js');
      w(() => syncTeamFile(project));
      // resume: the earlier card is still in the restored conversation; send only what it has not seen
      context = sessionContext({ project, session: ledger, hint, agent, native: await nativeFor(agent, project, n.cwd, w), onlyNew: n.source === 'resume', excludeSession: session, write: w }).text;
      context = [context, (await import('./handoff.js')).takeHandoff({ project, agent, session, write: w })].filter(Boolean).join('\n'); // v2-share: surface another agent's handoff once (≤60 tok)
      ensure();
      const { maybeAutoGc } = await import('./gc.js');
      w(() => maybeAutoGc());
      return { out: reply(agent, 'start', context) };
    }
    case 'substart': { // Claude SubagentStart: a small card for the subagent's fresh context
      context = sessionContext({ project, session: ledger, hint, agent, native: await nativeFor(agent, project, n.cwd, w), budget: 140, excludeSession: session, write: w }).text;
      return { out: reply(agent, 'SubagentStart', context) };
    }
    case 'prompt': {
      ensure();
      const saved = w(() => recordPrompt({ session, project, agent, prompt: n.prompt })) || [];
      w(() => markInjected(ledger, saved.map((r) => r.id))); // the user just said it; don't echo it back
      // Cursor's beforeSubmitPrompt cannot inject: computing recall would only poison the ledger
      if (agent !== 'cursor') {
        const parts = [];
        if (agent === 'gemini' && needsCard(ledger)) { // Gemini has no SessionStart(compact): re-send the card after PreCompress
          parts.push(sessionContext({ project, session: ledger, hint, agent, native: await nativeFor(agent, project, n.cwd, w), excludeSession: session, write: w }).text);
          w(() => openDb().prepare('DELETE FROM meta WHERE k = ?').run('needcard:' + ledger));
        }
        parts.push((await promptContext({ project, session: ledger, prompt: n.prompt, agent, write: w })).text);
        context = parts.filter(Boolean).join('\n');
      }
      return { out: reply(agent, 'prompt', context) };
    }
    case 'invocation': { // Antigravity: PreInvocation is the only pre-model hook
      ensure();
      const parts = [];
      // card once per session: on invocation 0, or (no counter in the payload) when nothing was injected yet
      const fresh = n.num === 0 || (n.num == null && !openDb().prepare('SELECT 1 FROM injections WHERE session = ? LIMIT 1').get(ledger));
      if (fresh) parts.push(sessionContext({ project, session: ledger, hint, agent, native: await nativeFor(agent, project, n.cwd, w), excludeSession: session, write: w }).text);
      const msg = lastUserMessage(n.transcript);
      if (msg) {
        const h = sha(msg, 10);
        const db = openDb();
        const seen = db.prepare("SELECT 1 FROM events WHERE session = ? AND type IN ('prompt', 'seen') AND subject = ?").get(session, h);
        if (!seen) {
          w(() => {
            const before = db.prepare("SELECT COALESCE(MAX(id), 0) m FROM events WHERE session = ? AND type = 'prompt'").get(session).m;
            markInjected(ledger, recordPrompt({ session, project, agent, prompt: msg }).map((r) => r.id));
            const ins = db.prepare("SELECT MAX(id) m FROM events WHERE session = ? AND type = 'prompt' AND id > ?").get(session, before).m;
            if (ins) db.prepare('UPDATE events SET subject = ? WHERE id = ?').run(h, ins);
            else db.prepare("INSERT INTO events(session, project, agent, ts, type, subject) VALUES (?, ?, ?, ?, 'seen', ?)").run(session, project.id, agent, Date.now(), h);
          });
          parts.push((await promptContext({ project, session: ledger, prompt: msg, agent, write: w })).text);
        }
      }
      context = parts.filter(Boolean).join('\n');
      return { out: reply(agent, hostEvent, context) };
    }
    case 'tool': {
      ensure();
      const r = w(() => recordTool({ session, project, agent, tool: n.tool, input: n.input, response: n.response, ok: n.ok, root: project.root }));
      if (r?.paths?.length && ['claude', 'codex', 'gemini', 'cursor'].includes(agent)) {
        context = fileContext({ project, session: ledger, paths: r.paths, write: w }).text;
      }
      // a command just failed: one compact past fix for it, within the per-session experience budget
      if (r?.type === 'cmd' && r.ok === false && ['claude', 'codex', 'gemini', 'cursor'].includes(agent) && (agent !== 'cursor' || /^posttooluse/i.test(hostEvent))) {
        context = [context, fixContext({ project, session: ledger, eventSession: session, cmd: r.cmd, agent, write: w }).text].filter(Boolean).join('\n');
      }
      const toolEv = agent === 'gemini' ? 'AfterTool' : /failure/i.test(hostEvent) ? (agent === 'cursor' ? 'postToolUseFailure' : 'PostToolUseFailure') : 'PostToolUse';
      return { out: reply(agent, toolEv, context) };
    }
    case 'compact': {
      ensure(); // keeps the transcript offset + digest id
      // Harvest before the transcript is summarized away; after compaction the card is re-injected.
      w(() => harvestTranscript({ session, project, agent, transcript: n.transcript }));
      w(() => resetLedger(ledger));
      if (agent === 'gemini') w(() => openDb().prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('needcard:' + ledger, '1'));
      return { out: reply(agent, hostEvent, '') };
    }
    case 'postcompact': {
      w(() => resetLedger(ledger));
      return { out: reply(agent, hostEvent, '') };
    }
    case 'harvest': {
      ensure(); // keeps the transcript offset + digest id
      w(() => harvestTranscript({ session, project, agent, transcript: null, extraTexts: n.lastText ? [n.lastText] : [] }));
      return { out: reply(agent, hostEvent, '') };
    }
    case 'substop': { // Claude SubagentStop: the subagent's own transcript + final message
      ensure();
      w(() => harvestTranscript({ session: null, project, agent, transcript: n.agentTranscript, extraTexts: n.lastText ? [n.lastText] : [] }));
      return { out: reply(agent, hostEvent, '') };
    }
    case 'stop': {
      ensure(); // keeps the transcript offset + digest id
      // one harvest over the transcript AND the final message: one 8-marker cap and one dedup set per turn
      w(() => harvestTranscript({ session, project, agent, transcript: n.transcript, extraTexts: n.lastText ? [n.lastText] : [] }));
      w(() => endSession({ session, project, agent, transcript: n.transcript, harvest: false }));
      { const { autoHandoff } = await import('./handoff.js'); w(() => autoHandoff({ session, project, agent })); } // v2-share: rolling handoff record
      return { out: reply(agent, hostEvent, '') };
    }
    case 'end': {
      ensure(); // keeps the transcript offset + digest id
      w(() => endSession({ session, project, agent, transcript: n.transcript }));
      { const { autoHandoff } = await import('./handoff.js'); w(() => autoHandoff({ session, project, agent })); } // v2-share: rolling handoff record
      return { out: reply(agent, hostEvent, '') };
    }
    default:
      return { out: reply(agent, hostEvent, '') };
  }
}

/** Native host memory matcher (read-only; lazily loaded: only card-building events pay for it). */
async function nativeFor(agent, project, cwd, w) {
  try {
    const { nativeContext } = await import('./native.js');
    return nativeContext({ db: openDb(), root: project.root, cwd, agent, write: w });
  } catch (e) {
    if (process.env.SAM_DEBUG) process.stderr.write('sam: native memory skipped: ' + (e?.message || e) + '\n');
    return null;
  }
}

function needsCard(ledger) {
  try { return !!ledger && !!openDb().prepare('SELECT 1 FROM meta WHERE k = ?').get('needcard:' + ledger); } catch { return false; }
}
