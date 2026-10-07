// Retrieval v1.2: query expansion (aliases, Turkish stems, typo fix, identifier twins), the size-relative
// relevance gate, and the card's decay floor. The full quality benchmark is `npm run bench:retrieval`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-ret-'));
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
const { saveMemory } = await import('../src/store.js');
const { search } = await import('../src/search.js');
const { promptContext, sessionContext } = await import('../src/inject.js');
const { openDb } = await import('../src/db.js');
const lex = await import('../src/lexicon.js');
const P = (id) => { openDb().prepare('INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)').run(id, id, null, Date.now()); return { id, name: id }; };

test('a tiny store still injects relevant memories (the rare-concept test is relative to store size)', async () => {
  const p = P('tiny');
  const a = saveMemory({ project: p.id, kind: 'decision', text: 'queue: SQS, not Kafka (ops cost)', source: 'user' });
  saveMemory({ project: p.id, kind: 'convention', text: 'api errors are RFC 7807 problem+json responses', source: 'user' });
  const r = await promptContext({ project: p, session: 'tiny1', prompt: 'which message queue do we use for jobs?' });
  assert.deepEqual(r.ids, [a.id]);
  const neg = await promptContext({ project: p, session: 'tiny2', prompt: 'write a haiku about autumn leaves please' });
  assert.equal(neg.ids.length, 0, 'unrelated prompt injects nothing');
});

test('aliases, Turkish stems and identifier twins reach memories that share no word with the prompt', async () => {
  const p = P('alias');
  const deploy = saveMemory({ project: p.id, kind: 'decision', text: 'deploy: fly.io with blue-green releases', source: 'user' });
  const cart = saveMemory({ project: p.id, kind: 'fact', text: 'guest cart is stored in a signed cookie', source: 'user' });
  const store = saveMemory({ project: p.id, kind: 'fact', text: 'session state lives in useAuthStore (zustand)', source: 'user' });
  for (let i = 0; i < 12; i++) saveMemory({ project: p.id, kind: 'note', text: `unrelated note ${i} about css grid spacing tweak number ${i}`, source: 'user' });
  const top = async (q) => (await search(q, { project: p.id, k: 3 })).map((h) => h.m.id);
  assert.ok((await top('how do we ship to prod?')).includes(deploy.id), 'ship/prod → deploy');
  assert.ok((await top('where does the anonymous basket live')).includes(cart.id), 'basket → cart');
  assert.ok((await top('sepet nerede tutuluyor')).includes(cart.id), 'sepet (TR) → cart');
  assert.ok((await top('auth store')).includes(store.id), 'auth store → useAuthStore');
  assert.deepEqual(lex.splitIdent('PG_POOL_MAX'), ['pg', 'pool', 'max']);
});

test('joint selectivity: two common words that pick one memory together clear the gate', async () => {
  const p = P('joint');
  const mods = ['billing', 'auth', 'search', 'checkout'], libs = ['zod', 'redis', 'stripe', 'pino'];
  let target;
  for (const m of mods) for (const l of libs) {
    const r = saveMemory({ project: p.id, kind: 'decision', text: `${m} ${l}: chose ${l} for ${m} after the load test`, source: 'user' });
    if (m === 'billing' && l === 'redis') target = r.id;
  }
  const r = await promptContext({ project: p, session: 'j1', prompt: 'what did we pick for redis in billing?' });
  assert.ok(r.ids.includes(target), 'billing+redis is selective even though each word is in 25% of the store');
});

test('card: important standing decisions do not decay out (decay floor)', () => {
  const p = P('card');
  const old = saveMemory({ project: p.id, kind: 'decision', text: 'money: store prices as integer kuruş, never floats', importance: 0.9, source: 'user' });
  openDb().prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Date.now() - 900 * 86400000, old.id);
  for (let i = 0; i < 30; i++) saveMemory({ project: p.id, kind: 'fact', text: `fact ${i}: module ${i} renders list ${i} with virtual rows`, importance: 0.6, source: 'user' });
  const c = sessionContext({ project: p, projectName: 'card', session: 'c1' });
  assert.ok(c.ids.includes(old.id));
});
