// Out-of-process hook fuzzer: runs the real `node bin/sam.js hook <Event> --agent <a>` and checks the
// contract a host sees: exit code 0, stdout empty or exactly one JSON document, stderr, wall latency,
// peak RSS (reported by a preload over fd 3, so stdout/stderr stay untouched).
//
//   node fuzz-hooks-proc.mjs --mode random  --agent claude --n 40 [--seed 3]
//   node fuzz-hooks-proc.mjs --mode special [--agent claude|antigravity|...]
//   node fuzz-hooks-proc.mjs --mode stdin
// Writes JSON lines to --out (default stdout summary only). A run is killed at 12 s (host timeout is 10 s).
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, ftruncateSync, closeSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshEnv, SAM_BIN, rng, pct, payloadBytes, DIALECTS } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const mode = args.mode || 'random';
const env = freshEnv('proc-' + mode);
const KILL_MS = Number(args.kill || 12000);
const preload = join(env.tmp, 'rss-preload.mjs');
writeFileSync(preload, "import { writeSync } from 'node:fs';\nprocess.on('exit', () => { try { writeSync(3, String(process.resourceUsage().maxRSS)); } catch {} });\n");

const tdir = join(env.tmp, 't');
mkdirSync(tdir, { recursive: true });
const fifo = join(tdir, 'fifo');
execFileSync('mkfifo', [fifo]);
const sparse = join(tdir, 'sparse.bin');
{ const fd = openSync(sparse, 'w'); ftruncateSync(fd, 2 * 1024 ** 3); closeSync(fd); }
const noperm = join(tdir, 'noperm.jsonl');
writeFileSync(noperm, '{"role":"user","content":"x"}\n');
chmodSync(noperm, 0o000);
const good = join(tdir, 'good.jsonl');
writeFileSync(good, JSON.stringify({ role: 'user', content: 'remember that deploys are blue-green' }) + '\n' + JSON.stringify({ role: 'assistant', content: 'ok ⟦mem decision: deploys are blue-green⟧' }) + '\n');

/** Run one hook process. `feed` is a Buffer (written then closed), or a function(child) for custom stdin behaviour. */
export function runOne(agent, event, feed, { killMs = KILL_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const c = spawn(process.execPath, ['--import', preload, SAM_BIN, 'hook', event, '--agent', agent], {
      cwd: env.repo, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const out = [], err = [], rss = [];
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => err.push(d));
    c.stdio[3].on('data', (d) => rss.push(d));
    c.stdin.on('error', () => {});
    let killed = false;
    const timer = setTimeout(() => { killed = true; c.kill('SIGKILL'); }, killMs);
    c.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      let validJson = stdout === '';
      if (!validJson) { try { JSON.parse(stdout); validJson = stdout.endsWith('\n') && stdout.trim().split('\n').length === 1; } catch { validJson = false; } }
      resolve({ agent, event, code, signal, killed, ms: Math.round(performance.now() - t0), rssMB: Math.round(Number(Buffer.concat(rss).toString() || 0) / 1024), validJson, stdoutHead: stdout.slice(0, 160), stderr: Buffer.concat(err).toString('utf8').slice(0, 400) });
    });
    if (typeof feed === 'function') feed(c);
    else { c.stdin.end(feed); }
  });
}

const ok = (r) => r.code === 0 && !r.killed && r.validJson && r.stderr === '';
const results = [];
const record = (label, r) => { r.label = label; r.pass = ok(r); results.push(r); if (args.verbose || !r.pass) console.error((r.pass ? 'PASS ' : 'FAIL ') + label, JSON.stringify({ code: r.code, signal: r.signal, killed: r.killed, ms: r.ms, rssMB: r.rssMB, validJson: r.validJson, stderr: r.stderr.slice(0, 160), out: r.stdoutHead.slice(0, 80) })); };

const ctx = {
  repo: env.repo, sessions: ['s1', 's2', 'x'.repeat(200)], cwds: [env.repo, '/', '/nonexistent'],
  transcripts: [good, '/dev/zero', tdir, sparse, noperm, '/dev/stdin', join(tdir, 'missing')], events: [],
};

if (mode === 'random') {
  const agents = args.agent ? [args.agent] : Object.keys(DIALECTS);
  const r = rng(Number(args.seed || 3));
  for (const a of agents) for (const ev of DIALECTS[a]) {
    ctx.events = DIALECTS[a];
    for (let i = 0; i < Number(args.n || 20); i++) record(`${a}/${ev}/random#${i}`, await runOne(a, ev, payloadBytes(r, ctx, { big: r.chance(0.05) })));
  }
}

if (mode === 'special') {
  const big = 'x'.repeat(10 * 1024 * 1024);
  const J = (o) => Buffer.from(JSON.stringify(o));
  const S = { session_id: 'sp1', cwd: env.repo };
  const cases = [
    ['prompt 10MB string', 'UserPromptSubmit', J({ ...S, prompt: big })],
    ['prompt 10MB words', 'UserPromptSubmit', J({ ...S, prompt: 'remember that we deploy with blue green on fridays. '.repeat(200000) })],
    ['prompt 20KB a_a_ (redact quadratic)', 'UserPromptSubmit', J({ ...S, prompt: 'a_'.repeat(10000) })],
    ['prompt 60KB a_a_ (redact quadratic)', 'UserPromptSubmit', J({ ...S, prompt: 'a_'.repeat(30000) })],
    ['prompt 200KB a_a_ (redact quadratic)', 'UserPromptSubmit', J({ ...S, prompt: 'a_'.repeat(100000) })],
    ['bash heredoc 150KB snake_case (redact quadratic)', 'PostToolUse', J({ ...S, tool_name: 'Bash', tool_input: { command: "cat > gen.txt <<'EOF'\n" + 'some_generated_identifier_'.repeat(6000) + '\nEOF' }, tool_response: { stdout: '', exit_code: 0 } })],
    ['tool_response 10MB', 'PostToolUse', J({ ...S, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: big, exit_code: 1 } })],
    ['10MB JSON array of objects (readStdin re-parse)', 'PostToolUse', Buffer.from('{"session_id":"sp1","tool_name":"Read","tool_input":{"file_path":"a.ts"},"x":[' + Array.from({ length: 400000 }, () => '{"a":1}').join(',') + ']}')],
    ['invalid UTF-8 bytes', 'UserPromptSubmit', Buffer.concat([Buffer.from('{"session_id":"sp1","prompt":"remember that '), Buffer.from([0xff, 0xc0, 0xaf, 0xed, 0xa0, 0x80]), Buffer.from(' x y z"}')])],
    ['raw NUL bytes', 'UserPromptSubmit', Buffer.concat([Buffer.from('{"session_id":"sp1",'), Buffer.alloc(100), Buffer.from('"prompt":"x"}')])],
    ['escaped NULs', 'UserPromptSubmit', J({ ...S, prompt: 'remember that \u0000 nul \u0000 bytes are fine here' })],
    ['200k-deep array', 'UserPromptSubmit', Buffer.from('['.repeat(200000) + ']'.repeat(200000))],
    ['200k-deep tool_response', 'PostToolUse', Buffer.from('{"session_id":"sp1","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":' + '['.repeat(200000) + ']'.repeat(200000) + '}')],
    ['1M-element array', 'PostToolUse', Buffer.from('{"session_id":"sp1","tool_name":"Edit","tool_input":{"paths":[' + Array.from({ length: 1000000 }, (_, i) => i).join(',') + ']}}')],
    ['__proto__ / constructor keys', 'UserPromptSubmit', Buffer.from('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"session_id":"sp1","prompt":"remember that proto keys are inert"}')],
    ['numbers where strings belong', 'PostToolUse', J({ session_id: 7, cwd: 8, transcript_path: 9, tool_name: 10, tool_input: 11, tool_response: 12 })],
    ['object transcript_path', 'Stop', J({ ...S, transcript_path: { a: 1 } })],
    ['marker poison: constructor kind', 'Stop', J({ ...S, last_assistant_message: 'done ⟦mem constructor: keep me⟧ and ⟦mem decision: second marker is lost⟧' })],
    ['marker poison: blank body', 'Stop', J({ ...S, last_assistant_message: '⟦mem fact:      ⟧ then ⟦mem decision: lost too⟧' })],
  ];
  const tpCases = [['/dev/zero', '/dev/zero'], ['FIFO', fifo], ['directory', tdir], ['2GB sparse', sparse], ['no permission', noperm], ['/dev/stdin', '/dev/stdin'], ['/proc/self/mem', '/proc/self/mem']];
  for (const [n, p] of tpCases) {
    cases.push([`transcript ${n} (Stop)`, 'Stop', J({ ...S, transcript_path: p })]);
    cases.push([`transcript ${n} (PreCompact)`, 'PreCompact', J({ ...S, transcript_path: p })]);
    cases.push([`transcript ${n} (antigravity PreInvocation)`, 'PreInvocation', J({ conversationId: 'sp2', workspacePaths: [env.repo], transcriptPath: p, invocationNum: 1 }), 'antigravity']);
  }
  for (const [label, ev, feed, ag] of cases) record(label, await runOne(ag || args.agent || 'claude', ev, feed));
}

if (mode === 'stdin') {
  const J = Buffer.from(JSON.stringify({ session_id: 'st1', cwd: env.repo, prompt: 'remember that stdin handling is bounded' }));
  record('stdin kept open, no data', await runOne('claude', 'UserPromptSubmit', () => {}));
  record('stdin kept open after full JSON', await runOne('claude', 'UserPromptSubmit', (c) => c.stdin.write(J)));
  record('stdin closed immediately', await runOne('claude', 'UserPromptSubmit', (c) => c.stdin.end()));
  record('slow writer (1 byte / 20 ms)', await runOne('claude', 'UserPromptSubmit', (c) => { let i = 0; const t = setInterval(() => { if (i >= J.length) { clearInterval(t); c.stdin.end(); return; } c.stdin.write(J.subarray(i, i + 1)); i++; }, 20); c.on('close', () => clearInterval(t)); }));
  record('half JSON then hang', await runOne('claude', 'UserPromptSubmit', (c) => c.stdin.write(J.subarray(0, 30))));
  record('two JSON docs', await runOne('claude', 'UserPromptSubmit', Buffer.concat([J, J])));
  record('stdin 10MB in 64KB chunks, 5 ms apart', await runOne('claude', 'PostToolUse', (c) => {
    const b = Buffer.from('{"session_id":"st1","tool_name":"Read","tool_input":{"file_path":"a.ts"},"x":[' + Array.from({ length: 1200000 }, () => '{"a":1}').join(',') + ']}');
    let i = 0; const t = setInterval(() => { if (i >= b.length) { clearInterval(t); c.stdin.end(); return; } c.stdin.write(b.subarray(i, i + 65536)); i += 65536; }, 5); c.on('close', () => clearInterval(t));
  }));
}

const lat = results.map((r) => r.ms), mem = results.map((r) => r.rssMB);
const summary = { mode, n: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length,
  nonzeroExit: results.filter((r) => r.code !== 0).length, killedAt12s: results.filter((r) => r.killed).length, invalidStdout: results.filter((r) => !r.validJson).length,
  stderrNonEmpty: results.filter((r) => r.stderr).length, p50ms: pct(lat, 50), p99ms: pct(lat, 99), maxms: Math.max(...lat), rssP50MB: pct(mem, 50), rssMaxMB: Math.max(...mem) };
if (args.out) appendFileSync(args.out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify(summary));
try { chmodSync(noperm, 0o600); } catch { /* noop */ }
