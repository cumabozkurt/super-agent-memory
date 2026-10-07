// Platform layer: Windows command forms (simulated with path.win32 + plat: 'win32'), the launcher,
// shell choice for `sam run`, output decoding, unsafe filesystems, installer safety and config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'sam-plat-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.SAM_TEST = '1';
process.env.SAM_HOME = join(TMP, 'samhome');
process.env.SAM_INSTALL_HOME = join(TMP, 'user');
const SAM_BIN = fileURLToPath(new URL('../bin/sam.js', import.meta.url));
const POSIX = process.platform !== 'win32';
const hasBash = POSIX && spawnSync('bash', ['-c', 'true']).status === 0;

const plat = await import('../src/platform.js');
const inst = await import('../src/install.js');

/** Run sam in a fresh process with its own homes (HOME/SAM_HOME are read at import). */
function sam(args, { env = {}, input, home } = {}) {
  const h = home || mkdtempSync(join(TMP, 'h-'));
  return spawnSync(process.execPath, [SAM_BIN, ...args], {
    encoding: 'utf8', input,
    env: { ...process.env, SAM_HOME: join(h, 'samhome'), SAM_INSTALL_HOME: join(h, 'user'), ...env },
  });
}

// ---- reference parsers used to check Windows quoting without Windows ----

/** CommandLineToArgvW / MSVCRT rules. */
function parseWinArgv(s) {
  const args = []; let cur = ''; let inQ = false; let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0; while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') { cur += '\\'.repeat(n >> 1); if (n % 2) { cur += '"'; } else { inQ = !inQ; } has = true; }
      else { cur += '\\'.repeat(n); i--; has = true; }
      continue;
    }
    if (c === '"') { if (inQ && s[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; has = true; continue; }
    if (!inQ && /\s/.test(c)) { if (has) { args.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) args.push(cur);
  return args;
}
/** cmd.exe phase for a line where every metacharacter is ^-escaped: drop the carets. */
const cmdUnescape = (s) => s.replace(/\^(.)/g, '$1');
/** Tokenize a PowerShell `& 'a' 'b''c'` line (single-quoted literals only, as we generate). */
function parsePwsh(s) {
  assert.match(s, /^& '/);
  const out = []; const re = /'((?:[^']|'')*)'/g; let m;
  const rest = s.slice(2);
  assert.equal(rest.replace(re, '').trim(), '', 'only single-quoted tokens: ' + s);
  while ((m = re.exec(rest))) out.push(m[1].replace(/''/g, "'"));
  return out;
}
/** What bash makes of a command string (no execution of the command itself). */
const bashTokens = (cmd) => spawnSync('bash', ['-c', `set -- ${cmd}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).stdout.split('\n').slice(0, -1);

const WIN = {
  plat: 'win32', samJs: 'C:\\Users\\John Doe\\AppData\\Roaming\\npm\\node_modules\\super-agent-memory\\bin\\sam.js',
  node: 'C:\\Program Files\\nodejs\\node.exe', execPath: 'C:\\Program Files\\nodejs\\node.exe',
  binDir: "C:\\Users\\John Doe\\.sam\\bin",
};

test('C1: Windows hook command per host (Claude exec/bash/PowerShell, Gemini/Cursor PowerShell, Codex cmd, Antigravity wrapper)', () => {
  // Claude >= 2.1.139: exec form, no shell, real .exe (a .cmd cannot be exec-spawned)
  const ce = inst.hookSpec(inst.context({ ...WIN, claudeExec: true, gitBash: null }), 'claude', 'Stop');
  assert.equal(ce.command, WIN.node);
  assert.deepEqual(ce.args, [WIN.samJs, 'hook', 'Stop', '--agent', 'claude']);
  assert.equal(ce.shell, undefined);
  // older Claude + Git Bash: explicit shell, forward-slash single-quoted POSIX launcher
  const cb = inst.hookSpec(inst.context({ ...WIN, claudeExec: false, gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' }), 'claude', 'Stop');
  assert.equal(cb.shell, 'bash');
  assert.equal(cb.command, "'C:/Users/John Doe/.sam/bin/sam' hook Stop --agent claude");
  if (hasBash) assert.deepEqual(bashTokens(cb.command), ['C:/Users/John Doe/.sam/bin/sam', 'hook', 'Stop', '--agent', 'claude']);
  // older Claude, no Git Bash: PowerShell call operator on sam.cmd
  const cp = inst.hookSpec(inst.context({ ...WIN, claudeExec: false, gitBash: null }), 'claude', 'Stop');
  assert.equal(cp.shell, 'powershell');
  assert.deepEqual(parsePwsh(cp.command), ['C:/Users/John Doe/.sam/bin/sam.cmd', 'hook', 'Stop', '--agent', 'claude']);
  // Gemini and Cursor: always PowerShell
  for (const a of ['gemini', 'cursor']) {
    const s = inst.hookSpec(inst.context({ ...WIN, claudeExec: false, gitBash: null }), a, 'SessionStart');
    assert.deepEqual(parsePwsh(s.command), ['C:/Users/John Doe/.sam/bin/sam.cmd', 'hook', 'SessionStart', '--agent', a]);
  }
  // Codex: cmd /C "<cmd>" → CRT parsing of the quoted path
  const cx = inst.hookSpec(inst.context({ ...WIN, claudeExec: false, gitBash: null }), 'codex', 'Stop').command;
  assert.equal(cx, '"C:\\Users\\John Doe\\.sam\\bin\\sam.cmd" hook Stop --agent codex');
  assert.deepEqual(parseWinArgv(cx), ['C:\\Users\\John Doe\\.sam\\bin\\sam.cmd', 'hook', 'Stop', '--agent', 'codex']);
  const cx2 = inst.hookSpec(inst.context({ ...WIN, binDir: 'C:\\Users\\cuma\\.sam\\bin', claudeExec: false, gitBash: null }), 'codex', 'Stop').command;
  assert.equal(cx2, 'C:\\Users\\cuma\\.sam\\bin\\sam.cmd hook Stop --agent codex', 'no backslash-eating: cmd keeps backslashes');
  // Antigravity: argument-free per-event wrapper
  assert.equal(inst.hookSpec(inst.context({ ...WIN, claudeExec: false, gitBash: null }), 'antigravity', 'Stop').command, 'C:\\Users\\John Doe\\.sam\\bin\\antigravity-Stop.cmd');
  // a quote in the user name is doubled for PowerShell
  const ob = inst.hookSpec(inst.context({ ...WIN, binDir: "C:\\Users\\O'Brien\\.sam\\bin", claudeExec: false, gitBash: null }), 'gemini', 'Stop').command;
  assert.deepEqual(parsePwsh(ob)[0], "C:/Users/O'Brien/.sam/bin/sam.cmd");
  // MCP on Windows: node.exe + sam.js (hosts spawn MCP servers without a shell)
  assert.deepEqual(inst.mcpSpec(inst.context({ ...WIN, claudeExec: false, gitBash: null }), 'cursor'), { command: WIN.node, args: [WIN.samJs, 'mcp', '--agent', 'cursor'] });
  // host → shell mapping used by the self-test
  assert.equal(inst.hookShell('codex', { command: cx }, { plat: 'win32' }), 'cmd');
  assert.equal(inst.hookShell('gemini', { command: 'x' }, { plat: 'win32' }), 'powershell');
  assert.equal(inst.hookShell('claude', { command: 'x' }, { plat: 'win32', gitBash: 'bash.exe' }), 'bash');
  assert.equal(inst.hookShell('claude', ce, { plat: 'win32' }), 'exec');
  assert.equal(inst.hookShell('cursor', { command: 'x' }, { plat: 'linux' }), 'sh');
});

test('C1: cmd.exe quoting rejects unrepresentable paths and argv escaping round-trips', () => {
  assert.throws(() => plat.qCmd('C:\\100%\\sam.js'));
  assert.throws(() => plat.qCmd('C:\\a"b\\sam.js'));
  for (const a of ['plain', 'a b', 'a"b', 'trailing\\', 'x\\"y', '%PATH%', '!VAR!', 'a & calc', 'p|q', '(x)', '^caret', 'tab\there', '']) {
    const line = plat.escCmdArg(a);
    assert.deepEqual(parseWinArgv(cmdUnescape(line)), [a], JSON.stringify(a) + ' → ' + line);
    assert.ok(!/(^|[^^])%/.test(line), 'every % is caret-escaped: ' + line);
  }
  const line = plat.quoteArgvFor('cmd', ['node', '-e', 'console.log(1)', 'a b; echo INJECTED']);
  assert.deepEqual(parseWinArgv(cmdUnescape(line)), ['node', '-e', 'console.log(1)', 'a b; echo INJECTED']);
  assert.deepEqual(parsePwsh(plat.quoteArgvFor('powershell', ['npm', "it's", '$env:X'])), ['npm', "it's", '$env:X']);
});

test('POSIX hook and argv quoting survive a real sh', { skip: !POSIX && 'POSIX shell' }, () => {
  for (const nasty of ["/tmp/it's here/sam", '/tmp/evil $(touch x) dir/sam', '/tmp/a`id`b/sam']) {
    const cmd = plat.shellCommand('sh', [nasty, 'hook', 'Stop']);
    const r = spawnSync('sh', ['-c', `set -- ${cmd}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
    assert.deepEqual(r.stdout.split('\n').slice(0, -1), [nasty, 'hook', 'Stop']);
  }
});

test('findExecutable scans PATH itself: PATHEXT on Windows, never the cwd or relative entries; Git Bash is not System32 bash', () => {
  const files = new Set(['C:\\tools\\claude.cmd', 'C:\\Windows\\System32\\bash.exe', '.\\claude.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']);
  const exists = (f) => files.has(f);
  const env = { PATH: '.;relative\\dir;C:\\tools;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(plat.findExecutable('claude', { plat: 'win32', env, exists }), 'C:\\tools\\claude.cmd');
  assert.equal(plat.findExecutable('nope', { plat: 'win32', env, exists }), null);
  assert.equal(plat.findGitBash({ plat: 'win32', env, exists }), null, 'WSL launcher is not Git Bash');
  assert.equal(plat.findGitBash({ plat: 'win32', env: { ...env, ProgramFiles: 'C:\\Program Files' }, exists }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(plat.findExecutable('sh', { plat: 'linux', env: { PATH: ':.:/bin' }, exists: (f) => f === '/bin/sh' || f === 'sh' }), '/bin/sh');
});

test('M1: sam run shell on Windows prefers Git Bash, then PowerShell, then cmd; SAM_SHELL overrides', () => {
  const base = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' };
  const has = (...f) => (x) => f.includes(x);
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const gb = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(plat.pickShell({ plat: 'win32', env: base, exists: has(gb, ps) }).kind, 'bash');
  assert.equal(plat.pickShell({ plat: 'win32', env: base, exists: has(ps) }).kind, 'powershell');
  const c = plat.pickShell({ plat: 'win32', env: base, exists: has() });
  assert.equal(c.kind, 'cmd'); assert.ok(c.verbatim); assert.deepEqual(c.argsFor('dir'), ['/d', '/s', '/c', '"dir"']);
  assert.equal(plat.pickShell({ plat: 'win32', env: { ...base, SAM_SHELL: 'cmd' }, exists: has(gb, ps) }).kind, 'cmd');
  assert.equal(plat.pickShell({ plat: 'win32', env: { ...base, SAM_SHELL: 'powershell' }, exists: has(gb, ps) }).kind, 'powershell');
  assert.equal(plat.pickShell({ plat: 'linux', env: {} }).file, '/bin/sh');
  assert.ok(plat.hasShellMeta('npm test && rm -rf x') && plat.hasShellMeta('a; b') && plat.hasShellMeta('echo $(id)') && plat.hasShellMeta('x > y'));
  assert.ok(!plat.hasShellMeta('npm test') && !plat.hasShellMeta('jest src/*.test.ts'));
});

test('M2: output decoding: UTF-8, CP857, Windows-1254, CRLF, a UTF-8 char cut by the byte cap', () => {
  assert.equal(plat.decodeOutput(Buffer.from('ışık\r\nİzmir\r\n')), 'ışık\nİzmir\n');
  const cp1254 = Buffer.from([0x62, 0x75, 0x6c, 0x75, 0x6e, 0x61, 0x6d, 0x61, 0x64, 0xfd]); // "bulunamadı"
  assert.equal(plat.decodeOutput(cp1254, { codePage: 1254, plat: 'win32', env: {} }), 'bulunamadı');
  const cp857 = Buffer.from([0x44, 0x6f, 0x73, 0x79, 0x61, 0x20, 0x62, 0x75, 0x6c, 0x75, 0x6e, 0x61, 0x6d, 0x61, 0x64, 0x8d, 0x2e, 0x20, 0x98, 0x9f]); // "Dosya bulunamadı. İş"
  assert.equal(plat.decodeOutput(cp857, { codePage: 857, plat: 'win32', env: {} }), 'Dosya bulunamadı. İş');
  assert.equal(plat.decodeOutput(cp857, { codePage: null, plat: 'linux', env: { SAM_VAULT_ENCODING: 'cp857' } }), 'Dosya bulunamadı. İş');
  assert.equal(plat.decodeOutput(cp1254, { codePage: null, plat: 'win32', env: {} }), 'bulunamadı', 'Windows default fallback is windows-1254');
  const cut = Buffer.from('ok ı'); // last char is 2 bytes; drop one
  assert.equal(plat.decodeOutput(cut.subarray(0, cut.length - 1)), 'ok ');
});

test('H4: unsafe DB locations are detected (WSL /mnt/c, cloud sync, network FS)', () => {
  const none = { statfs: () => null, mounts: () => [], wsl: () => false };
  assert.match(plat.unsafeDbLocation('/mnt/c/Users/x/.sam', { plat: 'linux', ...none, wsl: () => true }), /WSL/);
  assert.equal(plat.unsafeDbLocation('/mnt/c/Users/x/.sam', { plat: 'linux', ...none }), null, 'not WSL: /mnt/c is just a dir');
  assert.match(plat.unsafeDbLocation('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/.sam', { plat: 'darwin', ...none }), /cloud-sync/);
  assert.match(plat.unsafeDbLocation('/Users/x/Dropbox/.sam', { plat: 'darwin', ...none }), /Dropbox/);
  assert.match(plat.unsafeDbLocation('C:\\Users\\x\\OneDrive - Acme\\.sam', { plat: 'win32', ...none }), /OneDrive/);
  assert.match(plat.unsafeDbLocation('\\\\server\\share\\.sam', { plat: 'win32', ...none }), /network share/);
  assert.match(plat.unsafeDbLocation('/home/x/.sam', { plat: 'linux', ...none, statfs: () => 0x6969 }), /nfs/);
  assert.match(plat.unsafeDbLocation('/home/x/.sam', { plat: 'linux', ...none, mounts: () => [{ dir: '/', type: 'ext4' }, { dir: '/home', type: 'cifs' }] }), /cifs/);
  assert.equal(plat.unsafeDbLocation('/home/x/.sam', { plat: 'linux', ...none, mounts: () => [{ dir: '/', type: 'ext4' }] }), null);
});

test('H1: stable node selection and launcher scripts', () => {
  const ex = (f) => f === '/opt/homebrew/opt/node/bin/node' || f === 'C:\\nvm4w\\nodejs\\node.exe';
  assert.equal(plat.stableNode({ plat: 'darwin', env: {}, execPath: '/opt/homebrew/Cellar/node/24.21.0/bin/node', exists: ex }), '/opt/homebrew/opt/node/bin/node');
  assert.equal(plat.stableNode({ plat: 'win32', env: { NVM_SYMLINK: 'C:\\nvm4w\\nodejs' }, execPath: 'C:\\Users\\x\\AppData\\Local\\nvm\\v24.1.0\\node.exe', exists: ex }), 'C:\\nvm4w\\nodejs\\node.exe');
  const sh = plat.posixLauncher({ samJs: '/x/bin/sam.js', execPath: '/opt/homebrew/Cellar/node/24.21.0/bin/node' });
  assert.match(sh, /command -v node/); assert.match(sh, /opt\/node\/bin\/node/); assert.match(sh, /current\/bin\/node/);
  assert.ok(sh.indexOf('command -v node') < sh.indexOf('Cellar'), 'PATH first, then the remembered execPath');
  assert.match(plat.posixLauncher({ samJs: '/x/sam.js', execPath: '/usr/bin/deno', deno: true }), /run -A --no-prompt/);
  const cmd = plat.cmdLauncher({ samJs: WIN.samJs, execPath: WIN.execPath });
  assert.match(cmd, /%%~\$PATH:X/); assert.ok(!/\bwhere\b/.test(cmd), 'no where.exe'); assert.ok(cmd.includes('\r\n'));
  assert.match(cmd, /if errorlevel 86 if not errorlevel 87 goto next/);
  assert.throws(() => plat.cmdLauncher({ samJs: 'C:\\100%\\sam.js', execPath: WIN.execPath }));
  assert.match(plat.ps1Launcher({ samJs: WIN.samJs, execPath: WIN.execPath }), /Get-Command node/);
  assert.ok(inst.claudeSupportsExecForm([2, 1, 139]) && inst.claudeSupportsExecForm([3, 0, 0]) && !inst.claudeSupportsExecForm([2, 1, 138]) && !inst.claudeSupportsExecForm(null));
});

test('H1: the POSIX launcher runs from a nasty path, retries a too-old node, and never fails a hook', { skip: !POSIX && 'POSIX launcher' }, () => {
  const dir = join(TMP, "la it's $(x)");
  mkdirSync(dir, { recursive: true });
  const L = join(dir, 'sam');
  writeFileSync(L, plat.posixLauncher({ samJs: SAM_BIN, execPath: process.execPath }), { mode: 0o755 });
  const run = (cmd, env = {}) => spawnSync('sh', ['-c', cmd], { input: '{}', encoding: 'utf8', env: { ...process.env, SAM_SELFTEST: '1', ...env } });
  assert.match(run(plat.shellCommand('sh', [L, 'hook', 'Stop', '--agent', 'claude'])).stdout, /sam-selftest-ok/);
  // an old node first on PATH answers 86 (what bin/sam.js does under the launcher) → next candidate
  const fake = join(TMP, 'fakebin'); mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'node'), '#!/bin/sh\nexit 86\n', { mode: 0o755 });
  const r = run(plat.shellCommand('sh', [L, 'hook', 'Stop']), { PATH: `${fake}:/usr/bin:/bin` });
  assert.match(r.stdout, /sam-selftest-ok/, r.stderr);
  // sam.js gone (package removed): hook exits 0, CLI exits 1, both say why
  const L2 = join(dir, 'sam2');
  writeFileSync(L2, plat.posixLauncher({ samJs: join(TMP, 'gone', 'sam.js'), execPath: process.execPath }), { mode: 0o755 });
  const h = run(plat.shellCommand('sh', [L2, 'hook', 'Stop']));
  assert.equal(h.status, 0); assert.match(h.stderr, /missing/);
  assert.equal(run(plat.shellCommand('sh', [L2, 'doctor'])).status, 1);
  // the gate itself: under the launcher an unsupported runtime exits 86; elsewhere hooks exit 0
  const g = spawnSync(process.execPath, [SAM_BIN, '--version'], { encoding: 'utf8', env: { ...process.env, SAM_LAUNCHER: '1' } });
  assert.equal(g.status, 0, 'supported node passes the gate');
});

test('install: launcher-based hooks + MCP, self-test, doctor finds broken paths, clean uninstall', { skip: !POSIX && 'POSIX install paths' }, () => {
  const h = mkdtempSync(join(TMP, 'inst-'));
  mkdirSync(join(h, 'user', '.claude'), { recursive: true });
  const r = sam(['install', '--all'], { home: h });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /self-test: (\d+)\/\1 commands/);
  const L = join(h, 'samhome', 'bin', 'sam');
  assert.ok(lstatSync(L).mode & 0o100, 'launcher is executable');
  const cs = JSON.parse(readFileSync(join(h, 'user', '.claude', 'settings.json'), 'utf8'));
  assert.equal(cs.hooks.Stop[0].hooks[0].command, `${L} hook Stop --agent claude`);
  assert.equal(JSON.parse(readFileSync(join(h, 'user', '.claude.json'), 'utf8')).mcpServers.sam.command, L);
  assert.ok(!readFileSync(join(h, 'user', '.cursor', 'mcp.json'), 'utf8').includes(process.execPath), 'no embedded execPath');
  assert.match(readFileSync(join(h, 'user', '.codex', 'AGENTS.md'), 'utf8'), /sam-memory q/, 'rules use the non-colliding alias');
  assert.ok(readFileSync(join(h, 'user', '.agents', 'skills', 'sam-memory', 'SKILL.md'), 'utf8').includes(L), 'skill names the launcher path');
  // exec form for Claude Code >= 2.1.139
  sam(['install', 'claude', '--no-self-test'], { home: h, env: { SAM_CLAUDE_VERSION: '2.1.140' } });
  const ce = JSON.parse(readFileSync(join(h, 'user', '.claude', 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0];
  assert.deepEqual([ce.command, ce.args], [L, ['hook', 'Stop', '--agent', 'claude']]);
  const d = sam(['doctor'], { home: h });
  assert.equal(d.status, 0, d.stdout + d.stderr); assert.match(d.stdout, /self-test: .*claude\/hook:✔/);
  // configs pointing at a deleted node / moved package are reported
  const launcher = readFileSync(L, 'utf8');
  writeFileSync(L, launcher.replace(/^SAM_JS=.*$/m, `SAM_JS='${join(h, 'moved', 'sam.js')}'`));
  const d2 = sam(['doctor'], { home: h });
  assert.equal(d2.status, 1); assert.match(d2.stdout, /BROKEN: .*moved\/sam\.js/);
  writeFileSync(L, launcher);
  // uninstall leaves nothing SAM created behind (the pre-existing ~/.claude dir stays)
  const u = sam(['uninstall', '--all'], { home: h });
  assert.equal(u.status, 0, u.stdout + u.stderr);
  const left = spawnSync('find', [join(h, 'user'), join(h, 'samhome', 'bin')], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(left, [join(h, 'user'), join(h, 'user', '.claude')], left.join('\n'));
});

test('S17: installer refuses symlinked targets and planted .sam-bak links; uninstall removes its backups', { skip: !POSIX && 'symlinks need privileges on Windows' }, () => {
  const h = mkdtempSync(join(TMP, 's17-'));
  const g = join(h, 'user', '.gemini');
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, 'settings.json'), '{"mcpServers":{"gh":{"env":{"GITHUB_TOKEN":"ghp_FAKE"}}}}');
  mkdirSync(join(h, 'exfil'));
  symlinkSync(join(h, 'exfil', 'stolen.json'), join(g, 'settings.json.sam-bak')); // dangling link
  const r = sam(['install', 'gemini', '--no-self-test'], { home: h });
  assert.ok(!existsSync(join(h, 'exfil', 'stolen.json')), 'backup written through a planted symlink');
  assert.match(r.stdout, /symlink; not following/);
  // a symlinked config file is not written through
  const h2 = mkdtempSync(join(TMP, 's17b-'));
  mkdirSync(join(h2, 'user', '.cursor'), { recursive: true });
  writeFileSync(join(h2, 'target.json'), '{}');
  symlinkSync(join(h2, 'target.json'), join(h2, 'user', '.cursor', 'mcp.json'));
  const r2 = sam(['install', 'cursor', '--no-self-test'], { home: h2 });
  assert.equal(r2.status, 1); assert.match(r2.stdout, /symlink; refusing/);
  assert.equal(readFileSync(join(h2, 'target.json'), 'utf8'), '{}');
  // backups made by install are removed by uninstall; the user's original content is restored
  const h3 = mkdtempSync(join(TMP, 's17c-'));
  mkdirSync(join(h3, 'user', '.gemini'), { recursive: true });
  writeFileSync(join(h3, 'user', '.gemini', 'settings.json'), '{"theme":"dark"}');
  sam(['install', 'gemini', '--no-self-test'], { home: h3 });
  assert.ok(existsSync(join(h3, 'user', '.gemini', 'settings.json.sam-bak')));
  sam(['uninstall', 'gemini'], { home: h3 });
  assert.ok(!existsSync(join(h3, 'user', '.gemini', 'settings.json.sam-bak')));
  assert.deepEqual(JSON.parse(readFileSync(join(h3, 'user', '.gemini', 'settings.json'), 'utf8')), { theme: 'dark' });
  assert.ok(!existsSync(join(h3, 'user', '.gemini', 'GEMINI.md')), 'file created by install removed once empty');
});

test('M4: CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME are honored (only inside the sandbox home in tests)', () => {
  const h = mkdtempSync(join(TMP, 'm4-'));
  const u = join(h, 'user');
  const env = { CLAUDE_CONFIG_DIR: join(u, 'cc'), CODEX_HOME: join(u, 'cx'), XDG_CONFIG_HOME: join(u, 'xdg') };
  const r = sam(['install', 'claude', 'codex', 'opencode', '--no-self-test'], { home: h, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(u, 'cc', 'settings.json')) && existsSync(join(u, 'cc', '.claude.json')));
  assert.ok(existsSync(join(u, 'cx', 'hooks.json')) && existsSync(join(u, 'cx', 'config.toml')));
  assert.ok(existsSync(join(u, 'xdg', 'opencode', 'opencode.json')));
  assert.ok(!existsSync(join(u, '.claude')) && !existsSync(join(u, '.codex')) && !existsSync(join(u, '.config')));
  // an override outside the sandbox home is ignored (tests must never touch the real home)
  const h2 = mkdtempSync(join(TMP, 'm4b-'));
  const outside = mkdtempSync(join(TMP, 'outside-'));
  sam(['install', 'codex', '--no-self-test'], { home: h2, env: { CODEX_HOME: outside } });
  assert.ok(existsSync(join(h2, 'user', '.codex', 'hooks.json')) && !existsSync(join(outside, 'hooks.json')));
});

test('selfTest reports failures and skips shells that are absent', { skip: !POSIX && 'POSIX shells' }, () => {
  const ok = inst.selfTest([{ agent: 'codex', kind: 'hook', command: plat.shellCommand('sh', [process.execPath, SAM_BIN, 'hook', 'Stop']) }]);
  assert.equal(ok[0].status, 'ok', JSON.stringify(ok));
  const bad = inst.selfTest([{ agent: 'gemini', kind: 'hook', command: "'/nonexistent/sam' hook Stop" }]);
  assert.equal(bad[0].status, 'failed');
  const stale = inst.stalePaths([{ command: '/nonexistent/node', args: ['/x/sam.js', 'hook'] }, { command: "& 'C:/nope/sam.cmd' 'hook'" }], { plat: 'linux' });
  assert.deepEqual(stale, ['/nonexistent/node', '/x/sam.js']);
  assert.equal(inst.firstToken("& 'C:/Users/O''Brien/sam.cmd' 'hook'"), "C:/Users/O'Brien/sam.cmd");
  assert.equal(inst.firstToken('"C:\\a b\\sam.cmd" hook'), 'C:\\a b\\sam.cmd');
});

test('config: types are checked, unknown keys / bad JSON warn, remote embedUrl needs config.json opt-in (S18)', () => {
  const run = (cfgJson, env = {}) => {
    const h = mkdtempSync(join(TMP, 'cfg-'));
    if (cfgJson !== undefined) writeFileSync(join(h, 'config.json'), cfgJson);
    const code = `const c = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}); console.log(JSON.stringify({ cfg: c.config(), w: c.configWarnings() }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, SAM_HOME: h, ...env } });
    return { ...JSON.parse(r.stdout), stderr: r.stderr };
  };
  let r = run(undefined, { SAM_BUDGET_SESSION_START: 'abc', SAM_CAPTURE_EDITS: '0' });
  assert.equal(r.cfg.budgetSessionStart, 320, 'NaN budget falls back to the default');
  assert.equal(r.cfg.captureEdits, false);
  assert.match(r.stderr, /SAM_BUDGET_SESSION_START/);
  r = run('{"budgetPrompt":"200","captureEdits":"false","budgetSesionStart":1,"autoProjectCard":true}');
  assert.equal(r.cfg.budgetPrompt, 200); assert.equal(r.cfg.captureEdits, false);
  assert.ok(r.w.some((w) => /unknown key "budgetSesionStart"/.test(w)));
  assert.ok(!r.w.some((w) => /autoProjectCard/.test(w)), 'retired key accepted silently');
  r = run('{not json');
  assert.ok(r.w.some((w) => /not valid JSON/.test(w)));
  r = run(undefined, { SAM_EMBED_URL: 'https://evil.example/v1', SAM_EMBED_MODEL: 'x' });
  assert.equal(r.cfg.embedUrl, '', 'env alone cannot send prompts off the machine');
  r = run(undefined, { SAM_EMBED_URL: 'http://127.0.0.1:11434/v1', SAM_EMBED_MODEL: 'x' });
  assert.equal(r.cfg.embedUrl, 'http://127.0.0.1:11434/v1');
  r = run('{"allowRemoteEmbed":true}', { SAM_EMBED_URL: 'https://api.example/v1' });
  assert.equal(r.cfg.embedUrl, 'https://api.example/v1');
  r = run('{"embedUrl":"https://api.example/v1"}');
  assert.equal(r.cfg.embedUrl, 'https://api.example/v1');
  r = run(undefined, { SAM_ALLOW_REMOTE_EMBED: '1', SAM_EMBED_URL: 'https://evil.example/v1' });
  assert.equal(r.cfg.embedUrl, '', 'the opt-in itself cannot come from env');
  // hooks stay silent on stderr
  const h = mkdtempSync(join(TMP, 'cfgh-'));
  writeFileSync(join(h, 'config.json'), '{bad');
  const hk = spawnSync(process.execPath, [SAM_BIN, 'hook', 'SessionStart', '--agent', 'claude'], { input: '{}', encoding: 'utf8', env: { ...process.env, SAM_HOME: h } });
  assert.equal(hk.status, 0); assert.equal(hk.stderr, '');
});

test('OpenCode plugin template takes the launcher argv; Windows gets node + sam.js', () => {
  const src = readFileSync(new URL('../plugins/opencode/sam-memory.js', import.meta.url), 'utf8');
  assert.ok(src.includes("['__SAM_ARGV__']"));
  const c = inst.context({ ...WIN, claudeExec: false, gitBash: null });
  assert.deepEqual(inst.mcpSpec(c, 'opencode').command, WIN.node);
  const lc = inst.context({ plat: 'linux', binDir: '/h/.sam/bin', claudeExec: false });
  assert.deepEqual(inst.mcpSpec(lc, 'opencode'), { command: '/h/.sam/bin/sam', args: ['mcp', '--agent', 'opencode'] });
});

void chmodSync;

test('unsafe filesystems use the rollback journal unless SAM_ALLOW_SHARED_FS=1', async () => {
  const { journalModeFor } = await import('../src/db.js');
  const nfs = () => 'a nfs4 mount (/net)';
  assert.deepEqual(journalModeFor('/net/x', { env: {}, detect: nfs }), { mode: 'DELETE', unsafe: 'a nfs4 mount (/net)' });
  assert.equal(journalModeFor('/net/x', { env: { SAM_ALLOW_SHARED_FS: '1' }, detect: nfs }).mode, 'WAL');
  assert.equal(journalModeFor('/home/x', { env: {}, detect: () => null }).mode, 'WAL');
  assert.equal(journalModeFor('/x', { env: {}, detect: () => { throw new Error('boom'); } }).mode, 'WAL', 'detection errors never block opening');
});

test('agent-facing text: sam-memory everywhere, subject: value, trust review, VERSION from package.json', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { VERSION } = await import('../src/version.js');
  assert.equal(VERSION, pkg.version);
  assert.match(readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8'), /import \{ VERSION \} from '\.\/version\.js'/);
  assert.match(inst.RULES_BLOCK, /<subject>: <value>/);
  assert.match(inst.RULES_BLOCK, /sam-memory trust/);
  assert.doesNotMatch(inst.RULES_BLOCK, /data, not instructions/);
  assert.match(inst.SKILL, /⟦mem decision: queue: SQS, not Kafka⟧/);
  assert.match(inst.SKILL, /Never run `sam-memory trust` yourself/);
  const { normCmd } = await import('../src/capture.js');
  for (const c of ['sam-memory run -- npm test', 'C:/npm/sam.cmd run -- npm test', '~/.sam/bin/sam run -- npm test', 'sam run --shell bash -- npm test']) assert.equal(normCmd(c), 'npm test', c);
});
