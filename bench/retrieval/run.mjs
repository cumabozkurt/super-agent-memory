// Retrieval-quality + token-efficiency evaluation of one SAM build: `npm run bench:retrieval`.
//   node bench/retrieval/run.mjs [--src <sam/src>] [--label NAME] [--full] [--embed http://127.0.0.1:8089/v1 --embed-model NAME]
// Defaults: this repo's src/, label "current", no embeddings, no parameter sweeps (--full adds them).
// Writes bench/retrieval/results/<label>.json and prints a summary. Token counts use python tiktoken
// (o200k_base) when available, otherwise SAM's own estimator (reported as "est").
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as L from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const SRC = resolve(opt('--src') || L.REPO_SRC);
const LABEL = opt('--label') || 'current';
const QUICK = !args.includes('--full');
const EMBED = opt('--embed');

process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-reteval-'));
if (EMBED) { process.env.SAM_EMBED_URL = EMBED; process.env.SAM_EMBED_MODEL = opt('--embed-model') || 'local'; process.env.SAM_EMBED_IN_HOOKS = '1'; }
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));

const { search } = await import(join(SRC, 'search.js'));
const { sessionContext, promptContext } = await import(join(SRC, 'inject.js'));
const { tokens, keywords } = await import(join(SRC, 'text.js'));
const { line } = await import(join(SRC, 'store.js'));
const { config } = await import(join(SRC, 'config.js'));
const { openDb } = await import(join(SRC, 'db.js'));

const mems = L.parseMemories();
const queries = L.parseQueries();
const ctx = await L.loadCorpus(SRC, mems);
if (EMBED) { const { backfill } = await import(join(SRC, 'embed.js')); console.error('embedded', await backfill({ max: 5000 })); }
const db = openDb();
const cfg = config();
const DEFAULTS = { minPromptScore: cfg.minPromptScore, maxPromptHits: cfg.maxPromptHits, budgetPrompt: cfg.budgetPrompt, singleConceptCoverage: cfg.singleConceptCoverage, gateMinConcepts: cfg.gateMinConcepts, minPromptCoverage: cfg.minPromptCoverage, relPromptFloor: cfg.relPromptFloor };
const proj = (id) => ({ id, name: id });
const pos = queries.filter((q) => q.type !== 'neg');
const neg = queries.filter((q) => q.type === 'neg');
const TT = []; // texts for tiktoken: {tag, text}
const tt = (tag, text) => { TT.push({ tag, text }); return text; };

// sanity: labels pointing at superseded / merged rows
const unreachable = [];
for (const q of pos) for (const k of Object.keys(q.rel)) if (!ctx.key2id[k]) unreachable.push(q.qid + ':' + k + '(missing)'); else if (ctx.superseded.has(ctx.key2id[k])) unreachable.push(q.qid + ':' + k + '(superseded)');
const merges = ctx.log.filter((l) => l.status === 'merged').map((l) => l.key + '→' + ctx.id2keys[l.id].join('+'));
const supers = ctx.log.filter((l) => l.status === 'superseded').map((l) => l.key + ' supersedes ' + l.supersedes.map((i) => ctx.id2keys[i].join('+')).join(','));

// ---------- 1. search() ranking ----------
const perQ = [];
let tSearch = 0;
for (const q of pos) {
  const t0 = performance.now();
  const hits = await search(q.query, { project: q.project, k: 10, useVectors: !!EMBED });
  tSearch += performance.now() - t0;
  perQ.push({ qid: q.qid, type: q.type, query: q.query, ...L.rankMetrics(q, hits.map((h) => h.m.id), ctx), top3: hits.slice(0, 3).map((h) => (ctx.id2keys[h.m.id] || ['?'])[0]) });
}
// lexical-overlap bucket: does any query content word share a 5-char prefix with a grade-3 target's text?
const STOPQ = new Set('how what which where when why who can do does did we our the a an to of in on for is are was it my i you me this that and or with from be should just again'.split(' '));
const foldQ = (s) => String(s).replace(/İ/g, 'i').replace(/I/g, 'i').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ı/g, 'i');
const wordsQ = (s) => (foldQ(s).match(/[\p{L}\p{N}_]+/gu) || []);
const memByKey = Object.fromEntries(mems.map((m) => [m.key, m]));
for (const r of perQ) {
  const q = pos.find((x) => x.qid === r.qid);
  const tw = new Set(Object.entries(q.rel).filter(([, g]) => g >= 3).flatMap(([k]) => wordsQ([memByKey[k].text, memByKey[k].body || '', memByKey[k].tags.join(' '), memByKey[k].files.join(' ')].join(' ')).flatMap((w) => [w, ...w.split('_')])));
  const qw = wordsQ(q.query).filter((w) => w.length >= 3 && !STOPQ.has(w));
  const pre = (w) => w.slice(0, Math.min(5, w.length));
  r.overlap = qw.filter((w) => [...tw].some((t) => t.startsWith(pre(w)) || (t.length >= 4 && w.startsWith(t)))).length;
}
const agg = (rows) => ({ n: rows.length, r1: L.r3(L.mean(rows.map((r) => r.r1))), r3: L.r3(L.mean(rows.map((r) => r.r3))), r5: L.r3(L.mean(rows.map((r) => r.r5))), r10: L.r3(L.mean(rows.map((r) => r.r10))), mrr: L.r3(L.mean(rows.map((r) => r.mrr))), ndcg5: L.r3(L.mean(rows.map((r) => r.ndcg5))) });
const types = [...new Set(pos.map((q) => q.type))];
const searchRes = { all: agg(perQ), byType: Object.fromEntries(types.map((t) => [t, agg(perQ.filter((r) => r.type === t))])),
  bySplit: { main: agg(perQ.filter((r) => !r.qid.startsWith('q4'))), heldout: agg(perQ.filter((r) => r.qid.startsWith('q4'))) },
  byHalf: { tuning: agg(perQ.filter((r) => L.isTuning(r))), heldout: agg(perQ.filter((r) => !L.isTuning(r))) },
  byOverlap: { zero: agg(perQ.filter((r) => r.overlap === 0)), one: agg(perQ.filter((r) => r.overlap === 1)), twoPlus: agg(perQ.filter((r) => r.overlap >= 2)) }, staleAbove: perQ.filter((r) => r.staleAbove === 1).map((r) => r.qid), msPerQuery: L.r3(tSearch / pos.length) };

// ---------- 2. promptContext (fresh session per prompt) ----------
let sid = 0;
async function promptEval(tag, qs = queries) {
  const rows = [];
  for (const q of qs) {
    const r = await promptContext({ project: proj(q.project), session: `${tag}:${sid++}`, prompt: q.query });
    if (r.text) tt(tag + (q.type === 'neg' ? ':neg' : ':pos'), r.text);
    const T = L.targets(q, ctx.key2id, ctx.superseded);
    const g = r.ids.map((id) => L.gradeOf(q, id, ctx.id2keys));
    rows.push({
      qid: q.qid, type: q.type, neg: q.type === 'neg', est: r.tokens, n: r.ids.length,
      hit: T.size ? r.ids.filter((id) => T.has(id)).length / T.size : 0, any: g.some((x) => x >= 2) ? 1 : 0,
      prec: r.ids.length ? g.filter((x) => x >= 1).length / r.ids.length : null, keys: r.ids.map((id) => (ctx.id2keys[id] || ['?'])[0]),
    });
  }
  const P = rows.filter((r) => !r.neg), N = rows.filter((r) => r.neg);
  const precRows = rows.filter((r) => r.prec !== null);
  return {
    hit: L.r3(L.mean(P.map((r) => r.hit))), anyHit: L.r3(L.mean(P.map((r) => r.any))), fir: L.r3(L.mean(N.map((r) => (r.n ? 1 : 0)))),
    precision: L.r3(L.mean(precRows.filter((r) => !r.neg).map((r) => r.prec))), linesPerPrompt: L.r3(L.mean(rows.map((r) => r.n))),
    estTokPos: L.r3(L.mean(P.map((r) => r.est))), estTokNeg: L.r3(L.mean(N.map((r) => r.est))), estTokAll: L.r3(L.mean(rows.map((r) => r.est))), rows,
  };
}
const prompt = await promptEval('prompt');
const pSplit = (pred) => { const P = prompt.rows.filter((r) => !r.neg && pred(r)), N = prompt.rows.filter((r) => r.neg && pred(r)); return { hit: L.r3(L.mean(P.map((r) => r.hit))), fir: L.r3(L.mean(N.map((r) => (r.n ? 1 : 0)))), n: P.length, nNeg: N.length }; };
const heldNeg = new Set(['n29', 'n30', 'n31', 'n32']);
prompt.bySplit = { main: pSplit((r) => !r.qid.startsWith('q4') && !heldNeg.has(r.qid)), heldout: pSplit((r) => r.qid.startsWith('q4') || heldNeg.has(r.qid)) };
prompt.byHalf = { tuning: pSplit((r) => L.isTuning(r)), heldout: pSplit((r) => !L.isTuning(r)) };
prompt.byType = Object.fromEntries(types.map((t) => [t, L.r3(L.mean(prompt.rows.filter((r) => r.type === t).map((r) => r.hit)))]));

// ---------- 3. SessionStart card ----------
const coreSets = L.core();
const card = {};
for (const p of ['kervan', 'pulsar', 'atlas']) {
  const r = sessionContext({ project: proj(p), projectName: p, session: 'card:' + p });
  tt('card:' + p, r.text);
  const cs = new Set(coreSets[p].map((k) => ctx.key2id[k]).filter((id) => id && !ctx.superseded.has(id)));
  const inCard = r.ids.filter((id) => cs.has(id));
  card[p] = { est: r.tokens, lines: r.ids.length, coreCovered: inCard.length, coreTotal: cs.size, coverage: L.r3(inCard.length / cs.size), missing: [...cs].filter((id) => !r.ids.includes(id)).map((id) => ctx.id2keys[id][0]), shown: r.ids.map((id) => ctx.id2keys[id]?.[0]), ids: r.ids };
}
// card budget sweep (coverage vs tokens); gist length only applies to builds that support cfg.cardGistMax
const cardSweep = [];
if (!QUICK) {
  const save = { b: cfg.budgetSessionStart, g: cfg.cardGistMax };
  for (const g of cfg.cardGistMax !== undefined ? [0, 80, 60] : [0]) for (const b of [200, 320, 480, 640, 960]) {
    cfg.budgetSessionStart = b; cfg.cardGistMax = g;
    let cov = 0, tk = 0;
    for (const p of ['kervan', 'pulsar', 'atlas']) {
      const r = sessionContext({ project: proj(p), projectName: p, session: `cs:${g}:${b}:${p}`, budget: b });
      tt(`cs:${g}:${b}`, r.text);
      const cs = new Set(coreSets[p].map((k) => ctx.key2id[k]).filter((id) => id && !ctx.superseded.has(id)));
      cov += r.ids.filter((id) => cs.has(id)).length / cs.size / 3;
    }
    cardSweep.push({ budget: b, gistMax: g, coverage: L.r3(cov) });
  }
  cfg.budgetSessionStart = save.b; cfg.cardGistMax = save.g;
}
// how many query answers are already in the card (card ∪ prompt recall)
let cardAns = 0, cardOrPrompt = 0;
for (const q of pos) {
  const T = L.targets(q, ctx.key2id, ctx.superseded);
  const c = card[q.project].ids; const pr = prompt.rows.find((r) => r.qid === q.qid);
  const pIds = new Set(pr.keys.map((k) => ctx.key2id[k]));
  cardAns += T.size ? [...T].filter((id) => c.includes(id)).length / T.size : 0;
  cardOrPrompt += T.size ? [...T].filter((id) => c.includes(id) || pIds.has(id)).length / T.size : 0;
}
const cardSummary = { avgCoverage: L.r3(L.mean(Object.values(card).map((c) => c.coverage))), avgEst: L.r3(L.mean(Object.values(card).map((c) => c.est))), queryAnswersInCard: L.r3(cardAns / pos.length), queryAnswersInCardOrPrompt: L.r3(cardOrPrompt / pos.length) };

// ---------- 4. sweep minPromptScore × maxPromptHits ----------
const sweep = [];
if (!QUICK) {
  const cov = cfg.gateMode === 'coverage';
  // legacy build: RRF-scale floor minPromptScore; coverage build: singleConceptCoverage (9 = off) × gateMinConcepts
  const floors = cov ? [0.25, 0.3, 0.4, 0.5, 0.6, 9] : [0, 0.004, 0.008, 0.010, 0.012, 0.014, 0.016, 0.018, 0.020, 0.024];
  for (const mc of cov ? [1, 2] : [null]) for (const f of floors) for (const mh of [1, 2, 3, 4, 6]) {
    if (cov) { cfg.singleConceptCoverage = f; cfg.gateMinConcepts = mc; } else cfg.minPromptScore = f;
    cfg.maxPromptHits = mh;
    const r = await promptEval(`sw:${mc}:${f}:${mh}`);
    sweep.push({ minConcepts: mc, floor: f, maxHits: mh, hit: r.hit, anyHit: r.anyHit, fir: r.fir, precision: r.precision, estTokAll: r.estTokAll, estTokPos: r.estTokPos, estTokNeg: r.estTokNeg });
  }
  Object.assign(cfg, DEFAULTS);
}

// ---------- 5. 40-turn session: ledger effect ----------
const s40 = L.parseSession40();
async function runSession(mode) {
  const sess = 'ledger:' + mode;
  const c = sessionContext({ project: proj('kervan'), projectName: 'kervan', session: sess });
  const seen = new Set(c.ids);
  let est = c.tokens; const texts = [c.text]; let dupLines = 0; const turns = [];
  const shownAt = new Map(c.ids.map((id) => [id, 0]));
  for (const t of s40) {
    const r = await promptContext({ project: proj('kervan'), session: mode === 'ledger' ? sess : `${sess}:${t.turn}`, prompt: t.query });
    est += r.tokens; if (r.text) texts.push(r.text);
    for (const id of r.ids) { if (seen.has(id)) dupLines++; seen.add(id); if (!shownAt.has(id)) shownAt.set(id, t.turn); }
    const T = L.targets(t, ctx.key2id, ctx.superseded);
    const visible = T.size ? [...T].filter((id) => seen.has(id)).length / T.size : null;
    const fresh = T.size ? [...T].filter((id) => r.ids.includes(id) || c.ids.includes(id)).length / T.size : null;
    const gap = T.size ? Math.max(0, ...[...T].filter((id) => seen.has(id) && !r.ids.includes(id)).map((id) => t.turn - shownAt.get(id))) : 0;
    turns.push({ turn: t.turn, est: r.tokens, n: r.ids.length, visible, fresh, gap, keys: r.ids.map((id) => ctx.id2keys[id]?.[0]) });
  }
  const P = turns.filter((t) => t.visible !== null);
  return { est, cardEst: c.tokens, dupLines, visible: L.r3(L.mean(P.map((t) => t.visible))), freshOrCard: L.r3(L.mean(P.map((t) => t.fresh))), negTok: turns.filter((t) => t.visible === null).reduce((a, t) => a + t.est, 0), maxGap: Math.max(...turns.map((t) => t.gap)), turns, texts };
}
const ledgerOn = await runSession('ledger'); const ledgerOff = await runSession('noledger');
ledgerOn.texts.forEach((x) => tt('s40:ledger', x)); ledgerOff.texts.forEach((x) => tt('s40:noledger', x));

// ---------- 6. baselines ----------
const scopeRows = (p) => db.prepare("SELECT * FROM memories WHERE superseded_by IS NULL AND (project = ? OR project = 'global')").all(p);
// 6a plain BM25 (porter FTS, OR of keywords, no trigram/priors/coverage/gate), compact SAM lines
function bm25(qs, p, k) {
  const terms = keywords(qs, 16);
  const fq = terms.map((w) => '"' + w.replace(/"/g, '""') + '"' + (w.length > 3 ? '*' : '')).join(' OR ');
  if (!fq) return [];
  try {
    return db.prepare(`SELECT m.* FROM mem_fts f JOIN memories m ON m.rowid = f.rowid WHERE mem_fts MATCH ? AND m.superseded_by IS NULL AND (m.project = ? OR m.project = 'global') ORDER BY bm25(mem_fts, 4.0, 1.0, 2.0, 2.0) LIMIT ?`).all(fq, p, k);
  } catch { return []; }
}
const curve = { bm25: [], verbose: [] };
const verboseCache = new Map();
for (const k of [1, 2, 3, 4, 6, 8, 10]) {
  for (const strat of ['bm25', 'verbose']) {
    const hits = [], est = [], firN = [];
    for (const q of queries) {
      let rows, text;
      if (strat === 'bm25') {
        rows = bm25(q.query, q.project, k);
        text = rows.length ? '<memory recall>\n' + rows.map((m) => '- ' + line(m)).join('\n') + '\n</memory>' : '';
      } else {
        if (!verboseCache.has(q.qid)) verboseCache.set(q.qid, (await search(q.query, { project: q.project, k: 10, useVectors: !!EMBED })).map((h) => h.m));
        rows = verboseCache.get(q.qid).slice(0, k);
        text = rows.length ? JSON.stringify(rows.map((m) => ({ id: m.id, type: m.kind, memory: m.gist, details: m.body, files: m.files, created: new Date(m.created_at).toISOString() })), null, 1) : '';
      }
      if (text) tt(`base:${strat}:${k}`, text);
      est.push(tokens(text));
      if (q.type === 'neg') { firN.push(rows.length ? 1 : 0); continue; }
      const T = L.targets(q, ctx.key2id, ctx.superseded);
      hits.push(T.size ? rows.filter((m) => T.has(m.id)).length / T.size : 0);
    }
    curve[strat].push({ k, hit: L.r3(L.mean(hits)), fir: L.r3(L.mean(firN)), estTokAll: L.r3(L.mean(est)) });
  }
}
// 6b full dump per project (bench style) and priority-truncated dump at a token budget
const dumpText = (rows) => rows.map((m) => `- (${m.kind}) ${m.gist}${m.body ? '\n  ' + m.body : ''}`).join('\n');
const prio = (rows) => [...rows].sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || b.updated_at - a.updated_at);
const dump = {};
for (const p of ['kervan', 'pulsar', 'atlas']) {
  const rows = scopeRows(p);
  dump[p] = { est: tokens(tt('dump:' + p, dumpText(rows))), rows: rows.length };
}
// equal-token dump: same total tokens as SAM's 40-turn ledger session, compact lines, by priority
function truncatedDump(p, budget) {
  const out = []; let used = 0;
  for (const m of prio(scopeRows(p))) { const l = '- ' + line(m); const t = tokens(l) + 1; if (used + t > budget) break; used += t; out.push(m.id); }
  return new Set(out);
}
const eqDump = truncatedDump('kervan', ledgerOn.est);
const s40T = s40.filter((t) => L.targets(t, ctx.key2id, ctx.superseded).size);
const eqDumpHit = L.r3(L.mean(s40T.map((t) => { const T = L.targets(t, ctx.key2id, ctx.superseded); return [...T].filter((id) => eqDump.has(id)).length / T.size; })));
// same for all queries of each project at the per-project budget = card + avg prompt tokens × 40 turns
const eqDumpQ = {};
for (const p of ['kervan', 'pulsar', 'atlas']) {
  const budget = Math.round(card[p].est + prompt.estTokAll * 40);
  const set = truncatedDump(p, budget);
  const qs = pos.filter((q) => q.project === p);
  eqDumpQ[p] = { budget, hit: L.r3(L.mean(qs.map((q) => { const T = L.targets(q, ctx.key2id, ctx.superseded); return T.size ? [...T].filter((id) => set.has(id)).length / T.size : 0; }))) };
}

// ---------- 7. tiktoken ----------
const TIK = L.tiktokenCounts(TT.map((x) => x.text));
const counts = TIK || TT.map((x) => tokens(x.text)); // no tiktoken: SAM's estimator (≈0.94–0.99× o200k on this set)
const byTag = {};
TT.forEach((x, i) => { (byTag[x.tag] ||= { n: 0, tik: 0, est: 0 }); byTag[x.tag].n++; byTag[x.tag].tik += counts[i]; byTag[x.tag].est += tokens(x.text); });
const tik = (tag) => byTag[tag]?.tik || 0;
const nPos = pos.length, nNeg = neg.length;
prompt.tikTokPos = L.r3(tik('prompt:pos') / nPos); prompt.tikTokNeg = L.r3(tik('prompt:neg') / nNeg); prompt.tikTokAll = L.r3((tik('prompt:pos') + tik('prompt:neg')) / queries.length);
for (const p of Object.keys(card)) card[p].tik = tik('card:' + p);
cardSummary.avgTik = L.r3(L.mean(Object.values(card).map((c) => c.tik)));
for (const p of Object.keys(dump)) dump[p].tik = tik('dump:' + p);
for (const s of ['bm25', 'verbose']) for (const c of curve[s]) c.tikTokAll = L.r3(((byTag[`base:${s}:${c.k}`]?.tik) || 0) / queries.length);
for (const c of cardSweep) c.tik = L.r3((byTag[`cs:${c.gistMax}:${c.budget}`]?.tik || 0) / 3);
for (const s of sweep) s.tikTokAll = L.r3(((byTag[`sw:${s.minConcepts}:${s.floor}:${s.maxHits}:pos`]?.tik || 0) + (byTag[`sw:${s.minConcepts}:${s.floor}:${s.maxHits}:neg`]?.tik || 0)) / queries.length);
ledgerOn.tik = tik('s40:ledger'); ledgerOff.tik = tik('s40:noledger');
const estVsTik = Object.fromEntries(Object.entries(byTag).filter(([k]) => /^(prompt|card|dump|s40)/.test(k)).map(([k, v]) => [k, L.r3(v.est / v.tik)]));
delete ledgerOn.texts; delete ledgerOff.texts;

const result = {
  label: LABEL, src: SRC, embed: EMBED || null, corpus: { memories: mems.length, live: db.prepare('SELECT COUNT(*) c FROM memories WHERE superseded_by IS NULL').get().c, merges, supersessions: supers, unreachableLabels: unreachable },
  queries: { pos: nPos, neg: nNeg }, defaults: DEFAULTS, search: searchRes, prompt: { ...prompt, rows: undefined }, promptRows: prompt.rows, card, cardSummary, cardSweep, sweep,
  ledger: { on: ledgerOn, off: ledgerOff, eqTokenDumpHit: eqDumpHit, eqTokenDumpBudget: ledgerOn.est }, baselines: { curve, dump, eqDumpQ }, estOverTiktoken: estVsTik, perQuery: perQ,
};
result.tokenizer = TIK ? 'tiktoken o200k_base' : 'SAM estimator (tiktoken unavailable)';
mkdirSync(join(L.ROOT, 'results'), { recursive: true });
writeFileSync(join(L.ROOT, 'results', LABEL + '.json'), JSON.stringify(result, null, 1));
try { rmSync(process.env.SAM_HOME, { recursive: true, force: true }); } catch { /* Windows keeps the open DB locked; it is only a temp dir */ }
const S = searchRes.all;
console.log(`## ${LABEL}\ncorpus ${result.corpus.memories} (${result.corpus.live} live) · ${nPos} pos + ${nNeg} neg queries · merges ${merges.length} · supersessions ${supers.length} · unreachable labels ${unreachable.length}`);
console.log(`search: R@1 ${S.r1} R@3 ${S.r3} R@5 ${S.r5} R@10 ${S.r10} MRR ${S.mrr} nDCG@5 ${S.ndcg5} · ${searchRes.msPerQuery} ms/q · stale-above ${searchRes.staleAbove.length}`);
console.log('by split: ' + Object.entries(searchRes.bySplit).map(([t, v]) => `${t}(${v.n}) R@1 ${v.r1} R@3 ${v.r3} MRR ${v.mrr}`).join(' · ') + ' | prompt ' + Object.entries(prompt.bySplit).map(([t, v]) => `${t} hit ${v.hit} FIR ${v.fir}`).join(' · '));
console.log('by half (odd qid = tuning, even = held-out): search ' + Object.entries(searchRes.byHalf).map(([t, v]) => `${t}(${v.n}) R@3 ${v.r3} MRR ${v.mrr}`).join(' · ') + ' | prompt ' + Object.entries(prompt.byHalf).map(([t, v]) => `${t} hit ${v.hit} FIR ${v.fir} (${v.n}+${v.nNeg} neg)`).join(' · '));
const xl = ['xl-tr', 'xl-en'].map((t) => searchRes.byType[t]).filter(Boolean);
console.log(`Turkish↔English (${xl.reduce((a, v) => a + v.n, 0)} q): R@3 ${L.r3(xl.reduce((a, v) => a + v.r3 * v.n, 0) / (xl.reduce((a, v) => a + v.n, 0) || 1))} MRR ${L.r3(xl.reduce((a, v) => a + v.mrr * v.n, 0) / (xl.reduce((a, v) => a + v.n, 0) || 1))} · tokens: ${result.tokenizer}`);
console.log('by overlap: ' + Object.entries(searchRes.byOverlap).map(([t, v]) => `${t}(${v.n}) R@3 ${v.r3} MRR ${v.mrr}`).join(' · '));
console.log('by type: ' + Object.entries(searchRes.byType).map(([t, v]) => `${t}(${v.n}) R@3 ${v.r3} MRR ${v.mrr}`).join(' · '));
console.log(`prompt: hit ${prompt.hit} any ${prompt.anyHit} prec ${prompt.precision} FIR ${prompt.fir} · tok/prompt est ${prompt.estTokAll} tik ${prompt.tikTokAll} (pos ${prompt.tikTokPos}, neg ${prompt.tikTokNeg})`);
console.log(`card: coverage ${cardSummary.avgCoverage} · tik ${cardSummary.avgTik} est ${cardSummary.avgEst} · answers in card ${cardSummary.queryAnswersInCard} · card∪prompt ${cardSummary.queryAnswersInCardOrPrompt}`);
console.log(`ledger 40 turns: on ${ledgerOn.tik} tik (visible ${ledgerOn.visible}, fresh ${ledgerOn.freshOrCard}) · off ${ledgerOff.tik} tik (dup lines ${ledgerOff.dupLines}) · eq-token dump hit ${eqDumpHit}`);
