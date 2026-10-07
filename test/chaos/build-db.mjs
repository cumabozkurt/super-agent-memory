// Build a large, realistic SAM DB through the real write path (saveMemory), for scale tests.
//   node build-db.mjs --out /tmp/big50k.db --memories 50000 --events 200000 [--seed 1] [--project-root <repo>]
// Memories: 3 projects + global, all kinds, topic forms ("x: y"), near-duplicates (~5%), files, Turkish text.
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { rng, quietSqlite, SAM_SRC } from './lib.mjs';

quietSqlite();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const out = args.out || '/tmp/sam-big.db';
for (const s of ['', '-wal', '-shm']) rmSync(out + s, { force: true });
mkdirSync(dirname(out), { recursive: true });
process.env.SAM_HOME = dirname(out);
const { openDb, closeDb } = await import(join(SAM_SRC, 'db.js'));
openDb(out);
const { saveMemory } = await import(join(SAM_SRC, 'store.js'));
const r = rng(Number(args.seed || 1));
const N = Number(args.memories || 50000);
const E = Number(args.events || 200000);
const projects = (args.projects || 'p_alpha,p_beta,p_gamma,global').split(',');
const nouns = ['cache', 'router', 'auth', 'billing', 'search', 'queue', 'worker', 'schema', 'migration', 'logger', 'config', 'session', 'token', 'upload', 'invoice', 'webhook', 'parser', 'scheduler', 'metrics', 'gateway'];
const verbs = ['uses', 'requires', 'must call', 'never touches', 'is owned by', 'retries', 'caches', 'validates', 'emits', 'reads from'];
const objs = ['redis', 'postgres 16', 'the outbox table', 'S3 presigned URLs', 'zod schemas', 'tRPC procedures', 'a 30 s timeout', 'idempotency keys', 'OpenTelemetry spans', 'the feature flag service'];
const kinds = ['decision', 'convention', 'preference', 'fact', 'fix', 'bug', 'todo', 'note', 'fact', 'decision', 'note'];
const t0 = Date.now();
const prevNow = Date.now;
const yearAgo = Date.now() - 365 * 86400000;
const db = openDb();
db.exec('PRAGMA synchronous=OFF');
for (let i = 0; i < N; i++) {
  const n = r.pick(nouns), v = r.pick(verbs), o = r.pick(objs);
  const kind = r.pick(kinds);
  const form = r.next();
  let text;
  if (form < 0.15) text = `${n} ${r.int(1, 400)} ${r.pick(['timeout', 'owner', 'store', 'limit'])}: ${o} ${r.int(1, 99)}`;
  else if (form < 0.2) text = `bundan sonra ${n} modülü ${o} kullanır, ışık ${i}`;
  else text = `The ${n} module ${r.int(1, 2000)} ${v} ${o} because of incident ${r.int(1, 99999)} in src/${n}/${r.pick(['index', 'service', 'handler'])}.ts`;
  if (r.chance(0.05) && i > 10) text = text + ' really'; // near-duplicate style
  // spread created_at over the last year (Date.now is read inside saveMemory via text.now())
  const ts = yearAgo + Math.floor((i / N) * 365 * 86400000);
  Date.now = () => ts;
  try {
    saveMemory({ project: r.pick(projects), kind, text, files: r.chance(0.4) ? [`src/${n}/${r.pick(['index', 'service'])}.ts`] : [], source: 'build' });
  } catch (e) { if (i < 5) console.error(e.message); }
}
Date.now = prevNow;
// raw events, spread over the last 30 days (older ones are what gc expires)
const ev = db.prepare('INSERT INTO events(session, project, agent, type, subject, ok, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (let i = 0; i < E; i++) {
  ev.run('claude:s' + r.int(0, 3000), r.pick(projects), 'claude', r.pick(['prompt', 'edit', 'cmd', 'read', 'tool']), `src/${r.pick(nouns)}/x.ts`, r.int(0, 1), 'detail '.repeat(r.int(0, 20)), Date.now() - r.int(0, 30 * 86400000));
  if (i % 20000 === 19999) { db.exec('COMMIT'); db.exec('BEGIN'); }
}
db.exec('COMMIT');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const c = db.prepare('SELECT COUNT(*) c, SUM(superseded_by IS NULL) live FROM memories').get();
closeDb();
console.log(JSON.stringify({ out, memories: c.c, live: c.live, events: E, seconds: (Date.now() - t0) / 1000 }));
