# SAM v1.1.0: cross-platform and environment audit

> Audit report on SAM **v1.1.0** (`66f45b6`), written 2026-10-07 as part of the six-perspective audit summarized in [../AUDIT2.md](../AUDIT2.md). Line numbers refer to v1.1.0. Experiments ran on throw-away copies of the repo; repro scripts and simulation drivers mentioned here were working files and are not shipped, except the retrieval eval set, which now lives in [`bench/retrieval/`](../../bench/retrieval/).

**Scope.** Files read: `README.md`, `docs/ARCHITECTURE.md`, `package.json`, `bin/sam.js`, `src/install.js`, `src/hooks.js`, `src/project.js`, `src/vault.js`, `src/text.js` and `plugins/opencode/sam-memory.js`, plus the parts of `src/capture.js`, `src/portable.js`, `src/db.js`, `src/config.js`, `src/cli.js`, `src/inject.js` and `test/sam.test.js` they call into.
**Method.** All experiments ran on a copy of the repo.
- Tested on official Node builds for linux-arm64: 20.18.0, 22.12.0, 22.13.0, 22.14.0, 22.15.0, 22.16.0, 23.4/23.6/23.8/23.10/23.11.1, 24.0.0, 24.14.0, 24.21.0 and 26.10.0; SAM and its test suite also ran on Bun 1.4.2 and Deno 2.9.7.
- Windows path logic was simulated with `path.win32`, and Windows quoting by mocking `process.platform` and feeding the generated tokens to a real `bash -c`.
- No Windows or macOS host and no PowerShell binary were available. Every behaviour that needs one is either backed by a cited vendor doc or host source, or marked **UNVERIFIED**.

All line numbers refer to the original repo files.

---

## 0. Prioritized summary

| # | Sev | Issue | Where |
|---|---|---|---|
| C1 | **Critical** | **Windows hook commands are broken in practice for every host that runs them through Git Bash or PowerShell:** Claude Code (Git Bash by default, PowerShell without it), Gemini CLI (always PowerShell) and Cursor (PowerShell wrapper). Paths without spaces are left unquoted, so bash eats the backslashes. A quoted `node.exe` path as the first token is a PowerShell parse error. | `src/install.js:14-17,151,276,342` |
| C2 | **Critical** | **`node:sqlite` has no FTS5 on Node 22.13–22.15 or on any 23.x.** `openDb()` throws `no such module: fts5`, hooks silently do nothing, and every CLI command crashes. The `>=22.13` gate and `engines` are wrong; the real minimum is **22.16 (22.x) or 24.0+**. | `bin/sam.js:13`, `package.json` engines, `src/db.js:134` |
| H1 | High | Hooks and MCP configs embed `process.execPath`. That is the **realpath**, e.g. `/opt/homebrew/Cellar/node/24.x/bin/node`, so a plain `brew upgrade node` (which auto-cleans the old keg), `nvm uninstall`, asdf/mise uninstall, or configs mounted into a devcontainer leave every hook and MCP server pointing at a deleted binary. | `src/install.js:12,17,176,202,247,269,298,315,332` |
| H2 | High | **A team file with CRLF line endings imports 0 memories.** Git for Windows' default `core.autocrlf=true` produces exactly that, and the file hash is still recorded as "imported", so it is never retried. | `src/portable.js:55,60,117-133` |
| H3 | High | Project identity is not canonical. These each produce two projects for one repo when it has no `origin`, plus duplicate file subjects: symlinked paths (macOS `/var`→`/private/var`, `~/code`→`/Volumes/…`), NFC vs NFD names (`Masaüstü`), drive-letter case (`c:` from VS Code-based hosts vs `C:`), path case, and MSYS `/c/...` paths. | `src/project.js:8-19,54-66`, `src/text.js:59-66` |
| H4 | High | One `~/.sam` cannot safely span WSL↔Windows (`/mnt/c`), a macOS host↔devcontainer bind mount, NFS/SMB homes or Dropbox/iCloud, because WAL needs shared memory on one kernel. The default is also split-brain: memory is per environment, which contradicts the README's "shared live by all your agents". | `src/db.js:130-133`, `src/config.js:6` |
| M1 | Medium | `sam run` always uses `cmd.exe` on Windows, while the agent's shell is Git Bash or PowerShell. The argv quoting lets `%VAR%` expand, and a UNC cwd silently runs the command in `C:\Windows`. | `src/vault.js:67`, `src/cli.js:196-199` |
| M2 | Medium | The vault decodes all output as UTF-8. Turkish Windows console output in CP857/CP1254 turns into `�`, and CRLF output breaks `--grep 'x$'`. | `src/vault.js:77,118` |
| M3 | Medium | The git remote parser only reads `origin`, matches `pushurl` before `url`, and keeps the quotes of a quoted `url`. | `src/project.js:33` |
| M4 | Medium | Host config-directory overrides are ignored: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME` (UNVERIFIED for OpenCode). | `src/install.js:156,193,294` |
| M5 | Medium | On Windows, `spawnSync('claude', ['--version'])` fails with EINVAL for an npm-installed `claude.cmd`, so the installer silently edits `~/.claude.json` instead. There is also no Claude version probe, which the exec-form fix (C1) needs. | `src/install.js:174-176` |
| M6 | Medium | The tests are POSIX-only (`sh -c`, `printf`, `/tmp`) and there is no OS × Node CI matrix, which would have caught C1 and C2. | `test/sam.test.js:221-225,332` |
| L1 | Low | Turkish: an explicit `--topic` uses `toLowerCase()` instead of `fold()`, and `--grep` does not fold İ/ı. There is **no** locale-dependent `toLowerCase` bug: JS case mapping is locale-independent. | `src/text.js:141`, `src/vault.js:101-108` |
| L2 | Low | `detect()` depends on `which`/`where` binaries, which are missing on minimal images. | `src/install.js:356` |
| L3 | Low | Under Deno the installed hooks lack `run -A`. Bun and Deno otherwise pass 22/22 tests. | `src/install.js:12` |
| L4 | Low | `shortPath` edge cases: cross-drive results stay absolute, a `\\?\` prefix leaks through, MSYS paths are not mapped. | `src/text.js:59-66` |
| L5 | Low | Git edge cases: `GIT_DIR`, bare repos, `include.path`, `insteadOf`, and a worktree created on another OS (Windows `gitdir:` read from WSL). | `src/project.js:8-38` |
| L6 | Info | Codex on POSIX runs hooks with `$SHELL -lc` (a login shell), so profile output or an exotic shell can corrupt or break hooks. | n/a (host behaviour) |
| L7 | Info | The ExperimentalWarning filter is correct but only cosmetic. Node 24.15+, 25.7+ and 26 no longer emit the warning. The comment's claim about protecting JSON is inaccurate. | `bin/sam.js:3-10` |

The fixes for C1, C2 and H1 are related and should land together. Section 9 proposes a single launcher plus per-host command-form design that covers all three.

---

## 1. Windows

### C1: hook command quoting is wrong for the shells that actually run the hooks (Critical)

**Code.** `src/install.js:14-17`
```js
const q = process.platform === 'win32'
  ? (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)   // cmd.exe style
  : ...
const CMD = `${q(NODE)} ${q(SAM_JS)}`;
```
On Windows the quoting assumes `cmd.exe`, and a path with no space is left **unquoted, backslashes and all**. Each host runs hook strings through a different shell:

| Host | Shell for a hook command on Windows | Source |
|---|---|---|
| Claude Code | **Git Bash** (`sh -c` on macOS/Linux) when installed, **PowerShell** when Git Bash isn't. Optional `shell: "bash"\|"powershell"`. **Exec form** with `args` runs with no shell at all. Before v2.1.47 the shell was cmd.exe. | [hooks ref: Exec form and shell form](https://code.claude.com/docs/en/hooks); CHANGELOG 2.1.47 ("using Git Bash instead of cmd.exe"), 2.1.139 ("Added hook `args: string[]` field (exec form)") at https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md |
| Gemini CLI | **PowerShell, always**: `$ComSpec` if it is powershell/pwsh, else `pwsh.exe`, else `powershell.exe`, with `-NoProfile -Command`, spawned with `shell:false`. | `getShellConfiguration()` in https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/utils/shell-utils.ts; `hookRunner.ts` |
| Codex | `%COMSPEC%` (cmd.exe) `/C "<cmd>"` via `raw_arg` (no `/S`); a `commandWindows` override exists. | `build_command()` in https://raw.githubusercontent.com/openai/codex/main/codex-rs/hooks/src/engine/command_runner.rs; https://developers.openai.com/codex/hooks |
| Cursor | Wraps the hook in a PowerShell preamble (`Get-Content … \| & { $input \| <command> }`). The cursor-agent CLI started from Git Bash evaluates that wrapper with bash, which is a Cursor bug. | Cursor forum threads [168129](https://forum.cursor.com/t/cursor-agent-windows-imported-claude-code-hooks-are-composed-as-powershell-but-executed-with-bash-silently-blocking-every-tool-call/168129), [148131](https://forum.cursor.com/t/project-level-hooks-fail-on-windows-with-git-bash-due-to-powershell-injection/148131). Official docs say nothing, so the exact shell is **UNVERIFIED**. |
| Antigravity | **UNVERIFIED** (no public spec found). | n/a |
| OpenCode plugin | `spawn(NODE, [SAM, …])` with no shell, so it is safe. | `plugins/opencode/sam-memory.js:16` |

**Repro (simulation).** repro `winq.mjs` (not shipped) mocks `process.platform='win32'`. The generated tokens were then fed to a real `bash -c`:
```
"C:\\Program Files\\nodejs\\node.exe"  => "C:\Program Files\nodejs\node.exe"
"C:\\nvm4w\\nodejs\\node.exe"          => C:\nvm4w\nodejs\node.exe            (unquoted)
"C:\\Users\\cuma\\AppData\\Roaming\\npm\\node_modules\\super-agent-memory\\bin\\sam.js"
                                       => C:\Users\cuma\AppData\...\sam.js  (unquoted)
"\\\\server\\share\\tools\\sam.js"     => \\server\share\tools\sam.js        (unquoted)
--- bash -c sees:
C:nvm4wnodejsnode.exe
C:UserscumaAppDataRoamingnpmnode_modulessuper-agent-memorybinsam.js
\serversharetoolssam.js
```
What happens on a stock install (MSI node in `C:\Program Files`, npm global in `%APPDATA%`) is a direct consequence of the shell semantics above:
- **Claude Code + Git Bash:** `"C:\Program Files\nodejs\node.exe" C:UserscumaAppData…sam.js hook …` gives `Cannot find module`, so every hook fails.
- **Claude Code without Git Bash, Gemini CLI, Cursor (PowerShell):** a statement starting with a quoted string is an expression in PowerShell, so the next bareword is `ParserError: Unexpected token`. Every hook fails. (I could not run PowerShell here; this is standard PowerShell grammar and is also documented in the obra/superpowers Windows hook notes at https://github.com/obra/superpowers/blob/main/docs/windows/polyglot-hooks.md.)
- **Codex (cmd /C):** works, because cmd strips the outer added quotes. This is the only host the current quoting was written for.
- Cursor forum reports say a hook that *fails* is treated as a block. SAM installs `beforeSubmitPrompt`, so a broken SAM hook could block prompts in Cursor on Windows. **UNVERIFIED.**

**Fix.** Generate the command per host, and prefer exec form wherever the host supports it (see the full design in section 9). The core helper:
```js
// src/install.js
const WIN = process.platform === 'win32';
const fwd = (p) => (WIN ? p.replace(/\\/g, '/') : p);            // Win32 accepts '/', and no shell treats it as an escape
const qSh   = (s) => (/^[\w@+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`); // sh / Git Bash
const qPwsh = (s) => `'${s.replace(/'/g, "''")}'`;                // PowerShell literal string
const qCmd  = (s) => (/^[\w@+=:,./\\-]+$/.test(s) ? s : `"${s}"`); // cmd: '%' / '"' can't be made safe; reject at install
const unsafeForCmd = (s) => /["%!]/.test(s);

/** argv = [NODE, SAM_JS, 'hook', ev, '--agent', agent] */
export function shellCommand(shell, argv) {
  if (shell === 'powershell') return '& ' + argv.map(qPwsh).join(' ');   // call operator: quoted path is a command
  if (shell === 'cmd') {
    if (argv.some(unsafeForCmd)) throw new Error(`path not representable for cmd.exe: ${argv.find(unsafeForCmd)}`);
    return argv.map(qCmd).join(' ');
  }
  return argv.map((a, i) => qSh(i < 2 ? fwd(a) : a)).join(' ');        // 'sh' | 'bash'
}

// per host, on win32:
const HOOK_SHELL = { claude: 'bash', gemini: 'powershell', cursor: 'powershell', codex: 'cmd', antigravity: 'powershell' /* UNVERIFIED */ };
const hookEntry = (agent, ev, extra = {}) => {
  const argv = [NODE, SAM_JS, 'hook', ev, '--agent', agent];
  if (agent === 'claude' && claudeSupportsExecForm())              // >= 2.1.139: no shell on any OS
    return { type: 'command', command: argv[0], args: argv.slice(1), timeout: 10, ...extra };
  const shell = WIN ? HOOK_SHELL[agent] : 'sh';
  return { type: 'command', command: shellCommand(shell, argv), timeout: 10,
           ...(WIN && agent === 'claude' ? { shell: 'bash' } : {}), ...extra };
};
```
`isOurs()` (`src/install.js:20-26`) already joins `command` with `args`, so ownership detection keeps working with exec form. `OURS_RE` also matches `…sam.js' hook`.

Add a **self-test** to `sam install` / `sam doctor` that runs each generated command through the host's real shell with a `{}` payload and checks exit 0. On Windows that means `bash -c` (Git Bash), `powershell -NoProfile -Command`, and `cmd /d /c`. It turns this whole class of bug into a visible install error.

### Backslash paths in `shortPath`, `compactPaths`, file-note matching and project roots
- **`shortPath` (`src/text.js:59-66`)** uses the native `path` module, so on Windows it uses `path.win32`. repro `winpath.mjs` (not shipped) results:
  - `C:\Users\cuma\repo\src\App.tsx` → `src/App.tsx` ✔
  - `c:\users\cuma\repo\src\App.tsx` → `src/App.tsx` ✔ (`win32.relative` is case-insensitive)
  - `C:/Users/...` → ✔; relative `src\App.tsx` → `src/App.tsx` ✔; UNC under a UNC root → ✔
  - `/c/Users/cuma/repo/src/App.tsx` (MSYS) → **kept absolute** ✖
  - `D:\other\x.ts` → `D:/other/x.ts`: absolute but treated as relative, because `relative()` returns an absolute path across drives and only `..` is checked ✖
  - `\\?\C:\…` → `//?/C:/…` ✖
  - `src\app.tsx` vs `src\App.tsx` → two different subjects ✖ (see H3)

  Claude documents that Windows `file_path` arrives with backslashes even under Git Bash (hooks ref, PreToolUse section), so the common case works. The failures are in the edge spellings.
- **`compactPaths` (`src/text.js`)** and **file-note matching (`src/inject.js:136`)** split on `/` only, which is correct because `shortPath` already normalised the separators. If a raw backslash path reaches them (an MSYS path, or a POSIX-side SAM in WSL receiving a Windows path), basename extraction fails and no file note is shown. SQLite `LIKE` is ASCII-case-insensitive, so `src/app.tsx` vs `src/App.tsx` still matches. That masks case duplicates for ASCII names, but not for `Ü`/`ü`.
- **Fix.** See H3 for `canonPath()`. In `shortPath`:
```js
export function shortPath(p, root) {
  if (!p) return '';
  let s = canonPath(String(p));                       // NFC, MSYS→win, strip \\?\, true case when it exists
  if (root && isAbsolute(s)) {
    const r = relative(root, s);
    if (r && !r.startsWith('..') && !isAbsolute(r)) s = r;   // cross-drive stays absolute AND is not mistaken for relative
  }
  return s.split(sep).join('/').split('\\').join('/');  // also normalise stray backslashes on POSIX (WSL receiving Windows paths)
}
```

### Drive letters and UNC
- `resolveProject` keys by `resolve(cwd)` (`src/project.js:55`). Simulation: `c:\Users\cuma\repo` and `C:\Users\cuma\repo` resolve to **different strings**, which gives different `sha('path:'+root)` ids for no-remote repos. VS Code-based hosts (Cursor, Antigravity, the Claude/Codex IDE extensions) commonly report lower-case drive letters, so this is a realistic split. The VS Code `fsPath` lower-casing is well known but **UNVERIFIED** for each host. Fix in H3.
- UNC: `findRoot` terminates correctly (`dirname('\\\\server\\share\\')` is a fixed point). UNC paths without spaces break hook commands (C1). `cmd.exe` refuses a UNC current directory and falls back to `C:\Windows`, which affects `sam run` (M1).

### Case-insensitive paths creating duplicate file notes
Edit and read events store `subject` verbatim (`src/capture.js:166-167,183-184`). `src/App.tsx` and `src/app.tsx` become two hot files, two entries in fix detection (`detectFix` uses `DISTINCT subject`), and two `files` anchors. Fix: canonicalise to the on-disk case with `realpathSync.native` when the file exists (H3 snippet). That is cheap: one call per tool event.

### CRLF in transcripts and markdown imports
- Transcripts: `JSON.parse` tolerates a trailing `\r`. A CRLF JSONL transcript still harvested markers in `crlf.mjs` (`CRLF transcript markers harvested: 1`) ✔. `lastUserMessage` behaves the same ✔.
- Markdown import is broken: see **H2**.

### `which` vs `where` in `detect()`: L2 (Low)
`src/install.js:356` picks `where` on win32, which is correct. But spawning a binary just to probe PATH fails silently on images without `which` (some minimal containers), and it is slow. Fix:
```js
import { delimiter } from 'node:path';
const bin = (b) => {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  return (process.env.PATH || '').split(delimiter).filter(Boolean)
    .some((d) => exts.some((e) => existsSync(join(d, b + e.toLowerCase())) || existsSync(join(d, b + e))));
};
```

### HOME vs USERPROFILE: OK, with one note
`os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere (libuv docs: https://raw.githubusercontent.com/libuv/libuv/v1.x/docs/src/misc.rst, `uv_os_homedir`). Claude, Gemini and Codex use the same profile directory, so the paths agree. A Git Bash user with a corporate `HOME=H:\` sees `git` use `H:\` while SAM and the agents use `%USERPROFILE%`. That is consistent with the agents and needs no fix. The real gap is the host-specific overrides (**M4**).

### M5: `claude` CLI probe on Windows (Medium)
`src/install.js:174`: `spawnSync('claude', ['--version'])` with no shell. For an npm-installed `claude.cmd`, Node refuses to spawn `.bat`/`.cmd` without `shell:true`. It errors with EINVAL since the April 2024 security release (https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2). `status` is `null`, so the installer falls back to rewriting `~/.claude.json` directly. That file is actively rewritten by a running Claude, so concurrent edits can be lost. Fix, which also yields the version C1 needs:
```js
function claudeVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 5000 });
  const m = r.status === 0 && /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout || '');
  return m ? m.slice(1).map(Number) : null;
}
const claudeSupportsExecForm = () => { const v = claudeVersion(); return !!v && (v[0] > 2 || (v[0] === 2 && (v[1] > 1 || (v[1] === 1 && v[2] >= 139)))); };
// use the same `shell: win32` for the `claude mcp add/remove` calls (args are fixed literals + NODE/SAM_JS → quote them with qCmd)
```

### M1: the `sam run` shell and its quoting (Medium)
`src/vault.js:67` is `spawn(cmd, { shell: true })`, which on Windows is always `cmd.exe /d /s /c "…"`. Three problems:
1. Agents write commands in their own shell's syntax. Claude's Bash tool on Windows is Git Bash, and PowerShell is the primary shell when its tool is enabled (hooks ref, PowerShell section). So `FOO=1 npm test`, `'quoted args'`, `2>/dev/null` or `$env:X` passed as one string fail or misbehave in cmd.
2. The argv quoting (`src/cli.js:196-199`) allows `%` unquoted, and cmd expands `%VAR%` even inside double quotes. An argv must never be re-expanded.
3. A UNC cwd makes cmd run in `C:\Windows` with only a warning on stderr.

Fix:
```js
// src/vault.js
function shellFor() {
  if (process.env.SAM_SHELL) return process.env.SAM_SHELL;                  // explicit override
  if (process.platform !== 'win32') return true;                            // /bin/sh
  if (process.env.MSYSTEM || /bash(\.exe)?$/i.test(process.env.SHELL || '')) return process.env.SHELL || 'bash.exe'; // Git Bash (Claude Bash tool)
  return true;                                                              // cmd.exe
}
const child = spawn(cmd, { cwd, shell: shellFor(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

// src/cli.js: argv form on cmd.exe: cross-spawn's escaping (MIT), not ad-hoc "" doubling
const escWinArg = (a) => {
  a = String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');  // CRT argv rules
  return `"${a}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');                // cmd metachars incl. % and !
};
```
For a UNC cwd on Windows, run through bash (from `shellFor`) or prefix `pushd "<unc>" && `. Document `SAM_SHELL=pwsh` for PowerShell users.

### `sh -c` assumptions in the tests: M6 (Medium)
- `test/sam.test.js:221-225`: `spawnSync('sh', ['-c', …shellQuote…])` with `/tmp/...` paths. On Windows, `shellQuote` is the cmd variant and `sh` is usually absent, so the test fails or tests the wrong quoter.
- `test/sam.test.js:332`: `sam run -- printf …`. `printf` does not exist in cmd.

Fix: gate with `{ skip: process.platform === 'win32' }`, add win32 variants that call `cmd /d /s /c` and `powershell -NoProfile -Command` on the generated commands, and add CI:
```yaml
# .github/workflows/ci.yml
jobs:
  test:
    strategy: { matrix: { os: [ubuntu-latest, macos-latest, windows-latest], node: ['22.16', '24', '26'] } }
    runs-on: ${{ matrix.os }}
    steps: [ { uses: actions/checkout@v4 }, { uses: actions/setup-node@v4, with: { node-version: '${{ matrix.node }}' } }, { run: npm test } ]
```
On 22.13 this matrix would have caught C2 immediately: the whole suite crashes at import.

### File locking
SQLite WAL works on local NTFS. `busy_timeout=5000` is set before WAL (`src/db.js:132-133`), so parallel hooks are fine. Antivirus or indexer handles can still cause transient `SQLITE_BUSY` beyond 5 s. Hooks swallow that, so the only cost is lost events. `writeFileSync` on a settings file a host holds open without `FILE_SHARE_WRITE` can throw EBUSY/EPERM. The installer reports it as `ERROR …`, which is acceptable. Cross-kernel sharing is the real locking risk (H4).

### Long paths: Low / UNVERIFIED
Node's `fs` on Windows namespaces long paths internally, and SAM's own paths are short (`%USERPROFILE%\.sam\sam.db`, `…\npm\node_modules\super-agent-memory\bin\sam.js` ≈ 80 chars). Deep repos only touch `existsSync(join(dir,'.git'))`, which goes through Node `fs`. Not tested on a Windows host. The only fix needed is in `shortPath`: strip a `\\?\` prefix (snippet in H3).

---

## 2. macOS

### H3 (part): case-insensitive FS, `/private/var` and symlinks, NFD
**Repro** (repro `posix.mjs` (not shipped) on Linux; a macOS symlink behaves the same):
```
symlink: physical 5d0a578e9dc6 logical 87df6419238b DIFFERENT PROJECTS
NFC vs NFD path spelling: 7736f0cf3751 5fc344cbdd6b DIFFERENT PROJECTS (same dir on macOS)
```
- `/var` → `/private/var` and `/tmp` → `/private/tmp` are symlinks. `getcwd()` returns the physical path, while a host may report the logical one, from `$PWD`, a workspace URI, or a user-typed path. The same goes for user symlinks like `~/code → /Volumes/Work/code`, which are very common. Repos with an `origin` are safe because the remote URL is the id. **No-remote repos split.**
- NFC vs NFD: HFS+ stored names in NFD. APFS preserves what was written but is normalization-insensitive, so `Masaüstü` (the Turkish "Desktop") can be spelled two ways for the same directory. Model-written `file_path`s are NFC. Different strings mean different project ids and file subjects.
- Case: on a case-insensitive APFS volume, `~/Projects/App` and `~/projects/app` are the same directory.

**Fix: one canonicaliser used for roots, cwd keys and file paths.**
```js
// src/project.js (export it; use in text.js shortPath too)
import { realpathSync } from 'node:fs';
export function canonPath(p) {
  let s = String(p);
  if (process.platform === 'win32') {
    s = s.replace(/^\\\\\?\\(?!UNC\\)/, '').replace(/^\\\\\?\\UNC\\/, '\\\\');        // strip \\?\ and \\?\UNC\
    s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => d.toUpperCase() + ':');            // MSYS /c/x → C:/x
  }
  s = resolve(s);
  try { s = realpathSync.native(s); } catch { /* may not exist (deleted file / worktree) */ }
  s = s.normalize('NFC');
  if (process.platform === 'win32') s = s.replace(/^[a-z]:/, (d) => d.toUpperCase());
  return s;
}
export function resolveProject(cwd) {
  const key = canonPath(cwd || process.cwd());
  // ... findRoot(key) unchanged; root is now canonical, so sha('path:' + root) is stable
}
```
`realpathSync.native` resolves symlinks and, on Windows (`GetFinalPathNameByHandle`), returns the on-disk case. On macOS, libuv calls `realpath(3)`. Whether Apple's `realpath` returns the true case on case-insensitive APFS is **UNVERIFIED** (no Mac to test on). If it does not, add `process.platform === 'darwin'` case-folding of the *comparison key only*, never of the stored path.

**Migration.** Path-based ids will change once. In `resolveProject`, if no row exists for the new id but one exists for `sha('path:' + legacyRoot)`, run `UPDATE memories SET project=? WHERE project=?` (and the same for `events`, `sessions`, `vault`, `stats`) inside `tx()`, then upsert the project row.

The `findRoot` home check `dir !== home` (`src/project.js:14`) compares raw strings. Use `canonPath(homedir())` so a logical vs physical `$HOME` does not let a dotfiles repo swallow every directory.

### H1: Homebrew, nvm or asdf node paths change and the hooks embed `process.execPath` (High)
**Repro** (repro `execpath.mjs` (not shipped)). A Homebrew-like layout `brew/bin/node → ../Cellar/node/24.21.0/bin/node`:
```
execPath=<copy>/exp/brew/Cellar/node/24.21.0/bin/node  argv0=<copy>/exp/brew/bin/node
CMD embedded in hooks: <copy>/exp/brew/Cellar/node/24.21.0/bin/node <copy>/bin/sam.js
```
On macOS, libuv's `uv_exepath` calls `_NSGetExecutablePath` and then `realpath()` (https://raw.githubusercontent.com/libuv/libuv/v1.x/src/unix/darwin.c), so the embedded path is the versioned Cellar path.

What breaks:
- **`brew upgrade node`** deletes `Cellar/node/<old>` immediately, because cleanup runs for the upgraded formula unless `HOMEBREW_NO_INSTALL_CLEANUP` is set (https://docs.brew.sh/Manpage, `upgrade`). So a plain upgrade is enough to break SAM. **Every** hook exits 127 and **every** MCP server (Claude, Codex, Gemini, Antigravity, Cursor, OpenCode plugin) fails to start. Claude shows a non-blocking hook error per event. Cursor may block prompts (see C1). The SessionStart card and all capture silently stop.
- **nvm:** `~/.nvm/versions/node/vX/bin/node` survives `nvm use`, so SAM keeps running on the old version, which is fine. It breaks on `nvm uninstall vX`. If SAM was installed with that node's npm, `SAM_JS` lives under the same version directory and disappears with it.
- **asdf/mise/fnm/Volta:** `execPath` is the real install directory, not the shim, so the same breakage follows on uninstall. Volta's `~/.volta/bin/node` shim is stable but never chosen.
- **Codex** hashes hook commands for trust, so any path change means the hooks need re-approving with `/hooks`. The installer already notes this (`src/install.js:203`).

Fix: see the **launcher strategy in section 9**. At minimum, map Homebrew Cellar paths to the stable `opt` symlink:
```js
function stableNode() {
  if (process.env.SAM_NODE) return process.env.SAM_NODE;
  const p = process.execPath;
  const m = p.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/);   // Homebrew (macOS + Linuxbrew)
  if (m && existsSync(`${m[1]}/opt/${m[2]}/bin/node`)) return `${m[1]}/opt/${m[2]}/bin/node`;
  return p;
}
const NODE = stableNode();
```
Also add to `sam doctor`: parse every installed SAM hook or MCP entry, check that its executable and `sam.js` exist, and print `stale node path → run sam install` when they don't.

---

## 3. Node versions, Bun, Deno

### C2: FTS5 is missing in `node:sqlite` before 22.16, and in all of 23.x (Critical)
Measured on official linux-arm64 builds. The SQLite build flags come from `deps/sqlite/sqlite.gyp`, which is the same for every platform; `SQLITE_ENABLE_FTS5` arrived with "sqlite: enable common flags" (nodejs/node#57621) in the 22.16.0 changelog.

| Node | `node:sqlite` | ExperimentalWarning | FTS5 (+trigram) | SAM |
|---|---|---|---|---|
| 20.18.0 | absent | n/a | n/a | clear error: `sam: Node.js >= 22.13 is required (found 20.18.0)`, exit 1 ✔ |
| 22.12.0 | behind `--experimental-sqlite` | n/a | n/a | same clear error ✔ |
| **22.13.0 / 22.14.0 / 22.15.0** | unflagged | yes | **`no such module: fts5`** | hooks exit 0 doing nothing; `sam doctor` gives the stack trace `Error: no such module: fts5 at openDb (src/db.js:134)`; test suite: `fail 1` at import |
| **23.4 – 23.11.1** | unflagged | yes | **no FTS5** (checked 23.4, 23.6, 23.8, 23.10, 23.11.1) | same as above |
| 22.16.0 | unflagged | yes | ✔ | works |
| 24.0.0 – 24.14.0 | unflagged | yes | ✔ | works; 22/22 tests on 24.14 |
| 24.15.0+ (24.21.0 tested) | **Release candidate (1.2)** | **no** | ✔ | 22/22 tests |
| 25.7.0+ | RC (1.2) | no | ✔ (per docs; 25.x not run) | n/a |
| 26.10.0 | RC | no | ✔ | 22/22 tests |

Sources:
- Stability and history: https://nodejs.org/api/sqlite.html ("v23.4.0, v22.13.0: no longer behind `--experimental-sqlite` but still experimental"; "v25.7.0: release candidate"). `latest-v24.x` doc history lists "v24.15.0: SQLite is now a release candidate". `latest-v22.x` and `latest-v23.x` docs still say "Stability: 1.1 - Active development".
- `lib/sqlite.js` contains `emitExperimentalWarning('SQLite')` at v22.23.0, v24.0.0 and v24.14.0, and not at v24.15.0, v25.7.0 or v26.0.0 (github.com/nodejs/node tags).
- `timeout` option: v24.0.0 / v22.16.0. `database.function()`: v23.5.0 / v22.13.0 (same doc). SAM uses neither: it uses `PRAGMA busy_timeout` (`src/db.js:132`), which works on every version. ✔
- Defensive mode is on by default from v25.5.0 / v24.14.0 (same doc). SAM's FTS external-content triggers and `optimize` still pass on 24.14, 24.21 and 26.10 ✔.

Fix:
```js
// bin/sam.js: replace the version gate
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = (major === 22 && minor >= 16) || major >= 24;          // 23.x never got FTS5
if (!supported && !process.versions.bun && !globalThis.Deno) {
  process.stderr.write(`sam: Node.js 22.16+ (22.x) or 24+ is required: node:sqlite needs FTS5 (found ${process.versions.node}).\n`);
  process.exit(process.argv[2] === 'hook' ? 0 : 1);                      // never fail a host hook
}
```
```js
// src/db.js: feature probe with an actionable message (covers distro builds using --shared-sqlite without FTS5)
try { db.exec(SCHEMA); } catch (e) {
  if (/no such module: fts5|no such tokenizer: trigram/.test(e.message))
    throw new Error(`this Node's SQLite lacks FTS5/trigram (node ${process.versions.node}, sqlite ${db.prepare('select sqlite_version() v').get().v}); use Node 22.16+ or 24+`);
  throw e;
}
```
```json
// package.json
"engines": { "node": ">=22.16 <23 || >=24" }
```
Also fix README "Node ≥22" and the comment in `bin/sam.js` ("still flagged experimental on Node 22/23").

### L7: ExperimentalWarning handling (Info)
`bin/sam.js:5-10` patches `process.emitWarning` *before* the dynamic `import('../src/cli.js')`, so the warning is filtered for all CLI, hook and MCP entries. Verified: hooks on 22.13 and 24.14 printed no warning, while `npm test` (which imports `src/` directly) does print it. Two notes:
- Warnings go to **stderr**, never stdout, so hook JSON and MCP JSON-RPC were never at risk. The comment's rationale is inaccurate, and the filter is purely cosmetic for stderr shown by hosts.
- The match on `'SQLite'` is brittle but harmless. On 24.15+ and 25.7+ there is no warning at all.

Optional: tests could run with `node --disable-warning=ExperimentalWarning --test`.

### Older binary than required: clear error ✔ (with a caveat)
The gate runs before any `node:sqlite` import, and top-level `await` is fine on Node 14.8+, so on 20.x or 22.12 the user sees one clear line. The caveat is that it exits 1 inside hooks. Claude treats exit 1 as non-blocking but shows it every event; Cursor may treat it as a block. Use `exit(0)` for `hook` (snippet above).

### L3: Bun and Deno (Low)
- **Bun 1.4.2:** `node:sqlite` exists, FTS5 and trigram work, `bun bin/sam.js doctor` works, and `bun test ./test/sam.test.js` gives **22 pass / 0 fail**. (`bun test/sam.test.js` without `test` refuses to run `node:test` outside its runner.) Bun reports `process.versions.node = 26.3.0`, so the gate passes.
- **Deno 2.9.7:** `deno run -A bin/sam.js …` works (doctor, hook, ls), and `deno test -A test/sam.test.js` gives **22 passed / 0 failed**.
- **Caveat:** `sam install` run under Deno embeds `process.execPath` = `deno`, producing `deno /…/sam.js hook …` with no `run -A`. Deno 2's script shorthand runs without permissions, the non-TTY prompt is denied, and every hook fails. Fix:
```js
const RUNTIME_ARGV = globalThis.Deno ? [process.execPath, 'run', '-A', '--no-prompt'] : [NODE];
// build every argv as [...RUNTIME_ARGV, SAM_JS, 'hook', …]  (for MCP: command = RUNTIME_ARGV[0], args = [...RUNTIME_ARGV.slice(1), SAM_JS, 'mcp', …])
```

---

## 4. Locale and encoding

### Turkish locale and `toLowerCase`: no locale bug; L1 is a consistency issue (Low)
`String.prototype.toLowerCase()` uses the locale-independent Unicode mapping; only `toLocaleLowerCase()` reads the locale. Run with `LANG=LC_ALL=tr_TR.UTF-8`:
```
toLowerCase I/İ under LANG=tr: i "i̇" locale-aware: ı
fold: istanbul isik isik | topic explicit: "i̇zin" auto: decision:izin
```
`grep -rn toLocale|Intl.|localeCompare src` finds no hits. `fold()` handles İ/I/ı correctly.

Remaining inconsistencies:
- `topicOf` with an explicit topic (`src/text.js:141`) uses `toLowerCase()`. `--topic İzin` becomes `i̇zin` (i + U+0307), which never equals the auto topic `decision:izin` or a later `--topic izin`. Fix: `if (explicit) return fold(explicit).trim();`. Old topics need a one-time `UPDATE memories SET topic = fold(topic)`, done in JS.
- `safeMatcher` (`src/vault.js:101-108`): the regex `/i` flag uses simple case folding, so `--grep IŞIK` doesn't match `ışık`. Use `fold` for the literal fallback, and document the limit for regex mode.
- `normRemote` lower-cases with `toLowerCase()` (`src/project.js:48`). That is fine for ASCII hosts; a Turkish-named repo path with `İ` gets `i̇`, but only consistently with itself. No action needed.

### M2: non-UTF-8 output in the vault (Medium)
`src/vault.js:77` decodes `Buffer.concat(chunks).toString('utf8')`. Concatenating before decoding is correct for split multibyte characters ✔. But Windows console programs writing to a pipe often use the OEM or ANSI code page; on Turkish Windows that is CP857 (cmd built-ins, many native tools) or CP1254. Demo:
```
cp1254 bytes as utf8: bulunamad�        TextDecoder('windows-1254'): bulunamadı
TextDecoder ibm857 NOT SUPPORTED   (WHATWG encoding list has no IBM857)
```
The stored copy is irrecoverably mangled, because the redacted string is what gets deflated. Fix:
```js
function decodeOutput(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder(config().vaultEncoding || (process.platform === 'win32' ? 'windows-1254' : 'latin1')).decode(buf); }
}
// and nudge children to UTF-8 on Windows:
const env = process.platform === 'win32' ? { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } : process.env;
// cmd.exe path only: prefix `chcp 65001>nul & ` to the command string
```
Make `vaultEncoding` a config key (`SAM_VAULT_ENCODING`), and document that a CP857 fallback is not available through WHATWG `TextDecoder`.

CRLF: `readVault` splits on `\n` (`src/vault.js:118`), so lines keep `\r` and `--grep 'boom$'` returns nothing on CRLF output (demo: `""`). The digest path strips trailing whitespace ✔. Fix: `.split(/\r?\n/)`.

### Unicode and NFD file paths on macOS
Covered in H3: normalise every path and root to NFC (`canonPath`). File-note `LIKE` on `files` also needs NFC on both sides; store NFC.

---

## 5. Containers, WSL, devcontainers, remote SSH, multiple machines

### H4: where hooks run vs where `~/.sam` is (High)
| Setup | Hooks run in | DB used | Result |
|---|---|---|---|
| Claude Code in WSL + Cursor or Antigravity on Windows | Linux (WSL) / Windows | `~/.sam` in WSL / `%USERPROFILE%\.sam` | **Two separate memories.** Contradicts "One SQLite file at `~/.sam/sam.db` is shared live by all your agents" (README). |
| User points WSL `SAM_HOME` at `/mnt/c/Users/x/.sam` to "share" | WSL + Windows | one file over 9p/drvfs | **Unsafe.** WAL needs shared memory and coherent locks inside one OS ("WAL does not work over a network filesystem", https://www.sqlite.org/wal.html). Two kernels cannot coordinate, so corruption is possible. |
| Devcontainer, `~/.sam` not mounted | container | container-local | Memory is lost on rebuild. |
| Devcontainer with host `~/.sam` bind-mounted (macOS Docker Desktop VM) | container VM + host | one file across a VM boundary | **Unsafe**, as above. |
| Devcontainer with host `~/.claude` bind-mounted (common for Claude devcontainers) | container | n/a | Hook commands point at **host** paths (`/opt/homebrew/...node`, host `sam.js`), so every hook exits 127 in the container (ties to H1). |
| Remote SSH (Claude or Codex on the server) | remote | remote `~/.sam` | Per-machine memory; nothing syncs. |
| `~/.sam` on NFS/SMB home, or Dropbox/iCloud | n/a | network or sync FS | WAL unsafe; a sync client can copy `sam.db` without `-wal`, which corrupts it. |

Fix (code plus docs):
```js
// src/db.js: refuse WAL on filesystems where it is unsafe; warn loudly in `sam doctor`
import { readFileSync } from 'node:fs';
function unsafeFs(dir) {
  if (process.platform === 'linux') {
    if (process.env.WSL_DISTRO_NAME && /^\/mnt\/[a-z]\//.test(dir)) return 'drvfs (Windows drive from WSL)';
    try {
      const mounts = readFileSync('/proc/mounts', 'utf8').split('\n').map((l) => l.split(' '));
      const m = mounts.filter((x) => x[1] && dir.startsWith(x[1])).sort((a, b) => b[1].length - a[1].length)[0];
      if (m && /^(nfs4?|cifs|smb3|9p|fuse\..*|virtiofs|vboxsf|drvfs)$/.test(m[2])) return m[2];
    } catch { /* ignore */ }
  }
  return null;
}
const why = unsafeFs(dirname(path));
if (why && !process.env.SAM_ALLOW_SHARED_FS) throw new Error(`SAM_HOME on ${why}: SQLite WAL cannot be shared safely; use a local SAM_HOME per environment (set SAM_ALLOW_SHARED_FS=1 to override)`);
```
Docs: "One DB per OS environment (Windows, each WSL distro, each container, each SSH host). Move memories with `sam export --jsonl` / `sam import`, or a committed `.sam/memory.md`. Projects keyed by git remote merge cleanly across machines; give no-remote repos a `.sam-project` name so their id is machine-independent." For devcontainers, run `sam install` **inside** the container (via a postCreateCommand) rather than mounting host agent configs, and mount a named volume at `~/.sam` if persistence is wanted.

### Multiple machines
Ids derived from the git remote are stable across machines ✔. Path-based ids (`sha('path:'+root)`) never match across machines, users, or WSL vs Windows (`/mnt/c/…` vs `C:\…`). `importJsonl` keeps the `project` column, so memories for no-remote repos land in an orphan project on the other machine. Recommendation: `sam import --remap-project <old>=<new>`, or recommend `.sam-project`.

---

## 6. Git edge cases

**Repro output** (repro `posix.mjs` (not shipped)):
```
remote pushurl_first  fork  9d1b74481bb9     ← should be "app" (team URL), got the user's fork via pushurl
remote upstream_only  upstream_only b237…    ← no origin → path id (differs per clone/machine)
remote quoted_url     app.git"  a212…         ← quote kept in name and id
remote crlf           app       6b87…         ✔ (\S+ stops at \r)
.sam-project BOM/CRLF same id: true           ✔ (String#trim strips U+FEFF and \r)
```

### M3: remote parsing (Medium)
`src/project.js:33`: `/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/`.
- `pushurl = …` before `url` is picked first, because `url` is a substring of `pushurl`.
- `url = "…"` keeps the quotes.
- With no `origin` but other remotes, SAM falls back to the path.
- `[remote "origin"]` defined via `include.path` / `includeIf` is missed.

Fix:
```js
function remoteFromConfig(cfg) {
  const remotes = {}; let cur = null;
  for (const line of cfg.split(/\r?\n/)) {
    const h = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (h) { cur = h[1]; continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    const u = cur && line.match(/^\s*url\s*=\s*"?([^"\s#;]+)"?/i);      // exact key "url", never "pushurl"
    if (u && !remotes[cur]) remotes[cur] = u[1];
  }
  return remotes.origin || remotes.upstream || remotes[Object.keys(remotes).sort()[0]] || null;
}
// gitRemote(): const url = remoteFromConfig(cfg); if (url) return normRemote(url);
```
The fallback changes the id only for repos that today have no origin; those currently use a path id, so migrate as in H3. `insteadOf` rewriting (`url = gh:owner/repo`) is not expanded. Low: read the `[url "<base>"] insteadOf = <prefix>` sections in the same loop and rewrite.

### L5: other git cases (Low)
- **`GIT_DIR` / `GIT_WORK_TREE` env:** ignored. A host started with `GIT_DIR` set (dotfiles-style) sees no `.git` and lands in `global`. Fix: `if (process.env.GIT_DIR && process.env.GIT_WORK_TREE && key.startsWith(canonPath(process.env.GIT_WORK_TREE))) root = canonPath(process.env.GIT_WORK_TREE)`, and read config from `GIT_DIR`.
- **Bare repos:** a directory with `HEAD`, `config` and `objects/` and no `.git` maps to `global`. Agents rarely work inside bare repos. The common "bare + worktrees" layout works (verified by reading the code): the worktree `.git` file has `gitdir: <bare>/worktrees/<n>`, `commondir` is `../..`, so the bare `config` is read.
- **`.git` file with a relative gitdir** (Git ≥2.48 `worktree.useRelativePaths`, submodules `gitdir: ../.git/modules/x`): `resolve(root, rel)` is relative to the `.git` file's directory ✔, and `commondir` is resolved relative to the gitdir ✔.
- **Worktrees on Windows:** Git for Windows writes `gitdir: C:/Users/…/.git/worktrees/wt` (forward slashes, drive letter), which Node's win32 `resolve` handles ✔. The same checkout opened from **WSL** reads `resolve('/mnt/c/…', 'C:/Users/…')` = `/mnt/c/…/C:/Users/…`, which does not exist, so the remote lookup silently falls to a path id. Fix: on Linux with `WSL_DISTRO_NAME`, map `^([A-Za-z]):[\\/]` to `/mnt/<lower>/`. Cygwin `/cygdrive/c/…` gets the analogous mapping on win32.
- **Submodules** become their own project (by their own origin), which is intended.

---

## 7. Other host-environment notes

- **M4, config-dir overrides (Medium).**
  - Codex keeps its state under `CODEX_HOME` (default `~/.codex`) (https://developers.openai.com/codex/config-advanced).
  - Claude Code uses `CLAUDE_CONFIG_DIR` (default `~/.claude`) (https://code.claude.com/docs/en/env-vars).
  - OpenCode reads `~/.config/opencode` per its docs (https://opencode.ai/docs/config). Whether it honours `XDG_CONFIG_HOME` is **UNVERIFIED** (its source could not be reached).

  SAM hardcodes all three (`src/install.js:156,193,294`, plus `~/.claude.json` and the skills directory), so users of these variables get configs written where the host never reads them, and `detect()` misses them. Fix:
  ```js
  const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
  const CODEX_DIR  = process.env.CODEX_HOME || join(HOME, '.codex');
  const OPENCODE_DIR = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'opencode'); // UNVERIFIED for OpenCode
  ```
  The same applies to `cursorNativeInstalled()` (`src/hooks.js`), which reads `~/.cursor/hooks.json`.
- **L6 (Info).** Codex on POSIX spawns hooks with `$SHELL -lc` (`default_shell_program`, command_runner.rs), i.e. a login shell. Profile scripts that print to stdout corrupt hook JSON. Unusual shells (nushell) do not run `'quoted path' args` as a command; SAM quotes only paths with spaces or specials. A `NODE_OPTIONS=--require x` that prints to stdout would also corrupt hook JSON. Document; optionally strip `NODE_OPTIONS` in the launcher.
- **Cursor imports Claude hooks** when Cursor has no hook config. On Windows those imported commands are wrapped for PowerShell and evaluated by bash (Cursor forum 168129). SAM's `cursor_version` re-tag (`src/hooks.js:135-138`) cannot help when the hook never starts. Installing native Cursor hooks avoids the import path; that is already the default.

---

## 8. What is fine (verified)
- Transcript harvesting with CRLF ✔. `.sam-project` with BOM and CRLF ✔. CRLF git config ✔.
- `shortPath` on Windows for normal backslash, forward-slash and case-differing paths under the root ✔.
- The OpenCode plugin spawns `node` with an argv, so it is shell-free on every OS ✔. Codex TOML uses `JSON.stringify(NODE)`, a valid TOML basic string with `\\` ✔.
- Hooks are silent on stderr on 22.13–26 (warning filtered) ✔. A pre-22.13 binary gets a clear message ✔.
- WAL and `busy_timeout` ordering is correct for parallel hooks on a local disk ✔.
- JS case mapping does not depend on the Turkish locale ✔.

---

## 9. Proposed stable launcher and command strategy (fixes C1, H1, the devcontainer case, Deno)

1. **Choose the runtime once, at install:** `SAM_NODE` env, else the Homebrew `opt/` symlink (`stableNode()`), else `process.execPath`, plus `RUNTIME_ARGV` for Deno.
2. **POSIX: write a launcher** at `~/.sam/bin/sam` (0755) and point every hook *and* MCP entry at it. The launcher re-resolves node at run time, so upgrades, uninstalls and switches self-heal:
   ```sh
   #!/bin/sh
   # written by `sam install`. Re-run it to refresh. Never fails the host.
   SAM_JS='/opt/homebrew/lib/node_modules/super-agent-memory/bin/sam.js'
   [ -f "$SAM_JS" ] || SAM_JS="$(command -v sam 2>/dev/null)"
   for n in "${SAM_NODE:-}" '/opt/homebrew/opt/node/bin/node' '/opt/homebrew/Cellar/node/24.21.0/bin/node' \
            "$HOME/.volta/bin/node" "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node; do
     [ -n "$n" ] && [ -x "$n" ] && [ -n "$SAM_JS" ] && exec "$n" "$SAM_JS" "$@"
   done
   printf 'sam: no usable node (>= 22.16) or sam.js; run "sam install" again\n' >&2
   exit 0
   ```
   (`sam.js` itself enforces the version; a too-old node falls through to its own `exit(0)`-for-hooks message.) Install generates the candidate list from what it knows: the stable path, the exact `execPath`, PATH lookups. The hook command becomes `'/Users/me/.sam/bin/sam' hook SessionStart --agent claude`, a single token that is trivially quoted and identical across node upgrades, so **Codex trust survives upgrades**. MCP entries become `{ command: "~/.sam/bin/sam" (absolute), args: ["mcp","--agent","codex"] }`.
3. **Windows:** do not rely on `.cmd` launchers. Claude exec form cannot spawn `.cmd` (hooks ref: "exec form requires `command` to resolve to a real executable such as a `.exe`"), and several MCP hosts spawn without a shell. Keep `node.exe` absolute and use the per-host shell forms from C1:
   - Claude: exec form `{command: node.exe, args:[sam.js, …]}` on ≥2.1.139, else `shell:"bash"` with forward-slash single-quoted paths.
   - Gemini and Cursor: PowerShell `& '…' '…'`.
   - Codex: cmd form, optionally also `commandWindows`.

   nvm-windows exposes a stable `C:\nvm4w\nodejs\node.exe` symlink. Whether `process.execPath` keeps that symlinked path on Windows (`GetModuleFileNameW`) is **UNVERIFIED**; prefer `SAM_NODE` or `where node` output when it points at the nvm4w link.
4. **Devcontainers / SSH:** the launcher lives in the environment's own `$HOME`, so `sam install` inside each environment produces correct local commands. Never mount host agent configs into containers for SAM. `sam doctor` should detect hook commands whose executable does not exist and say "configs from another machine/container? run sam install here".
5. **Self-test** (`sam install` end, and `sam doctor`): for every installed hook, run the exact command string through the host's shell with stdin `{}`, a 5 s timeout, and expect exit 0. Report per host. This is the single best guard against regressions of C1 and H1.

---

## Appendix: evidence files and commands
- Repro scripts (copies): the platform repro scripts (not shipped)
  - `winq.mjs`: win32 quoting simulation
  - `winpath.mjs`: `path.win32` shortPath, drive letters and UNC
  - `posix.mjs`: symlink and NFD project split, remote parsing, BOM `.sam-project`, CRLF markdown import (`import LF: 2  import CRLF: 0`)
  - `crlf.mjs`: CRLF transcript harvest, vault `$` grep, TextDecoder availability, Turkish case behaviour
  - `execpath.mjs`: Homebrew-style `execPath` realpath
- Node matrix: official tarballs from `https://nodejs.org/dist/<ver>/node-<ver>-linux-arm64.tar.gz`. The FTS5 probe was `new DatabaseSync(':memory:').exec('create virtual table x using fts5(a)')`. The suite was run with `<node> --test test/*.test.js` (24.14.0, 24.21.0, 26.10.0: 22/22 pass; 22.13.0: crash at import, `no such module: fts5`).
- Bun 1.4.2 (`bun test ./test/sam.test.js`: 22 pass) and Deno 2.9.7 (`deno test -A test/sam.test.js`: 22 passed).
- UNVERIFIED items (no Windows or macOS host, no PowerShell binary, no public spec):
  - the exact Cursor IDE hook shell on Windows, and whether a failing `beforeSubmitPrompt` blocks the prompt
  - the Antigravity hook shell
  - Apple `realpath(3)` true-case behaviour
  - `process.execPath` preserving the nvm-windows symlink
  - OpenCode `XDG_CONFIG_HOME` support
  - Windows long-path behaviour of SQLite and CreateProcess
