// Workflow regressions from the multi-agent simulation (P0–P2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'sam-wf-'));
process.env.SAM_HOME = join(TMP, 'home');
process.env.SAM_INSTALL_HOME = join(TMP, 'user');
mkdirSync(process.env.SAM_INSTALL_HOME, { recursive: true });
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));

const text = await import('../src/text.js');
const store = await import('../src/store.js');
const hooks = await import('../src/hooks.js');
const capture = await import('../src/capture.js');
const inject = await import('../src/inject.js');
const portable = await import('../src/portable.js');
const { openDb } = await import('../src/db.js');
const { resolveProject } = await import('../src/project.js');

function repo(name, remote = `https://github.com/acme/${name}.git`, parent = TMP) {
  const d = join(parent, name);
  mkdirSync(join(d, '.git'), { recursive: true });
  writeFileSync(join(d, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
  return d;
}
const ctx = (r) => r.out?.hookSpecificOutput?.additionalContext || r.out?.additional_context || '';
const live = (pid, like) => openDb().prepare('SELECT * FROM memories WHERE project = ? AND superseded_by IS NULL AND gist LIKE ?').all(pid, like);

test('P0: one turn yields at most 8 markers; junk is rejected; exact duplicates merge without a fingerprint', async () => {
  const r = repo('p0'); const P = resolveProject(r);
  const spam = Array.from({ length: 50 }, (_, i) => `⟦mem decision: step ${i}: updated module number ${i} in src/mod${i}.ts⟧`).join(' ');
  await hooks.runHook('Stop', { agent: 'claude', payload: { session_id: 's', cwd: r, last_assistant_message: spam } });
  assert.equal(openDb().prepare('SELECT COUNT(*) c FROM memories WHERE project = ?').get(P.id).c <= 9, true);
  assert.equal(capture.MAX_MARKERS, 8);
  const junk = capture.harvestMarkersFromText('⟦mem: done⟧ ⟦mem decision: done⟧ ⟦mem fact: fixed it⟧ ⟦mem todo: TODO⟧ ⟦mem decision: see above⟧ ⟦mem fact: this works now⟧ ⟦mem decision: ok⟧');
  assert.equal(junk.length, 0);
  const a = store.saveMemory({ project: P.id, kind: 'note', text: '🚀🚀🚀 🔥🔥 !!!' });
  const b = store.saveMemory({ project: P.id, kind: 'note', text: '🚀🚀🚀 🔥🔥 !!!' });
  assert.equal(a.id, b.id, 'exact text dedup even without a SimHash');
});

test('P1: supersession — subject: value, negation, "instead of", "switched from", Turkish "artık X değil Y"', () => {
  const r = repo('p1sup'); const P = resolveProject(r); const pid = P.id;
  const redis = store.saveMemory({ project: pid, kind: 'decision', text: 'Use Redis for caching search results', source: 'agent' });
  const lru = store.saveMemory({ project: pid, kind: 'decision', text: 'Do not use Redis for caching search results; use the in-process LRU', source: 'agent' });
  assert.equal(openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(redis.id).s, lru.id, 'negation supersedes');
  const rest = store.saveMemory({ project: pid, kind: 'decision', text: 'API style: REST endpoints via Express under /api/v1', source: 'agent' });
  const both = store.saveMemory({ project: pid, kind: 'decision', text: 'API: tRPC routers in src/trpc; REST only for the public /webhooks endpoint', source: 'agent' });
  store.saveMemory({ project: pid, kind: 'decision', text: 'Internal API uses tRPC instead of REST', source: 'agent' });
  assert.ok(openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(rest.id).s, '"instead of REST" retires the REST decision');
  assert.ok(!openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(both.id).s, 'a line that mentions the new choice stays');
  const npm = store.saveMemory({ project: pid, kind: 'decision', text: 'package manager: npm with workspaces', source: 'agent' });
  const fix = store.saveMemory({ project: pid, kind: 'fix', text: '`npm test` failed → fixed via package.json', source: 'auto' });
  store.saveMemory({ project: pid, kind: 'decision', text: 'We switched from npm to pnpm; use pnpm for all scripts', source: 'agent' });
  assert.ok(openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(npm.id).s);
  assert.ok(openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(fix.id).s, 'fixes for the replaced tool retire too');
  const yarn = store.saveMemory({ project: pid, kind: 'decision', text: 'yarn ile kuruyoruz paketleri', source: 'agent' });
  store.saveMemory({ project: pid, kind: 'decision', text: 'Artık yarn değil pnpm kullanıyoruz', source: 'user' });
  assert.ok(openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(yarn.id).s);
  assert.deepEqual(store.replacementOf('switched from Jest to Vitest'), { old: ['jest'], new: ['vitest'] });
});

test('P1: an agent can update a user value only when the user just asked for it; never a pinned one', async () => {
  const r = repo('p1conf'); const P = resolveProject(r);
  const u = store.saveMemory({ project: P.id, kind: 'decision', text: 'tests: vitest with --pool=forks', source: 'user' });
  await hooks.runHook('UserPromptSubmit', { agent: 'codex', payload: { session_id: 'c1', cwd: r, prompt: 'switch tests to node:test please' } });
  await hooks.runHook('Stop', { agent: 'codex', payload: { session_id: 'c1', cwd: r, last_assistant_message: 'Switched. ⟦mem decision: tests: node:test runner (vitest removed)⟧' } });
  assert.ok(openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(u.id).s, 'user-confirmed');
  const pinned = store.saveMemory({ project: P.id, kind: 'decision', text: 'database: postgres 16', source: 'user', pin: true });
  await hooks.runHook('UserPromptSubmit', { agent: 'codex', payload: { session_id: 'c2', cwd: r, prompt: 'try mysql 8 for the database' } });
  await hooks.runHook('Stop', { agent: 'codex', payload: { session_id: 'c2', cwd: r, last_assistant_message: '⟦mem decision: database: mysql 8⟧' } });
  assert.ok(!openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(pinned.id).s, 'pinned stays');
});

test('P1/P2: card format — spelled-out headings, dates on decisions/facts, #id only with detail, save rules in the footer, real token budget', () => {
  const r = repo('p2card'); const P = resolveProject(r);
  store.saveMemory({ project: P.id, kind: 'convention', text: 'Always run the linter before committing', source: 'user' });
  store.saveMemory({ project: P.id, kind: 'decision', text: 'package manager: pnpm', source: 'user' });
  store.saveMemory({ project: P.id, kind: 'fact', text: 'items endpoint paginates with ?cursor=&limit= (limit max 100)', source: 'agent' });
  store.saveMemory({ project: P.id, kind: 'fix', text: '`pnpm test` failed → fixed via src/x.ts', body: 'Error: expected 2 to be 3', source: 'auto' });
  const c = inject.sessionContext({ project: P, session: null }).text;
  assert.match(c, /^conventions the user recorded:/m); assert.match(c, /^decisions \(newest wins\):/m); assert.match(c, /^facts:/m); assert.match(c, /^past fixes:/m);
  assert.ok(!/\[[CDFPSN]\] /.test(c), 'no single-letter tags');
  assert.match(c, /package manager: pnpm · \d\d-\d\d$/m);
  assert.ok(!/Always run the linter before committing #/.test(c), 'no #id without detail');
  assert.match(c, /fixed in src\/x\.ts #\w+/, '#id where mem_get has more (compact fix line)');
  assert.match(c, /<subject>: <value>/); assert.match(c, /replaces/);
  // v2: the card is worded as facts (no imperative "follow"/"save" headers)
  assert.ok(!/follow unless|^save /m.test(c));
  assert.match(inject.sessionContext({ project: P, session: null, hint: 'cli' }).text, /sam-memory add/);
  // real o200k counts, when tiktoken is available
  const big = repo('p2big'); const PB = resolveProject(big);
  for (let i = 0; i < 40; i++) store.saveMemory({ project: PB.id, kind: ['convention', 'decision', 'fact', 'fix', 'todo'][i % 5], text: `memory number ${i}: kargo firması API’si saatte ${i * 100} istekle sınırlı, see src/mod${i}/index.ts #${i}`, source: 'user' });
  // v2: ≤40 memories would be a full dump (its own budget); this checks the ranked card's budget. Turkish-heavy → ×1.25
  const card = inject.sessionContext({ project: PB, session: null, smallStore: false }).text;
  const py = spawnSync('python3', ['-c', 'import sys,tiktoken;print(len(tiktoken.get_encoding("o200k_base").encode(sys.stdin.read())))'], { input: card, encoding: 'utf8' });
  if (py.status === 0) assert.ok(Number(py.stdout) <= 400, `real tokens ${py.stdout.trim()} > 400`);
  assert.ok(text.tokens(card) <= 400);
});

test('P1: a parent folder with several repos is "unscoped": not global, not on repo cards; routed when a repo is named', async () => {
  const code = join(TMP, 'code'); mkdirSync(code);
  const A = repo('shop-api', undefined, code); repo('shop-web', undefined, code);
  const PP = resolveProject(code);
  assert.equal(PP.id, 'unscoped');
  await hooks.runHook('UserPromptSubmit', { agent: 'claude', payload: { session_id: 'par', cwd: code, prompt: 'From now on use port 4000 for local dev servers.' } });
  await hooks.runHook('UserPromptSubmit', { agent: 'claude', payload: { session_id: 'par', cwd: code, prompt: 'I prefer short answers. Always answer in bullet points.' } });
  const web = ctx(await hooks.runHook('SessionStart', { agent: 'claude', payload: { session_id: 'w', cwd: join(code, 'shop-web') } }));
  assert.ok(!/port 4000/.test(web), 'unscoped directives stay off repo cards');
  assert.ok(!openDb().prepare("SELECT 1 FROM memories WHERE project = 'global' AND gist LIKE '%port 4000%'").get());
  await hooks.runHook('UserPromptSubmit', { agent: 'claude', payload: { session_id: 'par2', cwd: code, prompt: 'In shop-api, bump the pg pool to 20 connections.' } });
  await hooks.runHook('Stop', { agent: 'claude', payload: { session_id: 'par2', cwd: code, last_assistant_message: 'Done ⟦mem decision: database: pg pool max 20 connections⟧' } });
  assert.ok(live(resolveProject(A).id, '%pg pool max 20%').length, 'routed to the named repo');
});

test('P1 team: export merges with the file (hand edits kept, deletions stay deleted), no personal kinds, no pin inheritance', () => {
  const r = repo('teamx'); const P = resolveProject(r);
  store.saveMemory({ project: P.id, kind: 'decision', text: 'package manager: pnpm', pin: true, source: 'user' });
  store.saveMemory({ project: P.id, kind: 'convention', text: 'never call Stripe from the browser; all calls go through src/server/stripe.ts', source: 'user' });
  store.saveMemory({ project: P.id, kind: 'preference', text: 'answer me in short bullet points', source: 'user' });
  const f = portable.writeTeamFile(P);
  let md = readFileSync(f, 'utf8');
  assert.ok(!/bullet points/.test(md), 'preferences are personal');
  md = md.replace('package manager: pnpm', 'package manager: bun').replace(/^- \[C\] never call Stripe.*\n/m, '') + '\n- [D] payments: retries use exponential backoff, max 5 attempts\n';
  writeFileSync(f, md);
  store.saveMemory({ project: P.id, kind: 'fact', text: 'a brand new local fact after the edit', source: 'user' });
  portable.writeTeamFile(P);
  const out = readFileSync(f, 'utf8');
  assert.match(out, /package manager: bun/); assert.ok(!/package manager: pnpm/.test(out), 'hand edit kept');
  assert.ok(!/never call Stripe/.test(out), 'deleted line stays deleted');
  assert.match(out, /exponential backoff/); assert.match(out, /brand new local fact/);
  // a teammate's team line never takes the user's pin
  const other = repo('teamy'); const PO = resolveProject(other);
  const mine = store.saveMemory({ project: PO.id, kind: 'decision', text: 'package manager: pnpm', pin: true, source: 'user' });
  mkdirSync(join(other, '.sam')); writeFileSync(join(other, '.sam', 'memory.md'), '## decision\r\n- [D] package manager: bun 📌\r\n- [D] queue: SQS, not Kafka\r\n');
  portable.setTrusted(PO, true, portable.previewTeamFile(PO).hash);
  const n = portable.syncTeamFile(PO);
  assert.equal(n, 1, 'CRLF file imports (H2)');
  assert.ok(!openDb().prepare('SELECT superseded_by s FROM memories WHERE id = ?').get(mine.id).s);
  assert.ok(!openDb().prepare("SELECT 1 FROM memories WHERE project = ? AND source = 'team' AND pinned = 1").get(PO.id));
});

test('H2: a team file that parses to 0 rows is not recorded as imported', () => {
  const r = repo('h2'); const P = resolveProject(r);
  mkdirSync(join(r, '.sam')); writeFileSync(join(r, '.sam', 'memory.md'), '## decision\n- x\n- y\n'); // bullets, none parseable
  portable.setTrusted(P, true, portable.previewTeamFile(P).hash);
  portable.syncTeamFile(P);
  assert.ok(!openDb().prepare('SELECT 1 FROM meta WHERE k = ?').get('team:' + P.id));
});

test('P1 Cursor: beforeSubmitPrompt does not mark recall as shown; the file note still arrives', async () => {
  const r = repo('cur'); const P = resolveProject(r);
  store.saveMemory({ project: P.id, kind: 'convention', text: 'webhook retries are idempotent via the delivery id in src/hooks/receive.ts', files: ['src/hooks/receive.ts'], source: 'user' });
  await hooks.runHook('beforeSubmitPrompt', { agent: 'cursor', payload: { conversation_id: 'k', workspace_roots: [r], prompt: 'How are webhook retries made idempotent?' } });
  const fn = await hooks.runHook('postToolUse', { agent: 'cursor', payload: { conversation_id: 'k', workspace_roots: [r], tool_name: 'Read', tool_input: { file_path: join(r, 'src/hooks/receive.ts') } } });
  assert.match(ctx(fn), /idempotent/);
});

test('P1 subagents: the ledger is per agent_id; digests stay per session; SubagentStop harvests', async () => {
  const r = repo('sub'); const P = resolveProject(r);
  store.saveMemory({ project: P.id, kind: 'convention', text: 'auth middleware must run before rate limiting in src/http/app.ts', files: ['src/http/app.ts'], source: 'user' });
  await hooks.runHook('SessionStart', { agent: 'claude', payload: { session_id: 'par', cwd: r } });
  const sub = await hooks.runHook('PostToolUse', { agent: 'claude', payload: { session_id: 'par', agent_id: 'sub-1', cwd: r, tool_name: 'Read', tool_input: { file_path: join(r, 'src/http/app.ts') } } });
  assert.match(ctx(sub), /auth middleware/);
  assert.ok(openDb().prepare("SELECT 1 FROM events WHERE session = 'claude:par' AND type = 'read'").get(), 'events stay on the session');
  await hooks.runHook('SubagentStop', { agent: 'claude', payload: { session_id: 'par', agent_id: 'sub-1', cwd: r, last_assistant_message: '⟦mem bug: CORS middleware is registered after the router⟧' } });
  assert.ok(live(P.id, '%CORS middleware%').length);
});

test('P1 Turkish directives; reminders with time words are not durable', () => {
  const t = (s) => capture.extractDirectives(s);
  assert.equal(t('Bundan sonra bana Türkçe cevap ver.')[0]?.kind, 'preference');
  assert.equal(t('Artık npm değil pnpm kullanıyoruz.')[0]?.kind, 'decision');
  assert.equal(t('Sakın console.log bırakma.')[0]?.kind, 'convention');
  assert.equal(t('Önemli: veritabanı şeması değişirse migration yaz.').length, 1);
  assert.equal(t('Paket yöneticisi olarak pnpm kullanıyoruz, bunu unutma.')[0]?.text, 'Paket yöneticisi olarak pnpm kullanıyoruz');
  const y = t('Yarın toplantı var, unutma.')[0];
  assert.equal(y.kind, 'todo'); assert.ok(y.ephemeral);
  assert.equal(t('Bundan sonra testleri çalıştır ve sonucu göster.').length, 0, 'a one-off "after this" is not a rule');
  assert.equal(t('Artık çalışıyor.').length, 0);
});

test('P2: fix gists drop timings, so the same failure on three days is one memory', () => {
  const r = repo('fixdup'); const P = resolveProject(r);
  for (const [i, ms] of [[1, 737], [2, 774], [3, 811]]) {
    const s = 'claude:fd' + i;
    capture.ensureSession({ session: s, project: P, agent: 'claude' });
    capture.recordTool({ session: s, project: P, agent: 'claude', tool: 'Bash', input: { command: 'pnpm test' }, response: { stdout: `❯ src/retry.test.ts (2 tests | 1 failed) ${ms}ms\nAssertionError: expected 2 to be 3`, exit_code: 1 }, root: P.root });
    capture.recordTool({ session: s, project: P, agent: 'claude', tool: 'Edit', input: { file_path: join(r, 'src/retry.ts') }, root: P.root });
    capture.recordTool({ session: s, project: P, agent: 'claude', tool: 'Bash', input: { command: 'cd ' + r + ' && pnpm test 2>&1 | tail -20' }, response: { stdout: 'ok', exit_code: 0 }, root: P.root });
  }
  const fixes = openDb().prepare("SELECT body FROM memories WHERE project = ? AND kind = 'fix' AND superseded_by IS NULL").all(P.id);
  assert.equal(fixes.length, 1);
  assert.ok(!/\d+ms/.test(fixes[0].body)); assert.match(fixes[0].body, /AssertionError/);
  assert.equal(capture.stripTimings('took 1.2s (737ms) total'), 'took total');
});

test('H3/M3: canonical paths and remote parsing', async () => {
  const { remotesFromConfig, pickRemote } = await import('../src/project.js');
  assert.equal(text.canonicalPath('/c/Users/x', { platform: 'win32' }), 'C:\\Users\\x');
  assert.equal(text.canonicalPath('c:\\Users\\x', { platform: 'win32' }), 'C:\\Users\\x');
  assert.equal(text.shortPath('C:\\r\\src\\a.ts', 'c:\\r', { platform: 'win32' }), 'src/a.ts');
  assert.equal(text.shortPath('D:\\o\\x.ts', 'C:\\r', { platform: 'win32' }), 'D:/o/x.ts');
  assert.equal(text.canonicalPath('/tmp/Masau\u0308stu\u0308'), text.canonicalPath('/tmp/Masa\u00fcst\u00fc'));
  assert.equal(pickRemote('[remote "origin"]\n\tpushurl = git@github.com:me/fork.git\n\turl = git@github.com:acme/app.git\n'), 'git@github.com:acme/app.git');
  assert.equal(pickRemote('[remote "upstream"]\n\turl = "https://github.com/acme/app.git"\n'), 'https://github.com/acme/app.git');
  assert.equal(pickRemote('[remote "zeta"]\r\n\turl = a\r\n[remote "beta"]\r\n\turl = b\r\n'), 'b');
  assert.deepEqual(remotesFromConfig('[core]\n\turl = x\n'), {});
});
