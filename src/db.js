// SQLite storage (node:sqlite, zero native dependencies). WAL mode so several
// agents (Claude Code, Codex, Gemini, OpenCode…) can read/write concurrently.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, statSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, SAM_HOME } from './config.js';
import { unsafeDbLocation } from './platform.js';

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,           -- stable hash of git remote or root path
  name TEXT NOT NULL,
  root TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,       -- short base36 handle shown to agents
  project TEXT NOT NULL,         -- project id or 'global'
  kind TEXT NOT NULL,            -- decision|convention|preference|fact|fix|bug|todo|note|session
  gist TEXT NOT NULL,            -- <= 110 chars (140 for an explicit gist), what gets injected
  body TEXT NOT NULL DEFAULT '', -- full detail, only returned by get()
  tags TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '',
  topic TEXT,                    -- normalized key; a new memory on the same topic supersedes the old one
  importance REAL NOT NULL DEFAULT 0.5,
  pinned INTEGER NOT NULL DEFAULT 0,
  agent TEXT,                    -- host agent / client that wrote it (claude, codex, cli…)
  source TEXT,                   -- provenance: user|agent|auto|team|import (only user rows may pin or override user/pinned rows)
  session TEXT,
  simhash TEXT,
  embedding BLOB,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|quarantined|pending (pending = awaiting sam review)
  valid_from INTEGER,            -- optional validity window (ms epoch); NULL = open
  valid_to INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_access INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mem_project ON memories(project, superseded_by);
CREATE INDEX IF NOT EXISTS mem_topic ON memories(project, topic);
CREATE INDEX IF NOT EXISTS mem_dedup ON memories(project, kind, superseded_by, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  gist, body, tags, files,
  content='memories', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_tri USING fts5(
  gist, body, files,
  content='memories', content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO mem_fts(rowid, gist, body, tags, files) VALUES (new.rowid, new.gist, new.body, new.tags, new.files);
  INSERT INTO mem_tri(rowid, gist, body, files) VALUES (new.rowid, new.gist, new.body, new.files);
END;
CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, gist, body, tags, files) VALUES ('delete', old.rowid, old.gist, old.body, old.tags, old.files);
  INSERT INTO mem_tri(mem_tri, rowid, gist, body, files) VALUES ('delete', old.rowid, old.gist, old.body, old.files);
END;
CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE OF gist, body, tags, files ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, gist, body, tags, files) VALUES ('delete', old.rowid, old.gist, old.body, old.tags, old.files);
  INSERT INTO mem_tri(mem_tri, rowid, gist, body, files) VALUES ('delete', old.rowid, old.gist, old.body, old.files);
  INSERT INTO mem_fts(rowid, gist, body, tags, files) VALUES (new.rowid, new.gist, new.body, new.tags, new.files);
  INSERT INTO mem_tri(rowid, gist, body, files) VALUES (new.rowid, new.gist, new.body, new.files);
END;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  agent TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  first_prompt TEXT,
  transcript TEXT,
  transcript_offset INTEGER NOT NULL DEFAULT 0,
  digest_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session TEXT,
  project TEXT,
  agent TEXT,
  type TEXT NOT NULL,            -- prompt|edit|cmd|read|tool|error
  subject TEXT,                  -- file path / normalized command
  ok INTEGER,
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ev_session ON events(session, ts);
CREATE INDEX IF NOT EXISTS ev_project ON events(project, ts);

-- What was already pushed into which session: never pay for the same memory twice.
CREATE TABLE IF NOT EXISTS injections (
  session TEXT NOT NULL,
  mem_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, mem_id)
);

-- Output vault: full command output stays here, the agent only sees a digest.
CREATE TABLE IF NOT EXISTS vault (
  id TEXT PRIMARY KEY,
  project TEXT,
  cmd TEXT,
  exit_code INTEGER,
  bytes INTEGER,
  shown_bytes INTEGER,
  output BLOB,
  created_at INTEGER NOT NULL
);

-- Fingerprints of purged/forgotten content: the text is gone, the hash blocks re-capture.
CREATE TABLE IF NOT EXISTS tombstones (
  fp TEXT PRIMARY KEY,
  project TEXT,
  created_at INTEGER NOT NULL
);

-- Agent-to-agent handoff records (one agent ends, another picks up).
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  from_agent TEXT,
  to_agent TEXT,
  session TEXT,
  summary TEXT NOT NULL,
  open_items TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS handoff_project ON handoffs(project, consumed_at, created_at);

CREATE TABLE IF NOT EXISTS stats (
  day TEXT NOT NULL,
  project TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project, metric)
);
`;

let db;
let dbFile = null; // { path, dev, ino } of the open file: a replaced/deleted DB is reopened (MCP is long-lived)
let readOnly = false;
export const dbState = { readOnly: false, movedAside: null, journal: 'WAL', sharedFs: null, newerSchema: null };

const errText = (e) => String(e?.message || e) + ' ' + (e?.errcode ?? '') + ' ' + (e?.code ?? '');
/** SQLITE_CORRUPT (11) / SQLITE_NOTADB (26): the file is not a usable database. Never "locked"/"busy". */
export const isCorrupt = (e) => [11, 26].includes(e?.errcode) || /file is not a database|database disk image is malformed|malformed database schema/i.test(errText(e));
// read-only file/dir, or no space left (SQLITE_IOERR 10 / SQLITE_FULL 13): fall back to a read-only connection
const isReadOnly = (e) => [8, 10, 13].includes(e?.errcode) || /readonly database|read-only|attempt to write a readonly|unable to open database file|disk I\/O error|database or disk is full|EACCES|EROFS|ENOSPC|EFBIG/i.test(errText(e));

function secureHome(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // only tighten SAM's own home, never a directory the user pointed SAM_DB_PATH into
  if (resolve(dir) === resolve(SAM_HOME)) { try { chmodSync(dir, 0o700); } catch { /* not ours / read-only */ } }
}

function fixModes(path) {
  for (const f of [path, path + '-wal', path + '-shm']) { try { if (existsSync(f)) chmodSync(f, 0o600); } catch { /* not ours */ } }
}

const V3_TABLES = SCHEMA.slice(SCHEMA.indexOf('-- Fingerprints of purged'), SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS stats ('));

export const schemaOf = (d) => Number(d.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v || 0);

function migrate(d) {
  const cols = () => d.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  const need2 = !cols().includes('agent');
  const need3 = !cols().includes('status') || !d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tombstones'").get();
  if (!need2 && !need3) return;
  d.exec('BEGIN IMMEDIATE');
  try {
    if (!cols().includes('agent')) { // v1 → v2: `source` held the agent name; it becomes provenance
      d.exec('ALTER TABLE memories RENAME COLUMN source TO agent; ALTER TABLE memories ADD COLUMN source TEXT;');
      d.exec(`UPDATE memories SET source = CASE WHEN agent = 'cli' THEN 'user' WHEN agent = 'team' THEN 'team' WHEN agent = 'import' THEN 'import'
        WHEN kind IN ('session', 'fix') THEN 'auto' ELSE 'agent' END`);
    }
    const c = cols(); // v2 → v3: status (quarantine/review), validity window, tombstones, handoffs
    if (!c.includes('status')) d.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!c.includes('valid_from')) d.exec('ALTER TABLE memories ADD COLUMN valid_from INTEGER');
    if (!c.includes('valid_to')) d.exec('ALTER TABLE memories ADD COLUMN valid_to INTEGER');
    d.exec(V3_TABLES);
    d.prepare("INSERT INTO meta(k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(SCHEMA_VERSION));
    d.exec('COMMIT');
  } catch (e) { try { d.exec('ROLLBACK'); } catch { /* noop */ } throw e; }
}

/** Thrown when the DB was written by a newer SAM: this binary must not write to it (it would corrupt fields it does not know). */
export class NewerSchemaError extends Error {
  constructor(found) { super(`this database uses schema ${found}, newer than this SAM (${SCHEMA_VERSION}); upgrade SAM. Opened read-only.`); this.found = found; this.code = 'SAM_NEWER_SCHEMA'; }
}

/**
 * WAL needs shared memory (-shm) and a -wal file that travel with sam.db. Network filesystems, WSL drvfs
 * and cloud-sync folders break that (lost commits, "database disk image is malformed"), so there SAM uses
 * the rollback journal instead. SAM_ALLOW_SHARED_FS=1 keeps WAL anyway (you know your mount is local).
 */
export function journalModeFor(dir, { env = process.env, detect = unsafeDbLocation } = {}) {
  if (env.SAM_ALLOW_SHARED_FS === '1') return { mode: 'WAL', unsafe: null };
  let unsafe = null;
  try { unsafe = detect(dir); } catch { unsafe = null; }
  return { mode: unsafe ? 'DELETE' : 'WAL', unsafe };
}

function openRW(path, journal = 'WAL') {
  const d = new DatabaseSync(path);
  try {
    // busy_timeout FIRST: switching a fresh DB to WAL takes a lock that parallel hooks would otherwise hit
    d.exec('PRAGMA busy_timeout=5000;');
    d.exec(`PRAGMA journal_mode=${journal === 'DELETE' ? 'DELETE' : 'WAL'}; PRAGMA synchronous=${journal === 'DELETE' ? 'FULL' : 'NORMAL'}; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;`);
    // read first: on an existing DB nothing here writes, so a held write lock (a long import / gc) cannot stall opening
    const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
    // schema guard: never migrate or write a DB from a newer SAM (an older binary would silently drop new fields)
    if (!fresh && d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
      const found = schemaOf(d);
      if (found > SCHEMA_VERSION) throw new NewerSchemaError(found);
    }
    if (fresh || !d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats'").get()) d.exec(SCHEMA);
    migrate(d);
    if (!d.prepare("SELECT 1 FROM meta WHERE k = 'schema'").get()) d.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
    return d;
  } catch (e) { try { d.close(); } catch { /* noop */ } throw e; }
}

function openRO(path) {
  const tryOpen = (p) => {
    const d = new DatabaseSync(p, { readOnly: true });
    try {
      d.exec('PRAGMA busy_timeout=2000;');
      d.prepare('SELECT 1 FROM memories LIMIT 1').get(); // fail now, not on the first query
      return d;
    } catch (e) { try { d.close(); } catch { /* noop */ } throw e; }
  };
  try { return tryOpen(path); } catch {
    // no room even for the -shm file (disk full / read-only dir): read the main file as immutable
    return tryOpen(pathToFileURL(path).href + '?immutable=1');
  }
}

/** Rename a broken DB (and its -wal/-shm) to sam.db.corrupt-<ts>; the caller recreates a fresh one. */
export function moveAside(path) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const to = `${path}.corrupt-${ts}`;
  renameSync(path, to);
  for (const s of ['-wal', '-shm']) { try { if (existsSync(path + s)) renameSync(path + s, to + s); } catch { /* noop */ } }
  return to;
}

export function openDb(path = config().dbPath) {
  if (db) return db;
  const mem = path === ':memory:';
  if (!mem) secureHome(dirname(path));
  const um = process.umask(0o077); // sam.db, -wal, -shm are created 0600
  readOnly = false;
  const jm = mem ? { mode: 'WAL', unsafe: null } : journalModeFor(dirname(path));
  dbState.journal = jm.mode;
  dbState.sharedFs = jm.unsafe;
  try {
    try {
      db = openRW(path, jm.mode);
    } catch (e) {
      if (!mem && isCorrupt(e) && existsSync(path)) {
        // unusable file: keep it for `sam doctor --repair` (salvage) and start fresh, so hooks keep working
        dbState.movedAside = moveAside(path);
        db = openRW(path, jm.mode);
      } else if (!mem && e?.code === 'SAM_NEWER_SCHEMA') {
        db = openRO(path); // reads still work; every write fails (hooks swallow it, the CLI reports it)
        readOnly = true;
        dbState.newerSchema = e.found;
      } else if (!mem && isReadOnly(e) && existsSync(path)) {
        db = openRO(path); // reads (cards, search) still work; writes fail and are swallowed by hooks
        readOnly = true;
      } else throw e;
    }
  } finally { process.umask(um); }
  dbState.readOnly = readOnly;
  if (!mem) {
    if (!readOnly) fixModes(path);
    try { const st = statSync(path); dbFile = { path, dev: st.dev, ino: st.ino }; } catch { dbFile = null; }
  }
  return db;
}

/** Long-lived processes (MCP): reopen when the DB file was deleted or replaced under us. */
export function reopenIfReplaced() {
  if (!db || !dbFile) return openDb();
  let same = false;
  try { const st = statSync(dbFile.path); same = st.ino === dbFile.ino && st.dev === dbFile.dev; } catch { same = false; }
  if (!same) { closeDb(); return openDb(dbFile.path); }
  return db;
}

export function closeDb() {
  if (db) { try { db.close(); } catch { /* noop */ } db = undefined; }
}

export function setBusyTimeout(ms) {
  try { openDb().exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(ms))};`); } catch { /* noop */ }
}

const TABLES = ['meta', 'projects', 'memories', 'sessions', 'events', 'injections', 'vault', 'stats', 'tombstones', 'handoffs'];
/**
 * Copy every readable row of `src` (a corrupt or old DB, opened read-only) into the open DB. Rows are read in
 * rowid windows; a window that hits a malformed page is bisected down to single rows, so one bad page costs
 * only its rows. FTS indexes are rebuilt by the insert triggers.
 */
export function salvage(src) {
  const out = openDb();
  const inp = new DatabaseSync(src, { readOnly: true });
  const report = {};
  try {
    for (const t of TABLES) {
      const r = { copied: 0, lostRows: 0 };
      let cols;
      try { cols = inp.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); } catch (e) { r.fatal = e.message; report[t] = r; continue; }
      if (t === 'memories' && cols.includes('source') && !cols.includes('agent')) cols = cols.map((c) => (c === 'source' ? 'source AS agent' : c)); // v1 file
      const dstCols = out.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const sel = cols.filter((c) => dstCols.includes(c.replace(/^.* AS /, '')));
      if (!sel.length) { report[t] = r; continue; }
      const names = sel.map((c) => c.replace(/^.* AS /, ''));
      const ins = out.prepare(`INSERT OR IGNORE INTO ${t}(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`);
      let maxRow = 0;
      let unknownMax = false;
      try { maxRow = inp.prepare(`SELECT MAX(rowid) m FROM ${t}`).get().m || 0; } catch { maxRow = 1e6; unknownMax = true; }
      // returns true when at least one row in [lo, hi) was readable
      const copy = (lo, hi) => {
        try {
          const rows = inp.prepare(`SELECT ${sel.join(',')} FROM ${t} WHERE rowid >= ? AND rowid < ?`).all(lo, hi);
          out.exec('BEGIN IMMEDIATE');
          try { for (const row of rows) r.copied += ins.run(...names.map((c) => row[c] ?? null)).changes; out.exec('COMMIT'); } catch (e) { out.exec('ROLLBACK'); throw e; }
          return rows.length > 0;
        } catch {
          if (hi - lo <= 1) { r.lostRows++; return false; }
          const mid = Math.floor((lo + hi) / 2);
          const a = copy(lo, mid);
          return copy(mid, hi) || a;
        }
      };
      // with an unreadable MAX(rowid) the scan is open-ended: stop after 20 windows in a row with no readable row
      // (a damaged b-tree interior page otherwise bisects ~1M rowids one by one)
      let dry = 0;
      for (let lo = 0; lo <= maxRow; lo += 500) {
        if (copy(lo, lo + 500)) dry = 0;
        else if (unknownMax && ++dry >= 20) { r.truncated = true; break; }
      }
      report[t] = r;
    }
    if (report.memories) out.prepare("UPDATE memories SET source = 'import' WHERE source IS NULL").run();
  } finally { inp.close(); }
  return report;
}

/** quick_check + both FTS integrity checks; returns '' when healthy, else the first problem. */
export function healthCheck() {
  const d = openDb();
  try {
    const q = d.prepare('PRAGMA quick_check').all().map((x) => Object.values(x)[0]).join('; ');
    if (q !== 'ok') return 'quick_check: ' + q.slice(0, 200);
    if (readOnly) return '';
    d.exec("INSERT INTO mem_fts(mem_fts) VALUES('integrity-check'); INSERT INTO mem_tri(mem_tri) VALUES('integrity-check');");
    return '';
  } catch (e) { return String(e.message || e); }
}

/** Leftover sam.db.corrupt-* files next to the DB (newest first). */
export function corruptCopies(path = config().dbPath) {
  try {
    const dir = dirname(path), base = basename(path) + '.corrupt-';
    return readdirSync(dir).filter((f) => f.startsWith(base) && !/-(wal|shm)$/.test(f)).sort().reverse().map((f) => join(dir, f));
  } catch { return []; }
}

export function tx(fn) {
  const d = openDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* noop */ }
    throw e;
  }
}

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function bump(project, metric, by = 1) {
  if (!by || readOnly) return;
  const day = localDay();
  try {
  openDb().prepare(
    `INSERT INTO stats(day, project, metric, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, project, metric) DO UPDATE SET value = value + excluded.value`
  ).run(day, project || 'global', metric, Math.round(by));
  } catch { /* stats are best-effort: a locked or read-only DB must not fail the caller */ }
}
