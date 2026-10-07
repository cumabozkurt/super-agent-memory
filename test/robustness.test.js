// Robustness regressions from the chaos audit (#1–#12) plus a ~60 s CI subset of the chaos harness
// (test/chaos/). The slow parts (process fuzzers, kill -9 loop, MCP fuzzer, concurrency) run with SAM_SLOW=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, openSync, writeSync, closeSync, readdirSync, rmSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'sam-rob-'));
process.env.SAM_HOME = join(TMP, 'home');
process.env.SAM_INSTALL_HOME = join(TMP, 'user');
mkdirSync(process.env.SAM_INSTALL_HOME, { recursive: true });
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'sam.js');
const POSIX = process.platform !== 'win32';
const SLOW = /^(1|true|yes)$/i.test(process.env.SAM_SLOW || '');

const hooks = await import('../src/hooks.js');
const store = await import('../src/store.js');
const capture = await import('../src/capture.js');
const inject = await import('../src/inject.js');
const { gc, maybeAutoGc } = await import('../src/gc.js');
const { openDb } = await import('../src/db.js');
const { resolveProject } = await import('../src/project.js');

const R = join(TMP, 'repo');
mkdirSync(join(R, '.git'), { recursive: true });
writeFileSync(join(R, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/rob.git\n');
const P = resolveProject(R);
const line = (t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }) + '\n';

/** A separate SAM_HOME for out-of-process checks. */
function env(tag) {
  const home = join(TMP, 'env-' + tag);
  mkdirSync(home, { recursive: true });
  return { ...process.env, SAM_HOME: home, SAM_INSTALL_HOME: process.env.SAM_INSTALL_HOME };
}
const run = (e, args, input = '') => spawnSync(process.execPath, [BIN, ...args], { cwd: R, env: e, input, encoding: 'utf8', timeout: 20000 });
const hookP = (e, ev, payload) => run(e, ['hook', ev, '--agent', 'claude'], JSON.stringify({ cwd: R, session_id: 'p', ...payload }));

test('#1: a poison marker (prototype kind, blank body) cannot stop capture; the offset always advances', async () => {
  const tr = join(TMP, 'poison.jsonl');
  writeFileSync(tr, line('first ⟦mem decision: marker before the poison pill⟧') + line('explaining JS: ⟦mem constructor: build the object first⟧ ⟦mem fact:      ⟧ ⟦mem __proto__: x y z⟧') + line('later ⟦mem decision: marker after the poison is saved⟧'));
  await hooks.runHook('Stop', { agent: 'claude', payload: { session_id: 'poison', cwd: R, transcript_path: tr } });
  const db = openDb();
  assert.ok(db.prepare("SELECT 1 FROM memories WHERE gist LIKE 'marker after the poison%'").get());
  assert.ok(!db.prepare("SELECT 1 FROM memories WHERE kind NOT IN ('decision','convention','preference','fact','fix','bug','todo','note','session')").get());
  assert.equal(db.prepare("SELECT transcript_offset o FROM sessions WHERE id = 'claude:poison'").get().o, (await import('node:fs')).statSync(tr).size);
});

test('#3: FIFO / device / directory / huge sparse transcripts are skipped without blocking', { skip: !POSIX }, async () => {
  const fifo = join(TMP, 'fifo');
  try { execFileSync('mkfifo', [fifo]); } catch { return; }
  const sparse = join(TMP, 'sparse.bin');
  { const fd = openSync(sparse, 'w'); (await import('node:fs')).ftruncateSync(fd, 600 * 1024 * 1024); closeSync(fd); }
  const t0 = Date.now();
  for (const t of [fifo, '/dev/zero', '/dev/null', TMP, sparse]) {
    await hooks.runHook('Stop', { agent: 'claude', payload: { session_id: 'fifo', cwd: R, transcript_path: t } });
    await hooks.runHook('PreInvocation', { agent: 'antigravity', payload: { cwd: R, transcript_path: t, invocationNum: 1 } });
  }
  assert.ok(Date.now() - t0 < 3000, 'no blocking read');
});

test('#4: a corrupt DB is moved aside, hooks keep working, `doctor --repair` salvages it', () => {
  const e = env('corrupt');
  for (let i = 0; i < 12; i++) run(e, ['add', `salvage fact ${i} about cache tier ${i}`, '-k', 'fact']);
  run(e, ['gc']);
  const db = join(e.SAM_HOME, 'sam.db');
  // damage a page in the middle (header intact → readable rows survive) and, second run, the header
  const fd = openSync(db, 'r+'); writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0); closeSync(fd);
  const h = hookP(e, 'SessionStart', { source: 'startup' });
  assert.equal(h.status, 0);
  assert.ok(readdirSync(e.SAM_HOME).some((f) => f.startsWith('sam.db.corrupt-')), 'moved aside');
  assert.equal(run(e, ['add', 'works after recreate', '-k', 'fact']).status, 0);
  const d = run(e, ['doctor']);
  assert.match(d.stdout, /corrupt DB cop/);
  const rep = run(e, ['doctor', '--repair']);
  assert.match(rep.stdout, /salvaged|could not read/);
});

test('#4: doctor --repair salvages rows around a damaged page', () => {
  const e = env('salvage');
  for (let i = 0; i < 400; i++) run(e, ['add', `bulk fact number ${i} ` + 'filler '.repeat(30), '-k', 'fact']);
  run(e, ['gc']);
  const db = join(e.SAM_HOME, 'sam.db');
  const size = (await_size(db));
  const fd = openSync(db, 'r+'); writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, Math.floor(size / 4096 / 2) * 4096); closeSync(fd);
  const rep = run(e, ['doctor', '--repair']);
  assert.equal(rep.status, 0, rep.stderr);
  const n = Number((run(e, ['q', 'bulk fact', '-n', '20']).stdout.match(/bulk fact/g) || []).length);
  assert.ok(n > 0, rep.stdout);
});
function await_size(p) { return (spawnSync(process.execPath, ['-e', `console.log(require('fs').statSync(${JSON.stringify(p)}).size)`], { encoding: 'utf8' }).stdout.trim() | 0); }

test('#5: a read-only DB (file or directory) still serves cards and search', { skip: !POSIX || process.getuid?.() === 0 }, () => {
  const e = env('ro');
  for (let i = 0; i < 5; i++) run(e, ['add', `read only fact ${i} about cache`, '-k', 'fact']);
  run(e, ['gc']);
  chmodSync(join(e.SAM_HOME, 'sam.db'), 0o444);
  const s = hookP(e, 'SessionStart', { source: 'startup' });
  assert.match(s.stdout, /read only fact/);
  assert.match(run(e, ['q', 'cache']).stdout, /read only fact/);
  chmodSync(join(e.SAM_HOME, 'sam.db'), 0o644);
  chmodSync(e.SAM_HOME, 0o555);
  try {
    assert.match(hookP(e, 'SessionStart', { source: 'startup' }).stdout, /read only fact/);
    assert.match(run(e, ['q', 'cache']).stdout, /read only fact/);
  } finally { chmodSync(e.SAM_HOME, 0o700); }
});

test('#6: the MCP server reopens a DB that was deleted/replaced under it', async () => {
  const e = env('mcp-inode');
  run(e, ['add', 'seed before the server starts', '-k', 'fact']);
  const c = spawn(process.execPath, [BIN, 'mcp'], { cwd: R, env: e, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiters = new Map();
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  let id = 0;
  const call = (name, args) => new Promise((res) => { const my = ++id; waiters.set(my, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
  await call('mem_save', { text: 'before delete: we use postgres 16', kind: 'fact' });
  for (const s of ['', '-wal', '-shm']) rmSync(join(e.SAM_HOME, 'sam.db' + s), { force: true });
  run(e, ['add', 'after delete the cli wrote this', '-k', 'fact']);
  const r = await call('mem_search', { q: 'after delete cli wrote' });
  c.stdin.end();
  assert.match(r.result.content[0].text, /after delete the cli wrote this/);
});

test('#8: hooks read before they write — a locked DB still yields the card quickly', async () => {
  const e = env('lock');
  for (let i = 0; i < 5; i++) run(e, ['add', `lock test convention ${i} always applies`, '-k', 'convention']);
  const { DatabaseSync } = await import('node:sqlite');
  const hog = new DatabaseSync(join(e.SAM_HOME, 'sam.db'));
  hog.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO meta(k, v) VALUES (\'hog\', \'1\');');
  const t0 = Date.now();
  const s = hookP(e, 'SessionStart', { source: 'startup' });
  const ms = Date.now() - t0;
  hog.exec('ROLLBACK'); hog.close();
  assert.match(s.stdout, /lock test convention/);
  assert.ok(ms < 6000, `took ${ms} ms`);
});

test('#9: automatic light gc runs at most once per 24 h', () => {
  const db = openDb();
  db.prepare("DELETE FROM meta WHERE k = 'gc:auto'").run();
  assert.ok(maybeAutoGc(), 'first call runs');
  assert.equal(maybeAutoGc(), null, 'second call within 24 h is skipped');
  db.prepare("UPDATE meta SET v = ? WHERE k = 'gc:auto'").run(String(Date.now() + 10 * 86400000)); // clock went back
  assert.ok(maybeAutoGc(), 'a last-run stamp in the future is stale');
});

test('#10: future timestamps are clamped for ranking and gc; a huge forward jump skips expiry', () => {
  const db = openDb();
  const m = store.saveMemory({ project: P.id, kind: 'decision', text: 'clock skew decision about the cache layer', source: 'user' });
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Date.now() + 400 * 86400000, m.id);
  const c = inject.sessionContext({ project: P, session: null });
  assert.ok(!/NaN/.test(c.text));
  gc();
  assert.ok(db.prepare('SELECT updated_at u FROM memories WHERE id = ?').get(m.id).u <= Date.now() + 1000, 'clamped to now');
  db.prepare("INSERT INTO events(session, project, type, ts) VALUES ('x', ?, 'edit', ?)").run(P.id, Date.now() - 3 * 86400000);
  const real = Date.now;
  Date.now = () => real() + 3 * 365 * 86400000; // the clock jumps 3 years ahead
  try {
    const r = gc();
    assert.match(String(r.skipped), /clock jumped/);
  } finally { Date.now = real; }
  assert.ok(db.prepare("SELECT 1 FROM events WHERE session = 'x'").get(), 'nothing expired by the jump');
});

test('#11: a forgotten memory is not resurrected by a re-harvest; resume re-injects only what is new', async () => {
  const tr = join(TMP, 'res.jsonl');
  writeFileSync(tr, line('⟦mem decision: resurrection test value is forty two⟧'));
  await hooks.runHook('Stop', { agent: 'claude', payload: { session_id: 'res', cwd: R, transcript_path: tr } });
  const db = openDb();
  const id = db.prepare("SELECT id FROM memories WHERE gist LIKE 'resurrection test%'").get().id;
  store.forget(id);
  db.prepare("UPDATE sessions SET transcript_offset = 0 WHERE id = 'claude:res'").run(); // e.g. a rewritten transcript
  await hooks.runHook('Stop', { agent: 'claude', payload: { session_id: 'res', cwd: R, transcript_path: tr } });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE gist LIKE 'resurrection test%' AND superseded_by IS NULL").get().c, 0);
  // resume
  store.saveMemory({ project: P.id, kind: 'convention', text: 'resume test: always run the linter first', source: 'user' });
  const first = (await hooks.runHook('SessionStart', { agent: 'claude', payload: { session_id: 'rs', cwd: R, source: 'startup' } })).out.hookSpecificOutput.additionalContext;
  assert.match(first, /resume test/);
  const again = (await hooks.runHook('SessionStart', { agent: 'claude', payload: { session_id: 'rs', cwd: R, source: 'resume' } })).out;
  assert.ok(!JSON.stringify(again).includes('resume test'), 'already in the resumed context');
  store.saveMemory({ project: P.id, kind: 'convention', text: 'resume test 2: a brand new rule after the pause', source: 'user' });
  const delta = (await hooks.runHook('SessionStart', { agent: 'claude', payload: { session_id: 'rs', cwd: R, source: 'resume' } })).out.hookSpecificOutput.additionalContext;
  assert.match(delta, /brand new rule/);
  assert.ok(!/always run the linter first/.test(delta));
});

test('#12: payload fields are type-checked; stdin is capped', async () => {
  for (const p of [null, [], 5, 'str', { session_id: { a: 1 }, cwd: ['x'], prompt: 42, transcript_path: { x: 1 }, tool_name: [] }]) {
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) await hooks.runHook(ev, { agent: 'claude', payload: p });
  }
  const n = hooks.normalize('claude', 'UserPromptSubmit', { session_id: { a: 1 }, cwd: 5, prompt: ['x'] });
  assert.equal(n.session, null); assert.equal(n.prompt, '');
  assert.equal(hooks.MAX_STDIN, 2 * 1024 * 1024);
  const e = env('big');
  const t0 = Date.now();
  const r = run(e, ['hook', 'UserPromptSubmit', '--agent', 'claude'], JSON.stringify({ cwd: R, session_id: 'big', prompt: 'remember that ' + 'x'.repeat(10 * 1024 * 1024) }));
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 8000);
});

// ---------- chaos harness CI subset (~30 s): in-process fuzz of every dialect ----------
test('chaos CI subset: in-process hook fuzz, every dialect — no exceptions, valid replies, within budget, DB intact', { timeout: 120000 }, () => {
  const n = SLOW ? 2000 : 60;
  for (const agent of ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'cursor']) {
    const out = join(TMP, `fuzz-${agent}.json`);
    const r = spawnSync(process.execPath, [join(ROOT, 'test', 'chaos', 'fuzz-hooks-inproc.mjs'), '--agent', agent, '--n', String(n), '--seed', '11', '--out', out],
      { env: { ...process.env, SAM_SRC: join(ROOT, 'src'), CHAOS_TMP: TMP }, encoding: 'utf8', timeout: 110000 });
    assert.equal(r.status, 0, r.stderr.slice(0, 500));
    const j = JSON.parse((r.stdout.trim().split('\n').pop()));
    assert.equal(j.integrity, 'ok'); assert.equal(j.fts, 'ok'); assert.equal(j.tri, 'ok');
    assert.deepEqual(j.orphans, { supersededByMissing: 0, digestMissing: 0, badKind: 0, nanImportance: 0 });
    for (const [ev, x] of Object.entries(j.perEvent)) {
      assert.equal(x.exc, 0, `${agent} ${ev} exceptions`);
      assert.equal(x.badShape, 0, `${agent} ${ev} bad reply shape`);
      assert.equal(x.overBudget, 0, `${agent} ${ev} over budget`);
    }
  }
});

test('chaos CI subset: storage faults (poison, corrupt, read-only, deleted, crash points, disk full)', { timeout: 120000, skip: !POSIX }, () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'test', 'chaos', 'faults.mjs'), '--only', SLOW ? 'poison,corrupt,readonly,deleted,crashpoints,diskfull,walgone,ftscorrupt' : 'poison,deleted,crashpoints'],
    { env: { ...process.env, SAM_SRC: join(ROOT, 'src'), CHAOS_TMP: TMP }, encoding: 'utf8', timeout: 115000 });
  assert.equal(r.status, 0, r.stderr.slice(0, 500));
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  for (const k of ['constructor-kind', 'blank-body']) {
    assert.ok(j.poison[k].savedAfterPoison >= 1, k);
    assert.equal(j.poison[k].offset, j.poison[k].transcriptBytes, k + ' offset advanced');
  }
  assert.match(j.deleted.mcpSearchSeesHookWrite, /hook wrote this/);
  assert.equal(j.crashpoints.liveDigestsForOneSession, 1);
  assert.equal(j.crashpoints.markerCopies, 1);
  if (SLOW) {
    assert.match(j.readonly.start.out, /additionalContext/);
    assert.match(j.diskfull.start.out, /additionalContext/);
    assert.match(j.corrupt.doctor.out, /corrupt/);
  }
});

test('chaos (SAM_SLOW=1): process fuzz, MCP fuzz, kill -9 loop', { timeout: 900000, skip: !SLOW }, () => {
  const e = { ...process.env, SAM_SRC: join(ROOT, 'src'), CHAOS_TMP: TMP };
  for (const [script, args] of [
    ['fuzz-hooks-proc.mjs', ['--mode', 'special']],
    ['fuzz-mcp.mjs', ['--n', '1500', '--seed', '5']],
    ['crash-kill9.mjs', ['--iters', '40', '--dir', join(TMP, 'kill9')]],
  ]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'test', 'chaos', script), ...args], { env: e, encoding: 'utf8', timeout: 400000 });
    assert.equal(r.status, 0, script + ': ' + r.stderr.slice(0, 500));
  }
});

test('schema guard: a DB from a newer SAM opens read-only and is never written or migrated', () => {
  const e = env('newer');
  run(e, ['add', 'guard probe fact', '-k', 'fact']);
  const dbp = join(e.SAM_HOME, 'sam.db');
  const bump = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(dbp)});d.exec("UPDATE meta SET v='99' WHERE k='schema'");d.close()`], { encoding: 'utf8' });
  assert.equal(bump.status, 0, bump.stderr);
  const q = run(e, ['q', 'guard probe']);
  assert.match(q.stdout, /guard probe/, 'reads still work');
  const w = run(e, ['add', 'must not land', '-k', 'fact']);
  assert.notEqual(w.status, 0, 'write refused');
  const chk = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(dbp)},{readOnly:true});console.log(d.prepare("SELECT v FROM meta WHERE k='schema'").get().v, d.prepare("SELECT count(*) n FROM memories WHERE gist LIKE '%must not land%'").get().n)`], { encoding: 'utf8' });
  assert.equal(chk.stdout.trim(), '99 0');
  const h = run(e, ['hook', 'UserPromptSubmit', '--agent', 'claude'], JSON.stringify({ session_id: 'g', cwd: R, prompt: 'guard probe?' }));
  assert.equal(h.status, 0, 'hooks never fail');
});
