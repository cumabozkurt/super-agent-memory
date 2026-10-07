// Platform layer: executable lookup, per-shell quoting, the stable `sam` launcher,
// shell choice for `sam run`, console-encoding decoding and unsafe-filesystem detection.
// Every function that depends on the OS takes an optional `plat` so Windows logic is
// testable on POSIX (and vice versa) with `path.win32` / `path.posix`.
import { existsSync, statSync, readFileSync, statfsSync } from 'node:fs';
import path from 'node:path';
// node:child_process is loaded on demand (Windows code page probe only): it costs a few ms on every hook start.
const spawnSync = (...a) => process.getBuiltinModule('node:child_process').spawnSync(...a);

export const IS_WIN = process.platform === 'win32';
const P = (plat) => (plat === 'win32' ? path.win32 : path.posix);

// ---------------- executable lookup (never `which`/`where`, never the cwd) ----------------

/**
 * Resolve an executable by scanning PATH ourselves. Empty, `.` and relative PATH entries are
 * skipped so a binary planted in the current directory can never win (Windows CreateProcess and
 * cmd.exe search the cwd first; we do not). Returns the absolute path or null.
 */
export function findExecutable(name, { plat = process.platform, env = process.env, exists = isFile } = {}) {
  const p = P(plat);
  const PATH = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = PATH.split(plat === 'win32' ? ';' : ':').map((d) => d.replace(/^"(.*)"$/, '$1')).filter((d) => d && p.isAbsolute(d));
  const hasExt = plat === 'win32' && /\.[a-z0-9]+$/i.test(name);
  const exts = plat === 'win32' && !hasExt ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  if (p.isAbsolute(name)) return exists(name) ? name : null;
  for (const d of dirs) {
    for (const e of exts) {
      for (const cand of e ? [p.join(d, name + e.toLowerCase()), p.join(d, name + e)] : [p.join(d, name)]) {
        if (exists(cand)) return cand;
      }
    }
  }
  return null;
}
function isFile(f) { try { return statSync(f).isFile(); } catch { return false; } }

/** Git Bash (MSYS) on Windows; never System32\bash.exe (that is the WSL launcher). */
export function findGitBash({ plat = process.platform, env = process.env, exists = isFile } = {}) {
  if (plat !== 'win32') return findExecutable('bash', { plat, env, exists }) || (exists('/bin/bash') ? '/bin/bash' : null);
  const w = path.win32;
  const cands = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && w.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && w.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of cands) if (exists(c)) return c;
  const onPath = findExecutable('bash', { plat, env, exists });
  if (onPath && !/\\(system32|sysnative|windowsapps)\\/i.test(onPath)) return onPath;
  return null;
}

export function findPowerShell({ plat = process.platform, env = process.env, exists = isFile } = {}) {
  return findExecutable('pwsh', { plat, env, exists }) || findExecutable('powershell', { plat, env, exists })
    || (plat === 'win32' && env.SystemRoot && exists(path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
      ? path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null);
}

export function findCmd({ env = process.env } = {}) {
  return env.ComSpec || env.COMSPEC || (env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe');
}

// ---------------- quoting ----------------

/** POSIX sh / bash / zsh: single quotes, nothing inside is expanded. */
export const qSh = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);
/** PowerShell literal string (single quotes, '' escapes a quote; no $ or ` expansion). */
export const qPwsh = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Characters cmd.exe cannot carry safely inside a quoted path (expansion / quote breaking). */
export const unsafeForCmd = (s) => /["%!\r\n]/.test(String(s));
/** cmd.exe token for a path or fixed literal: plain when harmless, otherwise "double quoted". */
export function qCmd(s) {
  s = String(s);
  if (unsafeForCmd(s)) throw new Error(`cannot be represented safely for cmd.exe: ${s}`);
  return /^[\w@+=:,./\\-]+$/.test(s) ? s : `"${s}"`;
}
const CMD_META = /[()\][%!^"`<>&|;, *?]/g;
/**
 * One argv element for a program started through cmd.exe (cross-spawn's algorithm, MIT):
 * CRT/CommandLineToArgvW escaping first, then ^-escape every cmd metacharacter (incl. % and !),
 * so an argv is never re-expanded by cmd. `double` for node_modules/.bin shims that re-parse %*.
 */
export function escCmdArg(a, double = false) {
  a = String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$&');
  return double ? a.replace(CMD_META, '^$&') : a;
}
/** The program token of a cmd.exe line (cross-spawn escapeCommand). */
export const escCmdCommand = (s) => String(s).replace(CMD_META, '^$&');
/** Forward slashes for Windows paths handed to bash/PowerShell (Win32 accepts '/', no shell escapes it). */
export const fwd = (p, plat = process.platform) => (plat === 'win32' ? String(p).replace(/\\/g, '/') : String(p));

/**
 * Turn an argv into a command string for the given shell.
 * shell: 'sh' | 'bash' | 'powershell' | 'cmd'. Paths (first `nPaths` items) get forward slashes
 * for bash/PowerShell on Windows.
 */
export function shellCommand(shell, argv, { plat = process.platform, nPaths = 1 } = {}) {
  const a = argv.map((x, i) => (i < nPaths && shell !== 'cmd' ? fwd(x, plat) : String(x)));
  if (shell === 'powershell') return '& ' + a.map(qPwsh).join(' ');
  if (shell === 'cmd') return a.map(qCmd).join(' ');
  return a.map(qSh).join(' ');
}

/** argv → one command string for the shell `sam run` will use (the argv must keep its quoting). */
export function quoteArgvFor(shellKind, parts) {
  if (shellKind === 'powershell') return '& ' + parts.map(qPwsh).join(' ');
  if (shellKind === 'cmd') return parts.map((p, i) => (i === 0 ? escCmdCommand(p) : escCmdArg(p))).join(' ');
  return parts.map(qSh).join(' ');
}

// ---------------- runtime / node selection ----------------

/** The node binary hooks should use: SAM_NODE, the Homebrew `opt` symlink, nvm-windows symlink, else execPath. */
export function stableNode({ plat = process.platform, env = process.env, execPath = process.execPath, exists = isFile } = {}) {
  if (env.SAM_NODE && exists(env.SAM_NODE)) return env.SAM_NODE;
  const m = execPath.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/); // Homebrew (macOS + Linuxbrew)
  if (m && exists(`${m[1]}/opt/${m[2]}/bin/node`)) return `${m[1]}/opt/${m[2]}/bin/node`;
  if (plat === 'win32' && env.NVM_SYMLINK && exists(path.win32.join(env.NVM_SYMLINK, 'node.exe'))) return path.win32.join(env.NVM_SYMLINK, 'node.exe');
  return execPath;
}

/** Runtime argv prefix: Deno needs `run -A` (no permission prompts in a non-TTY hook). */
export function runtimeArgv(node = stableNode()) {
  if (globalThis.Deno) return [process.execPath, 'run', '-A', '--no-prompt'];
  return [node];
}

/** Exit code bin/sam.js uses (only under the launcher) for "this runtime is unsupported, try the next one". */
export const LAUNCHER_RETRY = 86;

// ---------------- launcher scripts ----------------

/**
 * POSIX launcher (~/.sam/bin/sam). Locates node at run time: SAM_NODE, PATH, the node that ran
 * `sam install`, the Homebrew opt symlink, nvm "current", Volta. A candidate that is too old
 * exits LAUNCHER_RETRY and the next one is tried. Never fails a host hook (exit 0 for `hook`).
 */
export function posixLauncher({ samJs, execPath = process.execPath, samHome, deno = !!globalThis.Deno } = {}) {
  const brew = [];
  const m = execPath.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/);
  if (m) brew.push(`${m[1]}/opt/${m[2]}/bin/node`);
  brew.push('/opt/homebrew/opt/node/bin/node', '/usr/local/opt/node/bin/node');
  const run = deno
    ? `exec ${qSh(execPath)} run -A --no-prompt "$SAM_JS" "$@"`
    : `for n in "\${SAM_NODE:-}" "$(command -v node 2>/dev/null)" ${qSh(execPath)} ${brew.map(qSh).join(' ')} "\${NVM_DIR:-$HOME/.nvm}/current/bin/node" "$HOME/.volta/bin/node"; do
  [ -n "$n" ] && [ -x "$n" ] || continue
  "$n" "$SAM_JS" "$@"
  rc=$?
  [ "$rc" -eq ${LAUNCHER_RETRY} ] || exit "$rc"
done
echo 'sam: no usable Node.js (22.16+ or 24+) found on PATH or at the install-time location; re-run "sam install"' >&2`;
  return `#!/bin/sh
# super-agent-memory launcher, written by \`sam install\` (re-run it to refresh). Do not edit.
SAM_JS=${qSh(samJs)}
${samHome ? `[ -n "\${SAM_HOME:-}" ] || SAM_HOME=${qSh(samHome)}; export SAM_HOME\n` : ''}SAM_LAUNCHER=1; export SAM_LAUNCHER
if [ ! -f "$SAM_JS" ]; then
  echo "sam: $SAM_JS is missing (package moved or uninstalled); reinstall and run \\"sam install\\"" >&2
  [ "\${1:-}" = hook ] && exit 0
  exit 1
fi
${run}
[ "\${1:-}" = hook ] && exit 0
exit 1
`;
}

/** cmd.exe launcher (~/.sam/bin/sam.cmd). Pure cmd PATH lookup (%%~$PATH:), no `where`. */
export function cmdLauncher({ samJs, execPath = process.execPath, samHome } = {}) {
  for (const s of [samJs, execPath, samHome || '']) if (/["%!\r\n]/.test(s)) throw new Error(`path not representable in a .cmd launcher: ${s}`);
  const c = [
    `@echo off`,
    `rem super-agent-memory launcher, written by "sam install" (re-run it to refresh). Do not edit.`,
    `setlocal EnableExtensions DisableDelayedExpansion`,
    `set "SAM_JS=${samJs}"`,
    samHome ? `if not defined SAM_HOME set "SAM_HOME=${samHome}"` : null,
    `set "SAM_LAUNCHER=1"`,
    `if not exist "%SAM_JS%" goto nojs`,
    `set "I=0"`,
    `:next`,
    `set /a I+=1`,
    `set "N="`,
    `if %I%==1 if defined SAM_NODE set "N=%SAM_NODE%"`,
    `if %I%==2 for %%X in (node.exe) do set "N=%%~$PATH:X"`,
    `if %I%==3 set "N=${execPath}"`,
    `if %I%==4 if defined NVM_SYMLINK set "N=%NVM_SYMLINK%\\node.exe"`,
    `if %I%==5 if defined ProgramFiles set "N=%ProgramFiles%\\nodejs\\node.exe"`,
    `if %I% GTR 5 goto nonode`,
    `if not defined N goto next`,
    `if not exist "%N%" goto next`,
    `"%N%" "%SAM_JS%" %*`,
    `if errorlevel ${LAUNCHER_RETRY} if not errorlevel ${LAUNCHER_RETRY + 1} goto next`,
    `exit /b %ERRORLEVEL%`,
    `:nojs`,
    `>&2 echo sam: %SAM_JS% is missing; reinstall and run "sam install"`,
    `goto fail`,
    `:nonode`,
    `>&2 echo sam: no usable Node.js (22.16+ or 24+) found; re-run "sam install"`,
    `:fail`,
    `if /i "%~1"=="hook" exit /b 0`,
    `exit /b 1`,
    ``,
  ].filter((x) => x !== null);
  return c.join('\r\n');
}

/** PowerShell launcher (~/.sam/bin/sam.ps1) for interactive PowerShell use; hooks use sam.cmd (execution policy). */
export function ps1Launcher({ samJs, execPath = process.execPath, samHome } = {}) {
  return [
    `# super-agent-memory launcher, written by "sam install" (re-run it to refresh). Do not edit.`,
    `$samJs = ${qPwsh(samJs)}`,
    samHome ? `if (-not $env:SAM_HOME) { $env:SAM_HOME = ${qPwsh(samHome)} }` : null,
    `$env:SAM_LAUNCHER = '1'`,
    `if (-not (Test-Path -LiteralPath $samJs)) { [Console]::Error.WriteLine("sam: $samJs is missing; reinstall and run 'sam install'"); if ($args[0] -eq 'hook') { exit 0 }; exit 1 }`,
    `$onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source`,
    `$cands = @($env:SAM_NODE, $onPath, ${qPwsh(execPath)}, $(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK 'node.exe' }), $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\\node.exe' }))`,
    `foreach ($n in $cands) {`,
    `  if ($n -and (Test-Path -LiteralPath $n)) { & $n $samJs @args; if ($LASTEXITCODE -ne ${LAUNCHER_RETRY}) { exit $LASTEXITCODE } }`,
    `}`,
    `[Console]::Error.WriteLine('sam: no usable Node.js (22.16+ or 24+) found; re-run "sam install"')`,
    `if ($args[0] -eq 'hook') { exit 0 }`,
    `exit 1`,
    ``,
  ].filter((x) => x !== null).join('\r\n');
}

// ---------------- `sam run` shell choice ----------------

/**
 * Shell for `sam run`. POSIX: /bin/sh. Windows: SAM_SHELL override, else Git Bash (the shell of
 * Claude Code's Bash tool), else pwsh/powershell, else cmd.exe.
 * Returns { kind: 'sh'|'bash'|'powershell'|'cmd', file, argsFor(cmd) → string[], verbatim }.
 */
export function pickShell({ plat = process.platform, env = process.env, exists = isFile } = {}) {
  const want = (env.SAM_SHELL || '').toLowerCase();
  const sh = (file) => ({ kind: 'sh', file, argsFor: (c) => ['-c', c], verbatim: false });
  const bash = (file) => ({ kind: 'bash', file, argsFor: (c) => ['-c', c], verbatim: false });
  const pwsh = (file) => ({ kind: 'powershell', file, argsFor: (c) => ['-NoProfile', '-NonInteractive', '-Command', c], verbatim: false });
  // /s strips exactly the outer quotes we add (no `chcp 65001`: it would change the caller's console).
  const cmd = (file) => ({ kind: 'cmd', file, argsFor: (c) => ['/d', '/s', '/c', `"${c}"`], verbatim: true });
  if (plat !== 'win32') {
    if (/bash/.test(want)) { const b = findGitBash({ plat, env, exists }); if (b) return bash(b); }
    return sh('/bin/sh');
  }
  if (want === 'cmd') return cmd(findCmd({ env }));
  if (/pwsh|powershell/.test(want)) { const p = findPowerShell({ plat, env, exists }); if (p) return pwsh(p); }
  if (!want || /bash/.test(want)) { const b = findGitBash({ plat, env, exists }); if (b) return bash(b); }
  const p = findPowerShell({ plat, env, exists });
  if (p) return pwsh(p);
  return cmd(findCmd({ env }));
}

/** True when a single `sam run` argument would need a shell to mean what it says (S13). */
export const hasShellMeta = (s) => /[;&|<>`\n\r]|\$[({]/.test(String(s));

// ---------------- output decoding (M2) ----------------

// CP857 (Turkish OEM) upper half, from unicode.org MAPPINGS/VENDORS/MICSFT/PC/CP857.TXT.
// WHATWG TextDecoder has no IBM857, so it is mapped here.
const CP857_HI = '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u0131\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u0130\u00d6\u00dc\u00f8\u00a3\u00d8\u015e\u015f\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u011e\u011f\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00ba\u00aa\u00ca\u00cb\u00c8\ufffd\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\ufffd\u00d7\u00da\u00db\u00d9\u00ec\u00ff\u00af\u00b4\u00ad\u00b1\ufffd\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0';
export function decodeCp857(buf) {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : CP857_HI[b - 0x80];
  return s;
}

const CODEPAGES = { 65001: 'utf-8', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 28591: 'iso-8859-1', 28599: 'iso-8859-9' };
let consoleCp;
/** Active console code page on Windows (`chcp`, parsed language-independently); null elsewhere. */
export function consoleCodePage({ plat = process.platform, env = process.env } = {}) {
  if (plat !== 'win32') return null;
  if (consoleCp !== undefined) return consoleCp;
  consoleCp = null;
  try {
    const r = spawnSync(findCmd({ env }), ['/d', '/c', 'chcp'], { encoding: 'latin1', timeout: 3000, windowsHide: true });
    const m = /(\d{3,5})\D*$/.exec(r.stdout || '');
    if (m) consoleCp = Number(m[1]);
  } catch { /* keep null */ }
  return consoleCp;
}

/**
 * Decode captured command output: UTF-8 when valid; otherwise SAM_VAULT_ENCODING, then (Windows)
 * the console code page, then CP857 / windows-1254 (Turkish defaults), else latin1. CRLF → LF.
 */
export function decodeOutput(buf, { plat = process.platform, env = process.env, codePage } = {}) {
  let s;
  // stream:true holds back a multi-byte character cut by the vault's byte cap instead of failing on it
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); } catch {
    const forced = (env.SAM_VAULT_ENCODING || '').toLowerCase();
    const cp = codePage !== undefined ? codePage : consoleCodePage({ plat, env });
    const enc = forced || (cp === 857 ? 'cp857' : CODEPAGES[cp]) || (plat === 'win32' ? 'windows-1254' : 'latin1');
    if (/^(cp|ibm)857$/.test(enc)) s = decodeCp857(buf);
    else {
      try { s = new TextDecoder(enc).decode(buf); } catch { s = new TextDecoder('windows-1254').decode(buf); }
    }
  }
  return s.replace(/\r\n/g, '\n');
}

// ---------------- unsafe filesystems for SQLite WAL (H4) ----------------

// statfs f_type magic numbers (Linux): network / FUSE / VM-share filesystems where WAL's shared memory is unsafe.
const NET_MAGIC = { 0x6969: 'nfs', 0x517b: 'smb', 0xff534d42: 'cifs', 0xfe534d42: 'smb2', 0x01021997: '9p/v9fs', 0x65735546: 'fuse', 0x786f4256: 'vboxsf', 0x47504653: 'gpfs', 0x0bd00bd0: 'lustre', 0x564c: 'ncp', 0x6b414653: 'afs' };

/**
 * Why `dir` is a risky place for the SQLite DB (WAL needs shared memory and coherent locks on
 * one kernel), or null. Checks WSL /mnt/<drive>, statfs type, /proc/mounts and cloud-sync paths.
 */
export function unsafeDbLocation(dir, { plat = process.platform, env = process.env, statfs = safeStatfs, mounts = readMounts, wsl = isWsl } = {}) {
  const d = String(dir).replace(/\\/g, '/');
  const sync = /(\/Dropbox(\/|$)|\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|\/iCloud ?Drive|\/OneDrive( - [^/]+)?(\/|$)|\/Google ?Drive(\/|$)|\/My Drive(\/|$)|\/Box Sync(\/|$)|\/pCloud ?Drive)/i.exec(d);
  if (sync) return `a cloud-sync folder (${sync[1].replace(/\//g, '')}) — sync clients copy sam.db without its -wal file`;
  if (plat === 'win32' && /^\/\/[^/]/.test(d)) return 'a network share (UNC path)';
  if (plat === 'linux') {
    if (/^\/mnt\/[a-z](\/|$)/i.test(d) && wsl(env)) return 'a Windows drive mounted into WSL (drvfs/9p)';
    const t = statfs(dir);
    if (t != null && NET_MAGIC[t >>> 0]) {
      if (NET_MAGIC[t >>> 0] !== 'fuse') return `a ${NET_MAGIC[t >>> 0]} filesystem`;
    }
    const m = mounts().filter((x) => x.dir && (d === x.dir || d.startsWith(x.dir.endsWith('/') ? x.dir : x.dir + '/'))).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (m && /^(nfs4?|cifs|smb3?|9p|fuse\..*|fuseblk|virtiofs|vboxsf|drvfs|sshfs|afs|ceph|glusterfs|lustre)$/.test(m.type) && !/^fuse\.(lxcfs|portal)$/.test(m.type)) return `a ${m.type} mount (${m.dir})`;
  }
  return null;
}
function safeStatfs(dir) { try { return statfsSync(dir).type; } catch { return null; } }
function readMounts() {
  try {
    return readFileSync('/proc/mounts', 'utf8').split('\n').filter(Boolean).map((l) => {
      const [, dir, type] = l.split(' ');
      return { dir: (dir || '').replace(/\\040/g, ' '), type: type || '' };
    });
  } catch { return []; }
}
function isWsl(env) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

export { isFile };
export const existsPath = existsSync;
