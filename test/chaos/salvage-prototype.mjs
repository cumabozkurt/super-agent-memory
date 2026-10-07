// Prototype of the proposed auto-recovery ("move aside and recreate, then salvage").
//   node salvage-prototype.mjs <corrupt.db> <new.db>
// 1. The corrupt file (+ -wal/-shm) is never modified; the caller has already renamed it aside.
// 2. A fresh DB is created with SAM's own schema (openDb on the new path).
// 3. Every content table is copied in rowid windows; a window that hits a malformed page is bisected
//    down to single rows, so one bad page costs only the rows on it.
// 4. FTS indexes are not copied: they are rebuilt from `memories` by the triggers on insert.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { quietSqlite, SAM_SRC } from './lib.mjs';

quietSqlite();
const [src, dst] = process.argv.slice(2);
if (!src || !dst || existsSync(dst)) { console.error('usage: salvage-prototype.mjs <corrupt.db> <new.db (must not exist)>'); process.exit(2); }
process.env.SAM_HOME = join(dst, '..');
const { openDb } = await import(join(SAM_SRC, 'db.js'));
const out = openDb(dst);
const inp = new DatabaseSync(src, { readOnly: true });
const TABLES = ['meta', 'projects', 'memories', 'sessions', 'events', 'injections', 'vault', 'stats'];
const report = {};
for (const t of TABLES) {
  const r = { copied: 0, lostRows: 0, errors: 0 };
  let cols;
  try { cols = inp.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); } catch (e) { r.fatal = e.message; report[t] = r; continue; }
  const dstCols = out.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  cols = cols.filter((c) => dstCols.includes(c));
  const ins = out.prepare(`INSERT OR IGNORE INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  let maxRow = 0;
  try { maxRow = inp.prepare(`SELECT MAX(rowid) m FROM ${t}`).get().m || 0; } catch { maxRow = 1e7; } // unknown: scan wide
  const copyRange = (lo, hi) => {
    try {
      const rows = inp.prepare(`SELECT ${cols.join(',')} FROM ${t} WHERE rowid >= ? AND rowid < ?`).all(lo, hi);
      out.exec('BEGIN');
      for (const row of rows) r.copied += ins.run(...cols.map((c) => row[c])).changes;
      out.exec('COMMIT');
    } catch (e) {
      try { out.exec('ROLLBACK'); } catch { /* not in tx */ }
      r.errors++;
      if (hi - lo <= 1) { r.lostRows++; return; }
      const mid = Math.floor((lo + hi) / 2);
      copyRange(lo, mid); copyRange(mid, hi);
    }
  };
  for (let lo = 0; lo <= maxRow; lo += 500) copyRange(lo, lo + 500);
  report[t] = r;
}
inp.close();
let integrity, fts;
try { integrity = out.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]).join(';'); out.exec("INSERT INTO mem_fts(mem_fts) VALUES('integrity-check')"); fts = 'ok'; } catch (e) { fts = e.message; }
console.log(JSON.stringify({ report, integrity, fts }));
