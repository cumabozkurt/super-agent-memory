// Crash consistency: SIGKILL SAM writer processes at random points, then verify the DB.
//
//   node crash-kill9.mjs --iters 100 [--dir /tmp/kill9] [--seed 1]     (resumable: reuse --dir to continue)
//
// Writers: Stop hook harvesting a 400-marker transcript (400 small transactions + digest), a prompt hook
// with directives, `sam import` of a 3000-row JSONL (one long BEGIN IMMEDIATE), `sam gc`, `sam add`,
// and an MCP server receiving a burst of mem_save. Each is killed after a random 5–400 ms.
// After every kill: quick_check; every 25 kills and at the end: integrity_check, both FTS integrity-checks,
// FTS row counts vs memories, and orphan scans.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freshEnv, SAM_BIN, rng, quietSqlite } from './lib.mjs';

quietSqlite();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const ITERS = Number(args.iters || 100);
let env;
const stateFile = args.dir && join(args.dir, 'state.json');
if (args.dir && existsSync(stateFile)) { env = JSON.parse(readFileSync(stateFile, 'utf8')); Object.assign(process.env, { SAM_HOME: env.SAM_HOME, SAM_INSTALL_HOME: env.SAM_INSTALL_HOME }); }
else { env = freshEnv('kill9'); env.done = 0; env.failures = []; env.kills = 0; env.exitedBeforeKill = 0; if (args.dir) { mkdirSync(args.dir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(env)); } }
const r = rng(Number(args.seed || 1) * 7919 + env.done);

// fixtures
const tr = join(env.tmp, 'transcript.jsonl');
if (!existsSync(tr)) {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `step ${i} ⟦mem ${['fact', 'decision', 'convention', 'note'][i % 4]}: crash marker ${i} about subsystem s${i % 53} ${'detail '.repeat(i % 7)}⟧` }] } }));
  writeFileSync(tr, lines.join('\n') + '\n');
  const jl = [];
  for (let i = 0; i < 20000; i++) jl.push(JSON.stringify({ id: 'imp' + i.toString(36), project: 'global', kind: 'fact', gist: `imported fact ${i} about area ${i % 71}`, body: 'b'.repeat(i % 300), tags: '', files: '', created_at: Date.now(), updated_at: Date.now() }));
  writeFileSync(join(env.tmp, 'big.jsonl'), jl.join('\n') + '\n');
}

function spawnSam(argv, stdin) {
  const c = spawn(process.execPath, [SAM_BIN, ...argv], { cwd: env.repo, env: { ...process.env }, stdio: ['pipe', 'ignore', 'pipe'] });
  c.stdin.on('error', () => {});
  if (stdin !== undefined) c.stdin.end(stdin);
  return c;
}
const writers = [
  () => spawnSam(['hook', 'Stop', '--agent', 'claude'], JSON.stringify({ session_id: 'k' + r.int(0, 20), cwd: env.repo, transcript_path: tr })),
  () => spawnSam(['hook', 'UserPromptSubmit', '--agent', 'claude'], JSON.stringify({ session_id: 'k' + r.int(0, 20), cwd: env.repo, prompt: `remember that service ${r.int(0, 999)} uses port ${r.int(1000, 9999)}. From now on always run lint ${r.int(0, 99)}. Never deploy on day ${r.int(0, 6)}.` })),
  () => spawnSam(['import', join(env.tmp, 'big.jsonl')]),
  () => spawnSam(['gc']),
  () => spawnSam(['add', `decision ${r.int(0, 1e6)}: cache layer ${r.int(0, 50)} uses redis`, '-k', 'decision']),
  () => {
    const c = spawn(process.execPath, [SAM_BIN, 'mcp'], { cwd: env.repo, env: { ...process.env }, stdio: ['pipe', 'ignore', 'pipe'] });
    c.stdin.on('error', () => {});
    let s = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) + '\n';
    for (let i = 0; i < 200; i++) s += JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'mem_save', arguments: { text: `mcp burst ${r.int(0, 1e9)} item ${i}: ${'word '.repeat(i % 9)}`, kind: 'fact' } } }) + '\n';
    c.stdin.write(s);
    return c;
  },
];
const names = ['stop-harvest', 'prompt', 'import-20000', 'gc', 'add', 'mcp-burst'];

function check(full) {
  const db = new DatabaseSync(env.dbPath);
  db.exec('PRAGMA busy_timeout=10000');
  const res = {};
  try {
    res.check = db.prepare(full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all().map((x) => Object.values(x)[0]).join(';');
    if (full) {
      for (const t of ['mem_fts', 'mem_tri']) { try { db.exec(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`); res[t] = 'ok'; } catch (e) { res[t] = e.message; } }
      const mem = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
      res.memories = mem;
      res.ftsDocs = db.prepare('SELECT COUNT(*) c FROM mem_fts_docsize').get().c;
      res.triDocs = db.prepare('SELECT COUNT(*) c FROM mem_tri_docsize').get().c;
      res.danglingSupersede = db.prepare("SELECT COUNT(*) c FROM memories m WHERE superseded_by IS NOT NULL AND superseded_by NOT IN ('forgotten','archived') AND NOT EXISTS (SELECT 1 FROM memories x WHERE x.id = m.superseded_by)").get().c;
      res.danglingDigest = db.prepare('SELECT COUNT(*) c FROM sessions s WHERE digest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = s.digest_id)').get().c;
      res.sessionsWithSeveralLiveDigests = db.prepare("SELECT COUNT(*) c FROM (SELECT session FROM memories WHERE kind = 'session' AND superseded_by IS NULL AND session IS NOT NULL GROUP BY session HAVING COUNT(*) > 1)").get().c;
      res.digestsNotLinked = db.prepare("SELECT COUNT(*) c FROM memories m WHERE kind = 'session' AND session IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.digest_id = m.id)").get().c;
      res.multiLiveTopic = db.prepare('SELECT COUNT(*) c FROM (SELECT project, topic FROM memories WHERE topic IS NOT NULL AND superseded_by IS NULL GROUP BY project, topic HAVING COUNT(*) > 1)').get().c;
      res.walBytes = existsSync(env.dbPath + '-wal') ? readFileSync(env.dbPath + '-wal').length : 0;
    }
  } catch (e) { res.error = e.message; }
  db.close();
  return res;
}

const t0 = Date.now();
const lastFull = [];
for (let i = 0; i < ITERS; i++) {
  const w = r.int(0, writers.length - 1);
  const c = writers[w]();
  const delay = r.int(5, Number(args.maxDelay || 400));
  const exited = await new Promise((res) => {
    let done = false;
    c.on('close', () => { if (!done) { done = true; res(true); } });
    setTimeout(() => { if (!done) { c.kill('SIGKILL'); c.on('close', () => res(false)); done = true; } }, delay);
  });
  if (exited) env.exitedBeforeKill++; else env.kills++;
  env.done++;
  const q = check(false);
  if (q.check !== 'ok' || q.error) env.failures.push({ iter: env.done, writer: names[w], delay, ...q });
  if (env.done % 25 === 0 || i === ITERS - 1) { const f = check(true); lastFull.push({ iter: env.done, ...f }); if (f.check !== 'ok' || f.mem_fts !== 'ok' || f.mem_tri !== 'ok' || f.danglingSupersede || f.danglingDigest || f.ftsDocs !== f.memories || f.triDocs !== f.memories) env.failures.push({ iter: env.done, full: f }); }
}
if (stateFile) writeFileSync(stateFile, JSON.stringify(env));
console.log(JSON.stringify({ itersThisRun: ITERS, totalIters: env.done, kills: env.kills, exitedBeforeKill: env.exitedBeforeKill, seconds: (Date.now() - t0) / 1000, failures: env.failures.slice(-10), lastFull: lastFull.slice(-2) }));
