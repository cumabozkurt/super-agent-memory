// Consolidation & hygiene, LLM-free and reversible: nothing useful is hard-deleted.
// - expire raw events / vault outputs / injection ledgers past retention
// - merge near-duplicates that slipped in (keeps the stronger memory, supersedes the other)
// - archive stale session digests and abandoned todos
// - reinforce memories the agents keep using
import { inflateSync } from 'node:zlib';
import { existsSync, rmSync } from 'node:fs';
import { openDb, tx, corruptCopies } from './db.js';
import { hamming, fold } from './text.js';
import { sameMeaning, normTokens, contentTexts, addTombstones } from './store.js';
import { scrubTeamFile } from './portable.js';
import { config } from './config.js';
import { expireHeld } from './review.js'; // v2-guard
import { demoteIds, demotePass, maybeSleep } from './sleep.js';

const DAY = 86400000;

/**
 * Clock-jump guard (#10). Rows stamped in the future (the clock went back) are clamped to now so they expire
 * normally. When "now" is far past the newest recorded activity (the clock jumped forward, or a restored VM),
 * time-based expiry is skipped: it would otherwise wipe every event, vault output and todo at once.
 */
function clockGuard(db, t, dryRun) {
  const r = { clamped: 0, skewed: false };
  if (!dryRun) {
    for (const [tbl, col] of [['events', 'ts'], ['vault', 'created_at'], ['memories', 'updated_at'], ['memories', 'created_at'], ['injections', 'ts'], ['sessions', 'started_at']]) {
      r.clamped += db.prepare(`UPDATE ${tbl} SET ${col} = ? WHERE ${col} > ?`).run(t, t + DAY).changes;
    }
  }
  const newest = Math.max(db.prepare('SELECT COALESCE(MAX(ts), 0) m FROM events').get().m, db.prepare('SELECT COALESCE(MAX(updated_at), 0) m FROM memories').get().m);
  if (newest && t - newest > 365 * DAY) r.skewed = true;
  return r;
}

export function gc({ dryRun = false, light = false, force = false } = {}) {
  const cfg = config();
  const db = openDb();
  const t = Date.now();
  const day = DAY;
  const report = { events: 0, vault: 0, ledger: 0, merged: 0, archivedSessions: 0, archivedTodos: 0, reinforced: 0 };

  const run = (sql, ...args) => (dryRun ? 0 : db.prepare(sql).run(...args).changes);
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;
  const guard = clockGuard(db, t, dryRun);
  report.clamped = guard.clamped;
  if (guard.skewed && !force) { report.skipped = 'clock jumped >1 year past the newest activity; run `sam gc --force` if the date is right'; return report; }

  report.events = dryRun ? count('SELECT COUNT(*) c FROM events WHERE ts < ?', t - cfg.eventRetentionDays * day)
    : run('DELETE FROM events WHERE ts < ?', t - cfg.eventRetentionDays * day);
  report.vault = dryRun ? count('SELECT COUNT(*) c FROM vault WHERE created_at < ?', t - cfg.vaultRetentionDays * day)
    : run('DELETE FROM vault WHERE created_at < ?', t - cfg.vaultRetentionDays * day);
  report.ledger = dryRun ? 0 : run('DELETE FROM injections WHERE ts < ?', t - 7 * day);
  // the first prompt of old sessions is raw user text: expire it with the events it came from
  if (!dryRun) run('UPDATE sessions SET first_prompt = NULL WHERE started_at < ? AND first_prompt IS NOT NULL', t - cfg.eventRetentionDays * day);
  // time-bound reminders ("yarın toplantı var") retire after two days
  if (!dryRun) report.archivedTodos += run("UPDATE memories SET superseded_by = 'archived' WHERE kind = 'todo' AND superseded_by IS NULL AND pinned = 0 AND (' ' || tags || ' ') LIKE '% ephemeral %' AND updated_at < ?", t - 2 * day);

  // keep the 30 most recent digests per project live; older unused ones are archived
  for (const { project } of db.prepare("SELECT DISTINCT project FROM memories WHERE kind = 'session'").all()) {
    const old = db.prepare(
      `SELECT id FROM memories WHERE project = ? AND kind = 'session' AND superseded_by IS NULL AND pinned = 0
       ORDER BY updated_at DESC LIMIT -1 OFFSET 30`
    ).all(project);
    if (dryRun) { report.archivedSessions += old.length; continue; }
    if (cfg.demote) { report.demoted = (report.demoted || 0) + demoteIds(db, old.map((o) => o.id), t); continue; } // P2: low tier, not archived
    for (const o of old) report.archivedSessions += run("UPDATE memories SET superseded_by = 'archived' WHERE id = ?", o.id);
  }
  if (cfg.demote) { // P2 (flag demote): unused memories (old todos included) drop to a low tier instead of being archived
    const r = demotePass({ dryRun, t });
    report.demoted = (report.demoted || 0) + r.demoted;
    report.restored = r.restored;
  } else report.archivedTodos += (dryRun ? (sql, ...a) => count(sql.replace("UPDATE memories SET superseded_by = 'archived' WHERE", 'SELECT COUNT(*) c FROM memories WHERE'), ...a) : run)(
    "UPDATE memories SET superseded_by = 'archived' WHERE kind = 'todo' AND superseded_by IS NULL AND pinned = 0 AND updated_at < ? AND COALESCE(last_access, 0) < ?",
    t - 60 * day, t - 30 * day
  );

  report.expiredHeld = dryRun ? 0 : expireHeld(); // v2-guard: unreviewed pending/quarantined rows past reviewExpireDays
  report.meta = pruneMeta(db, t, { dryRun, retentionDays: cfg.eventRetentionDays });
  if (light) return report;

  // near-duplicate sweep (same project + kind). LSH: 4 bands of 16 bits; two hashes within
  // Hamming distance 3 must share at least one band (pigeonhole), so only bucket-mates are compared.
  const groups = db.prepare("SELECT project, kind FROM memories WHERE superseded_by IS NULL AND status = 'active' AND kind != 'session' GROUP BY project, kind HAVING COUNT(*) > 1").all();
  for (const g of groups) {
    const rows = db.prepare(
      "SELECT id, simhash, gist, body, importance, pinned, access_count, updated_at FROM memories WHERE project = ? AND kind = ? AND superseded_by IS NULL AND status = 'active' ORDER BY pinned DESC, (source = 'user') DESC, importance DESC, access_count DESC, updated_at DESC"
    ).all(g.project, g.kind);
    const rank = new Map(rows.map((r, i) => [r.id, i]));
    const buckets = new Map();
    for (const r of rows) {
      if (!r.simhash) continue;
      const h = r.simhash.padStart(16, '0');
      for (let b = 0; b < 4; b++) {
        const key = b + ':' + h.slice(b * 4, b * 4 + 4);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      }
    }
    const dead = new Set();
    const pairs = new Set();
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          let [a, c] = [list[i], list[j]];
          if (rank.get(a.id) > rank.get(c.id)) [a, c] = [c, a]; // a = the stronger memory
          const pk = a.id + '|' + c.id;
          if (pairs.has(pk) || dead.has(a.id) || dead.has(c.id)) continue;
          pairs.add(pk);
          // two-stage: SimHash candidate, then same words + same polarity / negation (store.sameMeaning)
          if (hamming(a.simhash, c.simhash) <= 3 && sameMeaning(a.gist, c.gist, { aFull: a.gist + ' ' + (a.body || ''), bFull: c.gist + ' ' + (c.body || '') })) {
            dead.add(c.id);
            if (!dryRun) tx((d) => {
              d.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(a.id, c.id);
              d.prepare('UPDATE memories SET access_count = access_count + ? WHERE id = ?').run(c.access_count, a.id);
            });
            report.merged++;
          }
        }
      }
    }
  }

  // reinforcement: memories fetched often in the last 30 days gain +0.05, at most once per 30 days (capped)
  const hot = db.prepare(
    'SELECT id FROM memories WHERE superseded_by IS NULL AND access_count >= 5 AND importance < 0.95 AND last_access > ?'
  ).all(t - 30 * day);
  for (const { id } of hot) {
    const k = 'reinforced:' + id;
    const last = Number(db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v || 0);
    if (t - last < 30 * day) continue;
    report.reinforced++;
    if (dryRun) continue;
    db.prepare('UPDATE memories SET importance = MIN(0.95, importance + 0.05) WHERE id = ?').run(id);
    db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(t));
  }

  if (!dryRun) {
    db.exec("INSERT INTO mem_fts(mem_fts) VALUES('optimize'); INSERT INTO mem_tri(mem_tri) VALUES('optimize');");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }
  return report;
}

/**
 * Per-session and per-memory meta keys grow with every session / memory; drop the ones whose owner is gone.
 * - fixpush:<ledger>, needcard:<ledger>: only meaningful while the session runs → kept while the session was active in
 *   the last 7 days (sessions row or an injection-ledger entry); a ledger is "<session>" or "<session>/<subagent>".
 * - route:<session>, tjson:<session>: harvest routing / offsets → kept while the session is within event retention;
 *   keys for unknown sessions (tjson keyed by transcript path) are left alone.
 * - guard:<id>, reinforced:<id>, demoted:<id>: dropped once the memory row no longer exists.
 */
function pruneMeta(db, t, { dryRun = false, retentionDays = 30 } = {}) {
  const lastActive = db.prepare('SELECT COALESCE(ended_at, started_at) a FROM sessions WHERE id = ?');
  const injected = db.prepare('SELECT 1 FROM injections WHERE session = ? AND ts > ? LIMIT 1');
  const memExists = db.prepare('SELECT 1 FROM memories WHERE id = ?');
  const del = db.prepare('DELETE FROM meta WHERE k = ?');
  let n = 0;
  const drop = (k) => { n++; if (!dryRun) del.run(k); };
  for (const { k } of db.prepare("SELECT k FROM meta WHERE k LIKE 'fixpush:%' OR k LIKE 'needcard:%'").all()) {
    const ledger = k.slice(k.indexOf(':') + 1);
    const sid = ledger.split('/')[0];
    const a = lastActive.get(sid)?.a;
    if (a != null && a > t - 7 * DAY) continue;
    if (injected.get(ledger, t - 7 * DAY)) continue;
    drop(k);
  }
  for (const { k } of db.prepare("SELECT k FROM meta WHERE k LIKE 'route:%' OR k LIKE 'tjson:%'").all()) {
    const a = lastActive.get(k.slice(k.indexOf(':') + 1))?.a;
    if (a != null && a < t - retentionDays * DAY) drop(k);
  }
  for (const { k } of db.prepare("SELECT k FROM meta WHERE k LIKE 'guard:%' OR k LIKE 'reinforced:%' OR k LIKE 'demoted:%'").all()) {
    if (!memExists.get(k.slice(k.indexOf(':') + 1))) drop(k);
  }
  return n;
}

/**
 * Lightweight automatic gc (#9): at most once per 24 h across all processes. The claim is an atomic
 * compare-and-set on meta('gc:auto') inside BEGIN IMMEDIATE, so parallel SessionStart hooks run it once.
 */
export function maybeAutoGc({ every = DAY } = {}) {
  const db = openDb();
  const t = Date.now();
  const last = Number(db.prepare("SELECT v FROM meta WHERE k = 'gc:auto'").get()?.v || 0);
  if (last && last <= t && t - last < every) return null; // a last-run "in the future" (clock went back) is stale
  let claimed = false;
  tx((d) => {
    const cur = Number(d.prepare("SELECT v FROM meta WHERE k = 'gc:auto'").get()?.v || 0);
    if (cur && cur <= t && t - cur < every) return;
    d.prepare("INSERT INTO meta(k, v) VALUES ('gc:auto', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(t));
    claimed = true;
  });
  if (!claimed) return null;
  const r = gc({ light: true });
  if (config().sleep) r.sleep = maybeSleep({ every, t }); // P2 (flag sleep): consolidation at most once a day
  return r;
}

// ---------- sam purge: erase content from every table (GDPR Art. 17 / KVKK Art. 7) ----------

// Contiguous token-sequence containment on the same normalization tombstones use (case, diacritics, whitespace,
// punctuation insensitive), plus a plain folded substring check for needles with symbols ("ali@x.com").
function containsSeq(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
function matcher(needles) {
  const seqs = needles.map((n) => ({ toks: normTokens(n), raw: fold(n).trim() })).filter((n) => n.toks.length);
  return (text) => {
    if (!text || !seqs.length) return false;
    const s = String(text);
    const toks = normTokens(s);
    const f = fold(s);
    return seqs.some((n) => containsSeq(toks, n.toks) || (n.raw.length >= 4 && f.includes(n.raw)));
  };
}

/**
 * Erase content everywhere SAM keeps it. Selectors (one or more):
 *   ids        memory ids (with the older versions they superseded)
 *   match      text: every memory, raw event, session first prompt, vault output, handoff and team-file line containing it
 *   project    a project id: all of its rows in every table
 * Memory-derived needles (the gist / full sentence of each erased memory, ≥ 3 words or ≥ 12 chars) are also
 * scrubbed from events, first prompts, vault outputs, handoffs, digests and the team file.
 * tombstone: write fingerprints (exact for erased memories, substring for `match`) so capture / saveMemory can
 * never re-create the content. `project` purges only fingerprint with tombstoneProject: true.
 * Afterwards: FTS optimize, VACUUM, WAL checkpoint(TRUNCATE). dryRun: count only (the transaction is rolled back).
 * includeBackups: also delete sam.db.corrupt-* copies (they hold old content and are never scrubbed).
 */
export function purge({ ids = [], match = null, project = null, tombstone = true, tombstoneProject = false, dryRun = false, includeBackups = false, teamFiles = true } = {}) {
  const db = openDb();
  const report = { memories: 0, events: 0, sessions: 0, vault: 0, injections: 0, handoffs: 0, meta: 0, projects: 0, stats: 0, tombstones: 0, teamFiles: [], backups: [], backupsDeleted: 0, vacuum: false, ids: [] };
  if (!ids.length && !match && !project) throw new Error('purge: nothing selected');
  const needles = match ? [String(match)] : [];
  const touchedProjects = new Set();
  let hitText = () => false;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1) target memories
    const target = new Map();
    const getRow = db.prepare('SELECT id, project, kind, gist, body, tags, files FROM memories WHERE id = ?');
    for (const raw of ids) { const r = getRow.get(String(raw).replace(/^#/, '')); if (r) target.set(r.id, r); }
    // superseded chains: every older version this memory (transitively) replaced
    let frontier = [...target.keys()];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) for (const r of db.prepare('SELECT id, project, kind, gist, body, tags, files FROM memories WHERE superseded_by = ?').all(id)) {
        if (!target.has(r.id)) { target.set(r.id, r); next.push(r.id); }
      }
      frontier = next;
    }
    if (project) for (const r of db.prepare('SELECT id, project, kind, gist, body, tags, files FROM memories WHERE project = ?').all(project)) target.set(r.id, r);
    // content needles from what is being erased (short gists like "done" would erase unrelated rows: skipped)
    for (const r of target.values()) {
      if (r.project === project) continue; // whole-project purge deletes by project, not by content
      for (const x of contentTexts(r)) {
        // the value of a "subject: value" memory is the content (a prompt said the value, not the subject key)
        const val = x.includes(': ') ? x.slice(x.indexOf(': ') + 2) : null;
        for (const y of [x, val]) if (y && (normTokens(y).length >= 3 || y.length >= 12)) needles.push(y);
      }
    }
    hitText = matcher(needles);
    // every memory (any kind, any project) whose text contains a needle: digests quoting it, other versions
    if (needles.length) {
      for (const r of db.prepare('SELECT id, project, kind, gist, body, tags, files FROM memories').iterate()) {
        if (!target.has(r.id) && hitText([r.gist, r.body, r.tags, r.files].join('\n'))) target.set(r.id, r);
      }
    }
    const dead = [...target.keys()];
    report.ids = dead;
    for (const r of target.values()) touchedProjects.add(r.project);

    // 2) tombstones before the text goes
    if (tombstone) {
      for (const r of target.values()) {
        if (r.project === project && !tombstoneProject) continue;
        if (r.kind === 'session') continue; // digests are rebuilt from scrubbed activity, not refused
        report.tombstones += addTombstones(db, r.project, contentTexts(r));
      }
      if (match) report.tombstones += addTombstones(db, 'global', [String(match)], { substring: true });
    }

    // 3) memories (+ FTS via triggers), injection ledger, reinforcement keys
    const delMem = db.prepare('DELETE FROM memories WHERE id = ?');
    const delInj = db.prepare('DELETE FROM injections WHERE mem_id = ?');
    const delMeta = db.prepare('DELETE FROM meta WHERE k = ?');
    for (const id of dead) {
      report.memories += delMem.run(id).changes;
      report.injections += delInj.run(id).changes;
      report.meta += delMeta.run('reinforced:' + id).changes;
      // rows a deleted memory had replaced (and that survive) stay retired, never dangling
      db.prepare("UPDATE memories SET superseded_by = 'archived' WHERE superseded_by = ?").run(id);
      db.prepare('UPDATE sessions SET digest_id = NULL WHERE digest_id = ?').run(id);
    }

    // 4) raw events, session first prompts, vault outputs, handoffs
    if (project) {
      report.events += db.prepare('DELETE FROM events WHERE project = ?').run(project).changes;
      report.vault += db.prepare('DELETE FROM vault WHERE project = ?').run(project).changes;
      report.handoffs += db.prepare('DELETE FROM handoffs WHERE project = ?').run(project).changes;
      const sids = db.prepare('SELECT id FROM sessions WHERE project = ?').all(project).map((r) => r.id);
      for (const sid of sids) { report.injections += db.prepare('DELETE FROM injections WHERE session = ?').run(sid).changes; report.meta += delMeta.run('route:' + sid).changes; }
      report.sessions += db.prepare('DELETE FROM sessions WHERE project = ?').run(project).changes;
      report.meta += db.prepare("DELETE FROM meta WHERE k IN (?, ?) OR k LIKE ? ESCAPE '\\' OR k LIKE ? ESCAPE '\\' OR (k LIKE 'route:%' AND v = ?)")
        .run('team:' + project, 'teamtexts:' + project, 'teamline:' + likeEsc(project) + ':%', 'teamtext:' + likeEsc(project) + ':%', project).changes;
      report.stats += db.prepare('DELETE FROM stats WHERE project = ?').run(project).changes;
      report.projects += db.prepare('DELETE FROM projects WHERE id = ?').run(project).changes;
    }
    if (needles.length) {
      const delEv = db.prepare('DELETE FROM events WHERE id = ?');
      for (const e of db.prepare('SELECT id, subject, detail FROM events').all()) if (hitText(e.detail) || hitText(e.subject)) report.events += delEv.run(e.id).changes;
      const nullFp = db.prepare('UPDATE sessions SET first_prompt = NULL WHERE id = ?');
      for (const r of db.prepare('SELECT id, first_prompt FROM sessions WHERE first_prompt IS NOT NULL').all()) if (hitText(r.first_prompt)) report.sessions += nullFp.run(r.id).changes;
      const delV = db.prepare('DELETE FROM vault WHERE id = ?');
      for (const v of db.prepare('SELECT id, cmd, output FROM vault').all()) {
        let out = '';
        try { out = v.output ? inflateSync(Buffer.from(v.output)).toString('utf8') : ''; } catch { out = ''; }
        if (hitText(v.cmd) || hitText(out)) report.vault += delV.run(v.id).changes;
      }
      const delH = db.prepare('DELETE FROM handoffs WHERE id = ?');
      for (const h of db.prepare('SELECT id, summary, open_items, files FROM handoffs').all()) if (hitText([h.summary, h.open_items, h.files].join('\n'))) report.handoffs += delH.run(h.id).changes;
      // the team sync keeps the texts it last imported (to propagate deletions): drop purged ones
      for (const m of db.prepare("SELECT k, v FROM meta WHERE k LIKE 'teamtexts:%'").all()) {
        let list; try { list = JSON.parse(m.v); } catch { continue; }
        if (!Array.isArray(list)) continue;
        const keep = list.filter((x) => !hitText(x));
        if (keep.length !== list.length) { db.prepare('UPDATE meta SET v = ? WHERE k = ?').run(JSON.stringify(keep), m.k); report.meta++; }
      }
    }
    if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* noop */ } throw e; }

  // 5) team files SAM writes (<root>/.sam/memory.md): drop matching bullets (git history still has them)
  if (teamFiles && needles.length) {
    const roots = match
      ? db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL').all()
      : db.prepare('SELECT id, root FROM projects WHERE root IS NOT NULL').all().filter((p) => touchedProjects.has(p.id));
    for (const p of roots) {
      try {
        const n = scrubTeamFile(p, hitText, { dryRun });
        if (n) report.teamFiles.push({ file: p.root + '/.sam/memory.md', removed: n });
      } catch (e) { report.teamFiles.push({ file: p.root + '/.sam/memory.md', error: e.message }); }
    }
  }

  // 6) backups: sam.db.corrupt-* copies hold old content and are never scrubbed
  report.backups = corruptCopies(config().dbPath);
  if (includeBackups && !dryRun) {
    for (const f of report.backups) {
      for (const x of [f, f + '-wal', f + '-shm']) { try { if (existsSync(x)) { rmSync(x, { force: true }); if (x === f) report.backupsDeleted++; } } catch { /* reported below */ } }
      try { db.prepare('DELETE FROM meta WHERE k = ?').run('salvaged:' + f); } catch { /* noop */ }
    }
    report.backups = corruptCopies(config().dbPath);
  }

  // 7) make the deleted text unrecoverable from the file: merge FTS segments, rewrite the DB, truncate the WAL
  if (!dryRun) {
    try { db.exec("INSERT INTO mem_fts(mem_fts) VALUES('optimize'); INSERT INTO mem_tri(mem_tri) VALUES('optimize');"); } catch { /* noop */ }
    try { db.exec('PRAGMA secure_delete=ON;'); db.exec('VACUUM;'); report.vacuum = true; } catch (e) { report.vacuumError = String(e.message || e); }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* another process holds the WAL */ }
  }
  return report;
}

const likeEsc = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
