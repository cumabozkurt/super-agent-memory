// Project scoping: every memory belongs to a project (git remote/root), to 'global' (user-wide), or to
// 'unscoped' (work started in a parent folder that holds several repos; never shown in a repo's card).
import { existsSync, readFileSync, statSync, lstatSync, openSync, readSync, fstatSync, closeSync, readdirSync, constants } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { openDb } from './db.js';
import { sha, canonicalPath } from './text.js';

const GLOBAL = Object.freeze({ id: 'global', name: 'global', root: null });

/** Directories whose `.sam-project` is never honored: shared or too broad to name a project (S19). */
function forbiddenMarkerDir(dir) {
  const home = canonicalPath(process.env.SAM_INSTALL_HOME || homedir());
  const bad = new Set([home, canonicalPath(tmpdir()), canonicalPath('/tmp'), canonicalPath('/var/tmp'), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']);
  return bad.has(dir) || dirname(dir) === dir;
}

/**
 * `.sam-project` comes from untrusted checkouts (S1): it must be a small regular file (never a symlink, FIFO
 * or device), owned by us when it sits in a group/world-writable directory, holding ONE line of [\w.-].
 * Anything else is ignored. Read through an O_NOFOLLOW|O_NONBLOCK descriptor, at most 257 bytes.
 */
export function readProjectMarker(file) {
  let fd;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size === 0 || st.size > 256) return null;
    if (process.platform !== 'win32') {
      const dst = statSync(dirname(file));
      if (dst.mode & 0o002) return null; // a world-writable directory (/tmp-like): anyone could have planted it
      if (typeof process.getuid === 'function' && st.uid !== process.getuid() && (dst.mode & 0o020)) return null; // another user, shared group dir
    }
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > 256) return null;
    const buf = Buffer.alloc(257);
    const n = readSync(fd, buf, 0, 257, 0);
    if (n > 256) return null;
    const name = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '').trim();
    if (/[\r\n]/.test(name)) return null; // a single line only
    return /^[\w.-]{1,64}$/.test(name) ? name : null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* noop */ } }
}

function findRoot(start) {
  let dir = start;
  const home = canonicalPath(process.env.SAM_INSTALL_HOME || homedir());
  for (let i = 0; i < 40; i++) {
    const marker = join(dir, '.sam-project');
    const name = !forbiddenMarkerDir(dir) && existsSync(marker) ? readProjectMarker(marker) : null;
    if (name) return { root: dir, name };
    // a dotfiles repo in $HOME must not swallow every non-repo directory
    if (existsSync(join(dir, '.git')) && (dir !== home || start === home)) return { root: dir, name: null };
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** All `[remote "x"] url = …` values of a git config (exact key `url`, never `pushurl`; quotes stripped) (M3). */
export function remotesFromConfig(cfg) {
  const remotes = {};
  let cur = null;
  for (const line of String(cfg).split(/\r?\n/)) {
    const h = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (h) { cur = h[1]; continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    const u = cur && line.match(/^\s*url\s*=\s*(?:"([^"]*)"|([^\s#;]+))/i);
    if (u && !remotes[cur]) remotes[cur] = (u[1] ?? u[2] ?? '').trim() || undefined;
  }
  return remotes;
}

/** origin, else upstream, else the alphabetically first remote. */
export function pickRemote(cfg) {
  const r = remotesFromConfig(cfg);
  return r.origin || r.upstream || r[Object.keys(r).filter((k) => r[k]).sort()[0]] || null;
}

function gitConfig(root) {
  try {
    let gitDir = join(root, '.git');
    if (statSync(gitDir).isFile()) {
      // worktree / submodule: "gitdir: <path>"
      const m = readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) gitDir = resolve(root, m[1].trim());
      const common = join(gitDir, 'commondir');
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, 'utf8').trim());
    }
    return readFileSync(join(gitDir, 'config'), 'utf8');
  } catch { return null; }
}

/** One id per repo however it was cloned: ssh/scp/https, credentials, trailing slash, .git, case. */
export function normRemote(u) {
  return String(u).trim()
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//, 'https://$1/')
    .replace(/^git:\/\//, 'https://')
    .replace(/^https?:\/\/[^@/]+@/, 'https://')
    .replace(/^http:\/\//, 'https://')
    .replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
    .toLowerCase();
}

// v1.1 remote parser (origin only, first `url` substring match incl. pushurl, quotes kept): legacy ids only.
function legacyRemote(cfg) {
  const m = cfg && cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
  return m ? normRemote(m[1]) : null;
}

/** Repos directly below a folder (name + path), at most 400 entries scanned. */
export function childRepos(dir) {
  const out = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true }).slice(0, 400)) {
      if (e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, e.name, '.git'))) out.push({ name: e.name, path: join(dir, e.name) });
    }
  } catch { /* unreadable */ }
  return out;
}
/** A parent folder that holds several repos (e.g. ~/code): work there is not user-wide. */
function holdsRepos(dir) { return childRepos(dir).length >= 2; }

/** In a parent folder, a prompt that names exactly one of the repos below it is about that repo. */
export function repoMentioned(project, text) {
  if (project?.id !== 'unscoped' || !project.dir || !text) return null;
  const t = String(text).toLowerCase();
  const hits = childRepos(project.dir).filter((r) => r.name.length >= 3 && new RegExp(`(^|[^\\w-])${r.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(t));
  return hits.length === 1 ? resolveProject(hits[0].path) : null;
}

const MOVE_TABLES = ['memories', 'events', 'sessions', 'vault', 'stats'];
/** Re-key a project whose id changed (canonical roots, remote parsing, name ids that now include the root). */
function adoptLegacy(db, id, legacyIds, roots) {
  for (const old of legacyIds) {
    if (!old || old === id) continue;
    const row = db.prepare('SELECT root FROM projects WHERE id = ?').get(old);
    if (!row || !roots.includes(row.root)) continue; // only the repo that owned it (a name collision must not inherit it)
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(old)) {
        for (const t of MOVE_TABLES) {
          if (t === 'stats') db.prepare('UPDATE OR IGNORE stats SET project = ? WHERE project = ?').run(id, old);
          else db.prepare(`UPDATE ${t} SET project = ? WHERE project = ?`).run(id, old);
        }
        for (const k of ['team:', 'teamtomb:']) db.prepare('UPDATE OR IGNORE meta SET k = ? WHERE k = ?').run(k + id, k + old);
        db.prepare("UPDATE OR IGNORE meta SET k = 'teamline:' || ? || substr(k, ?) WHERE k LIKE ?").run(id, ('teamline:' + old).length + 1, 'teamline:' + old + ':%');
        db.prepare('DELETE FROM meta WHERE k = ?').run('trust:' + old); // trust is re-keyed on the canonical root
        db.prepare('DELETE FROM projects WHERE id = ?').run(old);
      }
      db.exec('COMMIT');
    } catch { try { db.exec('ROLLBACK'); } catch { /* noop */ } }
  }
}

const cache = new Map();

/** Resolve (and register) the project for a working directory. */
export function resolveProject(cwd) {
  const raw = resolve(cwd || process.cwd());
  if (cache.has(raw)) return cache.get(raw);
  const key = canonicalPath(raw);
  const found = findRoot(key);
  let proj;
  if (!found) {
    proj = holdsRepos(key) ? { id: 'unscoped', name: 'unscoped', root: null, dir: key } : GLOBAL;
  } else {
    const { root, name: explicit } = found;
    const cfg = gitConfig(root);
    const remoteUrl = cfg ? pickRemote(cfg) : null;
    const remote = remoteUrl ? normRemote(remoteUrl) : null;
    // S2: a `.sam-project` name is namespaced by the repo it lives in, so another repo shipping the same
    // name can never share its memories or its trust
    const id = explicit ? sha('name:' + explicit + '@' + (remote || 'path:' + root)) : sha(remote || 'path:' + root);
    const name = explicit || (remote ? basename(remote) : basename(root));
    proj = { id, name, root };
    try {
      const db = openDb();
      const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
      if (!exists) {
        const old = legacyRemote(cfg);
        const rawRoot = findRootRaw(raw);
        const legacy = explicit ? [sha('name:' + explicit)] : [old && sha(old), sha('path:' + root), rawRoot && sha('path:' + rawRoot)];
        adoptLegacy(db, id, legacy, [root, rawRoot].filter(Boolean));
      }
      const cur = db.prepare('SELECT name, root FROM projects WHERE id = ?').get(id);
      if (!cur || cur.root !== root || cur.name !== name) { // read first: no write (no lock wait) when nothing changed
        db.prepare(
          `INSERT INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root = excluded.root, name = excluded.name`
        ).run(id, name, root, Date.now());
      }
    } catch { /* read-only / locked DB: the id is still right */ }
  }
  cache.set(raw, proj);
  return proj;
}

// v1.1 root spelling (no realpath / NFC): only to find a legacy path id
function findRootRaw(start) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.sam-project'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function projectByName(nameOrId) {
  if (!nameOrId || nameOrId === 'global') return GLOBAL;
  if (nameOrId === 'unscoped') return { id: 'unscoped', name: 'unscoped', root: null };
  return openDb().prepare('SELECT * FROM projects WHERE id = ? OR name = ? ORDER BY created_at DESC LIMIT 1').get(nameOrId, nameOrId) || null;
}

export function clearProjectCache() { cache.clear(); }
