// Lock arithmetic: busy_timeout (5 s per statement) × several write statements per hook vs the host's 10 s
// hook timeout. A "hog" holds the write lock in bursts (like `sam import` of a big file, or a long gc step
// on a huge DB) and releases it briefly; hooks started meanwhile are timed.
//   node lock-hog.mjs [--hold 4500] [--gap 30] [--hooks 12] [--seconds 40]
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freshEnv, SAM_BIN, pct, quietSqlite } from './lib.mjs';

quietSqlite();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const env = freshEnv('hog');
const HOLD = Number(args.hold || 4500), GAP = Number(args.gap || 30), HOOKS = Number(args.hooks || 12);
const run = (ev, p) => new Promise((res) => {
  const t = performance.now();
  const c = spawn(process.execPath, [SAM_BIN, 'hook', ev, '--agent', 'claude'], { cwd: env.repo, env: { ...process.env, SAM_DEBUG: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  c.stdin.end(JSON.stringify(p));
  c.on('close', (code) => res({ ev, code, ms: Math.round(performance.now() - t), err: err.replace(/\(node:\d+\)[^\n]*\n?|\(Use[^\n]*\n?/g, '').split('\n').find((l) => /Error/.test(l)) || '' }));
});
// create the DB and a session first
await run('SessionStart', { session_id: 'h0', cwd: env.repo });
// hog in a worker-like child (own connection, separate process)
const hogSrc = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(env.dbPath)}); db.exec('PRAGMA busy_timeout=60000');
const end = Date.now() + ${Number(args.seconds || 40) * 1000};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < end) { db.exec('BEGIN IMMEDIATE'); db.prepare("INSERT INTO meta(k, v) VALUES ('hog', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now())); sleep(${HOLD}); db.exec('COMMIT'); sleep(${GAP}); }
`;
const hog = spawn(process.execPath, ['-e', hogSrc], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 300));
const results = [];
const evs = [['UserPromptSubmit', { prompt: 'remember that lock hogs starve hooks in this test' }], ['Stop', { last_assistant_message: '⟦mem decision: hog test marker⟧' }], ['PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } }], ['SessionStart', {}]];
for (let i = 0; i < HOOKS; i++) {
  const [ev, p] = evs[i % evs.length];
  results.push(run(ev, { session_id: 'h' + (i % 3), cwd: env.repo, ...p }));
  await new Promise((r) => setTimeout(r, 900));
}
const res = await Promise.all(results);
hog.kill();
const lat = res.map((r) => r.ms);
const d = new DatabaseSync(env.dbPath); d.exec('PRAGMA busy_timeout=10000');
const markers = d.prepare("SELECT COUNT(*) c FROM memories WHERE gist LIKE 'hog test marker%'").get().c;
d.close();
console.log(JSON.stringify({ holdMs: HOLD, gapMs: GAP, hooks: res.length, over10s: res.filter((r) => r.ms > 10000).length, over5s: res.filter((r) => r.ms > 5000).length,
  p50: pct(lat, 50), max: Math.max(...lat), swallowed: res.filter((r) => r.err).length, errorKinds: [...new Set(res.map((r) => r.err).filter(Boolean))],
  perHook: res.map((r) => `${r.ev}:${r.ms}${r.err ? '!' : ''}`), hogMarkerSaved: markers }, null, 1));
