// Portability: Markdown (human/git-friendly, team-shareable) and JSONL (lossless backup).
// Team memory: commit `.sam/memory.md`; a teammate reviews and trusts it (`sam trust`), and SAM imports exactly the
// content that was reviewed. A later change to the file needs a new review.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, tx } from './db.js';
import { saveMemory, KINDS, normKind } from './store.js';
import { guardImported } from './guard.js'; // v2-guard
import { sha, topicOf, simhash, hamming, oneLine, sanitize, redact } from './text.js';

const TAG_TO_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.tag.toLowerCase(), k]));
// personal kinds never go to a shared file (one user's "answer me in bullet points" is not a team convention)
const PERSONAL = new Set(['preference', 'session']);
const MAX_TEAM_FILE = 1024 * 1024;

const bulletOf = (m) => `- [${KINDS[m.kind].tag}] ${m.gist}${m.pinned ? ' 📌' : ''}${m.files ? ` {${m.files}}` : ''}`;

export function exportMarkdown(projectId, { includeSessions = false, team = false } = {}) {
  const rows = openDb().prepare(
    `SELECT * FROM memories WHERE superseded_by IS NULL AND status = 'active' AND project = ? ${includeSessions && !team ? '' : "AND kind != 'session'"}
     ORDER BY kind, pinned DESC, importance DESC, updated_at DESC`
  ).all(projectId).filter((m) => !team || !PERSONAL.has(m.kind));
  const by = new Map();
  for (const m of rows) { if (!by.has(m.kind)) by.set(m.kind, []); by.get(m.kind).push(m); }
  const out = ['# Project memory', '', '<!-- managed by super-agent-memory (sam). One memory per bullet: "- [tag] text". Edit freely; teammates review changes with `sam trust`. -->', ''];
  for (const k of Object.keys(KINDS)) {
    const list = by.get(k);
    if (!list?.length) continue;
    out.push(`## ${k}`, '');
    for (const m of list) {
      out.push(bulletOf(m));
      if (m.body && m.body !== m.gist) for (const l of m.body.split('\n').slice(0, 8)) out.push('  > ' + l);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Parse the bullets of a memory markdown file (CRLF tolerant). */
export function parseMarkdown(md) {
  let kindCtx = 'note';
  const items = [];
  let last = null;
  for (const raw0 of String(md).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const raw = raw0.replace(/\r$/, '');
    const h = raw.match(/^##\s+([\p{L}\w-]+)/u);
    if (h) { last = null; kindCtx = normKind(h[1]); continue; }
    const q = raw.match(/^\s+>\s?(.*)$/);
    if (q && last) { last.body.push(q[1]); continue; }
    const b = raw.match(/^\s*[-*]\s+(?:\[([\w]+)\]\s*)?(.+)$/);
    if (b) {
      let text = b[2].trim();
      const pin = /📌/.test(text);
      text = text.replace(/📌/g, '').replace(/\s+#[0-9a-z]{4,12}\s*$/, '').trim(); // only a trailing id, never "#region"
      last = null;
      let files = [];
      const f = text.match(/\s*\{([^}]+)\}\s*$/);
      if (f) { files = f[1].split(/\s+/).filter(Boolean); text = text.slice(0, f.index).trim(); }
      const tag = b[1] ? b[1].toLowerCase() : null;
      const kind = tag ? (Object.hasOwn(TAG_TO_KIND, tag) ? TAG_TO_KIND[tag] : normKind(tag)) : kindCtx;
      if (text.length >= 3) { last = { kind, text, body: [], files, pin, line: raw.trim() }; items.push(last); }
    }
  }
  return items;
}

/**
 * team: untrusted-by-default content from a repo → never pinned, importance capped, tagged 'team';
 * skip(): lets the team sync drop lines it already imported, forgotten ones, and stale values.
 * trusted: a plain `sam import --trusted` may keep 📌 pins; otherwise imports never pin.
 * Returns the number of memories written; `.parsed` on the function result object is not used, see importMarkdownEx.
 */
export function importMarkdown(projectId, md, opts = {}) {
  return importMarkdownEx(projectId, md, opts).n;
}

export function importMarkdownEx(projectId, md, { source = 'import', team = false, skip, trusted = false } = {}) {
  let n = 0;
  const items = parseMarkdown(md);
  for (const it of items) {
    let text = it.text, body = it.body.join('\n');
    // an exported gist is truncated with "…"; its body holds the full sentence → restore it (no duplicate)
    if (text.endsWith('…') && body && oneLine(body).startsWith(text.slice(0, -1).trim())) { text = oneLine(body); body = ''; }
    if (team && PERSONAL.has(it.kind)) continue;
    // an unchanged exported line (same kind + gist already live) is not a new memory
    const same = openDb().prepare('SELECT 1 FROM memories WHERE project = ? AND kind = ? AND gist = ? AND superseded_by IS NULL').get(projectId, it.kind, it.text);
    if (same || skip?.({ ...it, text, body })) continue;
    try {
      const r = saveMemory({ project: projectId, kind: it.kind, text, body, files: it.files, source: team ? 'team' : source,
        pin: !team && trusted && it.pin, importance: team ? Math.min(KINDS[it.kind].importance, 0.5) : undefined, tags: team ? ['team'] : [] });
      if (r.status === 'created' || r.status === 'superseded') n++;
    } catch { /* one bad line never blocks the rest */ }
  }
  return { n, parsed: items.length };
}

export function exportJsonl(projectId) {
  const rows = openDb().prepare(`SELECT * FROM memories ${projectId ? 'WHERE project = ?' : ''} ORDER BY created_at`).all(...(projectId ? [projectId] : []));
  return rows.map(({ rowid, embedding, ...m }) => JSON.stringify(m)).join('\n') + '\n';
}

/**
 * Restore a JSONL backup. Untrusted by default (S15): every row is source 'import', never pinned, and rows
 * aimed at 'global' or another project land in `projectId` (the current project). `trusted` (a backup the user
 * made themselves, `sam import --trusted`) keeps project, pins and provenance.
 */
export function importJsonl(text, { projectId = 'global', trusted = false } = {}) {
  const db = openDb();
  return tx(() => importJsonlInner(db, text, { projectId, trusted }));
}
function importJsonlInner(db, text, { projectId, trusted }) {
  let n = 0;
  const cols = ['id', 'project', 'kind', 'gist', 'body', 'tags', 'files', 'topic', 'importance', 'pinned', 'agent', 'source', 'session', 'simhash', 'superseded_by', 'created_at', 'updated_at', 'last_access', 'access_count'];
  const st = db.prepare(`INSERT OR IGNORE INTO memories(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const t = Date.now();
  for (const l of String(text).split(/\r?\n/)) {
    if (!l.trim()) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; } // skip a corrupt line, keep the rest
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.gist !== 'string' || !m.gist.trim()) continue;
    const v = (c) => (typeof m[c] === 'string' || typeof m[c] === 'number' ? m[c] : null);
    const row = Object.fromEntries(cols.map((c) => [c, v(c)]));
    // v1 backups: `source` held the agent name
    if (row.agent == null && row.source && !['user', 'agent', 'auto', 'team', 'import'].includes(row.source)) { row.agent = row.source; row.source = null; }
    row.kind = normKind(row.kind);
    row.importance = Number.isFinite(row.importance) ? Math.max(0, Math.min(1, row.importance)) : 0.5;
    row.access_count = Number.isFinite(row.access_count) ? row.access_count : 0;
    row.created_at = Number.isFinite(row.created_at) ? Math.min(row.created_at, t) : t;
    row.updated_at = Number.isFinite(row.updated_at) ? Math.min(row.updated_at, t) : t;
    if (!trusted) {
      row.project = projectId;
      row.pinned = 0;
      row.source = 'import';
      row.gist = redact(sanitize(row.gist)).slice(0, 300);
      row.body = redact(sanitize(row.body || ''));
    } else {
      row.pinned = row.pinned ? 1 : 0;
      row.project = row.project || projectId;
      row.source = row.source || 'import';
    }
    row.body ??= ''; row.tags ??= ''; row.files ??= '';
    const added = st.run(...cols.map((c) => row[c])).changes;
    if (added) guardImported(db, { ...row, status: m.status }, { trusted }); // v2-guard: JSONL rows bypass saveMemory
    n += added;
  }
  return n;
}

// ---------- trust: keyed on the canonical repo root + the reviewed content hash (S2, r25) ----------

const textKey = (pid, kind, text) => 'teamtext:' + pid + ':' + sha(kind + '|' + String(text).trim(), 16);
const trustKey = (project) => 'trustroot:' + sha(project.root || '', 16);
const normContent = (s) => String(s).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export const contentHash = (s) => sha(normContent(s), 16);

function trustRecord(project) {
  if (!project?.root) return null;
  try { const v = openDb().prepare('SELECT v FROM meta WHERE k = ?').get(trustKey(project))?.v; return v ? JSON.parse(v) : null; } catch { return null; }
}
export const isTrusted = (project) => !!trustRecord(project);

export function setTrusted(project, on = true, hash = null) {
  if (!project?.root) throw new Error('not inside a project');
  const db = openDb();
  if (!on) { db.prepare('DELETE FROM meta WHERE k = ?').run(trustKey(project)); return; }
  db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(trustKey(project), JSON.stringify({ root: project.root, hash, at: Date.now() }));
}

/** The team file, only if it is a regular file (never a symlink, FIFO or device) of sane size. */
export function readTeamFile(project) {
  if (!project?.root) return null;
  const dir = join(project.root, '.sam');
  const file = join(dir, 'memory.md');
  try {
    const d = lstatSync(dir);
    if (!d.isDirectory()) return null;
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_TEAM_FILE) return null;
    return { file, content: readFileSync(file, 'utf8'), mtime: st.mtimeMs };
  } catch { return null; }
}

/** What `sam trust` would import: count + first lines (S12 preview). */
export function previewTeamFile(project) {
  const tf = readTeamFile(project);
  if (!tf) return null;
  const items = parseMarkdown(tf.content).filter((it) => !PERSONAL.has(it.kind));
  return { file: tf.file, hash: contentHash(tf.content), count: items.length, lines: items.slice(0, 8).map((it) => `[${it.kind}] ${it.text}`) };
}

/**
 * Pull the reviewed `.sam/memory.md` into memory. Only when the user trusted THIS repo root and THIS content
 * (`sam trust` records its hash): a teammate's later edit, or a PR branch checked out for review, is not imported
 * until the user reviews it again. Only lines not imported before are applied; a value the user changed locally
 * after the file's mtime wins; a memory the user forgot stays forgotten.
 */
export function syncTeamFile(project) {
  if (!project?.root) return 0;
  const rec = trustRecord(project);
  if (!rec) return 0;
  const tf = readTeamFile(project);
  if (!tf) return 0;
  const content = normContent(tf.content);
  const h = sha(content, 16);
  if (rec.hash && rec.hash !== h) return 0; // changed since review: the card asks the user to review it
  const db = openDb();
  const key = 'team:' + project.id;
  if (db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v === h) return 0;
  const seenKey = (line) => 'teamline:' + project.id + ':' + sha(line, 16);
  const markSeen = db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)');
  const skip = (m) => {
    if (db.prepare('SELECT 1 FROM meta WHERE k = ?').get(seenKey(m.line))) return true;
    markSeen.run(seenKey(m.line), '1');
    markSeen.run(textKey(project.id, m.kind, m.text), '1');
    const tp = topicOf(m.kind, m.text);
    if (tp && db.prepare('SELECT 1 FROM memories WHERE project = ? AND topic = ? AND superseded_by IS NULL AND updated_at > ?').get(project.id, tp, tf.mtime)) return true;
    const sh = simhash(m.text);
    if (sh) for (const f of db.prepare("SELECT simhash FROM memories WHERE project = ? AND superseded_by = 'forgotten'").all(project.id)) if (f.simhash && hamming(f.simhash, sh) <= 3) return true;
    return false;
  };
  const { n, parsed } = importMarkdownEx(project.id, content, { source: 'team', team: true, skip });
  // deletions propagate: a line that was in the previously imported file and is gone now retires its team memory
  const now = parseMarkdown(content).map((it) => it.text);
  const prevKey = 'teamtexts:' + project.id;
  let prev = [];
  try { prev = JSON.parse(db.prepare('SELECT v FROM meta WHERE k = ?').get(prevKey)?.v || '[]'); } catch { prev = []; }
  const keep = new Set(now);
  // (the user reviewed this content with `sam trust`, so their own unpinned copy of a removed line retires too)
  for (const t of prev) if (!keep.has(t)) db.prepare("UPDATE memories SET superseded_by = 'team-removed' WHERE project = ? AND gist = ? AND pinned = 0 AND superseded_by IS NULL").run(project.id, t);
  db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(prevKey, JSON.stringify(now.slice(0, 2000)));
  // H2: a file that yielded no bullets at all (wrong format) is not recorded as imported, so a fixed file is retried
  if (parsed > 0 || !/^\s*[-*]\s+/m.test(content)) db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, h);
  return n;
}

/**
 * `sam export --team`: MERGE this project's memories into <root>/.sam/memory.md.
 * - hand edits in the file are preserved; lines are only appended (or dropped when that exact memory was retired here)
 * - a line a teammate deleted is not re-added (every line ever exported/imported is remembered: a tombstone)
 * - personal kinds (preferences) and session digests are never exported
 * - symlinks are refused (S7) and the file is written to a temp file + rename in the same directory
 * - exporting never marks the repo trusted
 */
export function writeTeamFile(project) {
  if (!project?.root) throw new Error('not inside a project');
  const dir = join(project.root, '.sam');
  const file = join(dir, 'memory.md');
  try { if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory (symlink?): refusing to write`); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory: refusing to write`);
  }
  let existing = '';
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw new Error(`${file} is not a regular file (symlink?): refusing to write`);
    existing = normContent(readFileSync(file, 'utf8'));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const db = openDb();
  const before = contentHash(existing);
  const seenKey = (line) => 'teamline:' + project.id + ':' + sha(line, 16);
  const seen = (m, line) => !!db.prepare('SELECT 1 FROM meta WHERE k = ? OR k = ?').get(seenKey(line), textKey(project.id, m.kind, m.gist));
  const appended = [];

  let md;
  if (!existing.trim()) {
    md = exportMarkdown(project.id, { team: true });
    appended.push(...db.prepare("SELECT kind, gist FROM memories WHERE superseded_by IS NULL AND status = 'active' AND project = ? AND kind != 'session'").all(project.id).filter((m) => !PERSONAL.has(m.kind)));
  } else {
    const lines = existing.split('\n');
    // drop bullets of memories that were retired HERE (superseded / forgotten); everything else stays as written
    const retired = new Set(db.prepare("SELECT gist FROM memories WHERE project = ? AND superseded_by IS NOT NULL AND superseded_by != 'archived'").all(project.id).map((r) => r.gist));
    const live = new Set(db.prepare('SELECT gist FROM memories WHERE project = ? AND superseded_by IS NULL').all(project.id).map((r) => r.gist));
    const kept = [];
    let dropping = false;
    for (const l of lines) {
      const b = l.match(/^\s*[-*]\s+(?:\[[\w]+\]\s*)?(.+)$/);
      if (b) {
        const text = b[1].replace(/📌/g, '').replace(/\s*\{[^}]+\}\s*$/, '').trim();
        dropping = retired.has(text) && !live.has(text);
        if (dropping) continue;
      } else if (dropping && /^\s+>/.test(l)) continue;
      else dropping = false;
      kept.push(l);
    }
    const present = new Set(parseMarkdown(kept.join('\n')).map((it) => it.text));
    const rows = db.prepare("SELECT * FROM memories WHERE superseded_by IS NULL AND status = 'active' AND project = ? AND kind != 'session' ORDER BY kind, pinned DESC, importance DESC, updated_at DESC").all(project.id)
      .filter((m) => !PERSONAL.has(m.kind) && !present.has(m.gist));
    const add = new Map();
    for (const m of rows) {
      const bl = bulletOf(m);
      if (seen(m, bl)) continue; // it was in the file once and a teammate removed it: stays removed
      appended.push(m);
      if (!add.has(m.kind)) add.set(m.kind, []);
      add.get(m.kind).push(bl);
      if (m.body && m.body !== m.gist) for (const x of m.body.split('\n').slice(0, 8)) add.get(m.kind).push('  > ' + x);
    }
    for (const [k, list] of add) {
      const hi = kept.findIndex((l) => new RegExp(`^##\\s+${k}\\b`).test(l));
      if (hi < 0) { if (kept.length && kept[kept.length - 1].trim()) kept.push(''); kept.push(`## ${k}`, '', ...list, ''); continue; }
      let j = hi + 1;
      while (j < kept.length && !/^##\s/.test(kept[j])) j++;
      while (j > hi + 1 && !kept[j - 1].trim()) j--;
      kept.splice(j, 0, ...list);
    }
    md = kept.join('\n');
  }
  // atomic write in the same directory; rename replaces a link instead of following it
  const tmp = join(dir, `.memory.md.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  closeSync(fd);
  writeFileSync(tmp, md);
  try {
    try { if (!lstatSync(file).isFile()) throw new Error(`${file} changed into a non-regular file: refusing to write`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    renameSync(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch { /* noop */ } throw e; }
  // only what WE wrote is remembered as published (a teammate's hand-edited line stays importable)
  const mark = db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)');
  for (const m of appended) { mark.run(seenKey(bulletOf(m)), '1'); mark.run(textKey(project.id, m.kind, m.gist), '1'); }
  db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('teamtexts:' + project.id, JSON.stringify(parseMarkdown(md).map((it) => it.text).slice(0, 2000)));
  const after = contentHash(md);
  db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('team:' + project.id, after);
  // a repo the user already trusted at exactly the previous content stays trusted at the content they just wrote
  const rec = trustRecord(project);
  if (rec && (rec.hash === before || !existing.trim())) setTrusted(project, true, after);
  return file;
}


/**
 * `sam purge`: drop every bullet (and its "  >" body lines) of <root>/.sam/memory.md for which `hit(text)` is true.
 * Same safety as writeTeamFile: regular files only, temp file + rename. Returns the number of bullets removed.
 * Git history still holds the old content: the caller tells the user.
 */
export function scrubTeamFile(project, hit, { dryRun = false } = {}) {
  if (!project?.root) return 0;
  const root = project.root;
  const tf = readTeamFile(project);
  if (!tf) return 0;
  const lines = normContent(tf.content).split('\n');
  const kept = [];
  let removed = 0, dropping = false;
  for (const l of lines) {
    const b = l.match(/^\s*[-*]\s+(?:\[[\w]+\]\s*)?(.+)$/);
    if (b) {
      dropping = hit(b[1]);
      if (dropping) { removed++; continue; }
    } else if (/^\s+>/.test(l)) {
      if (dropping) continue;
      if (hit(l.replace(/^\s+>\s?/, ''))) { removed++; continue; }
    } else dropping = false;
    kept.push(l);
  }
  if (!removed || dryRun) return removed;
  const dir = join(root, '.sam');
  const tmp = join(dir, `.memory.md.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  closeSync(fd);
  writeFileSync(tmp, kept.join('\n'));
  try {
    if (!lstatSync(tf.file).isFile()) throw new Error(`${tf.file} changed into a non-regular file: refusing to write`);
    renameSync(tmp, tf.file);
  } catch (e) { try { unlinkSync(tmp); } catch { /* noop */ } throw e; }
  // the user's own erasure: a repo trusted at the old content stays trusted at the scrubbed content
  const before = contentHash(tf.content), after = contentHash(kept.join('\n'));
  const rec = trustRecord(project);
  if (rec && rec.hash === before) setTrusted(project, true, after);
  if (project.id) {
    const db = openDb();
    if (db.prepare('SELECT v FROM meta WHERE k = ?').get('team:' + project.id)?.v === sha(normContent(tf.content), 16)) {
      db.prepare('UPDATE meta SET v = ? WHERE k = ?').run(sha(kept.join('\n'), 16), 'team:' + project.id);
    }
  }
  return removed;
}
