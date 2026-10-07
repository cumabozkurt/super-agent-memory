// Hybrid retrieval: BM25 (porter) + trigram (identifiers, typos, substrings) + optional
// embeddings, fused with Reciprocal Rank Fusion, then re-weighted by importance,
// recency decay (per-kind half-life), pinning, project scope and usage.
import { openDb } from './db.js';
import { keywords, fold } from './text.js';
import { KINDS, normKind, liveSql, liveArgs } from './store.js';
import { embed, cosine, unpackVec } from './embed.js';
import { config } from './config.js';
import { aliasesOf, trStem, isTurkish, correct, GENERIC, stacksIn } from './lexicon.js';

// "what was I doing yesterday", "dün ne yapmıştım", "where did I leave off": recent session digests are the answer
export const TEMPORAL_RE = /\b(yesterday|last (session|time|week)|earlier today|what (was|were) (i|we) (doing|working)|where (was i|did (i|we) (leave|stop))|left off)\b|(dün|en son|geçen (sefer|hafta)|kaldığım|kaldığımız)/iu;

let vocabCache;
function vocab(db) {
  if (vocabCache && vocabCache.db === db) return vocabCache.rows;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_vocab USING fts5vocab(mem_fts, 'row')");
    vocabCache = { db, rows: db.prepare('SELECT term, doc FROM mem_vocab WHERE length(term) >= 4').all() };
  } catch { vocabCache = { db, rows: [] }; }
  return vocabCache.rows;
}

const RRF_K = 60;
const DURABLE = new Set(['decision', 'convention', 'preference', 'procedure']);

function ftsQuery(terms, { prefix = true, minLen = 1 } = {}) {
  const t = terms.filter((w) => w.length >= minLen).map((w) => '"' + w.replace(/"/g, '""') + '"' + (prefix && w.length > 3 ? '*' : ''));
  return t.length ? t.join(' OR ') : null;
}

function scopeSql(project, includeGlobal) {
  if (!project || project === '*') return { sql: '1=1', args: [] };
  if (includeGlobal && project !== 'global') return { sql: "(m.project = ? OR m.project = 'global')", args: [project] };
  return { sql: 'm.project = ?', args: [project] };
}

/**
 * @returns {Promise<Array<{m: object, score: number}>>}
 */
export async function search(query, { project, kind, k = 8, includeGlobal = true, includeSessions = true, useVectors = true, minScore = 0, includeHeld = false } = {}) {
  const db = openDb();
  const terms = keywords(query, 16);
  if (!terms.length && !query) return [];
  const scope = scopeSql(project, includeGlobal);
  const kindSql = kind ? ' AND m.kind = ?' : includeSessions ? '' : " AND m.kind != 'session'";
  const kindArgs = kind ? [normKind(kind)] : [];
  const lists = []; // [rowids, weight]
  const cfg = config();
  const t = Date.now();
  // one live-row predicate (store.liveSql): not superseded, status active unless includeHeld, inside its validity window.
  // LIVE carries two placeholders; every query below binds liveArgs(t) first.
  const LIVE = liveSql('m', { includeHeld });
  const LA = liveArgs(t);
  const expand = cfg.expandQuery !== false;
  // IDF over the rows this search can actually return (live, in scope, same kind filter): a word that is common
  // in another project, or only in superseded rows, is not evidence here.
  const N = Math.max(1, db.prepare(`SELECT COUNT(*) c FROM memories m WHERE ${LIVE} AND ${scope.sql}${kindSql}`).get(...LA, ...scope.args, ...kindArgs).c);
  const dfOf = (forms) => {
    const q = ftsQuery(forms);
    if (!q) return 0;
    try {
      return db.prepare(`SELECT COUNT(*) c FROM mem_fts f CROSS JOIN memories m ON m.rowid = f.rowid WHERE mem_fts MATCH ? AND ${LIVE} AND ${scope.sql}${kindSql}`)
        .get(q, ...LA, ...scope.args, ...kindArgs).c;
    } catch { return 0; }
  };
  // A rare concept is one that occurs in at most rareConceptShare of the searchable rows (at least 1 row): relative
  // to the store's size, so the gate behaves the same with 5 memories or 50,000 (an absolute IDF threshold made
  // every word "common" in a small store and nothing could ever be injected).
  const rareMax = Math.max(1, Math.floor((cfg.rareConceptShare ?? 0.15) * N));
  // Concepts: each query keyword plus its Turkish stem, dev-vocabulary aliases and (if absent from the corpus) a typo correction.
  const tr = isTurkish(query);
  const concepts = terms.slice(0, 12).map((t) => {
    const orig = [t];
    if (expand && tr) { const st = trStem(t); if (st !== t && st.length >= 4) orig.push(st); }
    const alias = expand ? [...new Set(orig.flatMap((f) => aliasesOf(f)))].filter((a) => !orig.includes(a)) : [];
    let df = dfOf([...orig, ...alias]);
    if (expand && df === 0 && !alias.length) {
      const c = correct(t, vocab(db));
      if (c) { orig.push(c); df = dfOf(orig); }
    }
    const generic = GENERIC.has(t) || GENERIC.has(t.replace(/s$/, ''));
    // a word that occurs nowhere in memory ("misbehaving") is weak evidence of irrelevance: it counts, but at reduced weight
    // rare: present in this scope (a word that occurs nowhere cannot be covered, so it is not a concept to demand) and selective
    const rare = !generic && df > 0 && df <= rareMax;
    return { t, orig, alias, df, w: Math.log(1 + N / (1 + df)) * (generic ? 0.3 : 1) * (df === 0 ? (cfg.absentTermWeight ?? 1) : 1), generic, rare };
  });
  const expTerms = [...new Set(concepts.flatMap((c) => [...c.orig.slice(1), ...c.alias]))].filter((x) => !terms.includes(x));

  const q1 = ftsQuery(terms);
  if (q1) {
    try {
      lists.push([db.prepare(
        `SELECT m.rowid AS rowid FROM mem_fts f CROSS JOIN memories m ON m.rowid = f.rowid
         WHERE mem_fts MATCH ? AND ${LIVE} AND ${scope.sql}${kindSql}
         ORDER BY bm25(mem_fts, 4.0, 1.0, 2.0, 2.0) LIMIT 60`
      ).all(q1, ...LA, ...scope.args, ...kindArgs).map((r) => r.rowid), 1]);
    } catch { /* malformed query: skip list */ }
  }
  const q2 = ftsQuery(terms, { prefix: false, minLen: 3 });
  if (q2) {
    try {
      lists.push([db.prepare(
        `SELECT m.rowid AS rowid FROM mem_tri t CROSS JOIN memories m ON m.rowid = t.rowid
         WHERE mem_tri MATCH ? AND ${LIVE} AND ${scope.sql}${kindSql}
         ORDER BY bm25(mem_tri, 3.0, 1.0, 2.0) LIMIT 60`
      ).all(q2, ...LA, ...scope.args, ...kindArgs).map((r) => r.rowid), 1]);
    } catch { /* skip */ }
  }
  // expansion list: aliases / stems / corrections, lower RRF weight than the user's own words
  const q3 = expTerms.length ? expTerms.map((w) => '"' + w.replace(/"/g, '""') + '"' + (w.length >= 5 ? '*' : '')).join(' OR ') : null;
  if (q3) {
    try {
      lists.push([db.prepare(
        `SELECT m.rowid AS rowid FROM mem_fts f CROSS JOIN memories m ON m.rowid = f.rowid
         WHERE mem_fts MATCH ? AND ${LIVE} AND ${scope.sql}${kindSql}
         ORDER BY bm25(mem_fts, 4.0, 1.0, 2.0, 2.0) LIMIT 60`
      ).all(q3, ...LA, ...scope.args, ...kindArgs).map((r) => r.rowid), cfg.expansionWeight ?? 0.7]);
    } catch { /* skip */ }
  }
  const temporal = expand && !kind && TEMPORAL_RE.test(query);
  const recentSessions = new Set();
  if (temporal) {
    const rs = db.prepare(`SELECT m.rowid AS rowid FROM memories m WHERE m.kind = 'session' AND ${LIVE} AND ${scope.sql} ORDER BY m.updated_at DESC LIMIT 3`).all(...LA, ...scope.args).map((r) => r.rowid);
    rs.forEach((r) => recentSessions.add(r));
    lists.push([rs, 1]);
  }
  const cosOf = new Map();
  if (useVectors && cfg.embedUrl && cfg.embedModel) {
    try {
      const [qv] = await embed([query]);
      if (qv) {
        const rows = db.prepare(
          `SELECT m.rowid AS rowid, m.embedding AS e FROM memories m
           WHERE m.embedding IS NOT NULL AND ${LIVE} AND ${scope.sql}${kindSql}`
        ).all(...LA, ...scope.args, ...kindArgs);
        const scored = rows.map((r) => ({ rowid: r.rowid, s: cosine(qv, unpackVec(r.e)) })).filter((r) => r.s > 0.25);
        scored.sort((a, b) => b.s - a.s);
        scored.forEach((r) => cosOf.set(r.rowid, r.s));
        lists.push([scored.slice(0, 60).map((r) => r.rowid), 1]);
      }
    } catch { /* embeddings are optional; lexical still works */ }
  }

  const fused = new Map();
  for (const [list, wt] of lists) {
    list.forEach((rowid, rank) => fused.set(rowid, (fused.get(rowid) || 0) + wt / (RRF_K + rank + 1)));
  }
  if (!fused.size) return [];

  const ids = [...fused.keys()];
  const rows = db.prepare(`SELECT * FROM memories WHERE rowid IN (${ids.map(() => '?').join(',')})`).all(...ids); // every candidate list above is already restricted by LIVE (guard status + validity window)

  // Concept coverage: a memory matching BOTH rare query concepts must beat one matching a single term many times.
  const idfSum = concepts.reduce((a, c) => a + c.w, 0) || 1;
  const toks = (s) => fold(s).match(/[\p{L}\p{N}_]+/gu) || [];
  const hasPrefix = (words, stem) => words.some((w) => w.startsWith(stem));
  const stemOf = (term) => { const parts = toks(term); return (parts.length === 1 && parts[0].length > 4) ? parts[0].slice(0, -1) : parts[0]; };
  const strongN = concepts.filter((c) => c.rare).length;
  const coverage = (m) => {
    const head = toks(m.gist + ' ' + m.tags);
    const files = toks(m.files);
    const body = toks(m.body);
    let c = 0, matched = 0, joint = 1;
    for (const k of concepts) {
      let best = 0;
      for (const [forms, f] of [[k.orig, 1], [k.alias, 0.8]]) {
        for (const form of forms) {
          const st = stemOf(form);
          if (!st) continue;
          // aliases match whole words plus a short inflection only ("prod" must not hit "ProductCard")
          const hit = f === 1 ? (ws) => hasPrefix(ws, st) : (ws) => ws.some((w) => w.startsWith(st) && w.length - st.length <= 4);
          if (hit(head)) best = Math.max(best, f); else if (hit(files)) best = Math.max(best, 0.5 * f); else if (hit(body)) best = Math.max(best, 0.35 * f);
        }
      }
      c += best * k.w;
      if (best > 0 && k.rare) matched++;
      if (best > 0 && !k.generic && k.df > 0) joint *= k.df / N;
    }
    // selective: the concepts this memory covers are rare TOGETHER (independence estimate of the share of rows that
    // would match them all, at least one row) — "billing" and "zod" can each be common while "billing + zod" picks one memory
    return { cov: c / idfSum, matched, selective: joint * N <= rareMax };
  };
  const out = rows.map((m) => {
    const hl = KINDS[m.kind]?.halfLife || 90;
    const ageDays = (t - (m.last_access && m.last_access > m.updated_at ? (m.updated_at + m.last_access) / 2 : m.updated_at)) / 86400000;
    let decay = Math.pow(0.5, ageDays / hl);
    // standing decisions/conventions do not go stale by age alone; supersession retires them
    if (cfg.decayFloor && DURABLE.has(m.kind) && (m.importance >= 0.7 || m.pinned)) decay = Math.max(decay, cfg.decayFloor);
    const prior = (0.55 + 0.45 * decay) * (0.7 + 0.6 * m.importance) * (m.pinned ? 1.25 : 1) *
      (project && m.project === project ? 1 : (cfg.globalFactor ?? 0.85)) * (1 + Math.min(0.15, Math.log1p(m.access_count) * 0.04));
    const { cov, matched, selective } = coverage(m);
    const recent = temporal && m.kind === 'session' && recentSessions.has(m.rowid);
    return { m, score: fused.get(m.rowid) * prior * (0.35 + cov * 1.3) * (recent ? 2 : 1), rrf: fused.get(m.rowid), cov, matched, selective, strongN, temporal: recent, cos: cosOf.get(m.rowid) || 0 };
  }).filter((r) => r.score >= minScore);
  if (cfg.actr && out.length) { // P2 ACT-R activation (flag actr, off by default); lazy so the per-prompt hook never loads sleep.js when off
    const { actrFactor } = await import('./sleep.js');
    for (const r of out) r.score *= actrFactor(r.m, t, cfg);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

// ---------------------------------------------------------------------------------------------------------------
// Project specificity (v2 gate features). Is this prompt about THIS project, or are its words better explained by a
// sibling project in the same DB or by a stack this project never uses? Pure features here; the decision is made
// in inject.js promptContext.

const SIG_VER = 1;
const EXACT_MAX = 500, SAMPLE_N = 250; // per-word per-project counts: exact up to EXACT_MAX matches, else a ~SAMPLE_N sample
/**
 * Per-project signature, cached in meta ('spec:sig:<project>') and rebuilt only when the project's live row count or
 * newest rowid changes: the stack families its memories name (words + file extensions in memories.files) and its size.
 */
export function projectSignature(db, project) {
  const st = db.prepare(`SELECT COUNT(*) n, COALESCE(MAX(rowid), 0) r FROM memories WHERE project = ? AND ${liveSql()}`).get(project, ...liveArgs());
  const stamp = `${SIG_VER}:${st.n}:${st.r}`;
  const key = 'spec:sig:' + project;
  try {
    const c = JSON.parse(db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v || 'null');
    if (c && c.stamp === stamp) return { ...c, stacks: new Set(c.stacks) };
  } catch { /* rebuild */ }
  const fams = new Map();
  for (const m of db.prepare(`SELECT gist, tags, files, body FROM memories WHERE project = ? AND ${liveSql()} AND kind != 'session'`).iterate(project, ...liveArgs())) {
    for (const f of stacksIn(`${m.gist} ${m.tags} ${m.files} ${m.body}`)) fams.set(f, (fams.get(f) || 0) + 1);
  }
  const sig = { stamp, n: st.n, stacks: [...fams.keys()].sort(), counts: Object.fromEntries(fams) };
  try { db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, JSON.stringify(sig)); } catch { /* read-only DB: recompute next time */ }
  return { ...sig, stacks: new Set(sig.stacks) };
}

/**
 * Live rows per project, cached in meta ('spec:sizes') while no row was added (same MAX(rowid), an O(1) lookup) and
 * for at most 10 minutes (supersessions and forgets shift counts slightly; a few rows of staleness is harmless).
 * Counting is a full index scan, ~1 ms per 20k memories, so a hook process should not pay it on every prompt.
 */
function projectSizes(db) {
  const r = db.prepare('SELECT COALESCE(MAX(rowid), 0) r FROM memories').get().r;
  try {
    const c = JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'spec:sizes'").get()?.v || 'null');
    if (c && c.r === r && Date.now() - c.t < 600000 && Date.now() >= c.t) return new Map(c.sizes);
  } catch { /* recount */ }
  const sizes = db.prepare(`SELECT project, COUNT(*) c FROM memories WHERE ${liveSql()} GROUP BY project`).all(...liveArgs()).map((x) => [x.project, x.c]);
  try { db.prepare("INSERT INTO meta(k, v) VALUES ('spec:sizes', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ r, t: Date.now(), sizes })); } catch { /* read-only */ }
  return new Map(sizes);
}

/**
 * Specificity features of a prompt for a project:
 *  own / glob / sib / absent: IDF mass of the prompt's own words found in this project, only in global memories,
 *    only in one sibling project (max over siblings), or nowhere;
 *  ownLead / sibLead: IDF mass of words relatively more frequent here vs. clearly more frequent in a sibling;
 *  llr / llrProject: log-likelihood ratio that the best sibling project, rather than this one, produced the words;
 *  stacks / foreign: stack families the prompt names, and those this project's memories never name
 *    (foreign is empty when the prompt also names a stack the project uses, or the signature is too thin).
 */
export function specificity(query, project, { minSigN = 8, mu = 20 } = {}) {
  const db = openDb();
  const sizes = projectSizes(db);
  const NP = sizes.get(project) || 0;
  const Nall = [...sizes.values()].reduce((a, b) => a + b, 0) || 1;
  const sibs = [...sizes.keys()].filter((p) => p !== project && p !== 'global');
  const tr = isTurkish(query);
  const words = keywords(query, 16).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC.has(t) && !GENERIC.has(t.replace(/s$/, '')));
  const out = { own: 0, glob: 0, sib: 0, sibProject: null, absent: 0, ownLead: 0, sibLead: 0, total: 0, n: words.length, concepts: [] };
  const sibMass = new Map();
  for (const t of words.slice(0, 12)) {
    const forms = [t];
    if (tr) { const s = trStem(t); if (s !== t && s.length >= 4) forms.push(s); }
    // dev-vocabulary aliases count as the same concept ("ship to prod" is explained by "deploy" notes here, not by a
    // sibling that happens to say "prod"), matched like search()'s expansion list
    const alias = [...new Set(forms.flatMap((f) => aliasesOf(f)))].filter((a) => !forms.includes(a));
    const q = [...forms.map((w) => '"' + w.replace(/"/g, '""') + '"' + (w.length > 3 ? '*' : '')),
      ...alias.map((w) => '"' + w.replace(/"/g, '""') + '"' + (w.length >= 5 ? '*' : ''))].join(' OR ');
    let rows = [];
    try {
      // exact per-project counts up to EXACT_MAX matches; above that a hashed-rowid sample (≈SAMPLE_N rows) scaled
      // to the total: the join to memories is the cost (~0.8 ms per 1,000 matches), the FTS count alone is cheap
      const total = db.prepare('SELECT COUNT(*) c FROM mem_fts WHERE mem_fts MATCH ?').get(q).c;
      if (!total) rows = [];
      else if (total <= EXACT_MAX) rows = db.prepare(`SELECT m.project p, COUNT(*) c FROM mem_fts f CROSS JOIN memories m ON m.rowid = f.rowid WHERE mem_fts MATCH ? AND ${liveSql('m')} GROUP BY m.project`).all(q, ...liveArgs());
      else {
        const k = Math.ceil(total / SAMPLE_N);
        const smp = db.prepare(`SELECT m.project p, COUNT(*) c FROM (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? AND ((rowid * 2654435761) >> 16) % ? = 0) f CROSS JOIN memories m ON m.rowid = f.rowid WHERE ${liveSql('m')} GROUP BY m.project`).all(q, k, ...liveArgs());
        rows = smp.map((x) => ({ p: x.p, c: Math.max(1, Math.round(x.c * k)) }));
      }
    } catch { continue; }
    const df = new Map(rows.map((r) => [r.p, r.c]));
    const dfAll = rows.reduce((a, r) => a + r.c, 0);
    const w = Math.log(1 + Nall / (1 + dfAll));
    const dP = df.get(project) || 0, dG = df.get('global') || 0;
    const rateP = NP ? dP / NP : 0;
    let rateS = 0, topS = null;
    for (const s of sibs) { const r = (df.get(s) || 0) / sizes.get(s); if (r > rateS) { rateS = r; topS = s; } }
    out.total += w;
    if (!dfAll) out.absent += w;
    else if (dP) out.own += w;
    else if (dG) out.glob += w;
    else for (const s of sibs) if (df.get(s)) sibMass.set(s, (sibMass.get(s) || 0) + w);
    if (dP && rateP >= rateS) out.ownLead += w;
    if (rateS > 0 && rateS > 3 * rateP && !dG) out.sibLead += w;
    out.concepts.push({ t, forms, w, dP, dG, dAll: dfAll, rateP, rateS, topS, df: Object.fromEntries(df) });
  }
  for (const [s, m] of sibMass) if (m > out.sib) { out.sib = m; out.sibProject = s; }
  out.sizes = Object.fromEntries(sizes);
  // Which project wrote this prompt? Naive-Bayes log-likelihood ratio (nats) of the best sibling against this project
  // + global, over the prompt's words that occur anywhere, with Dirichlet smoothing toward the word's DB-wide rate
  // (mu pseudo-rows): a small sibling that merely lacks a word gets no credit for it (add-one smoothing let a 10-note
  // sibling "explain" every word that is rare here). A sibling must contain at least one word absent here.
  const NPG = NP + (sizes.get('global') || 0);
  out.llr = -Infinity; out.llrProject = null;
  for (const s of sibs) {
    const NS = sizes.get(s);
    let t = 0, only = false;
    for (const c of out.concepts) {
      if (!c.dAll) continue;
      const bg = mu * c.dAll / Nall, dS = c.df[s] || 0, dPG = c.dP + c.dG;
      if (dS && !dPG) only = true;
      t += Math.log((dS + bg) / (NS + mu)) - Math.log((dPG + bg) / (NPG + mu));
    }
    if (only && t > out.llr) { out.llr = t; out.llrProject = s; }
  }
  out.stacks = [...stacksIn(query)];
  const sig = projectSignature(db, project);
  out.sigN = sig.n;
  out.known = [...sig.stacks];
  const mature = sig.n >= minSigN && sig.stacks.size > 0;
  out.foreign = mature && out.stacks.length && !out.stacks.some((f) => sig.stacks.has(f)) ? out.stacks : [];
  return out;
}
