// MCP stdio fuzzer for `sam mcp`. Every stdout line must be one JSON-RPC message; the server must
// never crash, must answer each request id exactly once, in order, and must exit cleanly on EOF.
//
//   node fuzz-mcp.mjs [--n 3000] [--seed 5] [--scenario all|random|huge|partial|interleave|slow|abrupt|dos]
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { freshEnv, SAM_BIN, rng, pct, hostileValue, hostileString } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const env = freshEnv('mcp');
const scenario = args.scenario || 'all';
const report = {};

function server() {
  const c = spawn(process.execPath, [SAM_BIN, 'mcp', '--agent', 'fuzz'], { cwd: env.repo, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { c, lines: [], bad: [], stderr: '', exit: null, buf: '', waiters: [] };
  c.stdout.on('data', (d) => {
    s.buf += d.toString('utf8');
    let i;
    while ((i = s.buf.indexOf('\n')) >= 0) {
      const ln = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1);
      try { s.lines.push(JSON.parse(ln)); } catch { s.bad.push(ln.slice(0, 200)); }
      s.waiters = s.waiters.filter((w) => !w());
    }
  });
  c.stderr.on('data', (d) => { s.stderr += d.toString('utf8'); });
  c.stdin.on('error', () => {});
  s.done = new Promise((res) => c.on('close', (code, signal) => { s.exit = { code, signal }; if (s.buf) s.bad.push('[unterminated] ' + s.buf.slice(0, 200)); res(); }));
  s.send = (o) => c.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  s.waitFor = (pred, ms = 30000) => new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    const w = () => { if (pred(s)) { clearTimeout(t); res(true); return true; } return false; };
    if (!w()) s.waiters.push(w);
  });
  return s;
}
const init = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fuzz', version: '0' } } };
const call = (id, name, a) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: a } });
const summarize = (s, extra = {}) => ({ exit: s.exit, nonJsonStdoutLines: s.bad.length, badExamples: s.bad.slice(0, 3), stderr: s.stderr.slice(0, 300), responses: s.lines.length, ...extra });

// 1) random JSON-RPC
if (scenario === 'all' || scenario === 'random') {
  const r = rng(Number(args.seed || 5));
  const N = Number(args.n || 3000);
  const s = server();
  s.send(init);
  let expected = 1; // init
  const lat = [];
  const sentIds = [];
  const methods = ['initialize', 'tools/list', 'tools/call', 'tools/call', 'tools/call', 'ping', 'resources/list', 'prompts/list', 'nope', '', 'notifications/initialized'];
  const tools = ['mem_search', 'mem_get', 'mem_save', 'mem_forget', 'mem_nope', '__proto__', 'constructor'];
  for (let i = 0; i < N; i++) {
    const k = r.next();
    let line;
    if (k < 0.08) line = r.pick(['', '   ', 'not json', '{', '[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', 'null', '42', '"x"', '{"jsonrpc":"2.0"}', '{"result":{}, "id": 3}', '\ufeff{"jsonrpc":"2.0","id":"bom","method":"ping"}', '{"id":1,"method":"ping"}\r']);
    else {
      const m = { jsonrpc: '2.0' };
      if (!r.chance(0.1)) m.id = r.chance(0.7) ? `r${i}` : r.pick([i, -i, 0, null, 1e300, { o: 1 }, [1], true, 'x'.repeat(1000)]);
      m.method = r.pick(methods);
      const a = {};
      if (r.chance(0.8)) a.q = r.chance(0.6) ? r.pick(['pnpm', 'deploy blue green', 'auth token', 'İstanbul ışık', 'NEAR(a b)', '"unbalanced', 'a* OR b*', '^$']) : hostileValue(r, 2);
      if (r.chance(0.5)) a.text = r.chance(0.6) ? `fuzz memory ${i % 97}: ${r.pick(['use pnpm', 'deploy on friday', 'never force push', 'package manager: yarn'])}` : hostileValue(r, 2);
      if (r.chance(0.4)) a.kind = r.pick(['decision', 'fact', 'note', 'todo', 'session', 'constructor', '__proto__', 'toString', 'karar', 5, null]);
      if (r.chance(0.4)) a.ids = r.chance(0.5) ? 'abcd o12345 ' + r.pick(['#x', '', 'zzzz']) : hostileValue(r, 2);
      if (r.chance(0.2)) a.grep = r.pick(['(a+)+$', 'error', '[', '\\1', 'x'.repeat(300)]);
      if (r.chance(0.3)) a.k = r.pick([1, 0, -5, 1e9, '7', null, 'NaN']);
      if (r.chance(0.2)) a.files = hostileValue(r, 2);
      if (r.chance(0.2)) a.pin = hostileValue(r, 3);
      if (r.chance(0.2)) a.id = hostileValue(r, 3);
      m.params = r.chance(0.9) ? { name: r.pick(tools), arguments: r.chance(0.9) ? a : hostileValue(r, 2) } : hostileValue(r, 2);
      if (m.method === 'initialize') m.params = { protocolVersion: r.pick(['2025-11-25', '1999-01-01', null, 5]) };
      line = JSON.stringify(m);
      if ('id' in m) expected++;
      if (typeof m.id === 'string' && m.id.startsWith('r')) sentIds.push(m.id);
    }
    if (line.trim() && !/^\s*(\{|\[|null|42|"x"|not json|\ufeff)/.test(line)) { /* blank lines are ignored */ }
    // expected responses for junk: parse errors and batches get an error with id null; valid non-request JSON gets nothing
    if (k < 0.08) {
      const t = line.trim();
      if (t) { let parsed, ok = true; try { parsed = JSON.parse(line); } catch { ok = false; } if (!ok || Array.isArray(parsed)) expected++; }
    }
    const t0 = performance.now();
    s.send(line);
    if (i % 50 === 0) { await s.waitFor((x) => x.lines.length >= expected, 60000); lat.push(performance.now() - t0); }
  }
  const got = await s.waitFor((x) => x.lines.length >= expected, 60000);
  s.c.stdin.end();
  await s.done;
  const answered = new Map();
  for (const l of s.lines) if (typeof l.id === 'string') answered.set(l.id, (answered.get(l.id) || 0) + 1);
  const unanswered = sentIds.filter((id) => !answered.has(id)).length;
  const duplicated = sentIds.filter((id) => answered.get(id) > 1).length;
  report.random = summarize(s, { sent: N, stringIdRequests: sentIds.length, unanswered, duplicated, expectedResponses: expected, allAnswered: got, roundTripP50: +pct(lat, 50).toFixed(1), roundTripP99: +pct(lat, 99).toFixed(1),
    isErrorResults: s.lines.filter((l) => l.result?.isError).length, errorMsgs: [...new Set(s.lines.filter((l) => l.result?.isError).map((l) => l.result.content[0].text.slice(0, 90)))].slice(0, 12) });
}

// 2) huge lines
if (scenario === 'all' || scenario === 'huge') {
  const s = server();
  s.send(init);
  const t0 = performance.now();
  s.send(call('h1', 'mem_search', { q: 'pnpm '.repeat(2_000_000) })); // 10 MB query
  s.send(call('h2', 'mem_save', { text: 'huge body memory: ' + 'lorem ipsum dolor '.repeat(600_000) })); // ~11 MB text
  s.send('x'.repeat(50 * 1024 * 1024)); // 50 MB junk line
  s.send({ jsonrpc: '2.0', id: 'h3', method: 'ping' });
  const ok = await s.waitFor((x) => x.lines.some((l) => l.id === 'h3'), 100000);
  const ms = Math.round(performance.now() - t0);
  s.c.stdin.end();
  await s.done;
  report.huge = summarize(s, { allAnswered: ok, ms, ids: s.lines.map((l) => l.id) });
}

// 3) partial lines + EOF without trailing newline
if (scenario === 'all' || scenario === 'partial') {
  const s = server();
  s.send(init);
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'tools/list' });
  s.c.stdin.write(msg.slice(0, 10));
  await new Promise((r) => setTimeout(r, 300));
  s.c.stdin.write(msg.slice(10) + '\n');
  s.c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'p2', method: 'ping' })); // no newline, then EOF
  s.c.stdin.end();
  await s.done;
  report.partial = summarize(s, { ids: s.lines.map((l) => l.id), finalLineWithoutNewlineAnswered: s.lines.some((l) => l.id === 'p2') });
}

// 4) interleaved / pipelined requests: 2000 without waiting; order must be FIFO
if (scenario === 'all' || scenario === 'interleave') {
  const s = server();
  s.send(init);
  const ids = [];
  let blob = '';
  for (let i = 0; i < 2000; i++) {
    const id = 'i' + i; ids.push(id);
    const m = i % 4 === 0 ? call(id, 'mem_save', { text: `interleave fact number ${i} about module m${i % 37}`, kind: 'fact' })
      : i % 4 === 1 ? call(id, 'mem_search', { q: 'module m' + (i % 37) }) : i % 4 === 2 ? call(id, 'mem_get', { ids: 'zzzz' }) : { jsonrpc: '2.0', id, method: 'ping' };
    blob += JSON.stringify(m) + '\n';
  }
  const t0 = performance.now();
  s.c.stdin.write(blob);
  const ok = await s.waitFor((x) => x.lines.filter((l) => /^i\d+$/.test(String(l.id))).length >= 2000, 100000);
  const ms = Math.round(performance.now() - t0);
  const order = s.lines.filter((l) => /^i\d+$/.test(String(l.id))).map((l) => l.id);
  s.c.stdin.end();
  await s.done;
  report.interleave = summarize(s, { allAnswered: ok, ms, fifo: JSON.stringify(order) === JSON.stringify(ids) });
}

// 5) slow writer: one byte every 2 ms
if (scenario === 'all' || scenario === 'slow') {
  const s = server();
  const b = Buffer.from(JSON.stringify(init) + '\n' + JSON.stringify(call('s1', 'mem_save', { text: 'slow writer memory survives', kind: 'fact' })) + '\n');
  for (let i = 0; i < b.length; i++) { s.c.stdin.write(b.subarray(i, i + 1)); await new Promise((r) => setTimeout(r, 2)); }
  const ok = await s.waitFor((x) => x.lines.some((l) => l.id === 's1'), 20000);
  s.c.stdin.end();
  await s.done;
  report.slow = summarize(s, { answered: ok });
}

// 6) abrupt close: stdin closed right after a write request; and client stops reading stdout
if (scenario === 'all' || scenario === 'abrupt') {
  const s = server();
  s.send(init);
  s.send(call('a1', 'mem_save', { text: 'abrupt close memory must persist', kind: 'decision' }));
  s.c.stdin.end();
  await s.done;
  const s2 = server();
  s2.c.stdout.destroy(); // client went away: writes hit EPIPE
  s2.send(init);
  s2.send(call('a2', 'mem_save', { text: 'written while stdout is closed', kind: 'fact' }));
  await new Promise((r) => setTimeout(r, 1500));
  s2.c.stdin.end();
  await s2.done;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(env.dbPath);
  const persisted = db.prepare("SELECT gist FROM memories WHERE gist LIKE 'abrupt close%' OR gist LIKE 'written while%'").all().map((x) => x.gist);
  db.close();
  report.abrupt = { first: summarize(s, { ids: s.lines.map((l) => l.id) }), stdoutGone: { exit: s2.exit, stderr: s2.stderr.slice(0, 200) }, persisted };
}

// 7) head-of-line blocking: one expensive request stalls every later request (FIFO chain)
if (scenario === 'all' || scenario === 'dos') {
  const s = server();
  s.send(init);
  await s.waitFor((x) => x.lines.length >= 1);
  const t0 = performance.now();
  s.send(call('d1', 'mem_save', { text: 'a_'.repeat(Number(args.dosN || 40000)), kind: 'note' })); // redact() is quadratic on long [\w-] runs
  s.send({ jsonrpc: '2.0', id: 'd2', method: 'ping' });
  const ok = await s.waitFor((x) => x.lines.some((l) => l.id === 'd2'), 110000);
  const pingMs = Math.round(performance.now() - t0);
  s.c.stdin.end();
  await s.done;
  report.dos = summarize(s, { pingAnswered: ok, pingLatencyMs: pingMs, payloadChars: 2 * Number(args.dosN || 40000) });
}

console.log(JSON.stringify(report, null, 1));
