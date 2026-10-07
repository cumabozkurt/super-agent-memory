// Shared helpers for the SAM chaos / fuzz / property harnesses. Zero dependencies.
//
// SAM_SRC   absolute path of SAM's src/ directory (default: ../../src relative to this file,
//           which is right once the harness is copied to <repo>/test/chaos/).
// SAM_BIN   absolute path of bin/sam.js (default: ../../bin/sam.js).
// Every harness creates its own throw-away SAM_HOME / SAM_INSTALL_HOME under os.tmpdir().
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SAM_SRC = resolve(process.env.SAM_SRC || join(here, '..', '..', 'src'));
export const SAM_BIN = resolve(process.env.SAM_BIN || join(SAM_SRC, '..', 'bin', 'sam.js'));

/** Fresh isolated SAM environment (must run BEFORE importing any SAM module). */
export function freshEnv(tag = 'chaos') {
  const tmp = mkdtempSync(join(process.env.CHAOS_TMP || tmpdir(), `sam-${tag}-`));
  const env = { SAM_HOME: join(tmp, 'home'), SAM_INSTALL_HOME: join(tmp, 'user') };
  mkdirSync(env.SAM_HOME, { recursive: true });
  mkdirSync(env.SAM_INSTALL_HOME, { recursive: true });
  Object.assign(process.env, env);
  // a git repo with an origin so hooks resolve a real project
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/chaos.git\n');
  mkdirSync(join(repo, 'src'), { recursive: true });
  return { tmp, repo, ...env, dbPath: join(env.SAM_HOME, 'sam.db') };
}

/** Silence node:sqlite's ExperimentalWarning in-process, like bin/sam.js does. */
export function quietSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : orig.call(process, w, ...r));
}

export const sam = (m) => import(pathToFileURL(join(SAM_SRC, m)).href);

/** mulberry32: small, fast, seedable PRNG so every failure is reproducible from its seed. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
  return r;
}

export function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ---------------- payload generation ----------------

const WORDS = ['use', 'pnpm', 'never', 'npm', 'remember', 'that', 'the', 'auth', 'token', 'redis', 'tRPC', 'inventory', 'always', 'from now on',
  'unutma', 'bundan sonra', 'her zaman', 'asla', 'İstanbul', 'ışık', 'deploy', 'migration', 'fix', 'error', 'TS2345', 'src/app.ts'];

/** A hostile string. `big` allows multi-megabyte strings. */
export function hostileString(r, { big = false } = {}) {
  const k = r.int(0, big ? 21 : 19);
  switch (k) {
    case 0: return '';
    case 1: return ' ';
    case 2: return Array.from({ length: r.int(1, 30) }, () => r.pick(WORDS)).join(' ');
    case 3: return '\u0000' + 'abc\u0000def' + '\u0000'.repeat(r.int(0, 50));
    case 4: return '\ud800' + 'x' + '\udfff' + '\ud83d'; // lone surrogates
    case 5: return '😀'.repeat(r.int(1, 200)) + '👨‍👩‍👧‍👦';
    case 6: return `⟦mem ${r.pick(['fact', 'decision', 'convention', 'constructor', '__proto__', 'kind', 'note', 'xyz', 'toString'])}: ${r.pick(['use pnpm workspaces for builds', '      ', '<text>', 'deploy: blue-green', '\n\n\n\n'])}⟧`;
    case 7: return `[[mem ${r.pick(['fact', 'constructor', 'decision'])}: ${r.pick(['package manager: pnpm', 'x'.repeat(600), '    '])}]]`;
    case 8: return 'remember that ' + r.pick(WORDS) + ' ' + r.pick(WORDS) + ' is the rule';
    case 9: return 'sk-proj-' + 'A1'.repeat(20) + ' password=hunter22 ' + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmn';
    case 10: return '<memory project="x">' + '</memory>'.repeat(3) + '<private>secret</private>';
    case 11: return 'a_'.repeat(r.int(10, 4000)); // redact() worst case (bounded here; see the subprocess test for big ones)
    case 12: return Array.from({ length: r.int(10, 400) }, () => r.pick(['-', '_', 'a', 'Z', '9', 'x'])).join('');
    case 13: return '/'.repeat(r.int(1, 500)) + '..'.repeat(r.int(0, 50));
    case 14: return String(r.next() * 1e308);
    case 15: return '*** Update File: ' + r.pick(['src/a.ts', '../../etc/passwd', '', ' '.repeat(10)]);
    case 16: return 'npm test\n' + 'FAIL src/x.test.ts\n'.repeat(r.int(1, 50)) + 'exit code 1';
    case 17: return '\u202e\u200b\ufeff' + 'İIı'.repeat(r.int(1, 30));
    case 18: return '"' + "'".repeat(r.int(1, 30)) + '\\'.repeat(r.int(1, 30));
    case 19: return Array.from({ length: r.int(1, 2000) }, () => String.fromCharCode(r.int(1, 0xd7ff))).join('');
    case 20: return 'x'.repeat(10 * 1024 * 1024); // 10 MB
    case 21: return ('lorem ipsum ' + r.pick(WORDS) + ' ').repeat(900000); // ~10 MB of words
    default: return 'x';
  }
}

export function hostileValue(r, depth = 0, opts = {}) {
  const k = r.int(0, depth > 4 ? 5 : 9);
  switch (k) {
    case 0: return null;
    case 1: return r.chance(0.5);
    case 2: return r.pick([0, -1, 1, 2 ** 53, -(2 ** 53), 1e308, -1e-308, 3.14159, 4294967296, -0]);
    case 3: case 4: case 5: return hostileString(r, opts);
    case 6: return Array.from({ length: r.int(0, 6) }, () => hostileValue(r, depth + 1, opts));
    case 7: {
      const o = {};
      for (let i = r.int(0, 6); i > 0; i--) o[r.pick(['__proto__', 'constructor', 'prototype', 'toString', 'a', 'command', 'file_path', 'exit_code', 'output', 'role', 'type', 'content', 'text'])] = hostileValue(r, depth + 1, opts);
      return o;
    }
    case 8: return r.chance(0.15) ? deepNest(r.int(50, 3000), r.chance(0.5)) : hostileString(r, opts);
    case 9: return r.chance(0.05) ? Array.from({ length: r.int(1000, 200000) }, (_, i) => (i % 2 ? i : 'x')) : [hostileString(r, opts), r.int(0, 9)];
    default: return null;
  }
}

export function deepNest(n, arr = true) {
  let v = 'leaf';
  for (let i = 0; i < n; i++) v = arr ? [v] : (i % 2 ? { output: v } : { content: v, role: "assistant" });
  return v;
}

/** The fields the six dialects send, with a well-typed generator for each. */
export function wellTyped(r, field, ctx) {
  switch (field) {
    case 'session_id': case 'sessionId': case 'conversation_id': case 'conversationId': case 'thread_id': return r.pick(ctx.sessions);
    case 'cwd': return r.pick(ctx.cwds);
    case 'workspacePaths': case 'workspace_roots': return [r.pick(ctx.cwds)];
    case 'transcript_path': case 'transcriptPath': return r.pick(ctx.transcripts);
    case 'source': case 'trigger': return r.pick(['startup', 'resume', 'clear', 'compact', 'auto', 'manual']);
    case 'prompt': case 'user_prompt': case 'text': return r.pick(['remember that we deploy with blue-green', 'always run pnpm lint before commit', 'fix the auth bug in src/app.ts', 'unutma: API anahtarı .env içinde', 'what is the inventory tRPC router?', '<memory recall>- [F] x #abcd</memory> real question here please']);
    case 'tool_name': case 'toolName': return r.pick(['Bash', 'Edit', 'Write', 'Read', 'run_shell_command', 'write_file', 'apply_patch', 'run_command', 'view_file', 'Shell', 'mcp__sam__mem_search', 'Unknown']);
    case 'tool_input': case 'toolInput': case 'args': return r.pick([{ command: 'npm test' }, { file_path: ctx.repo + '/src/app.ts' }, { path: 'src/x.ts' }, { command: ['bash', '-lc', 'pnpm build'] }, '*** Begin Patch\n*** Update File: src/a.ts\n']);
    case 'toolCall': return { name: r.pick(['run_command', 'write_to_file']), args: { CommandLine: 'npm test', TargetFile: 'src/b.ts' } };
    case 'tool_response': case 'toolResponse': case 'tool_output': case 'output': return r.pick([{ stdout: 'ok', exit_code: 0 }, { stderr: 'error: TS2345 boom', exit_code: 1 }, 'FAIL src/x.test.ts', '{"exitCode": 2}', { is_error: true }]);
    case 'error': return r.pick(['boom', { message: 'x' }, '']);
    case 'last_assistant_message': case 'prompt_response': return r.pick(['done ⟦mem decision: deploy with blue-green⟧', 'ok', '[[mem fact: node 22 required for node:sqlite]]']);
    case 'invocationNum': return r.int(0, 5);
    case 'fullyIdle': return r.chance(0.5);
    case 'file_path': return ctx.repo + '/src/app.ts';
    case 'command': return 'pnpm test';
    case 'hook_event_name': case 'hookEventName': return r.pick(ctx.events);
    case 'cursor_version': return '1.7.0';
    default: return null;
  }
}

export const FIELDS = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'cwd', 'workspacePaths', 'workspace_roots',
  'transcript_path', 'transcriptPath', 'source', 'trigger', 'prompt', 'user_prompt', 'text', 'tool_name', 'toolName', 'toolCall', 'tool_input',
  'toolInput', 'args', 'tool_response', 'toolResponse', 'tool_output', 'output', 'error', 'last_assistant_message', 'prompt_response',
  'invocationNum', 'fullyIdle', 'file_path', 'command', 'hook_event_name', 'hookEventName', 'cursor_version', '__proto__', 'constructor'];

export const DIALECTS = {
  claude: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'Stop', 'SessionEnd'],
  codex: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop'],
  gemini: ['SessionStart', 'BeforeAgent', 'AfterTool', 'PreCompress', 'AfterAgent', 'SessionEnd'],
  antigravity: ['PreInvocation', 'PostToolUse', 'Stop'],
  opencode: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SessionEnd'],
  cursor: ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse', 'preCompact', 'sessionEnd'],
};

/** A payload object: each field present with p=0.5, well-typed half the time, hostile otherwise. */
export function payloadObject(r, ctx, { big = false } = {}) {
  const p = {};
  for (const f of FIELDS) {
    if (!r.chance(0.45)) continue;
    const v = r.chance(0.5) ? wellTyped(r, f, ctx) : hostileValue(r, 0, { big });
    if (f === '__proto__') Object.defineProperty(p, '__proto__', { value: v, enumerable: true, configurable: true, writable: true });
    else p[f] = v;
  }
  return p;
}

/** Raw stdin bytes: usually valid JSON, sometimes damaged at the byte level. */
export function payloadBytes(r, ctx, opts = {}) {
  const roll = r.next();
  if (roll < 0.04) return Buffer.from(r.pick(['', ' ', '\n', 'null', '5', '"str"', '[]', '[1,2]', 'true', '{', '}', '{}{}', '\ufeff{}', 'NaN', '{"a":1}garbage']));
  if (roll < 0.06) return Buffer.from('['.repeat(r.int(1000, 200000)) + ']'.repeat(r.int(0, 1)));
  let s;
  try { s = JSON.stringify(payloadObject(r, ctx, opts)); } catch { s = '{}'; }
  let b = Buffer.from(s, 'utf8');
  const m = r.next();
  if (m < 0.05) { // invalid UTF-8 bytes spliced in
    const i = r.int(0, b.length);
    b = Buffer.concat([b.subarray(0, i), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x90, 0x28, 0xbc]), b.subarray(i)]);
  } else if (m < 0.08) { // raw NUL bytes
    const i = r.int(0, b.length);
    b = Buffer.concat([b.subarray(0, i), Buffer.alloc(r.int(1, 64)), b.subarray(i)]);
  } else if (m < 0.11) { // truncated document
    b = b.subarray(0, r.int(0, b.length));
  } else if (m < 0.13) { // invalid UTF-8 inside a JSON string value
    b = Buffer.concat([Buffer.from('{"prompt":"remember that '), Buffer.from([0xc0, 0xaf, 0xed, 0xa0, 0x80]), Buffer.from(' uses pnpm","session_id":"s1"}')]);
  }
  return b;
}
