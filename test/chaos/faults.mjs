// Storage fault injection: disk full, read-only DB, DB/WAL deleted under a running MCP server,
// corrupted DB (header and FTS pages), statement-level crash points (via SQLite triggers), and
// the marker "poison pill" that wedges transcript harvesting.
//
//   node faults.mjs [--only diskfull,readonly,deleted,walgone,corrupt,ftscorrupt,crashpoints,poison]
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, chmodSync, rmSync, openSync, writeSync, closeSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freshEnv, SAM_BIN, quietSqlite } from './lib.mjs';

quietSqlite();
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const only = args.only ? new Set(args.only.split(',')) : null;
const want = (k) => !only || only.has(k);
const report = {};

function sam(env, argv, stdin, { ulimitKB } = {}) {
  const cmd = ulimitKB ? 'bash' : process.execPath;
  const a = ulimitKB ? ['-c', `ulimit -f ${ulimitKB}; exec "${process.execPath}" "${SAM_BIN}" ${argv.map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(' ')}`] : [SAM_BIN, ...argv];
  const t = Date.now();
  const r = spawnSync(cmd, a, { cwd: env.repo, env: { ...process.env, SAM_HOME: env.SAM_HOME, SAM_INSTALL_HOME: env.SAM_INSTALL_HOME }, input: stdin ?? '', timeout: 15000 });
  return { code: r.status, signal: r.signal, ms: Date.now() - t, out: String(r.stdout).slice(0, 300), err: String(r.stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?|\(Use `node --trace-warnings[^\n]*\n?/g, '').slice(0, 300) };
}
const hook = (env, ev, payload, o) => sam(env, ['hook', ev, '--agent', 'claude'], JSON.stringify({ session_id: 'f1', cwd: env.repo, ...payload }), o);
function mcp(env) {
  const c = spawn(process.execPath, [SAM_BIN, 'mcp'], { cwd: env.repo, env: { ...process.env, SAM_HOME: env.SAM_HOME, SAM_INSTALL_HOME: env.SAM_INSTALL_HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let buf = ''; let err = '';
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  c.stderr.on('data', (d) => { err += d; });
  let id = 0;
  const req = (method, params) => new Promise((res) => {
    const my = ++id; c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    const t = setInterval(() => { const l = lines.find((x) => { try { return JSON.parse(x).id === my; } catch { return false; } }); if (l) { clearInterval(t); res(JSON.parse(l)); } }, 5);
    setTimeout(() => { clearInterval(t); res({ timeout: true }); }, 20000);
  });
  const tool = async (name, a) => { const r = await req('tools/call', { name, arguments: a }); return r.timeout ? 'TIMEOUT' : r.result ? (r.result.isError ? 'ERR ' : '') + r.result.content[0].text : JSON.stringify(r.error); };
  const exited = new Promise((res) => c.on('close', (code, signal) => res({ code, signal, err: err.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?|\(Use `node --trace-warnings[^\n]*\n?/g, '').slice(0, 300) })));
  return { c, req, tool, exited, lines, close: () => { c.stdin.end(); return exited; } };
}
const integrity = (path) => { try { const d = new DatabaseSync(path); const r = d.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]).join(';'); let f = 'ok'; try { d.exec("INSERT INTO mem_fts(mem_fts) VALUES('integrity-check')"); } catch (e) { f = e.message; } d.close(); return r + ' / fts:' + f; } catch (e) { return 'open failed: ' + e.message; } };
const count = (path, where = '1=1') => { try { const d = new DatabaseSync(path); const c = d.prepare(`SELECT COUNT(*) c FROM memories WHERE ${where}`).get().c; d.close(); return c; } catch (e) { return 'ERR ' + e.message; } };
const seed = (env, n = 50) => { for (let i = 0; i < n; i++) sam(env, ['add', `seed fact ${i} about component c${i % 13} and its cache`, '-k', 'fact']); };

// ---- F1 disk full (RLIMIT_FSIZE; node ignores SIGXFSZ so writes fail with EFBIG → SQLITE_FULL/IOERR) ----
if (want('diskfull')) {
  const env = freshEnv('diskfull');
  seed(env, 30);
  sam(env, ['gc']); // checkpoint + truncate WAL
  const dbKB = Math.ceil(statSync(env.dbPath).size / 1024);
  const lim = 1; // 1 KB: any file growth (WAL frames, new pages) fails
  const res = {};
  res.prompt = hook(env, 'UserPromptSubmit', { prompt: 'remember that the disk full test writes nothing ' + 'x'.repeat(5000) }, { ulimitKB: lim });
  res.start = hook(env, 'SessionStart', { source: 'startup' }, { ulimitKB: lim });
  res.add = sam(env, ['add', 'decision while disk is full: keep calm', '-k', 'decision'], '', { ulimitKB: lim });
  res.search = sam(env, ['q', 'cache component'], '', { ulimitKB: lim });
  res.integrityAfter = integrity(env.dbPath);
  res.afterSpaceReturns = sam(env, ['add', 'decision after disk recovered: works again', '-k', 'decision']);
  res.integrityFinal = integrity(env.dbPath);
  report.diskfull = { dbKB, ulimitKB: lim, ...res };
}

// ---- F2 read-only DB file / read-only SAM_HOME ----
if (want('readonly')) {
  const env = freshEnv('ro');
  seed(env, 20);
  sam(env, ['gc']);
  chmodSync(env.dbPath, 0o444);
  const res = {};
  res.start = hook(env, 'SessionStart', { source: 'startup' });
  res.search = sam(env, ['q', 'cache component']);
  res.add = sam(env, ['add', 'decision on ro db', '-k', 'decision']);
  const m = mcp(env);
  res.mcpInit = await Promise.race([m.req('initialize', {}), new Promise((r) => setTimeout(() => r('no answer'), 3000))]);
  res.mcpExit = await m.close();
  chmodSync(env.dbPath, 0o644);
  chmodSync(env.SAM_HOME, 0o555);
  res.dirRO_start = hook(env, 'SessionStart', { source: 'startup' });
  res.dirRO_search = sam(env, ['q', 'cache component']);
  chmodSync(env.SAM_HOME, 0o755);
  res.integrity = integrity(env.dbPath);
  report.readonly = res;
}

// ---- F3 DB deleted while the MCP server runs (split brain) ----
if (want('deleted')) {
  const env = freshEnv('deleted');
  seed(env, 5);
  const m = mcp(env);
  await m.req('initialize', {});
  const res = {};
  res.save1 = await m.tool('mem_save', { text: 'before delete: we use postgres 16', kind: 'fact' });
  for (const s of ['', '-wal', '-shm']) rmSync(env.dbPath + s, { force: true });
  res.hookAfterDelete = hook(env, 'UserPromptSubmit', { prompt: 'remember that after delete the hook wrote this' });
  res.mcpSaveAfterDelete = await m.tool('mem_save', { text: 'after delete: mcp saved this into a ghost file', kind: 'fact' });
  res.mcpSearchSeesHookWrite = await m.tool('mem_search', { q: 'after delete hook wrote' });
  res.cliSearchSeesMcpWrite = sam(env, ['q', 'ghost file mcp saved']).out;
  res.mcpExit = await m.close();
  res.cliSearchAfterMcpExit = sam(env, ['q', 'ghost file mcp saved']).out;
  res.integrity = integrity(env.dbPath);
  report.deleted = res;
}

// ---- F3b WAL file deleted while the MCP server holds committed-but-uncheckpointed frames ----
if (want('walgone')) {
  const env = freshEnv('walgone');
  seed(env, 40);
  const m = mcp(env);
  await m.req('initialize', {});
  const res = {};
  for (let i = 0; i < 30; i++) await m.tool('mem_save', { text: `wal frame memory ${i} for table t${i}`, kind: 'fact' });
  res.walBytesBefore = existsSync(env.dbPath + '-wal') ? statSync(env.dbPath + '-wal').size : 0;
  rmSync(env.dbPath + '-wal', { force: true });
  rmSync(env.dbPath + '-shm', { force: true });
  res.cliCountAfterWalGone = count(env.dbPath, "gist LIKE 'wal frame%'");
  for (let i = 0; i < 20; i++) sam(env, ['add', `independent writer ${i} after wal deletion`, '-k', 'fact']);
  res.mcpMore = await m.tool('mem_save', { text: 'mcp writes after wal deletion', kind: 'fact' });
  res.mcpExit = await m.close();
  res.integrity = integrity(env.dbPath);
  res.lostMcpWrites = 30 - Number(count(env.dbPath, "gist LIKE 'wal frame%'"));
  res.lostIndependentWrites = 20 - Number(count(env.dbPath, "gist LIKE 'independent writer%'"));
  res.seedRowsLeft = count(env.dbPath, "gist LIKE 'seed fact%'");
  res.ftsRows = (() => { try { const d = new DatabaseSync(env.dbPath); const c = d.prepare('SELECT COUNT(*) c FROM mem_fts_docsize').get().c; const m2 = d.prepare('SELECT COUNT(*) c FROM memories').get().c; d.close(); return { fts: c, memories: m2 }; } catch (e) { return e.message; } })();
  report.walgone = res;
}

// ---- F4 corrupted DB header (random bytes) ----
if (want('corrupt')) {
  const env = freshEnv('corrupt');
  seed(env, 10);
  sam(env, ['gc']);
  const fd = openSync(env.dbPath, 'r+');
  const junk = Buffer.alloc(100); for (let i = 0; i < 100; i++) junk[i] = (i * 73 + 41) & 0xff;
  writeSync(fd, junk, 0, 100, 0); closeSync(fd);
  const res = { runs: [] };
  for (let i = 0; i < 5; i++) res.runs.push(hook(env, i % 2 ? 'UserPromptSubmit' : 'SessionStart', { prompt: 'remember that corruption is detected', source: 'startup' }));
  res.cliSearch = sam(env, ['q', 'anything']);
  res.doctor = sam(env, ['doctor']);
  const m = mcp(env);
  res.mcpInit = await Promise.race([m.req('initialize', {}), new Promise((r) => setTimeout(() => r('no answer'), 3000))]);
  res.mcpExit = await m.close();
  res.stillCorrupt = integrity(env.dbPath);
  res.sidecarsCreated = ['.corrupt', '.bak'].filter((s) => existsSync(env.dbPath + s));
  report.corrupt = res;
}

// ---- F5 corrupted FTS pages: search degrades silently ----
if (want('ftscorrupt')) {
  const env = freshEnv('ftscorrupt');
  seed(env, 300);
  sam(env, ['gc']);
  const st = spawnSync('sqlite3', [env.dbPath, "SELECT pageno FROM dbstat WHERE name IN ('mem_fts_data','mem_fts_idx') ORDER BY pageno"]);
  const pages = String(st.stdout).trim().split('\n').filter(Boolean).map(Number);
  const pageSize = 4096;
  const res = { ftsPages: pages.length, before: sam(env, ['q', 'component cache']).out.split('\n').length };
  const fd = openSync(env.dbPath, 'r+');
  for (const p of pages) { const b = Buffer.alloc(pageSize, 0x5a); writeSync(fd, b, 0, pageSize, (p - 1) * pageSize + 0); }
  closeSync(fd);
  res.after = sam(env, ['q', 'component cache']);
  res.start = hook(env, 'SessionStart', { source: 'startup' });
  res.prompt = hook(env, 'UserPromptSubmit', { prompt: 'how does the component cache work here?' });
  res.add = sam(env, ['add', 'new fact after fts corruption is saved?', '-k', 'fact']);
  res.integrity = integrity(env.dbPath);
  report.ftscorrupt = res;
}

// ---- F6 statement-level crash points, injected with RAISE() triggers (≡ dying between two statements) ----
if (want('crashpoints')) {
  const env = freshEnv('crashpoints');
  const res = {};
  // (a) digest saved, but the process dies before sessions.digest_id is written
  hook(env, 'UserPromptSubmit', { session_id: 'cp1', prompt: 'refactor the cache layer please' });
  hook(env, 'PostToolUse', { session_id: 'cp1', tool_name: 'Edit', tool_input: { file_path: env.repo + '/src/cache.ts' } });
  let d = new DatabaseSync(env.dbPath);
  d.exec("CREATE TRIGGER inj_digest BEFORE UPDATE OF digest_id ON sessions BEGIN SELECT RAISE(ABORT, 'injected crash'); END");
  d.close();
  for (let i = 0; i < 3; i++) hook(env, 'Stop', { session_id: 'cp1' });
  d = new DatabaseSync(env.dbPath);
  d.exec('DROP TRIGGER inj_digest');
  hook(env, 'Stop', { session_id: 'cp1' });
  res.liveDigestsForOneSession = d.prepare("SELECT COUNT(*) c FROM memories WHERE kind = 'session' AND session = 'claude:cp1' AND superseded_by IS NULL").get().c;
  // (b) markers saved, but the process dies before transcript_offset is advanced
  const tr = join(env.tmp, 'tr.jsonl');
  writeFileSync(tr, JSON.stringify({ role: 'assistant', content: 'ok ⟦mem decision: offset crash point marker⟧' }) + '\n');
  d.exec("CREATE TRIGGER inj_off BEFORE UPDATE OF transcript_offset ON sessions BEGIN SELECT RAISE(ABORT, 'injected crash'); END");
  d.close();
  for (let i = 0; i < 3; i++) hook(env, 'Stop', { session_id: 'cp2', transcript_path: tr });
  d = new DatabaseSync(env.dbPath);
  res.offsetStuck = d.prepare("SELECT transcript_offset FROM sessions WHERE id = 'claude:cp2'").get()?.transcript_offset;
  res.markerCopies = d.prepare("SELECT COUNT(*) c FROM memories WHERE gist LIKE 'offset crash point%'").get().c;
  res.markerUpdatedAtBumpedBy3Harvests = true;
  d.exec('DROP TRIGGER inj_off');
  d.close();
  report.crashpoints = res;
}

// ---- F7 poison marker wedges transcript harvesting for the rest of the session ----
if (want('poison')) {
  const env = freshEnv('poison');
  const tr = join(env.tmp, 'tr.jsonl');
  const line = (t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }) + '\n';
  const res = {};
  for (const [name, poison] of [['constructor-kind', '⟦mem constructor: build the object first⟧'], ['blank-body', '⟦mem fact:      ⟧']]) {
    writeFileSync(tr, line('first ⟦mem decision: marker before the poison⟧') + line('explaining JS: ' + poison) + line('later ⟦mem decision: marker after the poison is never saved⟧'));
    const sid = 'p-' + name;
    const runs = [];
    for (let i = 0; i < 4; i++) {
      appendFileSync(tr, line(`turn ${i} ⟦mem fact: turn ${i} produced fact number ${i} for ${name}⟧`) + 'x'.repeat(20000) + '\n');
      runs.push(hook(env, 'Stop', { session_id: sid, transcript_path: tr }).code);
    }
    const d = new DatabaseSync(env.dbPath);
    res[name] = {
      exitCodes: runs,
      offset: d.prepare('SELECT transcript_offset FROM sessions WHERE id = ?').get('claude:' + sid)?.transcript_offset,
      transcriptBytes: statSync(tr).size,
      savedAfterPoison: d.prepare("SELECT COUNT(*) c FROM memories WHERE gist LIKE 'marker after the poison%'").get().c,
      laterTurnFactsSaved: d.prepare('SELECT COUNT(*) c FROM memories WHERE gist LIKE ?').get(`turn % produced fact number % for ${name}`).c,
      digest: d.prepare("SELECT COUNT(*) c FROM memories WHERE kind = 'session' AND session = ?").get('claude:' + sid).c,
    };
    d.close();
  }
  report.poison = res;
}

console.log(JSON.stringify(report, null, 1));
