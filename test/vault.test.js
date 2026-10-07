// Output vault digest on outputs that do not collapse: the error-context window, the line cap, the summary tail,
// and readVault's --lines / --tail / --grep views.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'sam-vault-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.SAM_TEST = '1';
process.env.SAM_HOME = join(TMP, 'home');
process.env.SAM_INSTALL_HOME = join(TMP, 'user');
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));

const vault = await import('../src/vault.js');

// lines that never collapse into "… similar lines" (letters, not just numbers, differ)
const word = (i) => i.toString(36).replace(/\d/g, (d) => 'abcdefghij'[d]);
const noisy = (n) => Array.from({ length: n }, (_, i) => `compiling module ${word(i)} done`);

test('digest: a long failing run keeps each error with context, the summary tail, and at most maxLines lines', () => {
  const lines = noisy(300);
  lines.splice(100, 0, 'Error: cannot find module "left-pad"', '    at require (loader.js:1:1)');
  lines.splice(200, 0, 'FAIL src/cart.test.ts');
  lines.push('Tests: 1 failed, 299 passed');
  const d = vault.digest(lines.join('\n'), false, { maxLines: 20 });
  const out = d.text.split('\n');
  assert.ok(d.partial);
  assert.equal(d.total, lines.length);
  assert.ok(d.shown <= 20, `${d.shown} lines shown`);
  assert.match(d.text, /cannot find module "left-pad"/);
  assert.match(d.text, /at require \(loader\.js/, 'the line after an error is context');
  assert.match(d.text, /FAIL src\/cart\.test\.ts/);
  assert.equal(out[out.length - 1], 'Tests: 1 failed, 299 passed', 'the summary tail is always last');
  assert.ok(out.some((l) => /^ {2}⋮ \d+ lines$/.test(l)), 'gaps are marked');
});

test('digest: a passing run shows only the tail; error-looking lines are not pulled forward', () => {
  const lines = noisy(200);
  lines.splice(50, 0, 'warning: deprecated API (not an error)', 'Error handling tests: 12 passed');
  const d = vault.digest(lines.join('\n'), true, { maxLines: 15 });
  assert.doesNotMatch(d.text, /Error handling tests/, 'ok runs do not hunt for errors');
  assert.ok(d.shown <= 15);
  assert.ok(d.text.endsWith(lines[lines.length - 1]));
});

test('digest: more error windows than maxLines still ends with the tail', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`step ${word(i)} ok`, `Error: case ${word(i)} failed`);
  lines.push('60 failed');
  const d = vault.digest(lines.join('\n'), false, { maxLines: 12 });
  assert.ok(d.shown <= 12);
  assert.ok(d.text.endsWith('60 failed'));
  assert.match(d.text, /Error: case a failed/, 'the first error survives the cap');
});

test('readVault: --lines A:B, --tail N, --grep with context; unknown ids are null', async () => {
  const cmd = `${JSON.stringify(process.execPath)} -e "for (let i = 1; i <= 120; i++) console.log((i === 77 ? 'FAIL ' : 'line ') + i)"`;
  const r = await vault.runCommand(cmd, { project: { id: 'vault-test' } });
  assert.equal(r.code, 0);
  assert.ok(vault.isVaultId(r.id));
  assert.ok(vault.isVaultId(r.id, { project: 'vault-test' }));
  assert.ok(!vault.isVaultId(r.id, { project: 'another-project' }), 'scoped to its project (and global)');
  const ln = vault.readVault(r.id, { lines: '10:12' }).text.split('\n');
  assert.deepEqual(ln, ['10: line 10', '11: line 11', '12: line 12']);
  assert.equal(vault.readVault(r.id, { lines: 'x:y' }).text.split('\n')[0], '1: line 1', 'a bad range falls back to the start');
  assert.deepEqual(vault.readVault(r.id, { tail: 2 }).text.split('\n'), ['line 119', 'line 120'], 'a trailing newline is not a line');
  assert.deepEqual(vault.readVault(r.id, { grep: '^FAIL' }).text.split('\n'), ['76: line 76', '77: FAIL 77', '78: line 78']);
  assert.match(vault.readVault(r.id).header, /exit 0 · 120 lines$/);
  assert.equal(vault.readVault('onope123'), null);
  assert.equal(vault.isVaultId('not-a-vault-id'), false);
});
