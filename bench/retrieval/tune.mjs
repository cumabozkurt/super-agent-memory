// Gate tuning on the tuning half (odd query number); the even half is held out. Pick settings on DEV only.
//   node bench/retrieval/tune.mjs [--src <sam/src>] key=v1,v2 ...   e.g. minPromptCoverage=0.2,0.3 maxPromptHits=2,3
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const si = argv.indexOf('--src');
const SRC = resolve(si >= 0 ? argv.splice(si, 2)[1] : L.REPO_SRC);
process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-tune-'));
if (process.env.SAM_EMBED_URL) { process.env.SAM_EMBED_MODEL ||= 'local'; process.env.SAM_EMBED_IN_HOOKS = '1'; }
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
const { promptContext } = await import(join(SRC, 'inject.js'));
const { config } = await import(join(SRC, 'config.js'));
const ctx = await L.loadCorpus(SRC, L.parseMemories());
if (process.env.SAM_EMBED_URL) { const { backfill } = await import(join(SRC, 'embed.js')); await backfill({ max: 5000 }); }
const qs = L.parseQueries();
const isDev = L.isTuning;
const SHOW = argv.includes('--show-heldout');
if (SHOW) argv.splice(argv.indexOf('--show-heldout'), 1);
const grid = argv.map((a) => { const [k, v] = a.split('='); return [k, v.split(',').map((x) => (isNaN(Number(x)) ? x : Number(x)))]; });
const combos = grid.reduce((acc, [k, vs]) => acc.flatMap((c) => vs.map((v) => ({ ...c, [k]: v }))), [{}]);
const cfg = config();
let sid = 0;
const rows = [];
for (const c of combos) {
  Object.assign(cfg, c);
  const res = { dev: { hit: [], fir: [], tok: [], prec: [] }, test: { hit: [], fir: [], tok: [], prec: [] } };
  for (const q of qs) {
    const r = await promptContext({ project: { id: q.project, name: q.project }, session: 't' + sid++, prompt: q.query });
    const b = res[isDev(q) ? 'dev' : 'test'];
    b.tok.push(r.tokens);
    b.n = (b.n || 0) + 1;
    if (q.type === 'neg') { b.fir.push(r.ids.length ? 1 : 0); continue; }
    const T = L.targets(q, ctx.key2id, ctx.superseded);
    b.hit.push(T.size ? r.ids.filter((id) => T.has(id)).length / T.size : 0);
    if (r.ids.length) b.prec.push(r.ids.filter((id) => L.gradeOf(q, id, ctx.id2keys) >= 1).length / r.ids.length);
  }
  const n = (b) => ({ hit: L.r3(L.mean(b.hit)), fir: L.r3(L.mean(b.fir)), prec: L.r3(L.mean(b.prec)), tok: L.r3(L.mean(b.tok)) });
  const row = { ...c, dev: n(res.dev), ...(SHOW ? { heldout: n(res.test) } : {}) };
  rows.push(row);
  console.log(JSON.stringify(row));
}
// held-out numbers stay hidden while choosing (pass --show-heldout only to report the chosen setting)
