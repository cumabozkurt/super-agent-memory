// Deterministic, LLM-free capture. Nothing here calls a model, so capture costs
// zero tokens: tool events are reduced to compact facts, error→fix pairs are
// detected from command outcomes, and sessions are digested at the end.
import { openDb, bump, localDay } from './db.js';
import { saveMemory, normKind, isKnownKind, scrubTombstoned } from './store.js';
import { redact, oneLine, truncate, shortPath, compactPaths, gistOf, now, sanitize } from './text.js';
import { config } from './config.js';
import { noteToolTaint } from './guard.js'; // v2-guard
import { repoMentioned } from './project.js';
import { statSync, openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';

const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|applypatch|write_file|replace|edit_file|str_replace\w*|create_file|write_to_file|replace_file_content|multi_replace_file_content|patch)$/i;
const CMD_TOOLS = /^(bash|powershell|shell|run_shell_command|run_command|exec_command|local_shell|terminal|execute_command|run_terminal_cmd)$/i;
const READ_TOOLS = /^(read|read_file|view_file|view|cat|open_file|read_many_files)$/i;

export function ensureSession({ session, project, agent, transcript }) {
  if (!session) return;
  const db = openDb();
  db.prepare(
    `INSERT INTO sessions(id, project, agent, started_at, transcript) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET transcript = COALESCE(excluded.transcript, sessions.transcript)`
  ).run(session, project.id, agent || null, now(), transcript || null);
}

function event(e) {
  openDb().prepare('INSERT INTO events(session, project, agent, type, subject, ok, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.session || null, e.project, e.agent || null, e.type, e.subject ? scrubTombstoned(e.project, e.subject) : null, e.ok ?? null, e.detail ? truncate(scrubTombstoned(e.project, redact(e.detail)), 600) : null, now());
}

// ---------- user prompts & directives ----------

// Sentences that only look like directives: "release notes", "I don't remember…", "always getting this error".
const NOT_DIRECTIVE = /\b(?:don'?t|do not|did not|can'?t|cannot)\s+(?:remember|recall)\b|\b(?:release|patch|foot|key|sticky)\s*notes?\b|\b(?:do|did|can|could)\s+you\s+(?:remember|recall)\b|^never\s?mind\b|^(?:always|never)\s+(?:getting|get|got|seeing|having|gonna|happens?)\b|\b(?:alıyorum|aliyorum|oluyor|veriyor|çıkıyor|cikiyor)\b|^\s*(?:npm|yarn|pnpm)\s+(?:warn|err)|^\s*(?:at |\$ |> |#\d)/i;
// Time-bound reminders are not durable knowledge ("Yarın toplantı var, unutma", "remember the demo is today").
const EPHEMERAL = /\b(?:yarın|yarin|bugün|bugun|bu akşam|bu aksam|bu gece|haftaya|yarından|tomorrow|today|tonight|this (?:afternoon|evening|morning|week)|next (?:week|monday|tuesday|wednesday|thursday|friday))\b/iu;
const ABOUT_ME = /\b(?:bana|bize|benimle|benim için|beni|me|my|i prefer|i like|i want you)\b/iu;

const DIRECTIVES = [
  { re: /\b(?:please\s+)?(?:remember|keep in mind)(?:\s+that)?[:,]?\s+(.{6,240})/i, kind: 'fact', imp: 0.75 },
  { re: /^(?:please\s+)?note(?:\s+that)?[:,]\s+(.{6,240})/i, kind: 'fact', imp: 0.7 },
  { re: /\b(?:from now on|going forward|from here on)[:,]?\s+(.{6,240})/i, kind: 'convention', imp: 0.85 },
  { re: /^(?:please\s+)?(?:always|never|don'?t ever|do not ever|make sure (?:you|to) (?:always|never)|stop using)\b(.{4,240})/i, kind: 'convention', imp: 0.85, keep: true },
  { re: /^(?:please\s+)?(?:don'?t|do not)\s+(?:use|add|commit|push|touch|edit|modify|import|install)\b(.{4,240})/i, kind: 'convention', imp: 0.8, keep: true },
  { re: /(?:^|\.\s+)((?:we|i)\s+(?:always|never|prefer)\b.{4,200})/i, kind: 'preference', imp: 0.8 },
  // Turkish: verb-first ("unutma: …") and the natural verb-final order ("… unutma.")
  { re: /^(?:lütfen\s+)?(?:unutma|hatırla|hatirla|aklında tut|aklinda tut|not al)[:,]\s*(.{6,240})/iu, kind: 'fact', imp: 0.75 },
  { re: /\b(?:aklında tut|aklinda tut|unutma|hatırla|hatirla)\s*:\s*(.{6,240})/iu, kind: 'fact', imp: 0.75 },
  { re: /^(.{6,240}?)[,\s]+(?:(?:bunu|şunu|sunu)\s+)?(?:unutma|aklında tut|aklinda tut|hatırla|hatirla)\s*[.!]*$/iu, kind: 'fact', imp: 0.75 },
  { re: /\b(?:bundan sonra|artık|artik)\s+(?:hep|her zaman|daima|asla|hiçbir zaman|hicbir zaman)\b[:,]?\s*(.{4,240})/iu, kind: 'convention', imp: 0.85 },
  { re: /^(?:lütfen\s+)?((?:bundan sonra|artık|artik)\s+(?:bana|bize|benimle)\b.{4,200})/iu, kind: 'preference', imp: 0.85 },
  // "Artık npm değil pnpm kullanıyoruz" / "artık X yerine Y" / "artık … kullanıyoruz|kullanacağız": a decision change
  { re: /^(?:lütfen\s+)?((?:artık|artik)\s+(?:.{2,200}?\b(?:değil|degil|yerine)\b.{2,120}|.{2,200}?(?:ıyoruz|iyoruz|uyoruz|üyoruz|acağız|eceğiz|yacağız|yeceğiz)))\s*[.!]*$/iu, kind: 'decision', imp: 0.85 },
  { re: /^(?:lütfen\s+)?(bundan sonra\s+.{2,200}?(?:ıyoruz|iyoruz|uyoruz|üyoruz|acağız|eceğiz|yacağız|yeceğiz|malıyız|meliyiz))\s*[.!]*$/iu, kind: 'convention', imp: 0.85 },
  { re: /^(?:lütfen\s+)?((?:her zaman|daima|asla|hiçbir zaman|hicbir zaman)\s.{4,200})/iu, kind: 'convention', imp: 0.85 },
  { re: /^((?:sakın|sakin)\s.{4,200})/iu, kind: 'convention', imp: 0.85 },
  { re: /^(?:önemli|onemli|dikkat)\s*:\s*(.{6,240})/iu, kind: 'convention', imp: 0.8 },
];

// Text the user pasted (an issue, an e-mail, a log, a web page) is not the user speaking (S6).
const PASTE_MARKERS = /^(?:title|subject|from|to|cc|date|steps(?: to reproduce)?|expected(?: behaviou?r)?|actual(?: behaviou?r)?|description|summary|issue|error|log|output|stack ?trace|re|fwd?|başlık|konu|kimden)\s*:|^\s*(?:>|```|~~~|-{3,}|={3,}|\s{4}\S)|wrote:\s*$|yazdı:\s*$|^\s*at\s+\S+\s*\(|\b(?:here is|here's|below is|see|this is) (?:the|an?|their|his|her|our) (?:issue|e-?mail|message|log|thread|page|ticket|report|doc|readme|comment|text)\b|\b(?:customer|user|vendor|someone|they) (?:filed|wrote|sent|posted|said)\b/im;
const QUOTED = /"[^"\n]{12,}"|“[^”\n]{12,}”|«[^»\n]{12,}»|„[^“”\n]{12,}[“”]|「[^」\n]{12,}」|'[^'\n]{24,}'/g;

/**
 * Durable instructions the USER typed: "from now on …", "always/never …", "remember that …", Turkish forms.
 * Only short prompts (< 600 chars) are read; quoted spans, blockquotes and code are skipped, and when the prompt
 * carries pasted material only its first paragraph (the user's own words) is considered.
 */
export function extractDirectives(prompt, { maxLen = 600 } = {}) {
  const out = [];
  let body = sanitize(String(prompt || ''));
  if (body.length > maxLen) return out;
  body = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(QUOTED, ' ')
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  if (PASTE_MARKERS.test(String(prompt))) body = body.split(/\n\s*\n/)[0];
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (s.length > 300 || /\?\s*$/.test(s) || NOT_DIRECTIVE.test(s)) continue;
    for (const d of DIRECTIVES) {
      const m = s.match(d.re);
      if (m) {
        let text = (d.keep ? s : m[1]).replace(/^(?:please|lütfen)\s+/i, '').replace(/[,\s]+(?:(?:bunu|şunu|sunu)\s+)?(?:unutma|hatırla|hatirla)\s*[.!]*$/iu, '').replace(/[.!\s]+$/, '');
        if (text.length < 6 || NOT_DIRECTIVE.test(text)) break;
        let kind = d.kind;
        if (EPHEMERAL.test(s)) kind = 'todo'; // a reminder, not a durable fact
        else if (kind === 'convention' && ABOUT_ME.test(s) && !/\b(?:we|biz)\b/i.test(s)) kind = 'preference';
        out.push({ kind, text, importance: kind === 'todo' ? 0.4 : d.imp, ephemeral: kind === 'todo' && d.kind !== 'todo' });
        break;
      }
    }
  }
  return out.slice(0, 3);
}

/** Drop SAM's own injected <memory …>…</memory> blocks (linear scan, unclosed blocks dropped to the end). */
function dropMemoryBlocks(t) {
  if (!t.includes('<memory')) return t;
  let out = '', i = 0;
  for (;;) {
    const a = t.indexOf('<memory', i);
    if (a < 0) return out + t.slice(i);
    out += t.slice(i, a);
    const b = t.indexOf('</memory>', a);
    if (b < 0) return out;
    i = b + 9;
  }
}

/** Project id that captured memories of this session belong to (parent-folder sessions can be routed to one repo). */
export function routeOf(project, session, text) {
  if (project.id !== 'unscoped') return project.id;
  const db = openDb();
  const p = text ? repoMentioned(project, text) : null;
  if (p && session) { try { db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('route:' + session, p.id); } catch { /* read-only */ } }
  if (p) return p.id;
  return (session && db.prepare('SELECT v FROM meta WHERE k = ?').get('route:' + session)?.v) || project.id;
}

export function recordPrompt({ session, project, agent, prompt }) {
  if (!prompt) return [];
  // never feed our own injected blocks back into storage
  const clean = redact(sanitize(dropMemoryBlocks(String(prompt))).trim());
  if (!clean) return [];
  event({ session, project: project.id, agent, type: 'prompt', detail: clean });
  if (session) {
    openDb().prepare('UPDATE sessions SET first_prompt = COALESCE(first_prompt, ?) WHERE id = ?').run(truncate(oneLine(scrubTombstoned(project.id, clean)), 200), session);
  }
  const saved = [];
  // a session started in a parent folder that names one repo ("In shop-api, …") is about that repo
  const target = routeOf(project, session, clean);
  if (config().captureDirectives) {
    for (const d of extractDirectives(clean)) {
      // outside any repo with several repos below (a parent folder), only preferences about the user are user-wide
      const scope = project.id === 'unscoped' && d.kind === 'preference' ? 'global' : target;
      try {
        const r = saveMemory({ project: scope, kind: d.kind, text: d.text, importance: d.importance, source: 'user', agent, session, tags: d.ephemeral ? ['ephemeral'] : [] });
        if (r.status !== 'forgotten' && r.status !== 'tombstoned') saved.push(r);
      } catch { /* one bad directive never blocks the rest */ }
    }
  }
  return saved;
}

// ---------- tool events ----------

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}

function pathsFromInput(input) {
  if (!input) return [];
  if (typeof input === 'string') {
    // apply_patch style: "*** Update File: path"
    return [...input.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim());
  }
  const out = [];
  const p = pick(input, ['file_path', 'filePath', 'path', 'absolute_path', 'TargetFile', 'AbsolutePath', 'target_file', 'notebook_path', 'file']);
  if (p) out.push(String(p));
  if (Array.isArray(input.paths)) out.push(...input.paths.map(String));
  const patch = pick(input, ['patch', 'patchText', 'command', 'input', 'content']);
  if (typeof patch === 'string' && patch.includes('*** ')) out.push(...pathsFromInput(patch));
  return out;
}

function cmdFromInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  let c = pick(input, ['command', 'cmd', 'CommandLine', 'commandLine', 'script']);
  if (Array.isArray(c)) c = c.filter((x) => !/^(bash|sh|-lc|-c)$/.test(x)).join(' ');
  return c ? String(c) : '';
}

export function normCmd(c) {
  return oneLine(String(c)
    .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '') // `cd /repo && pnpm test` ≡ `pnpm test`
    .replace(/^(\s*\w+=\S+\s+)+/, '')
    .replace(/^\s*(?:\S*node\S*\s+)?\S*?sam(?:-memory)?(?:\.js|\.cmd)?['"]?\s+run\s+(?:--shell\s+\S+\s+)?(?:--lines\s+\d+\s+)?--\s+/, '') // `sam run -- npm test` / `sam-memory run -- …` ≡ `npm test`
    .replace(/^(['"])(.*)\1$/, '$2')
    .replace(/\s+2>&1|\s*\|\s*(tail|head)\b.*$/g, '')).slice(0, 300);
}

// Text heuristics are only trusted for test/build/lint runners; `grep error` succeeding is not a failure.
const RUNNER = /^(?:npx\s+|bunx\s+|pnpm\s+exec\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|ci|t)\b|jest|vitest|mocha|ava|pytest|python3?\s+-m\s+(?:pytest|unittest)|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|tsc|eslint|ruff|mypy|make|gradle|mvn|dotnet\s+(?:test|build)|rspec|phpunit|swift\s+(?:test|build)|deno\s+(?:test|check)|node\s+--test)\b/i;

function outputText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) return resp.map(outputText).join('\n');
  const parts = [];
  for (const k of ['stdout', 'stderr', 'output', 'result', 'content', 'text', 'error', 'llmContent', 'returnDisplay']) {
    if (resp[k] != null) parts.push(outputText(resp[k]));
  }
  return parts.join('\n');
}

const FAIL_PATTERNS = [
  /\b[1-9]\d* (?:failed|failing|errors?)\b/i, /\bFAIL(?:ED)?\b/, /npm ERR!/, /Traceback \(most recent call last\)/,
  /\berror(?:\[E\d+\]|\s+TS\d+)?:/i, /\bcommand not found\b/i, /\bModuleNotFoundError\b/, /\bSyntaxError\b/, /\bpanic:/, /\bSegmentation fault\b/,
];

/** true / false when the outcome is knowable, undefined when it is not (then no fix pairing). */
export function outcome(resp, text, cmd = '') {
  const code = resp && typeof resp === 'object' ? pick(resp, ['exit_code', 'exitCode', 'returncode', 'code', 'status']) : undefined;
  if (typeof code === 'number') return code === 0;
  if (resp && typeof resp === 'object' && (resp.is_error === true || resp.isError === true || resp.interrupted === true)) return false;
  const m = text.match(/(?:exit(?:ed)? (?:with )?(?:code|status)|process exited with code)[:\s]+(\d+)/i);
  if (m) return m[1] === '0';
  if (cmd && !RUNNER.test(normCmd(cmd))) return undefined;
  const meaningful = text.split('\n').filter((l) => !/\b0 (?:failed|failing|errors?)\b/i.test(l) && !/^\s*(?:✓|✔|√|ok\b|PASS\b)/.test(l)).join('\n');
  return !FAIL_PATTERNS.some((re) => re.test(meaningful));
}

/** Timings and durations vary run to run; they must not make the same failure look new ("737ms", "1.2s"). */
export function stripTimings(s) {
  return String(s).replace(/\(?\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min)\b\)?/g, '').replace(/\s{2,}/g, ' ').trim();
}

export function errorLine(text) {
  const lines = String(text).split('\n');
  // the specific assertion beats the summary line
  const pref = lines.find((l) => /AssertionError|expected .* (?:to|but)|→ expected|^\s*[×✕]|--- FAIL|got .* want|error TS\d+|^\s*\w*Error:/.test(l) && l.trim().length > 3);
  const hit = pref || lines.find((l) => /error|failed|exception|traceback|cannot|not found|ERR!|panic|denied/i.test(l) && l.trim().length > 3);
  return truncate(stripTimings(oneLine(hit || lines.find((l) => l.trim()) || '')), 160);
}

export function recordTool({ session, project, agent, tool, input, response, ok, root }) {
  const cfg = config();
  const name = String(tool || '');
  const base = name.replace(/^mcp__\w+__/, '');
  if (response != null && !EDIT_TOOLS.test(base)) { try { noteToolTaint({ session, project: project.id, text: outputText(response) }); } catch { /* best-effort */ } } // v2-guard: laundering taint
  if (EDIT_TOOLS.test(base)) {
    if (!cfg.captureEdits) return null;
    const paths = pathsFromInput(input).map((p) => shortPath(p, root));
    for (const p of paths) event({ session, project: project.id, agent, type: 'edit', subject: p, ok: 1 });
    return { type: 'edit', paths };
  }
  if (CMD_TOOLS.test(base)) {
    if (!cfg.captureCommands) return null;
    const cmd = cmdFromInput(input);
    if (!cmd) return null;
    const text = outputText(response);
    const success = ok ?? outcome(response, text, cmd);
    const ncmd = normCmd(redact(cmd));
    const detail = success === false ? errorLine(text) : '';
    event({ session, project: project.id, agent, type: 'cmd', subject: ncmd, ok: success === undefined ? null : success ? 1 : 0, detail });
    if (success === true && session) detectFix({ session, project, agent, ncmd });
    return { type: 'cmd', cmd: ncmd, ok: success };
  }
  if (READ_TOOLS.test(base)) {
    const paths = pathsFromInput(input).map((p) => shortPath(p, root));
    for (const p of paths) event({ session, project: project.id, agent, type: 'read', subject: p });
    return { type: 'read', paths };
  }
  event({ session, project: project.id, agent, type: 'tool', subject: truncate(name, 80) });
  return { type: 'tool' };
}

/** A command that failed earlier in this session now passes, and files were edited in between → a "fix" memory. */
function detectFix({ session, project, agent, ncmd }) {
  const db = openDb();
  const fail = db.prepare(
    `SELECT id, detail, ts FROM events WHERE session = ? AND type = 'cmd' AND subject = ? AND ok = 0 ORDER BY id DESC LIMIT 1`
  ).get(session, ncmd);
  if (!fail) return;
  const oks = db.prepare(`SELECT COUNT(*) c FROM events WHERE session = ? AND type = 'cmd' AND subject = ? AND ok = 1 AND id > ?`)
    .get(session, ncmd, fail.id).c;
  if (oks > 1) return; // a success after that failure was already handled
  let edits = db.prepare(`SELECT DISTINCT subject FROM events WHERE session = ? AND type = 'edit' AND id > ?`).all(session, fail.id).map((r) => r.subject);
  // docs, changelogs and lockfiles do not fix a failing command when code changed too; docs alone never do
  const NOT_CODE = /(?:^|\/)(?:CHANGELOG|README|LICENSE|CONTRIBUTING)[^/]*$|\.(?:md|mdx|txt|rst|adoc)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/i;
  const code = edits.filter((e) => !NOT_CODE.test(e));
  if (!code.length) return; // flaky / env issue / docs only: not a code fix
  edits = code;
  const err = fail.detail || 'failure';
  // The error line is command OUTPUT (attacker-controllable in a malicious repo): it stays in the body, which is
  // only shown on mem_get, never in the gist that cards inject (S6).
  saveMemory({
    project: project.id, kind: 'fix', source: 'auto', agent, session,
    text: `\`${truncate(ncmd, 60)}\` failed → fixed via ${compactPaths(edits, 3)}`,
    body: `Command: ${ncmd}\nError: ${stripTimings(err)}\nFiles changed: ${edits.join(', ')}`,
    files: edits.slice(0, 8), tags: ['auto', 'fix'],
  });
  bump(project.id, 'fixes_detected');
}

// ---------- inline markers in assistant output ----------

const MARKER = /(?:⟦mem(?:\s+([A-Za-zçğıöşüÇĞİÖŞÜ]+))?\s*:\s*([^⟧]{4,500})⟧|\[\[mem(?:\s+([A-Za-zçğıöşüÇĞİÖŞÜ]+))?\s*:\s*((?:(?!\]\]).){4,500})\]\])/g;

// Example markers that appear in SAM's own rules/skill text must never become memories.
const DOC_EXAMPLES = new Set(['use pnpm, never npm', 'queue: sqs, not kafka', '<subject>: <value>']);
// status chatter, not knowledge
const JUNK = /^(?:ok(?:ay)?|done|fixed(?: it)?|see above|as above|this works(?: now)?|works now|it works|todo|tbd|n\/a|none|test(?:ing)?|wip|same as before|nothing|yes|no|tamam|bitti|oldu|düzeldi|yukarıya bak)\.?$/i;
export const MAX_MARKERS = 8; // one turn cannot flood memory (P0)

/** Markers inside code (fenced or inline) are quoted material, never the assistant's own memory. */
function stripCode(t) {
  return String(t).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

export function harvestMarkersFromText(text) {
  const out = [];
  for (const m of stripCode(text).matchAll(MARKER)) {
    const rawKind = m[1] || m[3] || 'note';
    const body = (m[2] ?? m[4] ?? '').trim();
    if (!isKnownKind(rawKind) || normKind(rawKind) === 'session') continue; // allow-listed kinds only ("constructor" is not one)
    const kind = normKind(rawKind);
    if (/^<?text>?$/i.test(body) || body.includes('<text>') || DOC_EXAMPLES.has(body.toLowerCase())) continue; // our own instructions
    if (body.length < 8 || JUNK.test(body) || body.split(/\s+/).filter((x) => x.length > 1).length < 2) continue; // "done", "see above"
    out.push({ kind, text: body });
    if (out.length >= MAX_MARKERS) break;
  }
  return out;
}

// ---------- transcripts: an ALLOW-list of what the assistant itself wrote (S6) ----------
// Claude JSONL: {type:'assistant', message:{content:[{type:'text', text}]}} (not thinking / tool_use / compact summaries)
// Codex rollout: {type:'response_item', payload:{type:'message', role:'assistant', content:[{type:'output_text', text}]}}
// Gemini chat:   {type:'gemini', content:'…'} (not toolCalls / thoughts); Gemini API: {role:'model', parts:[{text}]}
// Generic:       {role:'assistant', content:'…' | [{type:'text', text}]}
function textBlocks(c, out) {
  if (typeof c === 'string') { out.push(c); return; }
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (typeof b === 'string') out.push(b);
    else if (b && typeof b === 'object' && typeof b.text === 'string' && (b.type === 'text' || b.type === 'output_text' || b.type === undefined) && !b.thought) out.push(b.text);
  }
}

export function assistantTexts(o, out = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  if (o.isCompactSummary || o.isMeta) return out;
  if (o.type === 'response_item') { // Codex
    const p = o.payload;
    if (p && p.type === 'message' && p.role === 'assistant') textBlocks(p.content, out);
    return out;
  }
  if (['event_msg', 'compacted', 'turn_context', 'session_meta', 'summary', 'system', 'user', 'tool', 'result'].includes(o.type)) return out;
  if (o.type === 'assistant' && o.message && typeof o.message === 'object') { textBlocks(o.message.content, out); return out; } // Claude
  if (o.type === 'gemini' || o.type === 'model') { textBlocks(o.content, out); return out; } // Gemini CLI chat recording
  const role = o.role ?? o.author;
  if (role === 'assistant' || role === 'model') {
    if (o.content !== undefined) textBlocks(o.content, out);
    else if (Array.isArray(o.parts)) textBlocks(o.parts, out);
    else if (typeof o.text === 'string') out.push(o.text);
  }
  return out;
}

function saveMarkers(strings, { session, project, agent }) {
  const pid = routeOf(project, session, null);
  // the user's own recent words in this session: lets a marker update a user value the user just asked to change
  let confirm = '';
  try { if (session) confirm = openDb().prepare("SELECT detail FROM events WHERE session = ? AND type = 'prompt' ORDER BY id DESC LIMIT 3").all(session).map((r) => r.detail || '').join('\n'); } catch { /* noop */ }
  const saved = [];
  const seen = new Set();
  let n = 0;
  for (const s of strings) {
    if (n >= MAX_MARKERS) break;
    for (const mk of harvestMarkersFromText(s)) {
      const key = mk.kind + '|' + mk.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (++n > MAX_MARKERS) break;
      try {
        const r = saveMemory({ project: pid, kind: mk.kind, text: mk.text, source: 'agent', agent, session, confirm });
        if (r.status !== 'forgotten' && r.status !== 'conflict' && r.status !== 'tombstoned') saved.push(r);
      } catch { /* one bad marker never blocks the others */ }
    }
  }
  const created = saved.filter((r) => r.status !== 'merged').length;
  if (created) bump(project.id, 'markers_harvested', created);
  return saved;
}

/** Harvest markers from the final assistant message a host hands us directly (Stop/AfterAgent payloads). */
export function harvestText({ session, project, agent, text }) {
  if (!config().harvestMarkers || !text || typeof text !== 'string' || !text.includes('mem')) return [];
  return saveMarkers([text], { session, project, agent });
}

const MAX_TRANSCRIPT = 512 * 1024 * 1024;
/** Open a transcript only if it is a regular file of sane size (never a FIFO / device: they would block) (#3). */
function openTranscript(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) return null;
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile() || st.size > MAX_TRANSCRIPT) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const f = fstatSync(fd);
    if (!f.isFile()) { closeSync(fd); return null; }
    return { fd, size: f.size };
  } catch { if (fd !== undefined) try { closeSync(fd); } catch { /* noop */ } return null; }
}

export function readTranscriptTail(path, max = 256 * 1024) {
  const t = openTranscript(path);
  if (!t) return '';
  try {
    const len = Math.min(t.size, max);
    const buf = Buffer.alloc(len);
    readSync(t.fd, buf, 0, len, t.size - len);
    return buf.toString('utf8');
  } finally { closeSync(t.fd); }
}

export function harvestTranscript({ session, project, agent, transcript, extraTexts = [] }) {
  if (!config().harvestMarkers) return [];
  const t = transcript ? openTranscript(transcript) : null;
  if (!t) return extraTexts.length ? saveMarkers(extraTexts, { session, project, agent }) : [];
  const db = openDb();
  let saved = [];
  let newOffset = null;
  try {
    const row = session ? db.prepare('SELECT transcript_offset FROM sessions WHERE id = ?').get(session) : null;
    let offset = row?.transcript_offset || 0;
    const size = t.size;
    if (size < offset) offset = 0;
    if (size === offset) return extraTexts.length ? saveMarkers(extraTexts, { session, project, agent }) : [];
    const len = Math.min(size - offset, 8 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(t.fd, buf, 0, len, offset);
    const strings = [];
    const head = buf.subarray(0, Math.min(len, 4096)).toString('utf8').trimStart();
    // a pretty-printed JSON document (one value spread over many lines) is parsed whole, never line by line
    let whole = null;
    if (offset === 0 && /^[[{]/.test(head) && !/^[[{][^\n]*[\]}]\s*\n\s*[[{]/.test(head)) {
      try { whole = JSON.parse(buf.toString('utf8')); } catch { whole = undefined; }
    }
    if (whole !== null) {
      // complete document: walk its messages; a partial one (still being written) waits for the next harvest
      if (whole !== undefined) {
        const list = Array.isArray(whole) ? whole : Array.isArray(whole.messages) ? whole.messages : Array.isArray(whole.history) ? whole.history : [whole];
        const key = 'tjson:' + (session || transcript);
        const done = Number(db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v || 0);
        for (const o of list.slice(done)) assistantTexts(o, strings);
        try { db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(list.length)); } catch { /* read-only */ }
      } else if (len >= 8 * 1024 * 1024) newOffset = size; // unparseable and huge: skip it
    } else {
      // Only consume complete lines: a line still being written (or a multibyte char split
      // at the read boundary) is left for the next harvest instead of being misparsed.
      let end = buf.lastIndexOf(0x0a) + 1;
      if (end === 0) end = offset + len >= size && size - offset < 1024 * 1024 ? 0 : len; // single huge line: give up on it
      const chunk = buf.subarray(0, end).toString('utf8');
      for (const ln of chunk.split('\n')) {
        if (!ln.includes('mem')) continue;
        let o;
        try { o = JSON.parse(ln); } catch { continue; } // not JSON: unknown provenance, never harvested
        assistantTexts(o, strings);
      }
      if (end) newOffset = offset + end;
    }
    saved = saveMarkers([...strings, ...extraTexts], { session, project, agent });
  } finally {
    closeSync(t.fd);
    // always advance: a marker that cannot be saved must not wedge harvesting for the rest of the session (#1)
    if (session && newOffset != null) { try { db.prepare('UPDATE sessions SET transcript_offset = ? WHERE id = ?').run(newOffset, session); } catch { /* read-only */ } }
  }
  return saved;
}

// ---------- session digest ----------

export function endSession({ session, project, agent, transcript, harvest = true }) {
  if (!session) return null;
  const db = openDb();
  if (harvest) harvestTranscript({ session, project, agent, transcript });
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session);
  const evs = db.prepare('SELECT type, subject, ok, detail FROM events WHERE session = ? ORDER BY ts').all(session);
  const prompts = evs.filter((e) => e.type === 'prompt').map((e) => oneLine(e.detail));
  const edits = [...new Set(evs.filter((e) => e.type === 'edit').map((e) => e.subject))];
  const cmds = evs.filter((e) => e.type === 'cmd');
  const fixes = db.prepare("SELECT gist FROM memories WHERE session = ? AND kind = 'fix'").all(session).map((r) => r.gist);
  const saved = db.prepare("SELECT kind, gist FROM memories WHERE session = ? AND kind NOT IN ('fix','session')").all(session);
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now(), session);
  if (!edits.length && prompts.length < 2) return null; // a one-line chat with no edits is not worth a digest (its directives are already saved)

  const firstPrompt = s?.first_prompt || prompts[0] || 'session';
  const sentences = firstPrompt.split(/(?<=[.!?\n])\s+/).filter((x) => !extractDirectives(x).length);
  const intent = gistOf((sentences.join(' ') || firstPrompt).replace(/[.!?]+$/, ''), 70);
  const date = localDay().slice(5);
  const fails = cmds.filter((c) => !c.ok).length;
  const gist = `${date} ${intent} → ${edits.length} edits${edits.length ? ' ' + compactPaths(edits, 2) : ''}${fixes.length ? `, ${fixes.length} fix` : ''}`;
  const body = [
    prompts.length ? 'Asked: ' + prompts.slice(0, 5).map((p) => truncate(p, 140)).join(' | ') : '',
    edits.length ? 'Edited: ' + edits.slice(0, 30).join(', ') : '',
    cmds.length ? `Commands: ${cmds.length} (${fails} failed) e.g. ` + [...new Set(cmds.map((c) => c.subject))].slice(0, 6).join(' ; ') : '',
    fixes.length ? 'Fixes: ' + fixes.join(' | ') : '',
    saved.length ? 'Saved: ' + saved.map((m) => `[${m.kind}] ${m.gist}`).join(' | ') : '',
  ].filter(Boolean).join('\n');
  // Stop fires after every turn on some hosts: keep ONE rolling digest per session.
  if (s?.digest_id && db.prepare('SELECT 1 FROM memories WHERE id = ?').get(s.digest_id)) {
    db.prepare('UPDATE memories SET gist = ?, body = ?, files = ?, updated_at = ? WHERE id = ?')
      .run(scrubTombstoned(project.id, gist), scrubTombstoned(project.id, redact(body)), edits.slice(0, 12).join(' '), now(), s.digest_id);
    return { id: s.digest_id, status: 'updated' };
  }
  // the digest and the session's pointer to it commit together: a crash in between cannot leave two digests
  return saveMemory({ project: project.id, kind: 'session', text: gist, gist, body, files: edits.slice(0, 12), source: 'auto', agent, session,
    afterInsert: (d, id) => d.prepare('UPDATE sessions SET digest_id = ? WHERE id = ?').run(id, session) });
}
