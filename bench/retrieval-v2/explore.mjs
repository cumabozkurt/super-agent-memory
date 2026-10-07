// DEV-ONLY feature dump for designing the project-specificity gate. Never reads held-out items.
//   node bench/retrieval-v2/explore.mjs  → results/explore-dev.json
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as L from '../retrieval/lib.mjs';
import { pathToFileURL } from 'node:url';
process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-v2x-'));
const HERE = new URL('.', import.meta.url).pathname;
const { promptContext } = await import(pathToFileURL(join(L.REPO_SRC, 'inject.js')).href);
const { specificity } = await import(pathToFileURL(join(L.REPO_SRC, 'search.js')).href);
const { config } = await import(pathToFileURL(join(L.REPO_SRC, 'config.js')).href);
const { stacksIn } = await import(pathToFileURL(join(L.REPO_SRC, 'lexicon.js')).href);
const { openDb } = await import(pathToFileURL(join(L.REPO_SRC, 'db.js')).href);
const cfg = config(); cfg.specGate = false;
const ctx = await L.loadCorpus(L.REPO_SRC, L.parseMemories());
const B = JSON.parse(readFileSync(join(HERE, 'data/blind.json'), 'utf8'));
const dev = [...B.positives.map((x) => ({ ...x, neg: false })), ...B.negatives.map((x) => ({ ...x, neg: true }))].filter((x) => x.split === 'dev');
const db = openDb();
const rows = [];
let i = 0;
for (const q of dev) {
  const r = await promptContext({ project: { id: q.project, name: q.project }, session: 'x' + i++, prompt: q.prompt });
  const gold = new Set((q.gold || []).map((k) => ctx.key2id[k]));
  const sp = specificity(q.prompt, q.project);
  const hitStacks = r.ids.map((id) => { const m = db.prepare('SELECT gist, tags, files, body, project FROM memories WHERE id = ?').get(id); return { p: m.project, st: [...stacksIn(`${m.gist} ${m.tags} ${m.files} ${m.body}`)], gold: gold.has(id), text: `${m.gist} ${m.tags} ${m.files} ${m.body}` }; });
  rows.push({ id: q.id, neg: q.neg, cat: q.cat || q.style, lang: q.lang, project: q.project, prompt: q.prompt, n: r.ids.length, hit: q.neg ? null : r.ids.filter((x) => gold.has(x)).length / gold.size, hits: hitStacks, sp: { ...sp, cstr: sp.concepts.map((c) => `${c.t}:${c.dP}/${c.rateS.toFixed(3)}${c.topS ? '@' + c.topS[0] : ''}`) } });
}
writeFileSync(join(HERE, 'results/explore-dev.json'), JSON.stringify(rows, null, 1));
const P = rows.filter((r) => !r.neg), N = rows.filter((r) => r.neg);
console.log('dev hit', L.mean(P.map((r) => r.hit)).toFixed(3), 'FIR', L.mean(N.map((r) => (r.n ? 1 : 0))).toFixed(3));
for (const c of [...new Set(N.map((r) => r.cat))]) { const a = N.filter((r) => r.cat === c); console.log(' ', c, a.length, L.mean(a.map((r) => (r.n ? 1 : 0))).toFixed(3)); }
for (const p of ['kervan', 'pulsar', 'atlas']) console.log(p, rows.find((r) => r.project === p).sp.known.join(','));
