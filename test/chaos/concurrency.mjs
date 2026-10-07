// Concurrency at scale: N parallel hooks + M MCP servers + `sam gc`, all on one big DB.
//   node concurrency.mjs --template /tmp/big50k.db [--hooks 50] [--rounds 3] [--mcp 3] [--gc 1]
// Hooks run with SAM_DEBUG=1 so errors the CLI normally swallows ("database is locked") reach stderr.
import { spawn } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freshEnv, SAM_BIN, pct, quietSqlite, sam } from './lib.mjs';

quietSqlite();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const env = freshEnv('conc');
copyFileSync(args.template, env.dbPath);
const { resolveProject } = await sam('project.js');
const pid = resolveProject(env.repo).id;
const { closeDb } = await sam('db.js');
closeDb();
{ const d = new DatabaseSync(env.dbPath); d.prepare("UPDATE memories SET project = ? WHERE project = 'p_alpha'").run(pid); d.close(); }

const HOOKS = Number(args.hooks || 50), ROUNDS = Number(args.rounds || 3), MCPS = Number(args.mcp || 3);
const penv = { ...process.env, SAM_DEBUG: '1' };
const strip = (s) => s.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?|\(Use `node --trace-warnings[^\n]*\n?/g, '');

function run(argv, stdin) {
  return new Promise((res) => {
    const t = performance.now();
    const c = spawn(process.execPath, [SAM_BIN, ...argv], { cwd: env.repo, env: penv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.stdin.on('error', () => {});
    c.stdin.end(stdin ?? '');
    c.on('close', (code, signal) => res({ argv: argv.slice(0, 2).join(' '), code, signal, ms: Math.round(performance.now() - t), out: out.slice(0, 200), err: strip(err).slice(0, 300) }));
  });
}
const payload = (i, round) => {
  const s = `c${i % 20}`;
  const k = i % 5;
  if (k === 0) return ['SessionStart', { session_id: s + 'r' + round, cwd: env.repo, source: 'startup' }];
  if (k === 1) return ['UserPromptSubmit', { session_id: s, cwd: env.repo, prompt: `remember that the cache module ${i} uses redis cluster ${round}. how does the billing webhook retry work?` }];
  if (k === 2) return ['PostToolUse', { session_id: s, cwd: env.repo, tool_name: 'Edit', tool_input: { file_path: env.repo + '/src/cache/index.ts' } }];
  if (k === 3) return ['PostToolUse', { session_id: s, cwd: env.repo, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: i % 2 ? 'ok' : 'FAIL x', exit_code: i % 2 ? 0 : 1 } }];
  return ['Stop', { session_id: s, cwd: env.repo, last_assistant_message: `done ⟦mem decision: concurrency decision ${i} round ${round}⟧` }];
};

function mcpClient(n, stopAt) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SAM_BIN, 'mcp', '--agent', 'conc' + n], { cwd: env.repo, env: penv, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', id = 0;
    const lat = [], errors = [];
    let sentAt = 0;
    const next = () => {
      if (Date.now() > stopAt) { c.stdin.end(); return; }
      id++;
      const k = id % 3;
      const m = k === 0 ? { name: 'mem_save', arguments: { text: `mcp${n} concurrency fact ${id}: queue worker ${id % 50} uses idempotency keys`, kind: 'fact' } }
        : k === 1 ? { name: 'mem_search', arguments: { q: 'cache redis invoice webhook ' + (id % 20) } } : { name: 'mem_get', arguments: { ids: 'zzzz' } };
      sentAt = performance.now();
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: m }) + '\n');
    };
    c.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i); buf = buf.slice(i + 1);
        const msg = JSON.parse(ln);
        if (msg.id === 0) { next(); continue; }
        lat.push(performance.now() - sentAt);
        if (msg.result?.isError || msg.error) errors.push((msg.result?.content?.[0]?.text || msg.error?.message || '').slice(0, 100));
        next();
      }
    });
    c.stderr.on('data', (d) => { err += d; });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) + '\n');
    c.on('close', (code) => resolve({ n, code, requests: lat.length, p50: Math.round(pct(lat, 50)), p99: Math.round(pct(lat, 99)), max: Math.round(Math.max(0, ...lat)), errors: errors.length, errorKinds: [...new Set(errors)].slice(0, 5), stderr: strip(err).slice(0, 200) }));
  });
}

const t0 = Date.now();
const stopAt = Date.now() + Number(args.seconds || 40) * 1000;
const mcps = Array.from({ length: MCPS }, (_, n) => mcpClient(n, stopAt));
const gcs = [];
const hookResults = [];
for (let round = 0; round < ROUNDS; round++) {
  if (Number(args.gc ?? 1)) gcs.push(run(['gc']));
  const batch = Array.from({ length: HOOKS }, (_, i) => { const [ev, p] = payload(i, round); return run(['hook', ev, '--agent', 'claude'], JSON.stringify(p)).then((r) => ({ ev, ...r })); });
  hookResults.push(...(await Promise.all(batch)));
}
const gcRes = await Promise.all(gcs);
const mcpRes = await Promise.all(mcps);
const lat = hookResults.map((r) => r.ms);
const errs = hookResults.filter((r) => r.err);
const kinds = {};
for (const r of errs) { const k = (r.err.split('\n').find((l) => /Error|locked|busy/.test(l)) || r.err.split('\n')[0]).trim().slice(0, 90); kinds[k] = (kinds[k] || 0) + 1; }
const d = new DatabaseSync(env.dbPath);
const integrity = d.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]).join(';');
let fts = 'ok'; try { d.exec("INSERT INTO mem_fts(mem_fts) VALUES('integrity-check')"); } catch (e) { fts = e.message; }
const savedDecisions = d.prepare("SELECT COUNT(*) c FROM memories WHERE gist LIKE 'concurrency decision%'").get().c;
d.close();
console.log(JSON.stringify({
  hooks: hookResults.length, nonzeroExit: hookResults.filter((r) => r.code !== 0).length, over10s: hookResults.filter((r) => r.ms > 10000).length,
  p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: Math.max(...lat), hooksWithSwallowedErrors: errs.length, errorKinds: kinds,
  byEvent: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map((e) => { const l = hookResults.filter((r) => r.ev === e).map((r) => r.ms); return [e, { n: l.length, p50: pct(l, 50), max: Math.max(...l) }]; })),
  stopMarkersExpected: hookResults.filter((r) => r.ev === 'Stop').length, stopMarkersSaved: savedDecisions,
  gc: gcRes.map((g) => ({ code: g.code, ms: g.ms, out: g.out.slice(0, 160), err: g.err.slice(0, 160) })), mcp: mcpRes, integrity, fts, seconds: (Date.now() - t0) / 1000,
}, null, 1));
