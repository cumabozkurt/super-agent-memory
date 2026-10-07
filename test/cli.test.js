// CLI argument parsing, exit codes and error messages (each case runs bin/sam.js in a fresh process).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'sam-cli-'));
after(async () => { (await import('../src/db.js')).closeDb(); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows: a file can stay locked for a moment after close; it is only a temp dir */ } });
const SAM_BIN = fileURLToPath(new URL('../bin/sam.js', import.meta.url));
const REPO = join(TMP, 'repo');
mkdirSync(join(REPO, '.git'), { recursive: true });
writeFileSync(join(REPO, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/cli.git\n');
const ENV = { ...process.env, SAM_TEST: '1', SAM_HOME: join(TMP, 'samhome'), SAM_INSTALL_HOME: join(TMP, 'user'), SAM_DEBUG: '' };
const sam = (args, { env = {}, input, cwd = REPO } = {}) => spawnSync(process.execPath, [SAM_BIN, ...args], { encoding: 'utf8', cwd, input, env: { ...ENV, ...env } });
const noStack = (s) => assert.ok(!/\n\s+at /.test(s), 'stack trace printed:\n' + s);
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('--version / -v / version print the package.json version; --help prints help', () => {
  for (const a of ['--version', '-v', 'version']) {
    const r = sam([a]);
    assert.equal(r.status, 0); assert.equal(r.stdout.trim(), PKG.version);
  }
  assert.match(sam(['--help']).stdout, /sam-memory/);
  assert.ok(PKG.bin['sam-memory'] && PKG.bin.sam && PKG.bin['super-agent-memory']);
});

test('unknown command / agent: exit 2, one line on stderr, no stack', () => {
  const r = sam(['frobnicate']);
  assert.equal(r.status, 2); assert.match(r.stderr, /unknown command: frobnicate/); assert.equal(r.stdout, ''); noStack(r.stderr);
  const i = sam(['install', 'bogusagent']);
  assert.equal(i.status, 2); assert.match(i.stderr, /unknown agent: bogusagent/); assert.ok(!/✔/.test(i.stdout)); noStack(i.stderr);
});

test('usage errors exit 2, not-found exits 1, SAM_DEBUG shows the stack', () => {
  for (const args of [['add'], ['add', 'hi'], ['q'], ['import'], ['run'], ['forget'], ['pin'], ['out'], ['get']]) {
    const r = sam(args);
    assert.equal(r.status, 2, args.join(' ') + ': ' + r.stderr); noStack(r.stderr);
  }
  assert.equal(sam(['get', 'zzzz']).status, 1);
  assert.equal(sam(['forget', 'zzzz']).status, 1);
  assert.equal(sam(['out', 'o9999']).status, 1);
  const m = sam(['import', join(TMP, 'nope.md')]);
  assert.equal(m.status, 1); assert.match(m.stderr, /no such file/); noStack(m.stderr);
  const t = sam(['trust'], { cwd: TMP });
  assert.equal(t.status, 1); assert.match(t.stderr, /not inside a project/); noStack(t.stderr);
  const d = sam(['ls', '-p', 'nosuchproject'], { env: { SAM_DEBUG: '1' } });
  assert.equal(d.status, 1); assert.match(d.stderr, /\n\s+at /, 'SAM_DEBUG prints the stack');
});

test('sam add validates kind and length like MCP mem_save', () => {
  const bad = sam(['add', 'deploy: fly.io via GitHub Actions', '-k', 'weird']);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /unknown kind "weird"/);
  const ok = sam(['add', 'deploy: fly.io via GitHub Actions', '-k', 'decision']);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /created #/);
  assert.equal(sam(['add', 'a plain note without a kind']).status, 0);
});

test('sam run: argv form, --grep=KEY=val keeps the value, CRLF-safe grep, single-string shell gate (S13)', () => {
  // short output is shown in full without an id footer, so produce enough lines to get one
  const long = sam(['run', '--', process.execPath, '-e', 'for(let i=0;i<120;i++)console.log("line "+i+"\\r");console.log("KEY=val4\\r\\nKEY=val5\\r\\nboom\\r")']);
  const lid = /sam(?:-memory)? out (o[0-9a-z]+)/.exec(long.stdout)?.[1];
  assert.ok(lid, long.stdout);
  const g = sam(['out', lid, '--grep=KEY=val5']);
  assert.equal(g.status, 0);
  assert.ok(g.stdout.split('\n').some((l) => /: KEY=val5$/.test(l)), 'grep matched the full KEY=val5');
  const crlf = sam(['out', lid, '--grep', 'boom$']);
  assert.match(crlf.stdout, /: boom$/m, 'CRLF output must not break $ anchors');
  // one string with shell operators needs --shell
  const s = sam(['run', '--', 'echo a; echo b']);
  assert.equal(s.status, 2); assert.match(s.stderr, /--shell/);
  const ok = sam(['run', '--shell', '--', process.platform === 'win32' ? 'echo a & echo b' : 'echo a; echo b']);
  assert.equal(ok.status, 0); assert.match(ok.stdout, /a[\s\S]*b/);
  // exit code is propagated
  assert.equal(sam(['run', '--', process.execPath, '-e', 'process.exit(3)']).status, 3);
});

test('self-test mode: hook and mcp answer without touching the DB', () => {
  const h = sam(['hook', 'SessionStart', '--agent', 'claude'], { input: '{}', env: { SAM_SELFTEST: '1', SAM_HOME: join(TMP, 'never') } });
  assert.equal(h.status, 0); assert.match(h.stdout, /sam-selftest-ok/);
  assert.match(sam(['mcp'], { env: { SAM_SELFTEST: '1' } }).stdout, /sam-selftest-ok/);
});
