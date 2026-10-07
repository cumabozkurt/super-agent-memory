// Reproducible token benchmark: `npm run bench`.
// Builds a synthetic-but-realistic project memory (600 saved, 540 live after near-duplicate merges), replays a 30-prompt
// session, and compares how many tokens each injection strategy pushes into the
// agent's context — plus whether the memory each prompt actually needed got there.
//
// Baselines are strategy archetypes found across the reviewed repos, not
// re-implementations of any specific project:
//   A  full dump        — whole memory file loaded at session start (memory-bank / CLAUDE.md style)
//   B  top-10 verbose   — every prompt gets the 10 best hits with full bodies, JSON-ish (common default)
//   C  SAM              — budgeted card + gated per-prompt recall + per-session ledger
//   D  pure BM25        — honesty baseline printed next to every SAM number: FTS5 bm25() top-3 gists per prompt,
//                         the user's raw words OR'ed, no trigram/expansion/priors/gate/ledger/card
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-bench-'));
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));

const { saveMemory } = await import('../src/store.js');
const { search } = await import('../src/search.js');
const { sessionContext, promptContext } = await import('../src/inject.js');
const { tokens } = await import('../src/text.js');
const { digest } = await import('../src/vault.js');
const { toolSchemaTokens } = await import('../src/mcp.js');
const { openDb } = await import('../src/db.js');
const { line } = await import('../src/store.js');

// deterministic PRNG
let seed = 42;
// xorshift32: exact in 32-bit integer math (the old LCG overflowed 2^53 and repeated heavily)
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const modules = ['billing', 'auth', 'search', 'checkout', 'inventory', 'notifications', 'admin', 'reports', 'catalog', 'shipping', 'payments', 'users'];
const libs = ['zod', 'prisma', 'redis', 'bullmq', 'stripe', 'sentry', 'vitest', 'playwright', 'tRPC', 'tailwind', 'pino', 'msw'];
const project = { id: 'bench', name: 'bench' };
openDb().prepare('INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)').run('bench', 'bench', null, Date.now());

const targets = [];
let n = 0;
for (const mod of modules) {
  for (const lib of libs) {
    const kind = pick(['decision', 'convention', 'fact', 'fix', 'note']);
    const text = {
      decision: `${mod} ${lib}: chose ${lib} for ${mod} because the previous approach leaked connections under load`,
      convention: `${mod} ${lib} convention: wrap every ${lib} call in src/${mod}/lib/${lib}.ts and never import it directly`,
      fact: `${mod} uses ${lib} with config in src/${mod}/${lib}.config.ts; staging overrides via ${mod.toUpperCase()}_${lib.toUpperCase()}_URL`,
      fix: `${mod} ${lib} crash on cold start fixed by lazy-initialising the client in src/${mod}/${lib}.ts`,
      note: `${mod} team prefers ${lib} snapshots reviewed in PRs; flaky ${lib} tests are tagged @flaky`,
    }[kind];
    const body = `Context: ${text}. Discussed in sprint ${1 + (n % 9)}. Alternatives considered: ${pick(libs)}, ${pick(libs)}. Owner: ${mod} squad. ` +
      `Details: ${'the integration requires careful handling of retries, idempotency keys and timeouts; '.repeat(2)}`;
    const r = saveMemory({ project: project.id, kind, text, body, files: [`src/${mod}/${lib}.ts`] });
    targets.push({ id: r.id, mod, lib, text });
    n++;
  }
}
// pad with older session digests and generic notes to ~600
for (let i = 0; n < 600; i++, n++) {
  saveMemory({ project: project.id, kind: i % 3 ? 'note' : 'session', text: `${pick(modules)} ${pick(['refactor', 'cleanup', 'perf pass', 'bug bash', 'review'])} #${i} touched ${pick(libs)} and ${pick(libs)} wiring`, body: 'Longer description of what happened and why. '.repeat(4) });
}

// 30-prompt session: 20 need a specific memory, 10 are unrelated chit-chat / generic coding asks
const prompts = [];
for (let i = 0; i < 20; i++) {
  const t = targets[Math.floor(rnd() * targets.length)];
  prompts.push({ text: `In ${t.mod}, the ${t.lib} integration is misbehaving again — what did we decide about ${t.lib} there and where does it live?`, need: t.id });
}
const generic = ['rename this variable to camelCase', 'explain what a closure is', 'write a haiku about refactoring', 'format this JSON', 'what time complexity is this loop',
  'add a docstring to this function', 'make the button blue', 'summarize the diff', 'is this regex correct', 'thanks, looks good'];
for (const g of generic) prompts.splice(Math.floor(rnd() * prompts.length), 0, { text: g, need: null });

const all = openDb().prepare("SELECT * FROM memories WHERE superseded_by IS NULL AND project = 'bench'").all();

// A) full dump
const dump = all.map((m) => `- (${m.kind}) ${m.gist}\n  ${m.body}`).join('\n');
const A = { tokens: tokens(dump), hit: prompts.filter((p) => p.need).length };

// B) top-10 verbose per prompt
let Btok = 0, Bhit = 0;
for (const p of prompts) {
  const hits = await search(p.text, { project: project.id, k: 10, useVectors: false });
  const block = JSON.stringify(hits.map((h) => ({ id: h.m.id, type: h.m.kind, memory: h.m.gist, details: h.m.body, files: h.m.files, created: new Date(h.m.created_at).toISOString() })), null, 1);
  Btok += tokens(block);
  if (p.need && hits.some((h) => h.m.id === p.need)) Bhit++;
}

// C) SAM
const session = 'bench:s1';
const card = sessionContext({ project, session });
let Ctok = card.tokens;
let Chit = 0, Cgeneric = 0;
// the card is in context for the whole session: a memory it showed counts as recalled (the ledger will not repeat it)
const shown = new Set(card.ids);
for (const p of prompts) {
  const r = await promptContext({ project, session, prompt: p.text });
  Ctok += r.tokens;
  if (!p.need) Cgeneric += r.tokens;
  r.ids.forEach((id) => shown.add(id));
  if (p.need && shown.has(p.need)) Chit++;
}

// D) pure BM25 baseline: same line format as SAM's recall, top-3 (SAM's maxPromptHits), nothing else
const bm25Top = (q, k = 3) => {
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []))];
  if (!words.length) return [];
  return openDb().prepare(
    `SELECT m.* FROM mem_fts f JOIN memories m ON m.rowid = f.rowid WHERE mem_fts MATCH ? AND m.superseded_by IS NULL AND m.project = 'bench'
     ORDER BY bm25(mem_fts) LIMIT ?`
  ).all(words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' OR '), k);
};
let Dtok = 0, Dhit = 0, Dgeneric = 0;
for (const p of prompts) {
  const hits = bm25Top(p.text);
  const tk = hits.length ? tokens('<memory>\n' + hits.map((m) => line(m)).join('\n') + '\n</memory>') : 0;
  Dtok += tk;
  if (!p.need) Dgeneric += tk;
  if (p.need && hits.some((m) => m.id === p.need)) Dhit++;
}

// tool output vault
const log = [];
for (let i = 1; i <= 1800; i++) log.push(`  ✓ suite ${Math.ceil(i / 40)} › case ${i} (${(i % 17) + 2} ms)`);
log.splice(1200, 0, '  ✗ checkout › applies coupon', '    Error: expected 90 to be 81', '      at src/checkout/coupon.test.ts:44:17');
log.push('Test Files  1 failed | 44 passed (45)', 'Tests  1 failed | 1799 passed (1800)');
const raw = log.join('\n');
const dg = digest(raw, false).text;

const needed = prompts.filter((p) => p.need).length;
const row = (name, t, h) => `| ${name.padEnd(28)} | ${String(t).padStart(8)} | ${`${h}/${needed}`.padStart(9)} |`;
console.log(`\nCorpus: ${all.length} live memories · session: ${prompts.length} prompts (${needed} need a stored memory)\n`);
console.log('| Strategy                     | Tokens   | Recall    |');
console.log('|------------------------------|----------|-----------|');
console.log(row('A  full dump at start', A.tokens, A.hit));
console.log(row('B  top-10 verbose per prompt', Btok, Bhit));
console.log(row('C  SAM (card+gated+ledger)', Ctok, Chit));
console.log(row('D  pure BM25 top-3 baseline', Dtok, Dhit));
console.log(`\nSAM spent ${Cgeneric} tokens on the ${prompts.length - needed} unrelated prompts (relevance gate) · pure BM25 baseline: ${Dgeneric}`);
console.log(`SAM vs A: ${(100 * (1 - Ctok / A.tokens)).toFixed(1)}% fewer tokens · SAM vs B: ${(100 * (1 - Ctok / Btok)).toFixed(1)}% fewer tokens · SAM vs pure BM25: ${(100 * (1 - Ctok / Dtok)).toFixed(1)}% fewer tokens, recall ${Chit}/${needed} vs ${Dhit}/${needed}`);
console.log(`\nOutput vault on an 1,800-test log: ${tokens(raw)} → ${tokens(dg)} tokens (${(100 * (1 - tokens(dg) / tokens(raw))).toFixed(1)}% saved), failing test + stack kept · pure BM25 baseline: n/a (output digest, not retrieval)`);
console.log(`MCP tool surface: 4 tools ≈ ${toolSchemaTokens()} tokens (estimator), paid once per session · pure BM25 baseline: n/a (no tool surface)`);
// v2-guard: provenance tags ("-a"/"-t"/"-i" bullets + one legend line). Every bench row is agent-sourced, so this is
// the worst case (every line tagged). Same DB, same card, tags on vs off.
{
  const { resetConfigCache } = await import('../src/config.js');
  const on = sessionContext({ project, session: null });
  process.env.SAM_SOURCE_TAGS = '0'; resetConfigCache();
  const off = sessionContext({ project, session: null });
  delete process.env.SAM_SOURCE_TAGS; resetConfigCache();
  const d = on.tokens - off.tokens;
  console.log(`Source tags: card ${off.tokens} → ${on.tokens} tokens (+${d}, ${(100 * d / off.tokens).toFixed(1)}% of the card, ${(100 * d / Ctok).toFixed(1)}% of the session) · lines ${off.ids.length} → ${on.ids.length}`);
  if (process.env.SAM_BENCH_DUMP) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.SAM_BENCH_DUMP, JSON.stringify({ on: on.text, off: off.text })); }
}
rmSync(process.env.SAM_HOME, { recursive: true, force: true });
