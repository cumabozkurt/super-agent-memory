// Shared helpers: dataset parsing, loading a corpus into a SAM build, metrics, tiktoken bridge.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO_SRC = join(ROOT, '..', '..', 'src');
export const DATA = join(ROOT, 'data');

export function parseMemories() {
  const out = [];
  for (const f of readdirSync(DATA).filter((x) => /^memories_.*\.txt$/.test(x)).sort()) {
    let project = 'global';
    for (const raw of readFileSync(join(DATA, f), 'utf8').split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      if (l.startsWith('@project')) { project = l.split(/\s+/)[1]; continue; }
      const [head, body] = l.split(' || ');
      const p = head.split('|');
      if (p.length < 6) throw new Error('bad memory line: ' + l);
      const [key, kind0, age, tagsRaw, files] = p.map((s) => s.trim());
      const text = p.slice(5).join('|').trim();
      const tags = tagsRaw.split(/\s+/).filter(Boolean);
      const pin = tags.includes('@pin');
      const impT = tags.find((t) => t.startsWith('@imp'));
      const kind = kind0 === 'gotcha-note' ? 'note' : kind0;
      out.push({
        key, project, kind, label: kind0, ageDays: Number(age), text, body: body ? body.trim() : undefined,
        tags: tags.filter((t) => !t.startsWith('@')).concat(kind0 === 'gotcha-note' ? ['gotcha'] : []),
        files: files.split(/\s+/).filter(Boolean), pin, importance: impT ? Number(impT.slice(4)) : undefined,
        noise: f.includes('noise'),
      });
    }
  }
  return out;
}

function parseLabels(s) {
  const rel = {}; const stale = [];
  for (const tok of (s || '').trim().split(/\s+/).filter(Boolean)) {
    const [k, g] = tok.split(':');
    if (g === 'x') stale.push(k); else rel[k] = Number(g);
  }
  return { rel, stale };
}

export function parseQueries() {
  const out = [];
  for (const raw of readFileSync(join(DATA, 'queries.txt'), 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const p = l.split('|');
    const [qid, project, type] = p.map((s) => s.trim());
    const query = p[3].trim();
    out.push({ qid, project, type, query, ...parseLabels(p[4]) });
  }
  return out;
}

export function parseSession40() {
  const out = [];
  for (const raw of readFileSync(join(DATA, 'session40.txt'), 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const p = l.split('|');
    out.push({ turn: Number(p[0]), query: p[1].trim(), project: 'kervan', ...parseLabels(p[2]) });
  }
  return out;
}

export const core = () => JSON.parse(readFileSync(join(DATA, 'core.json'), 'utf8'));

/**
 * Provenance (v1.2+): curated memories load as source 'user' (only user rows may pin), the generated
 * auto-capture distractors as 'auto'. v1.1 builds store the value as a plain label, so both builds see the same rows.
 *
 * Load the corpus into the SAM build at srcDir. Oldest first so topic supersession runs in the natural order,
 * then backdate created/updated timestamps. Returns key<->id maps and the save log.
 */
export async function loadCorpus(srcDir, mems) {
  const { saveMemory } = await import(join(srcDir, 'store.js'));
  const { openDb } = await import(join(srcDir, 'db.js'));
  const db = openDb();
  for (const p of ['kervan', 'pulsar', 'atlas']) db.prepare('INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)').run(p, p, null, Date.now());
  const order = [...mems].sort((a, b) => b.ageDays - a.ageDays);
  const key2id = {}; const id2keys = {}; const log = [];
  const t0 = Date.now();
  for (const m of order) {
    const r = saveMemory({ project: m.project, kind: m.kind, text: m.text, body: m.body, tags: m.tags, files: m.files, pin: m.pin, importance: m.importance, source: m.noise ? 'auto' : 'user' });
    key2id[m.key] = r.id;
    (id2keys[r.id] ||= []).push(m.key);
    log.push({ key: m.key, ...r });
    const ts = t0 - m.ageDays * 86400000;
    if (r.status === 'merged') continue; // merge keeps the row; newest wording wins
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, r.id);
  }
  // merged rows: updated_at = age of the newest member
  for (const [id, keys] of Object.entries(id2keys)) {
    if (keys.length > 1) {
      const minAge = Math.min(...keys.map((k) => mems.find((m) => m.key === k).ageDays));
      db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(t0 - minAge * 86400000, id);
    }
  }
  const superseded = new Set(db.prepare('SELECT id FROM memories WHERE superseded_by IS NOT NULL').all().map((r) => r.id));
  return { key2id, id2keys, log, superseded };
}

/** Grades for a retrieved id: max grade over the dataset keys that were merged into that row. */
export function gradeOf(q, id, id2keys) {
  let g = 0;
  for (const k of id2keys[id] || []) g = Math.max(g, q.rel[k] || 0);
  return g;
}
export const isStale = (q, id, id2keys) => (id2keys[id] || []).some((k) => q.stale.includes(k));

/** Set of distinct target rows for grade-3 labels (merged keys collapse into one row). */
export function targets(q, key2id, superseded, minGrade = 3) {
  const s = new Set();
  for (const [k, g] of Object.entries(q.rel)) if (g >= minGrade && key2id[k] && !superseded.has(key2id[k])) s.add(key2id[k]);
  return s;
}

export function rankMetrics(q, ids, ctx) {
  const T = targets(q, ctx.key2id, ctx.superseded);
  const rec = (k) => (T.size ? ids.slice(0, k).filter((id) => T.has(id)).length / T.size : 0);
  let rr = 0;
  for (let i = 0; i < ids.length; i++) if (gradeOf(q, ids[i], ctx.id2keys) >= 2) { rr = 1 / (i + 1); break; }
  const dcg = ids.slice(0, 5).reduce((a, id, i) => a + (2 ** gradeOf(q, id, ctx.id2keys) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(q.rel).sort((a, b) => b - a).slice(0, 5).reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0);
  const firstT = ids.findIndex((id) => T.has(id));
  const staleIdx = ids.findIndex((id) => isStale(q, id, ctx.id2keys));
  return {
    r1: rec(1), r3: rec(3), r5: rec(5), r10: rec(10), mrr: rr, ndcg5: ideal ? dcg / ideal : 0,
    staleAbove: q.stale.length ? (staleIdx >= 0 && (firstT < 0 || staleIdx < firstT) ? 1 : 0) : null,
  };
}

/**
 * Exact o200k_base token counts via python tiktoken, batched. Optional: without python3 + tiktoken
 * (or with SAM_BENCH_TIKTOKEN=0) it returns null and the harness reports SAM's own estimator instead.
 */
export function tiktokenCounts(texts) {
  if (!texts.length) return [];
  if (process.env.SAM_BENCH_TIKTOKEN === '0') return null;
  const r = spawnSync('python3', ['-c', `import sys,json,tiktoken
e=tiktoken.get_encoding('o200k_base')
print(json.dumps([len(e.encode(t)) for t in json.load(sys.stdin)]))`], { input: JSON.stringify(texts), maxBuffer: 64 << 20 });
  if (r.status !== 0 || r.error) return null;
  try { return JSON.parse(r.stdout.toString()); } catch { return null; }
}

/** Tuning half = odd query number (q001, n01…); held-out half = even. Tune only on the tuning half. */
export const isTuning = (q) => Number(String(q.qid).replace(/\D/g, '')) % 2 === 1;

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export const r3 = (x) => Math.round(x * 1000) / 1000;
