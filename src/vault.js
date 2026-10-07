// Output vault: `sam run -- <cmd>` executes a command, keeps the FULL output in the
// local store and prints only a digest (status, error lines with context, tail).
// Agents pull more with `sam-memory out <id> --grep <re>` only when they need it.
import { spawn } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { openDb, bump } from './db.js';
import { newId, tokens, now, redact } from './text.js';
import { constants } from 'node:os';
import { config } from './config.js';
import { pickShell, decodeOutput } from './platform.js';

const ERR = /(error|fail|failed|failing|exception|traceback|panic|fatal|cannot|can't|not found|undefined|denied|refused|timeout|ERR!|✗|✖|×)/i;
// ANSI escape sequences (colors, cursor moves) and carriage-return progress bars
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');

export function clean(text) {
  return String(text).replace(ANSI, '').replace(/^.*\r(?!\n)/gm, '');
}

/** Collapse runs of identical / near-identical lines ("downloading… 1%", repeated warnings). */
export function collapse(lines) {
  const out = [];
  let prev = null, count = 0;
  const norm = (l) => l.replace(/\d+/g, '#').trim();
  for (const l of lines) {
    const n = norm(l);
    if (n === prev) { count++; continue; }
    if (count > 0) out.push(`  … (${count} similar lines)`);
    out.push(l); prev = n; count = 0;
  }
  if (count > 0) out.push(`  … (${count} similar lines)`);
  return out;
}

export function digest(output, ok, { maxLines = 40 } = {}) {
  const rawLines = clean(output).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (rawLines.length && !rawLines[rawLines.length - 1]) rawLines.pop();
  const total = rawLines.length;
  const lines = collapse(rawLines.filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim())));
  if (lines.length <= maxLines) return { text: lines.join('\n'), shown: lines.length, total, partial: lines.length < total };
  const keep = new Set();
  if (!ok) {
    lines.forEach((l, i) => {
      if (ERR.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
    });
  }
  // always keep the summary tail
  const tailN = Math.min(ok ? 12 : 10, maxLines);
  for (let i = lines.length - tailN; i < lines.length; i++) keep.add(i);
  let idx = [...keep].sort((a, b) => a - b);
  if (idx.length > maxLines) {
    const tail = idx.slice(-tailN);
    idx = [...idx.slice(0, maxLines - tailN), ...tail];
  }
  const out = [];
  let last = -1;
  for (const i of idx) {
    if (i > last + 1) out.push(`  ⋮ ${i - last - 1} lines`);
    out.push(lines[i]);
    last = i;
  }
  return { text: out.join('\n'), shown: idx.length, total, partial: true };
}

/**
 * Run `cmd` through `shell` (default: pickShell(): /bin/sh on POSIX; on Windows Git Bash, else
 * pwsh/powershell, else cmd.exe). Output is decoded as UTF-8, or the console code page when it is not.
 */
export function runCommand(cmd, { cwd = process.cwd(), project = { id: 'global' }, maxLines = 40, onEvent, shell = pickShell() } = {}) {
  return new Promise((resolve) => {
    // nudge common tools to UTF-8 on Windows (Python, git's pager-less output is already UTF-8)
    const env = process.platform === 'win32' ? { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...process.env } : process.env;
    // stdin is closed: a child waiting for input must not hang the agent forever
    const child = spawn(shell.file, shell.argsFor(cmd), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: !!shell.verbatim });
    const chunks = [];
    let bytes = 0;
    const cap = config().vaultMaxBytes;
    const take = (d) => { if (bytes < cap) chunks.push(d); bytes += d.length; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => take(Buffer.from(`[sam: ${e.message}]\n`)));
    child.on('close', (rawCode, signal) => {
      const code = rawCode ?? (signal ? 128 + (constants.signals[signal] || 0) : 1);
      const output = decodeOutput(Buffer.concat(chunks)) + (signal ? `\n[sam: killed by ${signal}]` : '') + (bytes > cap ? `\n[sam: output truncated at ${cap} bytes]` : '');
      const ok = code === 0;
      const d = digest(output, ok, { maxLines });
      const db = openDb();
      let id;
      do { id = 'o' + newId(6); } while (db.prepare('SELECT 1 FROM vault WHERE id = ?').get(id));
      const header = `$ ${cmd.length > 120 ? cmd.slice(0, 119) + '…' : cmd}  → exit ${code} · ${d.total} lines · ${(bytes / 1024).toFixed(1)}KB`;
      const footer = d.partial ? `[full output: sam-memory out ${id} --grep <re> | --tail N | --lines A:B]` : '';
      const shownText = [header, d.text, footer].filter(Boolean).join('\n');
      // the stored copy is redacted too (`sam run -- env` must not persist secrets for 14 days)
      db.prepare('INSERT OR REPLACE INTO vault(id, project, cmd, exit_code, bytes, shown_bytes, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, project.id, redact(cmd), code, bytes, Buffer.byteLength(shownText), deflateSync(Buffer.from(redact(output))), now());
      const saved = Math.max(0, tokens(output) - tokens(shownText));
      bump(project.id, 'vault_runs');
      bump(project.id, 'tokens_saved_vault', saved);
      onEvent?.({ ok, code, output });
      resolve({ id, code, ok, text: shownText, savedTokens: saved });
    });
  });
}

// ReDoS guard (S14). A user/agent-supplied grep runs as a regex only when it is in a safe subset: no quantified
// group (covers nested quantifiers like (a+)+ AND overlapping alternation like (a|aa)+), no backreference, at most
// 2 unbounded quantifiers, ≤200 chars. Lines are cut at 2,000 chars and the whole scan has a time budget.
const QUANTIFIED_GROUP = /\)\s*(?:[+*?]|\{\d*,?\d*\})/;
const BACKREF = /\\(?:[1-9]|k<)/;
export function safeRegex(pattern) {
  const p = String(pattern);
  if (p.length > 200 || QUANTIFIED_GROUP.test(p) || BACKREF.test(p)) return false;
  const unbounded = (p.replace(/\\./g, '').replace(/\[[^\]]*\]/g, 'x').match(/[+*]|\{\d+,\}/g) || []).length;
  return unbounded <= 2;
}
/** A grep pattern as a safe line test: regex when it is valid and cannot blow up, literal substring otherwise. */
export function safeMatcher(pattern) {
  const lit = String(pattern).toLowerCase();
  const literal = (l) => l.toLowerCase().includes(lit);
  if (!safeRegex(pattern)) return literal;
  try {
    const re = new RegExp(pattern, 'i');
    return (l) => re.test(l.length > 2000 ? l.slice(0, 2000) : l);
  } catch { return literal; }
}

export function isVaultId(id, { project } = {}) {
  if (!/^o[0-9a-z]{4,}$/.test(String(id))) return false;
  const row = openDb().prepare('SELECT project FROM vault WHERE id = ?').get(String(id));
  return !!row && (!project || row.project === project || row.project === 'global');
}

export function readVault(id, { grep, tail, lines, context = 1 } = {}) {
  const row = openDb().prepare('SELECT * FROM vault WHERE id = ?').get(String(id));
  if (!row) return null;
  const all = clean(inflateSync(row.output).toString('utf8')).split(/\r?\n/);
  let out;
  if (grep) {
    const test = safeMatcher(String(grep));
    const keep = new Set();
    const deadline = Date.now() + 500; // total time budget for the scan
    for (let i = 0; i < all.length; i++) {
      if ((i & 15) === 0 && Date.now() > deadline) break;
      if (test(all[i])) for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep.add(j);
    }
    out = [...keep].sort((a, b) => a - b).map((i) => `${i + 1}: ${all[i]}`).slice(0, 200);
  } else if (lines) {
    let [a, b] = String(lines).split(':').map((x) => parseInt(x, 10));
    if (!Number.isFinite(a) || a < 1) a = 1;
    if (!Number.isFinite(b) || b < a) b = a + 50;
    out = all.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`);
  } else {
    out = all.slice(-(tail || 40));
  }
  return { header: `$ ${row.cmd} → exit ${row.exit_code} · ${all.length} lines`, text: out.join('\n') };
}
