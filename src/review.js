// `sam review` (inbox for held memories) and `sam audit` (what is stored, what gets injected, what it led to).
// Held = status 'pending' (caps / reviewAgentRules) or 'quarantined' (guard.js heuristics). Held rows are invisible
// to agents; only the human, through this CLI, sees their text.
import { openDb, tx } from './db.js';
import { config } from './config.js';
import { gateTs, GATE_FIELDS } from './guard.js';

const DAY = 86400000;
const HELD = "status IN ('pending', 'quarantined')";
const clean = (id) => String(id).replace(/^#/, '').trim();

function reasonOf(db, id) {
  try { return JSON.parse(db.prepare('SELECT v FROM meta WHERE k = ?').get('guard:' + id)?.v || 'null'); } catch { return null; }
}

/** Held rows (newest first) with the reason they were held and when they expire. */
export function inbox({ project, status, limit = 200 } = {}) {
  const db = openDb();
  const where = ['superseded_by IS NULL', status ? 'status = ?' : HELD];
  const args = status ? [status] : [];
  if (project) { where.push("(project = ? OR project = 'global')"); args.push(project); }
  const days = config().reviewExpireDays;
  return db.prepare(`SELECT id, project, kind, gist, body, source, agent, session, status, created_at FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit)
    .map((m) => {
      const r = reasonOf(db, m.id);
      return { ...m, reasons: r?.r || [], expires_at: days > 0 ? Math.max(m.created_at, r?.at || 0) + days * DAY : null };
    });
}

/** Topic supersession that was deferred while the row was held (a held row retires nothing on save). */
function supersedeOnApprove(db, m) {
  if (!m.topic) return [];
  const olds = db.prepare(
    "SELECT id, pinned, source FROM memories WHERE project = ? AND topic = ? AND superseded_by IS NULL AND status = 'active' AND id != ? AND updated_at <= ?"
  ).all(m.project, m.topic, m.id, m.updated_at);
  const done = [];
  for (const o of olds) {
    if (o.pinned || o.source === 'user') continue; // approving an agent row never overrides the user's own value
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(m.id, o.id);
    done.push(o.id);
  }
  return done;
}

/** Approve held rows: they become active (visible to agents). Returns [{id, supersedes}] for rows that were held. */
export function approve(ids, { project } = {}) {
  return tx((db) => {
    const out = [];
    for (const raw of ids) {
      const id = clean(raw);
      const m = db.prepare(`SELECT * FROM memories WHERE id = ? AND ${HELD}${project ? " AND (project = ? OR project = 'global')" : ''}`).get(...(project ? [id, project] : [id]));
      if (!m) continue;
      db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), id);
      db.prepare('DELETE FROM meta WHERE k = ?').run('guard:' + id);
      out.push({ id, supersedes: supersedeOnApprove(db, { ...m, updated_at: Date.now() }) });
    }
    return out;
  });
}

/**
 * Reject held rows: retired as 'forgotten' (so the same text is not re-created by an agent / team file / import),
 * or deleted outright with hard. Returns the ids rejected.
 */
export function reject(ids, { project, hard = false } = {}) {
  return tx((db) => {
    const out = [];
    for (const raw of ids) {
      const id = clean(raw);
      const scope = project ? " AND (project = ? OR project = 'global')" : '';
      const args = project ? [id, project] : [id];
      const n = hard
        ? db.prepare(`DELETE FROM memories WHERE id = ? AND ${HELD}${scope}`).run(...args).changes
        : db.prepare(`UPDATE memories SET superseded_by = 'forgotten', updated_at = ? WHERE id = ? AND ${HELD} AND superseded_by IS NULL${scope}`).run(Date.now(), ...args).changes;
      if (n) { db.prepare('DELETE FROM meta WHERE k = ?').run('guard:' + id); out.push(id); }
    }
    return out;
  });
}

/** Approve every pending row (and quarantined ones only when asked explicitly). */
export function approveAll({ project, quarantined = false } = {}) {
  const rows = inbox({ project, status: quarantined ? undefined : 'pending', limit: 100000 });
  return approve(rows.map((r) => r.id), { project });
}

/**
 * Held rows nobody approved within reviewExpireDays are deleted (with their FTS entries, via trigger).
 * Rejected rows (superseded 'forgotten') stay as re-capture blockers. Called by `sam review`, `sam audit` and gc.
 */
export function expireHeld({ days = config().reviewExpireDays, dryRun = false, now = Date.now() } = {}) {
  const db = openDb();
  if (!dryRun) { try { db.prepare("DELETE FROM meta WHERE k >= 'taint:' AND k < 'taint;' AND json_extract(v, '$.at') < ?").run(now - 2 * DAY); } catch { /* noop */ } }
  if (!(days > 0)) return 0;
  const cut = now - days * DAY;
  // the clock starts when the row was held (an imported row keeps its original created_at)
  const sql = `SELECT m.id FROM memories m LEFT JOIN meta g ON g.k = 'guard:' || m.id
    WHERE m.${HELD} AND m.superseded_by IS NULL AND MAX(m.created_at, COALESCE(json_extract(g.v, '$.at'), 0)) < ?`;
  if (dryRun) return db.prepare(sql).all(cut).length;
  return tx((d) => {
    const ids = d.prepare(sql).all(cut).map((r) => r.id);
    for (const id of ids) {
      d.prepare('DELETE FROM memories WHERE id = ?').run(id);
      d.prepare('DELETE FROM meta WHERE k = ?').run('guard:' + id);
      d.prepare('DELETE FROM injections WHERE mem_id = ?').run(id);
    }
    return ids.length;
  });
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

/**
 * Per-project audit. Everything is read from tables SAM already keeps:
 * - memories: counts by source / status / kind
 * - injections (ledger, kept 7 days by gc): what was pushed into which session, most-injected memories
 * - follow-up signals for each injection: the agent fetched it (mem_get → last_access after the injection) or touched
 *   one of its files later in the same session (events edit/read)
 * - meta 'guard:*': why rows were held; meta 'gate:*': per-prompt gate features (calibration log)
 */
export function audit({ project, days = 30, top = 10 } = {}) {
  const db = openDb();
  const scope = project ? "(project = ? OR project = 'global')" : '1=1';
  const sa = project ? [project] : [];
  const group = (col) => Object.fromEntries(db.prepare(`SELECT COALESCE(${col}, '?') g, COUNT(*) c FROM memories WHERE superseded_by IS NULL AND ${scope} GROUP BY 1 ORDER BY 2 DESC`).all(...sa).map((r) => [r.g, r.c]));
  const counts = { bySource: group('source'), byStatus: group('status'), byKind: group('kind') };
  counts.retired = db.prepare(`SELECT COUNT(*) c FROM memories WHERE superseded_by IS NOT NULL AND ${scope}`).get(...sa).c;

  // injections of this project's (or global) memories
  const since = Date.now() - days * DAY;
  const inj = db.prepare(
    `SELECT i.session, i.mem_id, i.ts, m.files, m.last_access, m.kind, m.source, m.gist FROM injections i JOIN memories m ON m.id = i.mem_id
     WHERE i.ts >= ? AND ${scope.replace(/project/g, 'm.project')}`
  ).all(since, ...sa);
  const evStmt = db.prepare("SELECT subject FROM events WHERE session = ? AND ts >= ? AND type IN ('edit', 'read') AND subject IS NOT NULL LIMIT 400");
  const evCache = new Map();
  let fetched = 0, touched = 0, used = 0;
  const per = new Map();
  for (const r of inj) {
    const p = per.get(r.mem_id) || { id: r.mem_id, kind: r.kind, source: r.source, gist: r.gist, sessions: 0, used: 0 };
    p.sessions++;
    const f = r.last_access && r.last_access >= r.ts ? 1 : 0;
    let t = 0;
    const files = (r.files || '').split(' ').filter(Boolean);
    if (files.length && r.session) {
      const key = r.session + '|' + r.ts;
      if (!evCache.has(key)) evCache.set(key, evStmt.all(r.session, r.ts).map((e) => e.subject));
      const subj = evCache.get(key);
      t = files.some((fl) => subj.some((s) => s === fl || s.endsWith('/' + fl) || fl.endsWith('/' + s))) ? 1 : 0;
    }
    fetched += f; touched += t;
    if (f || t) { used++; p.used++; }
    per.set(r.mem_id, p);
  }
  const mostInjected = [...per.values()].sort((a, b) => b.sessions - a.sessions || b.used - a.used || (a.id < b.id ? -1 : 1)).slice(0, top);
  const sessions = new Set(inj.map((r) => r.session)).size;
  const hits = {
    injections: inj.length, sessions, fetchedAfter: fetched, filesTouchedAfter: touched, followedUp: used, followUpRate: pct(used, inj.length),
    note: 'follow-up = mem_get after the injection, or an edit/read of one of its files later in the same session (a lower bound on use; the ledger keeps 7 days)',
  };

  // quarantine / pending reasons
  const held = db.prepare(`SELECT id, status FROM memories WHERE ${HELD} AND superseded_by IS NULL AND ${scope}`).all(...sa);
  const reasons = {};
  for (const h of held) for (const r of reasonOf(db, h.id)?.r || ['unknown']) reasons[r] = (reasons[r] || 0) + 1;

  // gate log (calibration): pass rate and, per passed hit, whether it was followed up
  const gl = db.prepare("SELECT k, v FROM meta WHERE k >= ? AND k < 'gate;'").all('gate:' + Math.max(0, since).toString(36).padStart(9, '0'));
  let prompts = 0, passedPrompts = 0, passedHits = 0, passedUsed = 0;
  const memStmt = db.prepare('SELECT last_access FROM memories WHERE id = ?');
  for (const g of gl) {
    let v; try { v = JSON.parse(g.v); } catch { continue; }
    if (project && v.p !== project) continue;
    prompts++;
    const passed = (v.h || []).filter((h) => h[GATE_FIELDS.indexOf('passed')]);
    if (passed.length) passedPrompts++;
    for (const h of passed) {
      passedHits++;
      const la = memStmt.get(h[0])?.last_access;
      if (la && la >= gateTs(g.k)) passedUsed++;
    }
  }
  const gate = { prompts, passedPrompts, passRate: pct(passedPrompts, prompts), passedHits, passedFetched: passedUsed, fields: GATE_FIELDS };
  return { project: project || '*', days, counts, mostInjected, hits, held: { total: held.length, reasons }, gate };
}

/** Plain-text rendering of audit() for the CLI. */
export function formatAudit(a) {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  const out = [];
  out.push(`audit ${a.project === '*' ? 'all projects' : 'project'} (last ${a.days}d of ledger)`);
  out.push(`live by source: ${kv(a.counts.bySource)}`);
  out.push(`live by status: ${kv(a.counts.byStatus)}  (retired ${a.counts.retired})`);
  out.push(`live by kind:   ${kv(a.counts.byKind)}`);
  out.push(`held: ${a.held.total}${a.held.total ? ' — reasons: ' + kv(a.held.reasons) : ''}`);
  const h = a.hits;
  out.push(`injections: ${h.injections} into ${h.sessions} sessions · followed up ${h.followedUp} (${h.followUpRate}%): mem_get ${h.fetchedAfter}, files touched ${h.filesTouchedAfter}`);
  out.push(`gate log: ${a.gate.prompts} prompts with candidates · injected on ${a.gate.passedPrompts} (${a.gate.passRate}%) · ${a.gate.passedFetched}/${a.gate.passedHits} passed hits fetched later`);
  if (a.mostInjected.length) {
    out.push('most injected:');
    for (const m of a.mostInjected) out.push(`  ${String(m.sessions).padStart(3)}× #${m.id} [${m.kind}${m.source && m.source !== 'user' ? ' ' + m.source : ''}] ${m.gist.slice(0, 70)}${m.used ? ` (used ${m.used})` : ''}`);
  }
  return out.join('\n');
}

/** Plain-text rendering of the inbox. Held text is shown to the human only, escaped to one line. */
export function formatInbox(rows) {
  if (!rows.length) return 'review inbox empty';
  const now = Date.now();
  return rows.map((r) => {
    const left = r.expires_at ? Math.max(0, Math.ceil((r.expires_at - now) / DAY)) + 'd left' : '';
    const g = String(r.gist).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
    return `#${r.id} ${r.status === 'quarantined' ? '⚠ quarantined' : 'pending'} [${r.kind} · ${r.source || '?'}${r.agent ? '/' + r.agent : ''}] ${g}\n    reason: ${r.reasons.join(', ') || '—'}${left ? ' · ' + left : ''}`;
  }).join('\n');
}
