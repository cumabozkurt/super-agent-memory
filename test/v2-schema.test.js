// v2 schema workstream: privacy (purge, tombstones, PII redaction), memory model (procedure kind, additive guard,
// validity window, two-stage dedup) and doctor's newer-schema report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const TMP = mkdtempSync(join(tmpdir(), 'sam-v2s-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const SAM_BIN = fileURLToPath(new URL('../bin/sam.js', import.meta.url));
process.env.SAM_TEST = '1';
process.env.SAM_HOME = join(TMP, 'home');
process.env.SAM_INSTALL_HOME = join(TMP, 'user');
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));

const text = await import('../src/text.js');
const store = await import('../src/store.js');
const capture = await import('../src/capture.js');
const inject = await import('../src/inject.js');
const { gc, purge } = await import('../src/gc.js');
const { openDb, closeDb, SCHEMA_VERSION } = await import('../src/db.js');
const { resolveProject } = await import('../src/project.js');
const { config } = await import('../src/config.js');

function repo(name, url = `https://github.com/acme/${name}.git`) {
  const d = join(TMP, name);
  mkdirSync(join(d, '.git'), { recursive: true });
  writeFileSync(join(d, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  return d;
}
const live = (id) => { const r = openDb().prepare('SELECT superseded_by FROM memories WHERE id = ?').get(id); return !!r && r.superseded_by == null; };

// a valid TCKN from 9 leading digits (official checksum)
function tckn(base9) {
  const d = [...base9].map(Number);
  const d10 = (((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10 + 10) % 10;
  const d11 = (d.reduce((a, b) => a + b, 0) + d10) % 10;
  return base9 + d10 + d11;
}

// ---------------- PII redaction ----------------

test('PII: e-mail, phone (TR + international), IBAN (mod-97) and TCKN (checksum) are masked', () => {
  const r = (s) => text.redactPII(s);
  assert.equal(r('mail ali.veli@example.com.tr now'), 'mail [email] now');
  assert.equal(r('<Jane.Doe+ci@corp.io>'), '<[email]>');
  assert.equal(r('IBAN TR33 0006 1005 1978 6457 8413 26'), 'IBAN [iban]');
  assert.equal(r('TR330006100519786457841326'), '[iban]');
  assert.equal(r('DE89 3704 0044 0532 0130 00 and 1234'), '[iban] and 1234', 'a trailing unrelated group is kept');
  assert.equal(r('GB82WEST12345698765432'), '[iban]');
  const id = tckn('123456789');
  assert.ok(text.tcknValid(id));
  assert.equal(r(`TC kimlik ${id}.`), 'TC kimlik [tckn].');
  for (const p of ['+90 532 123 45 67', '+905321234567', '0532 123 45 67', '05321234567', '(0212) 555 12 34', '0 (532) 123-45-67',
    '+1 (415) 555-0100', '+44 20 7946 0958', '+14155550100', '+49 30 901820']) {
    assert.equal(r(`ara ${p} lütfen`), 'ara [phone] lütfen', p);
  }
  // redact() applies it by default (config redactPII = true) and keeps secret masking
  assert.equal(config().redactPII, true);
  assert.equal(text.redact('token=abcd1234efgh, mail a@b.co'), 'token=[redacted], mail [email]');
  assert.equal(text.redact('mail a@b.co', { pii: false }), 'mail a@b.co');
});

test('PII: no false positives on SHAs, timestamps, semver, ports, numeric ids, dates, remotes', () => {
  const keep = [
    'commit 3f2a9c1b8e7d6c5b4a39281706f5e4d3c2b1a090', 'short sha 1a2b3c4 and 0532123', 'merge 05321234567abcdef0123456789abcdef0123456',
    'v1.2.3', 'node 22.16.0', '1.0.0+20130313144700', '1.0.0-rc.1+build.5114f85', '^4.17.21',
    '2026-10-07T14:37:00+03:00', '2026-10-07 10:00:00', '07.10.2026', '05.10.2026', '20261007', 'Date: Wed, 07 Oct 2026 14:37:00 +0300',
    'ts 1696680000000', 'ts 1696680000', 'epoch 1759840620123',
    'localhost:8080', '0.0.0.0:5432', '127.0.0.1:30532', 'port 5432', '192.168.1.10:3000', '1.2.3.4', '::1',
    'id 98765432109', 'user 12345678901', 'order #05321234567', 'issue #4521', 'pid 12345678901234', 'card 4111 1111 1111',
    'chmod 0755', 'exit 137', 'price +5.00', '+1', 'x +12', 'retry in +300ms',
    'git@github.com:acme/demo.git', 'ssh://git@github.com/acme/demo.git', 'logo@2x.png', 'npm i @types/node@22.1.0', 'pnpm add react@19.0.0',
    'TR33 0006 1005 1978 6457 8413 27', 'AB12CDEFGHIJKLMNOP', 'sha256:0532123456789abc', 'uuid 123e4567-e89b-12d3-a456-426614174000',
  ];
  for (const s of keep) assert.equal(text.redactPII(s), s, 'over-redacted: ' + s);
  // a random 11-digit id that happens to pass the TCKN checksum is masked (1 in 100): accepted trade-off
  assert.ok(!text.tcknValid('12345678901'));
});

test('PII: linear time on adversarial input', () => {
  const t0 = Date.now();
  text.redactPII('+1 '.repeat(50000) + 'a@'.repeat(50000) + 'TR12 '.repeat(50000) + '0532 '.repeat(50000));
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + 'ms');
});

test('PII: memories are stored redacted', () => {
  const r = store.saveMemory({ project: 'pii', kind: 'fact', text: 'Support escalations go to ops@acme.com.tr or +90 212 555 12 34', source: 'user' });
  const g = openDb().prepare('SELECT gist FROM memories WHERE id = ?').get(r.id).gist;
  assert.equal(g, 'Support escalations go to [email] or [phone]');
});

// ---------------- memory model ----------------

test('procedure kind: tag R, aliases, long half-life, durable in the card next to conventions', () => {
  assert.equal(store.KINDS.procedure.tag, 'R');
  assert.ok(store.KINDS.procedure.halfLife >= 365);
  for (const a of ['procedure', 'howto', 'recipe', 'runbook', 'prosedür', 'yöntem']) assert.equal(store.normKind(a), 'procedure', a);
  assert.ok(store.DURABLE_KINDS.has('procedure') && store.STANDING.has('procedure'));
  const P = resolveProject(repo('proc'));
  const m = store.saveMemory({ project: P.id, kind: 'procedure', text: 'Release: bump version, run pnpm build, tag vX.Y.Z, then npm publish --provenance', source: 'user' });
  assert.match(store.line(openDb().prepare('SELECT * FROM memories WHERE id = ?').get(m.id)), /^\[R\] Release/);
  const card = inject.sessionContext({ project: P, session: null, write: () => {} });
  assert.match(card.text, /how-to/);
  assert.match(card.text, /npm publish/);
});

test('additive phrases never supersede: both values stay (EN + TR); a real replacement still does', () => {
  const P = 'additive';
  const a = store.saveMemory({ project: P, kind: 'decision', text: 'test runner: vitest', source: 'user' });
  const b = store.saveMemory({ project: P, kind: 'decision', text: 'test runner: also playwright for e2e', source: 'user' });
  assert.equal(b.status, 'created'); assert.ok(live(a.id) && live(b.id));
  const c = store.saveMemory({ project: P, kind: 'decision', text: 'lint: eslint', source: 'user' });
  const d = store.saveMemory({ project: P, kind: 'decision', text: 'lint: ayrıca biome da kullanıyoruz', source: 'user' });
  assert.ok(live(c.id) && live(d.id));
  const e = store.saveMemory({ project: P, kind: 'decision', text: 'ci: github actions', source: 'user' });
  const f = store.saveMemory({ project: P, kind: 'decision', text: 'ci: buildkite de ekle', source: 'user' });
  assert.ok(live(e.id) && live(f.id));
  for (const s of ['we also deploy to fly.io', 'Additionally run the smoke tests', 'staging as well', 'bunun yanında redis', 'plus a nightly job']) assert.ok(store.isAdditive(s), s);
  for (const s of ['package manager: pnpm', 'also-ran is a word', 'pluses and minuses', 'PG_POOL_MAX: 40 since the move to Cloud SQL Enterprise Plus', 'upgrade to the Plus tier']) assert.ok(!store.isAdditive(s), s);
  // no additive cue: the topic value is replaced as before
  const g = store.saveMemory({ project: P, kind: 'decision', text: 'test runner: node:test', source: 'user' });
  assert.equal(g.status, 'superseded'); assert.ok(!live(a.id));
});

test('valid_from / valid_to: stored, excluded from LIVE_SQL / ls outside the window; expired rows are not merge targets', () => {
  const P = 'validity';
  const t = Date.now();
  const past = store.saveMemory({ project: P, kind: 'fact', text: 'Code freeze for the 2.0 release is in effect', validTo: t - 1000, source: 'user' });
  const future = store.saveMemory({ project: P, kind: 'fact', text: 'Staging cluster migrates to eu-west-2 next quarter', validFrom: new Date(t + 86400000), source: 'user' });
  const now = store.saveMemory({ project: P, kind: 'fact', text: 'On-call rotation is owned by the platform team', validFrom: t - 1000, validTo: new Date(t + 86400000).toISOString(), source: 'user' });
  const row = openDb().prepare('SELECT valid_from, valid_to FROM memories WHERE id = ?').get(now.id);
  assert.equal(row.valid_from, t - 1000); assert.ok(row.valid_to > t);
  const ids = openDb().prepare(`SELECT id FROM memories WHERE project = ? AND ${store.LIVE_SQL}`).all(P, ...store.liveArgs()).map((r) => r.id);
  assert.deepEqual(ids, [now.id]);
  const ids2 = openDb().prepare(`SELECT m.id FROM memories m WHERE m.project = ? AND ${store.liveSql('m')}`).all(P, ...store.liveArgs()).map((r) => r.id);
  assert.deepEqual(ids2, [now.id]);
  assert.deepEqual(store.listMemories({ project: P }).map((m) => m.id).filter((id) => [past.id, future.id, now.id].includes(id)), [now.id]);
  assert.ok(store.listMemories({ project: P, all: true }).some((m) => m.id === past.id));
  assert.ok(store.isLive({ superseded_by: null, status: 'active', valid_from: null, valid_to: null }));
  assert.ok(!store.isLive({ superseded_by: null, status: 'quarantined' }));
  // the same statement again after its window closed is a new live row, not a merge into history
  const again = store.saveMemory({ project: P, kind: 'fact', text: 'Code freeze for the 2.0 release is in effect', source: 'user' });
  assert.notEqual(again.id, past.id); assert.equal(again.status, 'created');
  assert.throws(() => store.saveMemory({ project: P, kind: 'fact', text: 'bad window here', validFrom: t, validTo: t - 1 }), /validTo/);
  assert.throws(() => store.saveMemory({ project: P, kind: 'fact', text: 'bad date here', validTo: 'not a date' }), /invalid date/);
});

test('two-stage dedup: SimHash candidates merge only with high word overlap and the same polarity/negation', () => {
  assert.ok(store.sameMeaning('Use pnpm for installs in this repo', 'use pnpm for installs in this repo.'));
  assert.ok(!store.sameMeaning('use moment.js for dates', "don't use moment.js for dates"), 'polarity differs');
  assert.ok(!store.sameMeaning('use lodash in the bundle', 'avoid lodash in the bundle'), 'negation (avoid) differs');
  assert.ok(!store.sameMeaning('kullan redis oturumlar için', 'redis oturumlar için kullanma'), 'Turkish negation differs');
  assert.ok(!store.sameMeaning('deploy api with fly', 'monitor web with datadog'), 'low Jaccard');
  assert.ok(store.jaccard('a b c d', 'a b c e') >= 0.6 && store.jaccard('a b c d', 'a b c e') < 0.61);
  const P = 'dedup2';
  const a = store.saveMemory({ project: P, kind: 'note', text: 'The nightly job rebuilds the search index for all tenants at 02:00 UTC' });
  const b = store.saveMemory({ project: P, kind: 'note', text: 'The nightly job rebuilds the search index for all tenants at 02:00 UTC.' });
  assert.equal(b.id, a.id); assert.equal(b.status, 'merged');
  const c = store.saveMemory({ project: P, kind: 'note', text: 'The nightly job never rebuilds the search index for all tenants at 02:00 UTC' });
  assert.notEqual(c.id, a.id);
  // gc's sweep uses the same stage 2: a near-identical pair with opposite negation stays two rows
  openDb().prepare("UPDATE memories SET simhash = (SELECT simhash FROM memories WHERE id = ?) WHERE id = ?").run(a.id, c.id);
  gc({});
  assert.ok(live(a.id) && live(c.id));
});

// ---------------- tombstones ----------------

test('tombstone fingerprint ignores case, whitespace, punctuation and diacritics; scoped to project or global', () => {
  assert.equal(store.fpExact('p', 'Use  PNPM, never npm!'), store.fpExact('p', 'use pnpm never npm'));
  assert.equal(store.fpExact('p', 'İstanbul ofisi'), store.fpExact('p', 'istanbul OFISI'));
  assert.notEqual(store.fpExact('p', 'use pnpm'), store.fpExact('q', 'use pnpm'));
  assert.notEqual(store.fpExact('p', 'use pnpm'), store.fpExact('p', 'use npm'));
  const db = openDb();
  store.addTombstones(db, 'tp1', ['Secret staging host is build-07.internal']);
  assert.ok(store.isTombstoned('tp1', 'secret STAGING host is   build-07.internal.'));
  assert.ok(!store.isTombstoned('tp2', 'Secret staging host is build-07.internal'));
  store.addTombstones(db, 'global', ['Project Falcon'], { substring: true });
  assert.ok(store.isTombstoned('anywhere', 'the project falcon launch is in may'));
  assert.equal(store.scrubTombstoned('anywhere', 'Notes: Project  FALCON launch.'), 'Notes: [purged] launch.');
  assert.ok(!store.isTombstoned('anywhere', 'falcon alone is fine'));
  const fp = db.prepare('SELECT fp FROM tombstones WHERE project = ?').get('tp1').fp;
  assert.match(fp, /^x:[0-9a-f]{32}$/); // only a hash is kept
});

test('forget --hard tombstones by default: agents, capture and plain user saves cannot re-create it; --force can', async () => {
  const dir = repo('tomb');
  const P = resolveProject(dir);
  const m = store.saveMemory({ project: P.id, kind: 'convention', text: 'Always run migrations with the prod-admin role', source: 'user' });
  assert.equal(store.forget(m.id, { hard: true }), 1);
  assert.equal(openDb().prepare('SELECT COUNT(*) c FROM memories WHERE id = ?').get(m.id).c, 0);
  for (const source of ['agent', 'team', 'import', 'user']) {
    const r = store.saveMemory({ project: P.id, kind: 'convention', text: 'always run MIGRATIONS with the prod-admin role.', source });
    assert.equal(r.status, 'tombstoned', source); assert.equal(r.id, null);
  }
  // capture: the same directive in a user prompt is not re-saved
  const saved = capture.recordPrompt({ session: 'tomb-s1', project: P, agent: 'claude', prompt: 'always run migrations with the prod-admin role' });
  assert.equal(saved.length, 0);
  // an explicit user re-add lifts the exact fingerprint
  const back = store.saveMemory({ project: P.id, kind: 'convention', text: 'Always run migrations with the prod-admin role', source: 'user', allowTombstoned: true });
  assert.equal(back.status, 'created');
  // soft forget: no tombstone unless asked (the retained row already blocks non-user writers)
  const s = store.saveMemory({ project: P.id, kind: 'fact', text: 'The legacy billing cron runs on host b2', source: 'user' });
  store.forget(s.id);
  assert.ok(!store.isTombstoned(P.id, 'The legacy billing cron runs on host b2'));
  const s2 = store.saveMemory({ project: P.id, kind: 'fact', text: 'The legacy queue worker runs on host q9', source: 'user' });
  store.forget(s2.id, { tombstone: true });
  assert.ok(store.isTombstoned(P.id, 'the legacy queue worker runs on host q9'));
  // --no-tombstone on a hard forget
  const s3 = store.saveMemory({ project: P.id, kind: 'fact', text: 'Old metrics live in graphite on port 2003', source: 'user' });
  store.forget(s3.id, { hard: true, tombstone: false });
  assert.equal(store.saveMemory({ project: P.id, kind: 'fact', text: 'Old metrics live in graphite on port 2003', source: 'user' }).status, 'created');
});

// ---------------- purge ----------------

test('purge <id>: erases the memory, its older versions, events, first prompt, vault, ledger, handoff, digest, team file; VACUUMs', async () => {
  const dir = repo('purge1');
  const P = resolveProject(dir);
  const db = openDb();
  const SECRET = 'Payroll export goes to sftp host zebra-payroll-91';
  const v1 = store.saveMemory({ project: P.id, kind: 'decision', text: 'payroll export: sftp host zebra-payroll-90', source: 'user' });
  const v2 = store.saveMemory({ project: P.id, kind: 'decision', text: 'payroll export: ' + SECRET, source: 'user' });
  assert.equal(v2.status, 'superseded');
  const other = store.saveMemory({ project: P.id, kind: 'decision', text: 'Frontend uses React 19 with the compiler on', source: 'user' });
  capture.ensureSession({ session: 'p1', project: P, agent: 'claude' });
  capture.recordPrompt({ session: 'p1', project: P, agent: 'claude', prompt: 'remind me: ' + SECRET + ' and keep it' });
  db.prepare('INSERT INTO vault(id, project, cmd, exit_code, bytes, shown_bytes, output, created_at) VALUES (?, ?, ?, 0, 10, 10, ?, ?)')
    .run('ozz1', P.id, 'cat notes.txt', deflateSync(Buffer.from('line\n' + SECRET + '\n')), Date.now());
  db.prepare('INSERT INTO vault(id, project, cmd, exit_code, bytes, shown_bytes, output, created_at) VALUES (?, ?, ?, 0, 10, 10, ?, ?)')
    .run('ozz2', P.id, 'ls', deflateSync(Buffer.from('README.md\n')), Date.now());
  db.prepare('INSERT INTO injections(session, mem_id, ts) VALUES (?, ?, ?)').run('p1', v2.id, Date.now());
  db.prepare('INSERT INTO handoffs(id, project, summary, created_at) VALUES (?, ?, ?, ?)').run('h1', P.id, 'next: verify ' + SECRET, Date.now());
  const dg = store.saveMemory({ project: P.id, kind: 'session', text: 'digest', gist: 'payroll session', body: 'Asked: ' + SECRET, source: 'auto', session: 'p1' });
  mkdirSync(join(dir, '.sam'), { recursive: true });
  writeFileSync(join(dir, '.sam', 'memory.md'), `# Project memory\n\n## decision\n\n- [D] payroll export: ${SECRET}\n- [D] Frontend uses React 19 with the compiler on\n`);
  writeFileSync(config().dbPath + '.corrupt-2026-01-01T00-00-00-000Z', 'old copy');

  const dry = purge({ ids: [v2.id], dryRun: true });
  assert.ok(dry.memories >= 3 && dry.events >= 1, JSON.stringify(dry));
  assert.ok(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(v2.id), 'dry run deletes nothing');
  assert.match(readFileSync(join(dir, '.sam', 'memory.md'), 'utf8'), /zebra/);

  const r = purge({ ids: [v2.id] });
  for (const id of [v1.id, v2.id, dg.id]) assert.ok(!db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id), 'gone: ' + id);
  assert.ok(live(other.id), 'unrelated memory kept');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE detail LIKE '%zebra%'").get().c, 0);
  assert.equal(db.prepare("SELECT first_prompt FROM sessions WHERE id = 'p1'").get().first_prompt, null);
  assert.ok(!db.prepare("SELECT 1 FROM vault WHERE id = 'ozz1'").get()); assert.ok(db.prepare("SELECT 1 FROM vault WHERE id = 'ozz2'").get());
  assert.equal(db.prepare('SELECT COUNT(*) c FROM injections WHERE mem_id = ?').get(v2.id).c, 0);
  assert.ok(!db.prepare("SELECT 1 FROM handoffs WHERE id = 'h1'").get());
  const tf = readFileSync(join(dir, '.sam', 'memory.md'), 'utf8');
  assert.ok(!/zebra/.test(tf) && /React 19/.test(tf));
  assert.equal(r.teamFiles.length, 1);
  assert.equal(r.backups.length, 1, 'backup copies are reported');
  assert.ok(r.vacuum, 'vacuumed: ' + r.vacuumError);
  assert.ok(r.tombstones >= 2);
  // FTS no longer finds it, and the bytes are gone from the database file and its WAL
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mem_fts WHERE mem_fts MATCH 'zebra'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mem_tri WHERE mem_tri MATCH 'zebra'").get().c, 0);
  for (const f of [config().dbPath, config().dbPath + '-wal']) {
    if (existsSync(f)) assert.ok(!readFileSync(f).includes('zebra-payroll'), 'plaintext left in ' + f);
  }
  // re-capture is refused (tombstone), raw prompt text is scrubbed
  assert.equal(store.saveMemory({ project: P.id, kind: 'decision', text: 'payroll export: ' + SECRET, source: 'agent' }).status, 'tombstoned');
  const r2 = purge({ ids: [], match: 'nothing-like-this-exists', includeBackups: true });
  assert.equal(r2.backupsDeleted, 1); assert.equal(r2.backups.length, 0);
});

test('purge --all-matching: every table, every project; substring tombstone scrubs later capture', () => {
  const A = resolveProject(repo('pm-a')), B = resolveProject(repo('pm-b'));
  const db = openDb();
  const a = store.saveMemory({ project: A.id, kind: 'fact', text: 'Customer Kestrel Holdings is on the enterprise plan', source: 'user' });
  const b = store.saveMemory({ project: B.id, kind: 'note', text: 'Ask kestrel  holdings about the SSO rollout' });
  const c = store.saveMemory({ project: B.id, kind: 'note', text: 'Rotate the SSO certificate in March' });
  capture.ensureSession({ session: 'pm1', project: A, agent: 'codex' });
  capture.recordPrompt({ session: 'pm1', project: A, agent: 'codex', prompt: 'draft a mail to KESTREL HOLDINGS legal' });
  const r = purge({ match: 'Kestrel Holdings' });
  assert.ok(!db.prepare('SELECT 1 FROM memories WHERE id IN (?, ?)').get(a.id, b.id));
  assert.ok(live(c.id));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE lower(detail) LIKE '%kestrel%'").get().c, 0);
  assert.ok(r.tombstones >= 1);
  // later: a prompt mentioning it is stored scrubbed, a memory containing it is refused
  capture.recordPrompt({ session: 'pm1', project: B, agent: 'codex', prompt: 'call kestrel holdings tomorrow about renewal' });
  const ev = db.prepare("SELECT detail FROM events WHERE session = 'pm1' ORDER BY id DESC LIMIT 1").get().detail;
  assert.equal(ev, 'call [purged] tomorrow about renewal');
  assert.equal(store.saveMemory({ project: B.id, kind: 'fact', text: 'Kestrel Holdings renews in June', source: 'user' }).status, 'tombstoned');
  assert.equal(store.saveMemory({ project: B.id, kind: 'fact', text: 'Kestrel renews in June', source: 'user' }).status, 'created');
});

test('purge --project: all rows of one project, nothing else', () => {
  const A = resolveProject(repo('pp-a')), B = resolveProject(repo('pp-b'));
  const db = openDb();
  const a = store.saveMemory({ project: A.id, kind: 'fact', text: 'Project A uses a Postgres read replica', source: 'user' });
  const b = store.saveMemory({ project: B.id, kind: 'fact', text: 'Project B uses DynamoDB streams', source: 'user' });
  capture.ensureSession({ session: 'pp1', project: A, agent: 'claude' });
  capture.recordPrompt({ session: 'pp1', project: A, agent: 'claude', prompt: 'look at the replica lag' });
  const r = purge({ project: A.id });
  assert.ok(r.memories >= 1 && r.events >= 1 && r.sessions >= 1);
  assert.ok(!db.prepare('SELECT 1 FROM memories WHERE id = ?').get(a.id));
  assert.ok(live(b.id));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events WHERE project = ?').get(A.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE project = ?').get(A.id).c, 0);
  // a project wipe does not tombstone by default (a fresh start may re-learn the same facts)
  assert.equal(store.saveMemory({ project: A.id, kind: 'fact', text: 'Project A uses a Postgres read replica', source: 'user' }).status, 'created');
});

// ---------------- CLI ----------------

const CLI_TMP = join(TMP, 'cli');
const CLI_REPO = join(CLI_TMP, 'repo');
mkdirSync(join(CLI_REPO, '.git'), { recursive: true });
writeFileSync(join(CLI_REPO, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/purgecli.git\n');
const ENV = { ...process.env, SAM_TEST: '1', SAM_HOME: join(CLI_TMP, 'samhome'), SAM_INSTALL_HOME: join(CLI_TMP, 'user'), SAM_DEBUG: '' };
const sam = (args, { env = {}, input } = {}) => spawnSync(process.execPath, [SAM_BIN, ...args], { encoding: 'utf8', cwd: CLI_REPO, input, env: { ...ENV, ...env } });

test('CLI purge: needs --yes without a terminal, reports backups, --include-backups deletes them; forget --hard tombstones', () => {
  const add = sam(['add', 'Billing webhooks are signed with the vault key named orca-hmac']);
  const id = add.stdout.match(/#(\w+)/)[1];
  const dbPath = join(ENV.SAM_HOME, 'sam.db');
  writeFileSync(dbPath + '.corrupt-2026-02-02T00-00-00-000Z', 'old');
  const no = sam(['purge', id]);
  assert.equal(no.status, 1); assert.match(no.stdout, /not purged/); assert.match(no.stdout, /orca-hmac/);
  assert.match(sam(['get', id]).stdout, /orca-hmac/, 'still there');
  const dry = sam(['purge', id, '--dry-run']);
  assert.match(dry.stdout, /dry run/);
  const yes = sam(['purge', id, '--yes']);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /purged: 1 memories/);
  assert.match(yes.stdout, /--include-backups/);
  assert.ok(existsSync(dbPath + '.corrupt-2026-02-02T00-00-00-000Z'));
  assert.equal(sam(['get', id]).status, 1);
  const re = sam(['add', 'billing webhooks are signed with the vault key named ORCA-HMAC']);
  assert.equal(re.status, 1); assert.match(re.stdout, /tombstone/);
  assert.match(sam(['add', '--force', 'billing webhooks are signed with the vault key named ORCA-HMAC']).stdout, /^created/);
  const b = sam(['purge', '--all-matching', 'orca-hmac', '--yes', '--include-backups']);
  assert.equal(b.status, 0, b.stderr); assert.match(b.stdout, /deleted 1 backup copy/);
  assert.ok(!existsSync(dbPath + '.corrupt-2026-02-02T00-00-00-000Z'));
  assert.equal(sam(['purge']).status, 2);
  const f = sam(['add', 'Deploy previews live on the preview-42 cluster']);
  const fid = f.stdout.match(/#(\w+)/)[1];
  assert.match(sam(['forget', fid, '--hard']).stdout, /fingerprint kept/);
  assert.equal(sam(['add', 'deploy previews live on the PREVIEW-42 cluster']).status, 1);
  const q = sam(['purge', '--query', 'preview cluster', '--yes']);
  assert.equal(q.status, 0, q.stderr);
});

test('doctor reports a newer-schema DB clearly and exits 1; writes are refused', () => {
  const home = join(CLI_TMP, 'newer');
  const env = { SAM_HOME: home };
  assert.equal(sam(['add', 'A memory before the upgrade happened'], { env }).status, 0);
  // simulate a DB written by a future SAM
  closeDb();
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(join(home, 'sam.db'));
  d.prepare("UPDATE meta SET v = ? WHERE k = 'schema'").run(String(SCHEMA_VERSION + 1));
  d.close();
  const r = sam(['doctor'], { env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`DB schema ${SCHEMA_VERSION + 1} is NEWER than this SAM`));
  assert.match(r.stdout, /read-only/);
  const p = sam(['purge', '--all-matching', 'memory', '--yes'], { env });
  assert.notEqual(p.status, 0); assert.match(p.stderr, /newer than this SAM/);
});
