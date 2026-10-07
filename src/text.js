// Text utilities: token estimation, gists, near-duplicate hashing, redaction.
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Cheap, model-agnostic token estimate. Calibrated against o200k_base/cl100k_base (tiktoken) on
 * code, markdown, prose, memory lines, Turkish and JSON: within about ±5% per class. On everything SAM injects
 * (cards, recall lines, dumps) it reads 0.94–0.99× o200k (bench/retrieval); cards are packed to 94% of their budget.
 */
export function tokens(s) {
  if (!s) return 0;
  s = String(s);
  const segs = s.match(/[A-Za-z]+|[0-9]+|[\p{L}\p{M}]+|[^\s\p{L}\p{N}]+/gu) || [];
  let t = 0;
  for (const w of segs) {
    const c = w.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { if (/^[A-Za-z]+$/.test(w)) { t += w.length <= 8 ? 1 : Math.ceil(w.length / 6); continue; } }
    if (c >= 48 && c <= 57 && /^[0-9]+$/.test(w)) { t += Math.ceil(w.length / 3); continue; }
    if (/^[\p{L}\p{M}]+$/u.test(w)) { t += Math.max(1, [...w].length / 2.2); continue; }
    let astral = 0, nonAscii = 0, n = 0;
    for (const ch of w) { n++; const cp = ch.codePointAt(0); if (cp > 0xffff) astral++; else if (cp > 127) nonAscii++; }
    t += astral * 2 + nonAscii + Math.ceil((n - astral - nonAscii) / 3);
  }
  // short random ids (#k3x9) split into ~3 tokens, not 1 word
  t += (s.match(/#[0-9a-z]{4,12}\b/g) || []).length;
  // line breaks are their own token in o200k/cl100k almost always (calibrated on real cards: −4.7% → ±2%)
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) t += 1;
  // v2-guard: the provenance bullets "-a"/"-t"/"-i" are one o200k token each, like "-" (the split above counts 2)
  if (s.includes('-')) t -= (s.match(/(?:^|\n)-[ati] /g) || []).length;
  return Math.ceil(t);
}

const ALPH = '0123456789abcdefghijklmnopqrstuvwxyz';
export function newId(len = 5) {
  // uniform base36 (rejection sampling); collisions handled by caller retry
  let out = '';
  while (out.length < len) for (const b of randomBytes(len * 2)) { if (b < 252 && out.length < len) out += ALPH[b % 36]; }
  return out;
}

/** Fold case + diacritics identically for queries and stored text (Turkish İ/ı safe). */
export function fold(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ı/g, 'i');
}

export function sha(s, n = 12) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, n);
}

export function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Shorten to a gist: first sentence / line, hard-capped, word-boundary aware. */
export function gistOf(s, max = 100) {
  let t = oneLine(s);
  if (t.length <= max) return t;
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  if (m && m[1].length <= max) t = m[1];
  if (t.length <= max) return t;
  const cut = safeSlice(t, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

/**
 * Card cut for durable rule lines (convention / decision / preference / procedure): the coding eval showed a plain
 * word cut at 80 chars dropping the decisive tail of a rule (`--error-on-warnings`, an `ff-` prefix, a timezone).
 * Within `max` chars it cuts at the last clause boundary ("; ", ", ", " — ", ". ", " (") past 55% of the limit, and
 * never inside a `code span` or a quoted 'token': an open span is either completed (when it closes within
 * max + slack chars) or dropped whole. Falls back to gistOf's word cut.
 */
export function clauseCut(s, max = 120, { slack = 32 } = {}) {
  const t = oneLine(s).replace(/…$/, '');
  if (t.length <= max) return t;
  // spans that must stay whole: `code`, 'quoted', "quoted", and dash-flags / prefixes like --error-on-warnings
  const spans = [];
  for (const m of t.matchAll(/`[^`]*`|\([^()]{0,40}\)|'[^'\s][^']{0,60}'|"[^"]{1,60}"|(?<=\s|^)--?[A-Za-z][\w-]*/g)) spans.push([m.index, m.index + m[0].length]);
  const inside = (i) => spans.find(([a, b]) => i > a && i < b);
  let end = -1;
  const re = /[;,.](?=\s)|\s[—–-]\s|\s\(/g;
  for (let m; (m = re.exec(t));) {
    const i = m.index; // the boundary char (";" "," "." or the space before " — " / " (") is dropped
    if (i > max) break;
    if (i >= max * 0.55 && !inside(i)) end = i;
  }
  if (end > 0) return t.slice(0, end) + '…';
  // no clause boundary: word cut, but a span straddling the cut is completed (≤ slack chars over) or dropped
  let cut = t.lastIndexOf(' ', max - 1);
  if (cut < max * 0.5) cut = max - 1;
  const sp = inside(cut) || spans.find(([a, b]) => a < cut && b > cut);
  if (sp) {
    if (sp[1] <= max + slack) cut = sp[1];
    else cut = Math.max(t.lastIndexOf(' ', sp[0]), 1);
  }
  return t.slice(0, cut).replace(/[\s,;:]+$/, '') + (cut < t.length ? '…' : '');
}

/**
 * One canonical spelling per directory/file, used for project roots, cwd keys and file subjects:
 * MSYS /c/x → C:/x and \\?\ stripped (Windows), resolved, symlinks resolved (realpath, true case on Windows),
 * Unicode NFC (macOS NFD names), upper-case drive letter. A path that does not exist is still normalized.
 */
export function canonicalPath(p, { platform = process.platform } = {}) {
  if (p == null || p === '') return '';
  const P = platform === 'win32' ? path.win32 : path.posix;
  let s = String(p);
  if (platform === 'win32') {
    s = s.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => d.toUpperCase() + ':');
  }
  s = P.resolve(s);
  if (platform === process.platform) { try { s = realpathSync.native(s); } catch { /* may not exist */ } }
  s = s.normalize('NFC');
  if (platform === 'win32') s = s.replace(/^[a-z]:/, (d) => d.toUpperCase());
  return s;
}

export function shortPath(p, root, { platform = process.platform } = {}) {
  if (!p) return '';
  const P = platform === 'win32' ? path.win32 : path.posix;
  let s = stripInvisible(String(p));
  const msys = platform === 'win32' && /^\/[a-zA-Z](?:\/|$)/.test(s);
  if (P.isAbsolute(s) || msys || /^\\\\\?\\/.test(s)) {
    s = canonicalPath(s, { platform });
    if (root) {
      const r = P.relative(canonicalPath(root, { platform }), s);
      if (r && !r.startsWith('..') && !P.isAbsolute(r)) s = r;
    }
  } else s = s.normalize('NFC');
  return s.split(P.sep).join('/').split('\\').join('/');
}

/** Compress a list of paths into a compact glob-ish string: src/a/{x,y}.ts */
export function compactPaths(paths, max = 6) {
  const uniq = [...new Set(paths.filter(Boolean))];
  const groups = new Map();
  for (const p of uniq) {
    const i = p.lastIndexOf('/');
    const dir = i >= 0 ? p.slice(0, i + 1) : '';
    const base = i >= 0 ? p.slice(i + 1) : p;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(base);
  }
  const out = [];
  for (const [dir, bases] of groups) {
    out.push(bases.length === 1 ? dir + bases[0] : `${dir}{${bases.slice(0, 5).join(',')}${bases.length > 5 ? ',…' : ''}}`);
    if (out.length >= max) break;
  }
  const extra = groups.size - out.length;
  return out.join(' ') + (extra > 0 ? ` +${extra}` : '');
}

const STOP = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those ' +
  'i you he she we they me my your our their do does did done have has had not no yes so very can could should would will shall may might must ' +
  'just also than too into over under about after before again more most some such only own same any each few other both all what which who whom ' +
  'when where why how there here up down out off use using used make made get got please now new want need like ' +
  // Turkish
  've veya ile ama fakat ki de da bu şu o bir için gibi daha çok en mi mı mu mü ne neden nasıl hangi her şey ben sen biz siz onlar bana sana ' +
  'olan olarak olur oldu var yok değil ise çünkü kadar sonra önce yani hem lütfen şimdi yeni').split(/\s+/));

// Words that flip meaning: kept in the duplicate fingerprint even though they are stop words for search.
export const POLARITY = new Set(['not', 'no', 'never', 'always', 'before', 'after', 'dont', "don't", 'without', 'disable', 'disabled',
  'enable', 'enabled', 'değil', 'asla', 'yok', 'var', 'önce', 'sonra', 'hiçbir', 'her', 'should', 'must', 'can', 'cannot']);

export function keywords(s, max = 12) {
  const words = oneLine(fold(s)).match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]{1,}/gu) || [];
  const seen = new Map();
  for (let w of words) {
    w = w.replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (w.length < 2 || STOP.has(w)) continue;
    seen.set(w, (seen.get(w) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map((e) => e[0]);
}

/** 64-bit SimHash over word 2-shingles. Returns hex string. */
export function simhash(s) {
  const words = (oneLine(fold(s)).match(/[\p{L}\p{N}_']+/gu) || []).filter((w) => POLARITY.has(w) || !STOP.has(w));
  const feats = words.length > 1 ? words.slice(1).map((w, i) => words[i] + ' ' + w) : words;
  if (!feats.length) return ''; // no fingerprint: never merged as a duplicate
  // 64-bit SimHash on two 32-bit halves (plain Numbers: ~20x faster than BigInt, same output format)
  const v = new Int32Array(64);
  for (const f of feats) {
    const d = createHash('md5').update(f).digest();
    const hi = d.readUInt32BE(0), lo = d.readUInt32BE(4);
    for (let i = 0; i < 32; i++) { v[i] += (lo >>> i) & 1 ? 1 : -1; v[i + 32] += (hi >>> i) & 1 ? 1 : -1; }
  }
  let hi = 0, lo = 0;
  for (let i = 0; i < 32; i++) { if (v[i] > 0) lo |= 1 << i; if (v[i + 32] > 0) hi |= 1 << i; }
  hi >>>= 0; lo >>>= 0;
  return hi ? hi.toString(16) + lo.toString(16).padStart(8, '0') : lo.toString(16);
}

function pop32(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

export function hamming(a, b) {
  const A = String(a || '0').padStart(16, '0').slice(-16), B = String(b || '0').padStart(16, '0').slice(-16);
  return pop32((parseInt(A.slice(0, 8), 16) ^ parseInt(B.slice(0, 8), 16)) >>> 0) + pop32((parseInt(A.slice(8), 16) ^ parseInt(B.slice(8), 16)) >>> 0);
}

const GENERIC_TOPIC = /^(note|notes|important|update|todo|fyi|info|warning|tip|reminder|remember|nb|ps|not|önemli|onemli|uyarı|uyari|bilgi|hatırlatma|ipucu|dikkat)$/i;

/** Topic key: lets "use pnpm" supersede "use npm" for the same subject. */
export function topicOf(kind, text, explicit) {
  if (explicit) return explicit.toLowerCase().trim();
  if (!['decision', 'convention', 'preference', 'fact'].includes(kind)) return null;
  // "X: Y" / "X = Y" / "X -> Y" forms carry an explicit subject
  const m = oneLine(text).match(/^([\p{L}\p{N}_ .\-/]{2,40}?)\s*(?::|=|->|→)\s+\S/u);
  if (m && !GENERIC_TOPIC.test(m[1].trim())) return kind + ':' + fold(m[1]).trim();
  return null;
}

// ---------- untrusted text hygiene ----------

// Invisible / direction-changing code points: zero-width, bidi controls, Unicode TAG block ("ASCII smuggling"),
// variation selectors, fillers, soft hyphen, C0/C1 controls (except \t \n \r). They let the text a model reads
// differ from what a human reviews, and split secrets so redaction misses them.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]|\uDB40[\uDC00-\uDDEF]/g;

/** Strip invisible / bidi / tag characters (no other change). */
export function stripInvisible(s) {
  return String(s ?? '').replace(INVISIBLE, '');
}

/**
 * Normalize text that will be stored and later injected into a model's context: NFKC folds fullwidth and
 * compatibility forms (＜／memory＞ → </memory>, so escaping sees them), then invisible characters are dropped.
 */
export function sanitize(s) {
  if (s == null) return '';
  let t = String(s);
  try { t = t.normalize('NFKC'); } catch { /* lone surrogates: keep as is */ }
  return t.replace(INVISIBLE, '');
}

/** Escape a value for the <memory> wrapper: it is data, it can never close the wrapper or open a tag. */
export function escCard(s) {
  return sanitize(s).replace(/</g, '‹').replace(/>/g, '›').replace(/[\r\n\t]+/g, ' ');
}

// ---------- secret redaction (linear time) ----------
// Every pattern below is anchored on a literal prefix and uses BOUNDED quantifiers, so the cost per start
// position is a small constant: redact() is O(n) even on adversarial input ('a_'.repeat(1e6), 'sk-'.repeat(…)).
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant(?:-api\d{1,3})?)?[-_]?(?=[A-Za-z0-9_-]{0,64}(?:\d|[A-Z]))[A-Za-z0-9_-]{16,256}\b/g, // OpenAI / Anthropic / Stripe
  /\bgh[pousr]_[A-Za-z0-9]{12,255}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, /\bglpat-[A-Za-z0-9_-]{20,255}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g, /\bhf_[A-Za-z0-9]{30,255}\b/g, /\bSG\.[\w-]{16,128}\.[\w-]{16,128}\b/g, /\bya29\.[\w-]{20,512}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g, /https:\/\/hooks\.slack\.com\/services\/[\w/]{1,255}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bAIza[0-9A-Za-z_-]{30,255}/g,
  /\beyJ[\w-]{10,2048}\.[\w-]{10,2048}\.[\w-]{10,2048}\b/g, // JWT
  /\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6,7}\.[\w-]{27,40}\b/g, // Discord bot token
  /\bPrivate-Lines:\s{0,8}\d{1,4}\s{0,8}[\r\n]+[A-Za-z0-9+/=\r\n \t]{8,20000}/g, // PuTTY .ppk private part
  /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,1024}/g,
];
const SECRET_NAMES = 'api[_-]?key|apikey|secret|token|password|passwd|passphrase|private[_-]?key|access[_-]?key|account[_-]?key|client[_-]?secret|auth[_-]?token|(?<=[_-])(?:pwd|pass|pw|auth)';
// keep-prefix patterns: group 1 is kept, the secret after it is masked
const NOT_A_VALUE = String.raw`(?![A-Za-z_$][\w$.]{0,128}\s{0,8}\(|required\b|process\.env|os\.environ|getenv|null\b|undefined\b|true\b|false\b|none\b|\$\{|<|>|\|)`;
const KEEP_PATTERNS = [
  /(\b(?:Bearer|Basic|Token)\s{1,8})[A-Za-z0-9._~+/=-]{12,4096}/g,
  /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)[^\s@/]{3,512}(?=@)/gi, // scheme://user:PASSWORD@host
  // NAME = value / "name": "value" / NAME: value for secret-ish names (also as the last segment: OPENAI_API_KEY, SMTP_PASS, DB_PWD).
  // The lookbehind replaces v1.1's (?:[A-Za-z0-9]+[_-])* prefix chain (quadratic); it accepts exactly the same names.
  new RegExp(String.raw`((?<![A-Za-z0-9])(?:${SECRET_NAMES})(?![A-Za-z0-9])["']?\s{0,8}[:=]\s{0,8}["']?)${NOT_A_VALUE}([^\s'",;)}]{4,4096})`, 'gi'),
  new RegExp(String.raw`((?<![A-Za-z0-9])(?:api|x-api|x-auth|auth)[_-](?:key|token)\s{0,8}:\s{0,8})${NOT_A_VALUE}([^\s'",;)}]{4,4096})`, 'gi'), // X-Api-Key: header
  /((?<![A-Za-z0-9])(?:password|passwd|secret|token|api[_-]?key)\s{0,8}:\s{0,8}[>|][-+]?[ \t]{0,8}\r?\n[ \t]{1,32})(\S{4,4096})/gi, // YAML block scalar
  /([?&;](?:key|api[_-]?key|api%5Fkey|access[_-]?token|token|sig|signature|secret|password|code|client[_-]?secret)=)[^&\s#"']{6,4096}/gi, // URL query
  /(\s-u\s{0,4}["']?[^\s:"']{1,128}:)[^\s"']{3,512}/g, // curl -u user:pass
  /((?<![\w-])(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,200}?\s-p)(?![\s-])\S{3,512}/g, // mysql -pPASS
];

// <private>…</private>, nesting-aware, linear: an unclosed <private> hides everything after it.
function dropPrivate(t) {
  if (!/<private>/i.test(t)) return t;
  const re = /<(\/?)private>/gi;
  let out = '', depth = 0, last = 0, m;
  while ((m = re.exec(t))) {
    if (!m[1]) { if (depth === 0) out += t.slice(last, m.index); depth++; }
    else if (depth > 0) { depth--; if (depth === 0) { out += '[private]'; last = re.lastIndex; } }
  }
  if (depth > 0) return out + '[private]';
  return out + t.slice(last);
}

// PEM private keys (real or JSON-escaped newlines). A truncated block (no END line) is masked up to the next
// blank line or the end. Single forward scan: linear even with thousands of BEGIN lines and no END.
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
function dropPem(t) {
  if (!t.includes('PRIVATE KEY')) return t;
  let out = '', last = 0, m, endFrom = 0, noEndAfter = Infinity;
  PEM_BEGIN.lastIndex = 0;
  while ((m = PEM_BEGIN.exec(t))) {
    const from = m.index + m[0].length;
    let stop = -1;
    if (from < noEndAfter) {
      PEM_END.lastIndex = Math.max(from, endFrom);
      const e = PEM_END.exec(t);
      if (e) { stop = e.index + e[0].length; endFrom = e.index; } else noEndAfter = from;
    }
    if (stop < 0) { const b = /\n[ \t]*\n/g; b.lastIndex = from; const bm = b.exec(t); stop = bm ? bm.index : t.length; }
    out += t.slice(last, m.index) + '[redacted]';
    last = stop;
    PEM_BEGIN.lastIndex = Math.max(stop, PEM_BEGIN.lastIndex);
  }
  return out + t.slice(last);
}

function redactPlain(t) {
  t = dropPem(t);
  for (const re of SECRET_PATTERNS) t = t.replace(re, '[redacted]');
  for (const re of KEEP_PATTERNS) t = t.replace(re, (m, keep) => keep + '[redacted]');
  return t;
}

// base64 blobs that decode to a secret (an encoded .env line, an OpenSSH key body without its headers)
const B64 = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{24,8192}={0,2}(?![A-Za-z0-9+/=])/g;
function redactBase64(t) {
  return t.replace(B64, (m) => {
    if (!/[0-9+/]/.test(m) || !/[a-z]/.test(m) || !/[A-Z]/.test(m)) return m; // identifiers / words, not base64
    let d;
    try { d = Buffer.from(m, 'base64').toString('latin1'); } catch { return m; }
    if (/openssh-key-v1|PRIVATE KEY/.test(d)) return '[redacted]';
    let printable = 0;
    for (let i = 0; i < d.length; i++) { const c = d.charCodeAt(i); if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9) printable++; }
    if (printable < d.length * 0.95) return m;
    return redactPlain(d) !== d ? '[redacted]' : m;
  });
}

// ---------- PII redaction (linear time, checksum-validated where a checksum exists) ----------
// e-mail → [email], phone (TR national / international +CC) → [phone], IBAN (mod-97) → [iban], TCKN (official
// checksum) → [tckn]. Built to leave developer text alone: git SHAs, semver, dates, timestamps, ports, numeric ids,
// scp-style git remotes (git@github.com:o/r) and retina assets (logo@2x.png) are not touched.

// local@domain.tld; the tld must be letters and not a file extension (icon@2x.png), and an scp-like remote
// (git@host:path) or a `git@` user is not an address
const FILE_EXT = /^(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|js|mjs|cjs|ts|tsx|jsx|css|scss|less|json|ya?ml|md|txt|html?|xml|map|wasm|lock|log|py|rb|go|rs|java|kt|swift|sh|zip|gz|tgz)$/i;
const EMAIL = /(?<![\w.%+-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}([A-Za-z]{2,24}))(?![\w-]|\.[A-Za-z0-9])(:[\w~./-])?/g;
// RFC 2606 / 6761 reserved names never belong to a person: seed users like admin@shop.test stay readable
const RESERVED_TLD = /^(?:test|example|invalid|localhost|local)$/i;
const RESERVED_DOM = /^(?:.+\.)?example\.(?:com|net|org)$/i;
function redactEmail(t) {
  if (!t.includes('@')) return t;
  return t.replace(EMAIL, (m, local, dom, tld, scp) => {
    if (scp || /^git$/i.test(local) || FILE_EXT.test(tld) || RESERVED_TLD.test(tld) || RESERVED_DOM.test(dom)) return m;
    return '[email]';
  });
}

// IBAN: country code from the IBAN registry, 2 check digits, then 11–30 alphanumerics, optionally grouped by 4.
const IBAN_CC = new Set(('AD AE AL AT AZ BA BE BG BH BI BR BY CH CR CY CZ DE DJ DK DO EE EG ES FI FK FO FR GB GE GI GL GR GT HR HU IE IL IQ IS IT ' +
  'JO KW KZ LB LC LI LT LU LV LY MC MD ME MK MN MR MT MU NI NL NO OM PK PL PS PT QA RO RS RU SA SC SD SE SI SK SM SO ST SV TL TN TR UA VA VG XK YE').split(' '));
const IBAN_RE = /(?<![A-Za-z0-9])([A-Z]{2})(\d{2})((?:[ -]?[A-Z0-9]){11,30})(?![A-Za-z0-9])/g;
export function ibanValid(s) {
  const v = String(s).replace(/[ -]/g, '').toUpperCase();
  if (v.length < 15 || v.length > 34 || !IBAN_CC.has(v.slice(0, 2)) || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(v)) return false;
  const r = v.slice(4) + v.slice(0, 4);
  let mod = 0;
  for (const ch of r) {
    const c = ch.charCodeAt(0);
    const d = c >= 65 ? String(c - 55) : ch;
    for (const x of d) mod = (mod * 10 + (x.charCodeAt(0) - 48)) % 97;
  }
  return mod === 1;
}
function redactIban(t) {
  if (!/[A-Z]{2}\d{2}/.test(t)) return t;
  return t.replace(IBAN_RE, (m, cc) => {
    if (!IBAN_CC.has(cc)) return m;
    if (ibanValid(m)) return '[iban]';
    // a grouped IBAN followed by an unrelated group ("TR33 0006 … 26 1234"): try shorter group prefixes
    const groups = m.split(/[ -]/);
    for (let k = groups.length - 1; k >= 4; k--) {
      const head = groups.slice(0, k).join(' ');
      if (ibanValid(head)) return '[iban]' + m.slice(head.length);
    }
    return m;
  });
}

// TCKN: 11 digits, first non-zero, d10 = ((d1+d3+d5+d7+d9)*7 − (d2+d4+d6+d8)) mod 10, d11 = (d1+…+d10) mod 10.
export function tcknValid(s) {
  const v = String(s);
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8], even = d[1] + d[3] + d[5] + d[7];
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}
// standalone: not part of a longer number, a dotted version, a path/ident, a port or a hex id
const TCKN_RE = /(?<![\w.:/#@+-])[1-9]\d{10}(?![\w]|[.:-]\d)/g;
function redactTckn(t) {
  return t.replace(TCKN_RE, (m) => (tcknValid(m) ? '[tckn]' : m));
}

// Phones. International: "+" country code, 8–15 digits in total, separated by single spaces, dashes, dots or a
// parenthesized area code. TR national: 0 + area/mobile code [2-5]xx + 7 digits (0532 123 45 67, (0212) 555 12 34).
// A "+" glued to a word or digit (semver build metadata 1.0.0+2013…) never starts a phone.
const PHONE_INTL = /(?<![\w+])\+[1-9]\d{0,3}\)?(?:[ .-]?\(\d{1,5}\)|[ .-]?\d{1,5}){1,6}(?![\w]|[.:-]\d)/g;
const PHONE_TR = /(?<![\w.:/#@+-])\(?0[ ]?\(?[2-5]\d{2}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}(?![\w]|[.:-]\d)/g;
function redactPhone(t) {
  t = t.replace(PHONE_INTL, (m) => {
    const n = m.replace(/\D/g, '').length;
    return n >= 8 && n <= 15 ? '[phone]' : m;
  });
  return t.replace(PHONE_TR, (m) => {
    const digits = m.replace(/\D/g, '');
    // a compact 11-digit run must look like a mobile number (05xx): "02024100701" is more likely an id than a landline
    if (!/[ ().-]/.test(m) && !/^05/.test(digits)) return m;
    // dates written with separators (0 212-10-2026 …) never reach here: the groups are 3-3-2-2 after the 0
    return digits.length === 11 ? '[phone]' : m;
  });
}

/** Mask e-mail, phone, IBAN and TCKN (config `redactPII`, default on). Linear time. */
export function redactPII(t) {
  if (!t) return t;
  t = String(t);
  t = redactEmail(t);
  t = redactIban(t);
  t = redactTckn(t);
  t = redactPhone(t);
  return t;
}

let piiDefault = null;
/** Whether redact() masks PII when the caller does not say (config `redactPII`, env SAM_REDACT_PII). */
export function piiEnabled() {
  if (piiDefault === null) {
    try { piiDefault = config().redactPII !== false; } catch { piiDefault = true; }
  }
  return piiDefault;
}
/** Tests / config reloads. */
export function resetPiiCache() { piiDefault = null; }

/**
 * Drop <private>…</private> spans and mask obvious secrets (and, with `redactPII`, e-mail / phone / IBAN / TCKN)
 * before anything is stored. Linear time. `opts.pii` overrides the config for one call.
 */
export function redact(s, opts = {}) {
  if (!s) return s;
  let t = stripInvisible(String(s));
  t = dropPrivate(t);
  t = redactPlain(t);
  t = redactBase64(t);
  if (opts.pii ?? piiEnabled()) t = redactPII(t);
  return t;
}

/** Slice without splitting a surrogate pair (emoji). */
export function safeSlice(s, n) {
  let t = String(s).slice(0, n);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  return t;
}

export function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : safeSlice(t, n - 1) + '…';
}

export function now() { return Date.now(); }

export function ago(ms) {
  const d = (Date.now() - ms) / 86400000;
  if (d < 1 / 24) return Math.max(1, Math.round(d * 1440)) + 'm';
  if (d < 1) return Math.round(d * 24) + 'h';
  if (d < 60) return Math.round(d) + 'd';
  return Math.round(d / 30) + 'mo';
}
