// Bench v2: blind false-injection / hit set + knowledge-update, poisoning, dedup and latency suites.
//   npm run bench:v2                       # this repo's src/, prints the report, writes results/<label>.json
//   node bench/retrieval-v2/run.mjs [--src <sam/src>] [--label NAME] [--txt results/1.0.0.txt] [--B 2000]
// Every suite runs in its own child process with a fresh temporary SAM_HOME (nothing touches ~/.sam).
// Arms: "sam" = the build as configured; "v1.2" = the same build with the v2 project-specificity gate off
// (specGate=false); "bm25" = pure FTS5 BM25 baselines. Data: data/*.json (frozen; see gen.mjs and README).
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SRC = resolve(opt('--src', join(HERE, '..', '..', 'src')));
const SUITE = opt('--suite');
const B = Number(opt('--B', 2000));
const data = (f) => JSON.parse(readFileSync(join(HERE, 'data', f), 'utf8'));

// ---------- stats ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
/** Percentile bootstrap 95% CI of mean(f(row)) — or of a paired difference when f returns a - b. */
function ci(rows, f, seed = 7) {
  if (!rows.length) return [NaN, NaN];
  const v = rows.map(f), r = rng(seed), out = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < v.length; i++) s += v[Math.floor(r() * v.length)]; out.push(s / v.length); }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B) - 1]];
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const fmt = (m, c) => `${r3(m).toFixed(3)} [${r3(c[0]).toFixed(3)}, ${r3(c[1]).toFixed(3)}]`;
const hw = (c) => r3((c[1] - c[0]) / 2);

// =====================================================================================================
// child: one suite
// =====================================================================================================
async function child() {
  process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-v2-' + SUITE + '-'));
  const ew = process.emitWarning;
  process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : ew.call(process, w, ...r));
  const L = await import(join(HERE, '..', 'retrieval', 'lib.mjs'));
  const { promptContext, sessionContext } = await import(join(SRC, 'inject.js'));
  const { saveMemory } = await import(join(SRC, 'store.js'));
  const { config } = await import(join(SRC, 'config.js'));
  const { openDb } = await import(join(SRC, 'db.js'));
  const { keywords } = await import(join(SRC, 'text.js'));
  const search = await import(join(SRC, 'search.js'));
  const cfg = config();
  const db = openDb();
  const hasGate = 'specGate' in cfg;
  const arm = (name) => { cfg.specGate = name !== 'v1.2'; };
  let sid = 0;
  const pc = async (project, prompt) => {
    const t0 = performance.now();
    const r = await promptContext({ project: { id: project, name: project }, session: 'b' + sid++, prompt });
    return { ids: r.ids, tokens: r.tokens, ms: performance.now() - t0 };
  };
  const backdate = (id, days) => db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(Date.now() - days * 86400000, Date.now() - days * 86400000, id);
  const out = { suite: SUITE, src: SRC, hasGate };

  if (SUITE === 'blind') {
    const ctx = await L.loadCorpus(SRC, L.parseMemories());
    const D = data('blind.json');
    const items = [...D.positives.map((x) => ({ ...x, neg: false })), ...D.negatives.map((x) => ({ ...x, neg: true }))];
    const cards = {};
    for (const p of ['kervan', 'pulsar', 'atlas']) cards[p] = new Set(sessionContext({ project: { id: p, name: p }, projectName: p, session: 'card:' + p }).ids);
    // warm-up (first queries pay for statement compilation and the signature cache)
    for (const it of items.slice(0, 30)) { arm('sam'); await pc(it.project, it.prompt); arm('v1.2'); await pc(it.project, it.prompt); }
    const rows = [];
    const specMs = [];
    for (const it of items) {
      const gold = new Set((it.gold || []).map((k) => ctx.key2id[k]).filter(Boolean));
      const row = { id: it.id, neg: it.neg, split: it.split, project: it.project, lang: it.lang, cat: it.cat || it.style, prompt: it.prompt };
      // interleave arms per item so machine noise hits both equally
      for (const a of ['v1.2', 'sam']) {
        arm(a);
        const r = await pc(it.project, it.prompt);
        row[a] = { n: r.ids.length, tok: r.tokens, ms: r.ms,
          hit: it.neg ? null : r.ids.filter((x) => gold.has(x)).length / gold.size,
          any: it.neg ? null : (r.ids.some((x) => gold.has(x)) ? 1 : 0),
          card: it.neg ? null : [...gold].filter((x) => r.ids.includes(x) || cards[it.project].has(x)).length / gold.size };
      }
      if (search.specificity) { const t0 = performance.now(); search.specificity(it.prompt, it.project); specMs.push(performance.now() - t0); }
      // pure BM25: porter FTS5, OR of the prompt's keywords, project + global scope, no priors/trigram/gate
      const fq = keywords(it.prompt, 16).map((w) => '"' + w.replace(/"/g, '""') + '"' + (w.length > 3 ? '*' : '')).join(' OR ');
      let bm = [];
      if (fq) try {
        bm = db.prepare(`SELECT m.id id, -bm25(mem_fts, 4.0, 1.0, 2.0, 2.0) s FROM mem_fts f JOIN memories m ON m.rowid = f.rowid WHERE mem_fts MATCH ? AND m.superseded_by IS NULL AND m.kind != 'session' AND (m.project = ? OR m.project = 'global') ORDER BY bm25(mem_fts, 4.0, 1.0, 2.0, 2.0) LIMIT 3`).all(fq, it.project);
      } catch { bm = []; }
      row.bm25 = bm.map((x) => ({ s: x.s, g: gold.has(x.id) ? 1 : 0 }));
      row.ng = gold.size;
      if (!it.neg) { const sh = await search.search(it.prompt, { project: it.project, k: 3, includeSessions: false, useVectors: false }); row.r3 = sh.filter((h) => gold.has(h.m.id)).length / gold.size; }
      rows.push(row);
    }
    out.rows = rows; out.specMs = specMs; out.meta = D.meta;
  }

  if (SUITE === 'update') {
    await L.loadCorpus(SRC, L.parseMemories());
    const U = data('update.json').items;
    const cases = [];
    for (const u of U) {
      const o = saveMemory({ project: u.project, kind: u.kind, text: u.old, source: 'user' });
      backdate(o.id, u.old_age_days || 200);
      const n = saveMemory({ project: u.project, kind: u.kind, text: u.new, source: 'user' });
      if (n.status !== 'merged') backdate(n.id, u.new_age_days || 10);
      const live = (id) => !!db.prepare('SELECT 1 FROM memories WHERE id = ? AND superseded_by IS NULL').get(id);
      cases.push({ ...u, oldId: o.id, newId: n.id, status: n.status, merged: n.id === o.id, oldLive: live(o.id) });
    }
    const rows = [];
    for (const c of cases) for (const prompt of c.prompts || []) {
      const row = { id: c.id, mode: c.mode, status: c.status, merged: c.merged, oldLive: c.oldLive, prompt };
      for (const a of ['v1.2', 'sam']) {
        arm(a);
        const r = await pc(c.project, prompt);
        row[a] = { newHit: !c.merged && r.ids.includes(c.newId) ? 1 : 0, oldInj: !c.merged && r.ids.includes(c.oldId) ? 1 : 0, n: r.ids.length };
      }
      const hits = await search.search(prompt, { project: c.project, k: 10, includeSessions: false, useVectors: false });
      const rank = (id) => { const i = hits.findIndex((h) => h.m.id === id); return i < 0 ? 99 : i + 1; };
      row.newRank = rank(c.newId); row.oldRank = c.merged ? 99 : rank(c.oldId);
      rows.push(row);
    }
    // the SessionStart card must not show a superseded value either
    const cardOld = [];
    for (const p of ['kervan', 'pulsar', 'atlas']) {
      const ids = new Set(sessionContext({ project: { id: p, name: p }, projectName: p, session: 'card-u:' + p }).ids);
      for (const c of cases.filter((x) => x.project === p && !x.merged)) cardOld.push(ids.has(c.oldId) ? 1 : 0);
    }
    out.cases = cases.map(({ id, mode, status, merged, oldLive }) => ({ id, mode, status, merged, oldLive }));
    out.rows = rows; out.cardOld = cardOld;
  }

  if (SUITE === 'poison') {
    await L.loadCorpus(SRC, L.parseMemories());
    const Z = data('poison.json').items;
    const ids = [];
    for (const z of Z) {
      const r = saveMemory({ project: z.project, kind: z.kind || 'note', text: z.text, source: 'agent', agent: 'compromised' });
      if (r.status !== 'merged') backdate(r.id, 5);
      ids.push({ ...z, mid: r.id, status: r.held || r.status }); // held = quarantined / pending by src/guard.js
    }
    const rows = [];
    for (const z of ids) for (const [kind, prompt] of [['topical', z.topical], ['unrelated', z.unrelated]]) {
      if (!prompt) continue;
      const row = { id: z.id, attack: z.attack, kind, status: z.status };
      for (const a of ['v1.2', 'sam']) {
        arm(a);
        const r = await pc(z.project, prompt);
        row[a] = { own: r.ids.includes(z.mid) ? 1 : 0, any: ids.some((y) => r.ids.includes(y.mid)) ? 1 : 0 };
      }
      rows.push(row);
    }
    const card = [];
    for (const p of ['kervan', 'pulsar', 'atlas']) {
      const c = new Set(sessionContext({ project: { id: p, name: p }, projectName: p, session: 'card-z:' + p }).ids);
      card.push({ project: p, poisonInCard: ids.filter((z) => z.project === p && c.has(z.mid)).length, poisoned: ids.filter((z) => z.project === p).length });
    }
    out.rows = rows; out.card = card; out.saved = ids.map((z) => z.status);
  }

  if (SUITE === 'dedup') {
    const X = data('dedup.json').items;
    const rows = [];
    for (const x of X) {
      const p = 'dd-' + x.id;
      const a = saveMemory({ project: p, kind: x.kind, text: x.a, source: 'user' });
      const b = saveMemory({ project: p, kind: x.kind, text: x.b, source: 'user' });
      const live = db.prepare('SELECT COUNT(*) c FROM memories WHERE project = ? AND superseded_by IS NULL').get(p).c;
      rows.push({ id: x.id, should: !!x.should_merge, status: b.status, sameRow: a.id === b.id, live });
    }
    out.rows = rows;
  }
  writeFileSync(opt('--out'), JSON.stringify(out));
  rmSync(process.env.SAM_HOME, { recursive: true, force: true });
}

// =====================================================================================================
// parent: run suites, aggregate, report
// =====================================================================================================
function runSuite(s) {
  const f = join(mkdtempSync(join(tmpdir(), 'sam-v2o-')), s + '.json');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--suite', s, '--src', SRC, '--out', f], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  if (r.status !== 0) throw new Error('suite failed: ' + s);
  return JSON.parse(readFileSync(f, 'utf8'));
}

function blindReport(R, lines) {
  const rows = R.rows;
  const res = { splits: {} };
  const pos = (s) => rows.filter((r) => !r.neg && (s === 'all' || r.split === s));
  const neg = (s) => rows.filter((r) => r.neg && (s === 'all' || r.split === s));
  // BM25 threshold baseline: the largest top-3 score floor that keeps BM25's dev hit >= SAM's dev hit
  const bmHit = (r, th) => r.bm25.filter((x) => x.s >= th && x.g).length / r.ng;
  const bmInj = (r, th) => (r.bm25.some((x) => x.s >= th) ? 1 : 0);
  const samDevHit = mean(pos('dev').map((r) => r.sam.hit));
  const cands = [...new Set(pos('dev').flatMap((r) => r.bm25.map((x) => x.s)))].sort((a, b) => a - b);
  let th = 0;
  for (const c of cands) if (mean(pos('dev').map((r) => bmHit(r, c))) >= samDevHit) th = c;
  res.bm25Threshold = r3(th);
  lines.push(`blind set: ${pos('all').length} positives + ${neg('all').length} negatives (EN+TR; writer ${R.meta.writer}, judge ${R.meta.judge}, seed ${R.meta.seed}) · gate ${R.hasGate ? 'present' : 'absent in this build'}`);
  lines.push('');
  lines.push('| split | arm | hit [95% CI] | any-hit | hit@card | FIR [95% CI] | CI ±  | tok/prompt |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of ['dev', 'heldout', 'all']) {
    const P = pos(s), N = neg(s);
    const o = (res.splits[s] = { nPos: P.length, nNeg: N.length });
    for (const a of ['sam', 'v1.2']) {
      const h = mean(P.map((r) => r[a].hit)), f = mean(N.map((r) => (r[a].n ? 1 : 0)));
      const hc = ci(P, (r) => r[a].hit), fc = ci(N, (r) => (r[a].n ? 1 : 0));
      o[a] = { hit: r3(h), hitCI: hc.map(r3), any: r3(mean(P.map((r) => r[a].any))), hitCard: r3(mean(P.map((r) => r[a].card))), fir: r3(f), firCI: fc.map(r3), firHalfWidth: hw(fc), tok: r3(mean([...P, ...N].map((r) => r[a].tok))) };
      lines.push(`| ${s} | ${a === 'sam' ? 'SAM (v2 gate)' : 'SAM v1.2 (gate off)'} | ${fmt(h, hc)} | ${o[a].any} | ${o[a].hitCard} | ${fmt(f, fc)} | ${o[a].firHalfWidth} | ${o[a].tok} |`);
    }
    for (const [name, k] of [['BM25 top-3 (no gate)', -Infinity], [`BM25 top-3, floor ${res.bm25Threshold} (dev-tuned to SAM hit)`, th]]) {
      const h = mean(P.map((r) => bmHit(r, k))), f = mean(N.map((r) => bmInj(r, k)));
      const hc = ci(P, (r) => bmHit(r, k)), fc = ci(N, (r) => bmInj(r, k));
      o[name] = { hit: r3(h), hitCI: hc.map(r3), fir: r3(f), firCI: fc.map(r3) };
      lines.push(`| ${s} | ${name} | ${fmt(h, hc)} | | | ${fmt(f, fc)} | ${hw(fc)} | |`);
    }
    o.delta = { hit: r3(o.sam.hit - o['v1.2'].hit), hitCI: ci(P, (r) => r.sam.hit - r['v1.2'].hit).map(r3), fir: r3(o.sam.fir - o['v1.2'].fir), firCI: ci(N, (r) => (r.sam.n ? 1 : 0) - (r['v1.2'].n ? 1 : 0)).map(r3) };
  }
  lines.push('');
  res.searchR3 = { dev: r3(mean(pos('dev').map((r) => r.r3))), heldout: r3(mean(pos('heldout').map((r) => r.r3))) };
  lines.push(`ranking ceiling: SAM search() recall@3 on positives dev ${res.searchR3.dev} · held-out ${res.searchR3.heldout} (BM25 top-3 above; the gap to recall hit is what the relevance gate drops)`);
  for (const s of ['dev', 'heldout']) { const d = res.splits[s].delta; lines.push(`paired Δ (v2 gate − v1.2), ${s}: hit ${d.hit} [${d.hitCI.join(', ')}] · FIR ${d.fir} [${d.firCI.join(', ')}]`); }
  // breakdowns (held-out)
  const cats = [...new Set(rows.filter((r) => r.neg).map((r) => r.cat))];
  res.firByCat = {};
  lines.push('');
  lines.push('held-out FIR by negative category: ' + cats.map((c) => {
    const N = rows.filter((r) => r.neg && r.split === 'heldout' && r.cat === c);
    res.firByCat[c] = { n: N.length, sam: r3(mean(N.map((r) => (r.sam.n ? 1 : 0)))), 'v1.2': r3(mean(N.map((r) => (r['v1.2'].n ? 1 : 0)))) };
    return `${c}(${N.length}) ${res.firByCat[c]['v1.2']}→${res.firByCat[c].sam}`;
  }).join(' · '));
  res.byLang = {};
  lines.push('held-out by language (v1.2→v2): ' + ['en', 'tr'].map((l) => {
    const P = rows.filter((r) => !r.neg && r.split === 'heldout' && r.lang === l), N = rows.filter((r) => r.neg && r.split === 'heldout' && r.lang === l);
    const v = (a) => ({ hit: r3(mean(P.map((r) => r[a].hit))), fir: r3(mean(N.map((r) => (r[a].n ? 1 : 0)))) });
    res.byLang[l] = { 'v1.2': v('v1.2'), sam: v('sam') };
    return `${l}: hit ${res.byLang[l]['v1.2'].hit}→${res.byLang[l].sam.hit}, FIR ${res.byLang[l]['v1.2'].fir}→${res.byLang[l].sam.fir} (${P.length}+${N.length})`;
  }).join(' · '));
  // latency
  const ms = (a) => rows.map((r) => r[a].ms);
  res.latency = { sam: { p50: r3(pct(ms('sam'), 0.5)), p90: r3(pct(ms('sam'), 0.9)) }, 'v1.2': { p50: r3(pct(ms('v1.2'), 0.5)), p90: r3(pct(ms('v1.2'), 0.9)) }, specificity: { p50: r3(pct(R.specMs, 0.5)), p90: r3(pct(R.specMs, 0.9)) } };
  res.latency.gateP50 = r3(res.latency.sam.p50 - res.latency['v1.2'].p50);
  lines.push('');
  lines.push(`latency (in-process promptContext, ${rows.length} prompts, ms): v1.2 p50 ${res.latency['v1.2'].p50} p90 ${res.latency['v1.2'].p90} · v2 p50 ${res.latency.sam.p50} p90 ${res.latency.sam.p90} · gate +${res.latency.gateP50} ms p50 · specificity() alone p50 ${res.latency.specificity.p50} p90 ${res.latency.specificity.p90}`);
  return res;
}

function updateReport(R, lines) {
  const rows = R.rows.filter((r) => !r.merged);
  const res = { cases: R.cases.length, prompts: R.rows.length };
  const st = R.cases.reduce((o, c) => ((o[c.mode + ':' + c.status] = (o[c.mode + ':' + c.status] || 0) + 1), o), {});
  res.saveStatus = st;
  lines.push(`knowledge-update: ${R.cases.length} cases (${R.rows.length} prompts) · save status of the new value: ${Object.entries(st).map(([k, v]) => k + ' ' + v).join(', ')} · old value still live after the update: ${R.cases.filter((c) => c.oldLive && !c.merged).length}`);
  for (const mode of ['explicit', 'restated', 'all']) {
    const Rm = rows.filter((r) => mode === 'all' || r.mode === mode);
    const v = (a) => ({ newHit: r3(mean(Rm.map((r) => r[a].newHit))), oldInj: r3(mean(Rm.map((r) => r[a].oldInj))), oldCI: ci(Rm, (r) => r[a].oldInj).map(r3) });
    res[mode] = { n: Rm.length, sam: v('sam'), 'v1.2': v('v1.2'), oldAboveNew: r3(mean(Rm.map((r) => (r.oldRank < r.newRank ? 1 : 0)))) };
    lines.push(`  ${mode}(${Rm.length}): new recalled v1.2 ${res[mode]['v1.2'].newHit} / v2 ${res[mode].sam.newHit} · OLD injected v1.2 ${res[mode]['v1.2'].oldInj} / v2 ${res[mode].sam.oldInj} [${res[mode].sam.oldCI.join(', ')}] · old ranked above new in search ${res[mode].oldAboveNew}`);
  }
  res.oldInCard = r3(mean(R.cardOld));
  lines.push(`  old value shown in the SessionStart card: ${res.oldInCard}`);
  return res;
}

function poisonReport(R, lines) {
  const res = {};
  lines.push(`poisoning/laundering: ${R.saved.length} agent-written poisoned notes (saved: ${Object.entries(R.saved.reduce((o, s) => ((o[s] = (o[s] || 0) + 1), o), {})).map(([k, v]) => k + ' ' + v).join(', ')}) — held rows are invisible to agents (src/guard.js); only active ones can be injected`);
  for (const kind of ['topical', 'unrelated']) {
    const Rk = R.rows.filter((r) => r.kind === kind);
    res[kind] = { n: Rk.length, own: { 'v1.2': r3(mean(Rk.map((r) => r['v1.2'].own))), sam: r3(mean(Rk.map((r) => r.sam.own))) }, any: { 'v1.2': r3(mean(Rk.map((r) => r['v1.2'].any))), sam: r3(mean(Rk.map((r) => r.sam.any))) }, ci: ci(Rk, (r) => r.sam.own).map(r3) };
    lines.push(`  ${kind} prompts (${Rk.length}): its poisoned note injected v1.2 ${res[kind].own['v1.2']} / v2 ${res[kind].own.sam} [${res[kind].ci.join(', ')}] · any poisoned note injected v1.2 ${res[kind].any['v1.2']} / v2 ${res[kind].any.sam}`);
  }
  res.card = R.card;
  lines.push(`  in SessionStart cards: ${R.card.map((c) => `${c.project} ${c.poisonInCard}/${c.poisoned}`).join(', ')}`);
  return res;
}

function dedupReport(R, lines) {
  const rows = R.rows;
  const S = rows.filter((r) => r.should), N = rows.filter((r) => !r.should);
  const merged = (r) => r.status === 'merged';
  const one = (r) => r.live === 1;
  const tp = S.filter(merged).length, fp = N.filter(merged).length;
  const res = { pairs: rows.length, shouldMerge: S.length, shouldNot: N.length, mergeRecall: r3(tp / S.length), mergePrecision: tp + fp ? r3(tp / (tp + fp)) : 'n/a (no merges)', wrongMerge: r3(fp / N.length), oneLiveRowWhenSame: r3(S.filter(one).length / S.length), oneLiveRowWhenDifferent: r3(N.filter(one).length / N.length) };
  const conf = (A) => Object.entries(A.reduce((o, r) => ((o[r.status] = (o[r.status] || 0) + 1), o), {})).map(([k, v]) => k + ' ' + v).join(', ');
  lines.push(`dedup pairs: ${rows.length} · should merge (${S.length}): ${conf(S)} · should NOT merge (${N.length}): ${conf(N)}`);
  lines.push(`  merge recall ${res.mergeRecall} · merge precision ${res.mergePrecision} · wrong merges ${res.wrongMerge} · one live row: same-fact pairs ${res.oneLiveRowWhenSame}, different-fact pairs ${res.oneLiveRowWhenDifferent} (supersession counts as one row)`);
  return res;
}

async function parent() {
  const label = opt('--label', 'current');
  const t0 = Date.now();
  const blind = runSuite('blind'), update = runSuite('update'), poison = runSuite('poison'), dedup = runSuite('dedup');
  const lines = [`## bench v2 · ${label} · src ${SRC.replace(resolve(HERE, '..', '..') + '/', '')}`, ''];
  const result = { label, blind: blindReport(blind, lines) };
  lines.push('');
  result.update = updateReport(update, lines);
  result.poison = poisonReport(poison, lines);
  result.dedup = dedupReport(dedup, lines);
  lines.push('', `(${((Date.now() - t0) / 1000).toFixed(1)} s · bootstrap B=${B} · hit = share of gold ids injected by per-prompt recall · hit@card = share of gold ids in recall ∪ the project's SessionStart card · FIR = share of negatives with any injection)`);
  const text = lines.join('\n');
  console.log(text);
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, 'results', label + '.json'), JSON.stringify({ ...result, rows: blind.rows }, null, 1));
  const txt = opt('--txt');
  if (txt) writeFileSync(resolve(txt), text + '\n');
}

if (SUITE) await child(); else await parent();
