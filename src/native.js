// Native host memory, read-only: the instruction / memory files each host already loads on its own
// (CLAUDE.md, AGENTS.md, GEMINI.md, rules folders, Claude auto memory, Antigravity knowledge).
// SAM never writes to any of them. At session start the card drops lines whose content the host already
// injects, and flags (once per session) a SAM line that disagrees with a native line on the same subject.
import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { fold, sha } from './text.js';
import { config } from './config.js';

const FILE_CAP = 64 * 1024; // bytes read per file (Claude MEMORY.md: the host itself loads only 25 KB)
const TOTAL_CAP = 384 * 1024; // bytes read per session across all sources
const MAX_LINES = 1500; // cached native lines
const LINE_MAX = 240; // chars kept per cached line
const DIR_MAX = 40; // files per rules folder / knowledge items

/** Claude Code's per-project folder name: every non-alphanumeric character of the path becomes '-'. */
export const claudeSlug = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

const home = (env) => env.SAM_INSTALL_HOME || homedir();
const claudeDir = (env) => env.CLAUDE_CONFIG_DIR || join(home(env), '.claude');
const codexDir = (env) => env.CODEX_HOME || join(home(env), '.codex');

/**
 * The files a host loads by itself. Each entry: [label, absolute path | dir spec, hosts that read it].
 * Only sources the CURRENT host reads are used: a line in GEMINI.md is not "already present" for Codex.
 */
export function nativeSources({ root, cwd, agent, env = process.env }) {
  const out = [];
  const add = (label, path, opts = {}) => out.push({ label, path, ...opts });
  const A = String(agent || '').toLowerCase();
  const has = (...hosts) => hosts.includes(A);
  if (root) {
    const claudeMd = [join(root, 'CLAUDE.md'), join(root, '.claude', 'CLAUDE.md')];
    if (has('claude', 'cursor', 'opencode')) add('CLAUDE.md', claudeMd[0]);
    if (has('claude')) {
      add('.claude/CLAUDE.md', claudeMd[1]);
      add('CLAUDE.local.md', join(root, 'CLAUDE.local.md'));
      add('.claude/rules', join(root, '.claude', 'rules'), { dir: /\.md$/i, unscoped: true });
    }
    // Claude Code reads AGENTS.md only when there is no CLAUDE.md
    const claudeHasMd = claudeMd.some(isFile);
    if (has('codex', 'cursor', 'opencode', 'antigravity') || (A === 'claude' && !claudeHasMd)) add('AGENTS.md', join(root, 'AGENTS.md'));
    if (has('gemini', 'antigravity')) add('GEMINI.md', join(root, 'GEMINI.md'));
    if (has('antigravity')) add('.agents/rules', join(root, '.agents', 'rules'), { dir: /\.md$/i });
    if (has('cursor')) {
      add('.cursor/rules', join(root, '.cursor', 'rules'), { dir: /\.(md|mdc|txt)$/i });
      add('.cursorrules', join(root, '.cursorrules'));
    }
    if (has('copilot', 'vscode')) add('.github/copilot-instructions.md', join(root, '.github', 'copilot-instructions.md'));
  }
  if (has('claude')) {
    add('~/.claude/CLAUDE.md', join(claudeDir(env), 'CLAUDE.md'));
    // auto memory (on by default): the MEMORY.md index is loaded each session, first 200 lines / 25 KB
    const seen = new Set();
    for (const p of [root, cwd]) {
      if (!p || seen.has(claudeSlug(p))) continue;
      seen.add(claudeSlug(p));
      add('Claude auto memory (MEMORY.md)', join(claudeDir(env), 'projects', claudeSlug(p), 'memory', 'MEMORY.md'), { maxLines: 200, maxBytes: 25 * 1024 });
    }
  }
  if (has('gemini', 'antigravity')) add('~/.gemini/GEMINI.md', join(home(env), '.gemini', 'GEMINI.md'));
  if (has('codex')) add('~/.codex/AGENTS.md', join(codexDir(env), 'AGENTS.md'));
  if (has('opencode')) add('~/.config/opencode/AGENTS.md', join(home(env), '.config', 'opencode', 'AGENTS.md'));
  if (has('antigravity')) {
    // Knowledge Items: undocumented layout (one folder per item: metadata json + artifact files); 2.0 split dirs unverified
    for (const d of ['antigravity', 'antigravity-ide', 'antigravity-cli']) add('Antigravity knowledge', join(home(env), '.gemini', d, 'knowledge'), { knowledge: true });
  }
  return out;
}

function statOf(p) { try { return statSync(p); } catch { return null; } }
function isFile(p) { const s = statOf(p); return !!s && s.isFile(); }

/** Read at most n bytes of a regular file (never a FIFO/device; a symlink is followed only to a regular file). */
function readCapped(p, n) {
  const s = statOf(p);
  if (!s || !s.isFile()) return null;
  if (s.size <= n) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString('utf8').replace(/\uFFFD$/, '');
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* noop */ } }
}

function listDir(p, re) {
  const s = statOf(p);
  if (!s || !s.isDirectory()) return [];
  try { return readdirSync(p).filter((f) => re.test(f)).sort().slice(0, DIR_MAX).map((f) => join(p, f)); } catch { return []; }
}

/** Antigravity knowledge: defensive. Unexpected layout (not a dir, item not a dir, bad JSON) → that item (or all) is skipped. */
function knowledgeFiles(dir) {
  const s = statOf(dir);
  if (!s || !s.isDirectory()) return [];
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, DIR_MAX)) {
    if (!it.isDirectory()) continue; // stray files at the top level are not items
    const base = join(dir, it.name);
    for (const f of listDir(base, /\.(json|md|txt)$/i).slice(0, 6)) out.push({ path: f, json: /\.json$/i.test(f) });
    for (const f of listDir(join(base, 'artifacts'), /\.(md|txt)$/i).slice(0, 4)) out.push({ path: f });
  }
  return out;
}

/** Strings worth comparing inside a knowledge metadata JSON (title / summary / description…), depth ≤ 3. */
function jsonStrings(text) {
  let j;
  try { j = JSON.parse(text); } catch { return ''; }
  const out = [];
  const walk = (v, d) => {
    if (d > 3 || out.length > 40) return;
    if (typeof v === 'string') { if (v.length >= 12 && v.length <= 2000 && /\s/.test(v)) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v.slice(0, 40)) walk(x, d + 1); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!/^(id|uuid|path|uri|url|hash|created|updated|modified|timestamp)/i.test(k)) walk(x, d + 1);
  };
  walk(j, 0);
  return out.join('\n');
}

/** Markdown → candidate lines: front matter and HTML comments dropped (hosts strip comments), bullets/headings unwrapped. */
export function nativeLines(text, { unscoped = false } = {}) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  const fm = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    if (unscoped && /^paths\s*:/m.test(fm[1])) return []; // path-scoped Claude rules load on demand, not at start
    t = t.slice(fm[0].length);
  }
  t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, (m) => m.split('\n').slice(1, -1).join('\n'));
  const out = [];
  for (let l of t.split('\n')) {
    l = l.replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (l.length < 8) continue;
    // a long paragraph is compared sentence by sentence
    if (l.length > LINE_MAX) out.push(...l.split(/(?<=[.!?;])\s+/).filter((x) => x.length >= 8).map((x) => x.slice(0, LINE_MAX)));
    else out.push(l);
  }
  return out;
}

// ---------- comparison ----------
const STOP = new Set(('a an the and or of to in on at by for with from as is are was were be it its this that these those we you our your ' +
  'use uses used using should must can will please also all any each via into than then so do does ve ile bir bu şu için gibi da de ki ' +
  'olarak kullan kullanılır kullanıyoruz').split(' '));
// negations flip meaning: excluded from the overlap and compared separately ("never X" = "don't X" = "X değil")
const NEG = /^(not|no|never|dont|don't|without|avoid|disable[ds]?|degil|asla|yok|hicbir|instead)$/;
const POS = /^(always|enable[ds]?|her zaman)$/;

export function words(s) {
  const raw = fold(s).replace(/[’']/g, '').match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*[\p{L}\p{N}_]|[\p{L}\p{N}]/gu) || [];
  const content = new Set();
  let neg = false;
  for (const w of raw) {
    if (NEG.test(w)) { neg = true; continue; }
    if (POS.test(w) || w.length < 2 || STOP.has(w)) continue;
    content.add(w);
  }
  return { content, pol: neg ? 'neg' : '' };
}

const flat = (s) => ' ' + fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** "subject: value" (the decision format), also "**subject** — value" / "subject = value" in native files. */
export function subjectOf(s) {
  const m = String(s).replace(/\*\*/g, '').match(/^\s*([\p{L}\p{N}][\p{L}\p{N} _./-]{1,38}?)\s*(?::|=|—|–| - )\s*(.{2,})$/u);
  if (!m) return null;
  const subj = fold(m[1]).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (subj.length < 3 || /^(note|notes|important|warning|tip|example|e ?g|i ?e|todo|nb|not|uyari|ornek|onemli|see|http|https)$/.test(subj)) return null;
  return { subj, val: m[2].replace(/[.\s]+$/, '').trim() };
}

function sameValue(a, b) {
  const fa = flat(a), fb = flat(b);
  if (fa.includes(fb) || fb.includes(fa)) return true;
  return jaccard(words(a).content, words(b).content) >= 0.5;
}

/**
 * Read (or reuse from the mtime-keyed cache in meta) the native lines this host loads, and return a matcher.
 * Returns null when the host loads nothing SAM can see. `write` guards the cache write (hooks: read-only DB is fine).
 */
export function nativeContext({ db, root, cwd, agent, env = process.env, write = (fn) => fn() } = {}) {
  const cfg = config();
  if (!agent || cfg.nativeDedup === false) return null;
  const sources = nativeSources({ root, cwd, agent, env });
  // stat everything first: the signature decides whether the cached lines are still valid
  const files = [];
  for (const s of sources) {
    if (s.knowledge) { for (const k of knowledgeFiles(s.path)) files.push({ ...s, path: k.path, json: k.json }); continue; }
    if (s.dir) { for (const f of listDir(s.path, s.dir)) files.push({ ...s, label: s.label + '/' + basename(f), path: f }); continue; }
    files.push(s);
  }
  const present = [];
  for (const f of files) { const st = statOf(f.path); if (st && st.isFile()) present.push({ ...f, mtime: Math.trunc(st.mtimeMs), size: st.size }); }
  if (!present.length) return null;
  const sig = sha(present.map((f) => `${f.path}\0${f.mtime}\0${f.size}`).join('\n'), 16);
  const key = 'native:' + sha(`${agent}\0${root || ''}\0${cwd || ''}`, 16);
  let cached = null;
  try { const v = db?.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v; if (v) { const j = JSON.parse(v); if (j.sig === sig && Array.isArray(j.lines)) cached = j; } } catch { /* rebuild */ }
  if (!cached) {
    const lines = [];
    const labels = [];
    let budget = TOTAL_CAP;
    for (const f of present) {
      if (budget <= 0 || lines.length >= MAX_LINES) break;
      let t = readCapped(f.path, Math.min(f.maxBytes || FILE_CAP, budget));
      if (t == null) continue;
      budget -= Buffer.byteLength(t);
      if (f.json) t = jsonStrings(t);
      if (f.maxLines) t = t.split('\n').slice(0, f.maxLines).join('\n');
      const li = labels.push({ label: f.label, mtime: f.mtime }) - 1;
      for (const l of nativeLines(t, { unscoped: f.unscoped })) { if (lines.length >= MAX_LINES) break; lines.push([li, l]); }
    }
    cached = { sig, labels, lines };
    if (db) write(() => db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(key, JSON.stringify(cached)));
  }
  return matcher(cached, cfg);
}

/** Build the dedup / contradiction matcher over cached native lines. Exported for tests. */
export function matcher({ labels, lines }, cfg = config()) {
  const thr = cfg.nativeDedupJaccard || 0.6;
  const L = lines.map(([li, raw]) => ({ src: labels[li], raw, f: flat(raw), ...words(raw), so: subjectOf(raw) }));
  const index = new Map(); // content word → native line indexes (only lines sharing a word are compared)
  L.forEach((l, i) => { for (const w of l.content) { let a = index.get(w); if (!a) index.set(w, (a = [])); a.push(i); } });
  const bySubject = new Map();
  for (const l of L) if (l.so && !bySubject.has(l.so.subj)) bySubject.set(l.so.subj, l);
  return {
    sources: [...new Set(labels.map((x) => x.label))],
    lines: L.length,
    /** The memory's line is already in the host's own context (substring or token-Jaccard ≥ threshold, same polarity). */
    isDup(text) {
      const g = String(text || '').replace(/…$/, '');
      const f = flat(g);
      const w = words(g);
      if (!w.content.size) return false;
      const cand = new Set();
      for (const x of w.content) for (const i of index.get(x) || []) cand.add(i);
      for (const i of cand) {
        const l = L[i];
        if (l.pol !== w.pol) continue; // "never X" is not a copy of "X"
        if ((f.length >= 18 && l.f.includes(f)) || (w.content.size >= 2 && jaccard(w.content, l.content) >= thr)) return true;
      }
      return false;
    },
    /** A native line on the same subject that says the opposite (polarity) or a different value. */
    conflict(m) {
      const g = String(m.gist || '').replace(/…$/, '');
      const so = subjectOf(g);
      if (so) {
        const l = bySubject.get(so.subj);
        if (l && !sameValue(so.val, l.so.val)) return l;
      }
      const w = words(g);
      if (w.content.size < 3) return null;
      const cand = new Set();
      for (const x of w.content) for (const i of index.get(x) || []) cand.add(i);
      for (const i of cand) { const l = L[i]; if (l.pol !== w.pol && l.content.size >= 3 && jaccard(w.content, l.content) >= Math.max(thr, 0.6)) return l; }
      return null;
    },
  };
}
