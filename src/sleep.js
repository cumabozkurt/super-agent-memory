// P2 memory dynamics, all OFF by default (config flags) and LLM-free:
// - ACT-R base-level activation  B = ln(Σ_j t_j^-d)  as an optional ranking factor (flag `actr`)
// - demote instead of delete: gc lowers unused memories to a low-importance tier, reversibly (flag `demote`)
// - `sam sleep`: offline consolidation — near-duplicate clusters, weekly session digests, raw-event pruning
//   (manual, or at most once a day with the auto-gc when flag `sleep` is on)
import { openDb, tx } from './db.js';
import { config } from './config.js';
import { hamming, oneLine, compactPaths, gistOf, simhash, newId } from './text.js';
import { polarity } from './store.js';
import { draftSkills } from './skilldraft.js';

const DAY = 86400000;
const HOUR = 3600000;

// ---------------------------------------------------------------- ACT-R

/** Base-level activation from presentation ages (hours): ln(Σ t_j^-d). Ages are floored at 1 h (a just-saved memory is not infinitely active). */
export function actrActivation(agesHours, d = 0.5) {
  let s = 0;
  for (const a of agesHours) s += Math.pow(Math.max(1, a), -d);
  return s > 0 ? Math.log(s) : -Infinity;
}

/**
 * Activation of a memory row. SAM stores only created_at, updated_at, last_access and access_count, so the exact
 * sum runs over the presentations we know (creation, a later re-save, the last access) and the remaining
 * access_count-1 accesses use Petrov's (2006) approximation, spread uniformly between creation and last access:
 *   k · (t_c^(1-d) − t_l^(1-d)) / ((1-d)(t_c − t_l))
 */
export function actrOfRow(m, t = Date.now(), d = config().actrDecay ?? 0.5) {
  const age = (ms) => Math.max(1, (t - Math.min(ms, t)) / HOUR);
  const tc = age(m.created_at ?? m.updated_at ?? t);
  let s = Math.pow(tc, -d);
  if (m.updated_at && m.created_at && m.updated_at - m.created_at > 60000) s += Math.pow(age(m.updated_at), -d);
  const n = Math.max(0, Math.trunc(m.access_count || 0));
  if (n > 0 && m.last_access) {
    const tl = age(m.last_access);
    s += Math.pow(tl, -d);
    const k = n - 1;
    if (k > 0) s += tc - tl > 1e-6 ? k * (Math.pow(tc, 1 - d) - Math.pow(tl, 1 - d)) / ((1 - d) * (tc - tl)) : k * Math.pow(tl, -d);
  }
  return Math.log(s);
}

/**
 * Ranking multiplier in [1 − w, 1 + w] (w = actrWeight). Centred at B = −2 (one presentation ~2 days ago), so a
 * memory touched once long ago sinks slightly and one used often and recently rises slightly.
 * Integration (search.js, before out.sort): if (cfg.actr) for (const r of out) r.score *= actrFactor(r.m, t, cfg);
 */
export function actrFactor(m, t = Date.now(), cfg = config()) {
  const w = cfg.actrWeight ?? 0.15;
  const b = actrOfRow(m, t, cfg.actrDecay ?? 0.5);
  return 1 + w * Math.tanh((b + 2) / 2);
}

// ---------------------------------------------------------------- demote instead of delete

export const DEMOTED_IMPORTANCE = 0.05;
const DEMOTE_KINDS = "('fact','note','bug','fix','todo','session')"; // decisions/conventions/preferences retire by supersession only

/** Move rows to the low tier; the original importance is kept in meta('demoted:<id>') so it is restored on use. */
export function demoteIds(db, ids, t = Date.now()) {
  let n = 0;
  const get = db.prepare('SELECT importance FROM memories WHERE id = ? AND superseded_by IS NULL AND pinned = 0');
  const set = db.prepare('UPDATE memories SET importance = ? WHERE id = ?');
  const keep = db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING');
  for (const id of ids) {
    const r = get.get(id);
    if (!r || r.importance <= DEMOTED_IMPORTANCE) continue;
    keep.run('demoted:' + id, JSON.stringify({ imp: r.importance, at: t }));
    n += set.run(DEMOTED_IMPORTANCE, id).changes;
  }
  return n;
}

/** Unused (never fetched, or not for demoteAfterDays) non-durable rows. Pinned and user-written rows are never demoted. */
export function unusedIds(db, t = Date.now(), days = config().demoteAfterDays ?? 90) {
  return db.prepare(
    `SELECT id FROM memories WHERE superseded_by IS NULL AND pinned = 0 AND COALESCE(source, '') != 'user' AND kind IN ${DEMOTE_KINDS}
       AND importance > ? AND COALESCE(last_access, updated_at) < ? AND updated_at < ? ORDER BY id`
  ).all(DEMOTED_IMPORTANCE, t - days * DAY, t - days * DAY).map((r) => r.id);
}

/** A demoted memory that was fetched again gets its importance back. */
export function restoreUsed(db) {
  let n = 0;
  for (const { k, v } of db.prepare("SELECT k, v FROM meta WHERE k LIKE 'demoted:%'").all()) {
    const id = k.slice(8);
    let rec; try { rec = JSON.parse(v); } catch { rec = null; }
    const m = db.prepare('SELECT last_access, superseded_by FROM memories WHERE id = ?').get(id);
    if (!m || m.superseded_by || !rec) { db.prepare('DELETE FROM meta WHERE k = ?').run(k); continue; }
    if ((m.last_access || 0) > rec.at) {
      db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(rec.imp, id);
      db.prepare('DELETE FROM meta WHERE k = ?').run(k);
      n++;
    }
  }
  return n;
}

/** gc hook (flag `demote`): restore re-used rows, demote unused ones. Returns { demoted, restored }. */
export function demotePass({ dryRun = false, t = Date.now() } = {}) {
  const db = openDb();
  const ids = unusedIds(db, t);
  if (dryRun) return { demoted: ids.length, restored: 0 };
  return tx((d) => { const restored = restoreUsed(d); return { demoted: demoteIds(d, ids, t), restored }; });
}

// ---------------------------------------------------------------- sleep

/** ISO-8601 week of a ms timestamp (UTC), e.g. "2026-W41". */
export function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const th = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3)); // Thursday of this week
  const y = th.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((th - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/**
 * Near-duplicate clusters at SimHash distance ≤ th (gc merges pairs at 3). Star clustering in gc's rank order: the
 * strongest unassigned row is a centre and absorbs rows within th of IT (no chaining), same polarity, and the same
 * topic key when both have one. LSH: 8 bands of 8 bits find every pair within distance 7 (pigeonhole).
 */
function mergeClusters(db, { th, dryRun, report }) {
  const groups = db.prepare("SELECT project, kind FROM memories WHERE superseded_by IS NULL AND status = 'active' AND kind != 'session' AND simhash IS NOT NULL AND simhash != '' GROUP BY project, kind HAVING COUNT(*) > 1 ORDER BY project, kind").all();
  for (const g of groups) {
    const rows = db.prepare(
      `SELECT id, simhash, gist, topic, pinned, source, access_count FROM memories WHERE project = ? AND kind = ? AND superseded_by IS NULL AND status = 'active' AND simhash IS NOT NULL AND simhash != ''
       ORDER BY pinned DESC, (source = 'user') DESC, importance DESC, access_count DESC, updated_at DESC, id`
    ).all(g.project, g.kind);
    const buckets = new Map();
    rows.forEach((r, i) => {
      const h = r.simhash.padStart(16, '0');
      for (let b = 0; b < 8; b++) {
        const key = b + ':' + h.slice(b * 2, b * 2 + 2);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
    });
    const taken = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (taken.has(i)) continue;
      const c = rows[i];
      const h = c.simhash.padStart(16, '0');
      const cand = new Set();
      for (let b = 0; b < 8; b++) for (const j of buckets.get(b + ':' + h.slice(b * 2, b * 2 + 2)) || []) if (j > i && !taken.has(j)) cand.add(j);
      const members = [...cand].sort((a, b) => a - b).filter((j) => {
        const r = rows[j];
        if (r.pinned || (r.source === 'user' && c.source !== 'user')) return false; // provenance: never retire a stronger row
        if (c.topic && r.topic && c.topic !== r.topic) return false;
        return hamming(c.simhash, r.simhash) <= th && polarity(c.gist) === polarity(r.gist);
      });
      if (!members.length) continue;
      report.clusters++;
      for (const j of members) {
        taken.add(j);
        report.merged++;
        if (!dryRun) {
          db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(c.id, rows[j].id);
          db.prepare('UPDATE memories SET access_count = access_count + ? WHERE id = ?').run(rows[j].access_count, c.id);
        }
      }
    }
  }
}

const editsOf = (gist) => Number((String(gist).match(/→\s*(\d+)\s+edits?/) || [])[1] || 0);
const intentOf = (gist) => oneLine(String(gist).replace(/^\d\d-\d\d\s+/, '').replace(/\s*→.*$/, ''));

/** Fold session digests older than `days` into one digest per project and ISO week. */
function weeklyDigests(db, { days, t, dryRun, report }) {
  const old = db.prepare(
    `SELECT * FROM memories WHERE kind = 'session' AND superseded_by IS NULL AND pinned = 0 AND updated_at < ?
       AND (' ' || tags || ' ') NOT LIKE '% weekly %' ORDER BY project, updated_at, id`
  ).all(t - days * DAY);
  const groups = new Map();
  for (const m of old) {
    const key = m.project + '\u0000' + isoWeek(m.updated_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const [key, list] of groups) {
    const [project, week] = key.split('\u0000');
    const metaKey = `weekly:${project}:${week}`;
    const prevId = db.prepare('SELECT v FROM meta WHERE k = ?').get(metaKey)?.v;
    const prev = prevId ? db.prepare('SELECT * FROM memories WHERE id = ? AND superseded_by IS NULL').get(prevId) : null;
    if (!prev && list.length < 2) continue; // a lone digest stays as it is
    const lines = [...(prev ? prev.body.split('\n').filter((l) => /^\d\d-\d\d /.test(l)) : []), ...list.map((m) => oneLine(m.gist))];
    const all = [...new Set(lines)].sort();
    const fileCount = new Map();
    for (const f of [...(prev?.files || '').split(' '), ...list.flatMap((m) => (m.files || '').split(' '))]) if (f) fileCount.set(f, (fileCount.get(f) || 0) + 1);
    const files = [...fileCount].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map((e) => e[0]);
    const edits = all.reduce((a, l) => a + editsOf(l), 0);
    const intents = [...new Set(all.map(intentOf).filter(Boolean))];
    const gist = gistOf(`${week} (${all.length} sessions): ${intents.slice(0, 3).join('; ')}${intents.length > 3 ? '; …' : ''} → ${edits} edits`, 140);
    const body = all.join('\n') + (files.length ? '\nFiles: ' + compactPaths(files, 8) : '');
    report.weekly++;
    report.folded += list.length;
    if (dryRun) continue;
    const newest = Math.max(prev?.updated_at || 0, ...list.map((m) => m.updated_at));
    let id = prev?.id;
    if (prev) {
      db.prepare('UPDATE memories SET gist = ?, body = ?, files = ?, updated_at = ? WHERE id = ?').run(gist, body, files.join(' '), newest, id);
    } else {
      // a direct insert (not saveMemory): the weekly row must never be near-dup-merged into one of the digests it folds
      do id = newId(6); while (db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id));
      db.prepare(`INSERT INTO memories(id, project, kind, gist, body, tags, files, importance, agent, source, simhash, created_at, updated_at)
        VALUES (?, ?, 'session', ?, ?, 'weekly auto', ?, 0.3, 'sleep', 'auto', ?, ?, ?)`)
        .run(id, project, gist, body, files.join(' '), simhash(gist + ' ' + body), Math.min(...list.map((m) => m.created_at)), newest);
      db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(metaKey, id);
    }
    const sup = db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND id != ?');
    for (const m of list) sup.run(id, m.id, id);
  }
}

/**
 * Offline consolidation. Deterministic, LLM-free, reversible for memories (they are superseded, not deleted).
 * Raw events of ended sessions older than sleepEventDays are deleted (edit events stay: they feed "recently edited").
 */
export function sleep({ dryRun = false, t = Date.now(), days, eventDays, drafts } = {}) {
  const cfg = config();
  const db = openDb();
  days ??= cfg.sleepDigestDays ?? 14;
  eventDays ??= cfg.sleepEventDays ?? 7;
  const report = { clusters: 0, merged: 0, weekly: 0, folded: 0, events: 0, drafts: [] };
  const run = (fn) => (dryRun ? fn(db) : tx(fn));
  run((d) => mergeClusters(d, { th: Math.min(7, cfg.sleepHamming ?? 5), dryRun, report }));
  run((d) => weeklyDigests(d, { days, t, dryRun, report }));
  const evWhere = `ts < ? AND type != 'edit' AND session IN (SELECT id FROM sessions WHERE ended_at IS NOT NULL)`;
  report.events = dryRun ? db.prepare(`SELECT COUNT(*) c FROM events WHERE ${evWhere}`).get(t - eventDays * DAY).c
    : db.prepare(`DELETE FROM events WHERE ${evWhere}`).run(t - eventDays * DAY).changes;
  if (drafts ?? cfg.skillDrafts) report.drafts = draftSkills({ dryRun }).map((x) => x.file);
  if (!dryRun) db.prepare("INSERT INTO meta(k, v) VALUES ('sleep:last', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(t));
  return report;
}

/** Automatic run (flag `sleep`): at most once per 24 h across processes (compare-and-set claim, like maybeAutoGc). */
export function maybeSleep({ every = DAY, t = Date.now() } = {}) {
  if (!config().sleep) return null;
  let claimed = false;
  tx((d) => {
    const last = Number(d.prepare("SELECT v FROM meta WHERE k = 'sleep:auto'").get()?.v || 0);
    if (last && last <= t && t - last < every) return;
    d.prepare("INSERT INTO meta(k, v) VALUES ('sleep:auto', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(t));
    claimed = true;
  });
  return claimed ? sleep({ t }) : null;
}
