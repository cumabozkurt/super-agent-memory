// Memory store: write path with redaction, near-duplicate merge and topic supersession.
import { createHash } from 'node:crypto';
import { openDb, tx, bump } from './db.js';
import { splitIdent } from './lexicon.js';
import { guardOnSave, applyGuard } from './guard.js'; // v2-guard
import { gistOf, newId, redact, simhash, hamming, topicOf, oneLine, now, compactPaths, fold, sanitize, escCard, keywords } from './text.js';

export const KINDS = {
  convention: { tag: 'C', importance: 0.8, halfLife: 365 },
  procedure: { tag: 'R', importance: 0.75, halfLife: 365 }, // multi-step how-to ("release: bump, tag, npm publish")
  preference: { tag: 'P', importance: 0.8, halfLife: 365 },
  decision: { tag: 'D', importance: 0.75, halfLife: 240 },
  fact: { tag: 'F', importance: 0.6, halfLife: 180 },
  fix: { tag: 'fix', importance: 0.6, halfLife: 120 },
  bug: { tag: 'bug', importance: 0.55, halfLife: 60 },
  todo: { tag: 'todo', importance: 0.5, halfLife: 30 },
  note: { tag: 'N', importance: 0.45, halfLife: 90 },
  session: { tag: 'S', importance: 0.3, halfLife: 14 },
};

export const ALIASES = {
  c: 'convention', conv: 'convention', rule: 'convention', p: 'preference', pref: 'preference',
  d: 'decision', dec: 'decision', f: 'fact', n: 'note', s: 'session', t: 'todo', task: 'todo', b: 'bug', error: 'bug',
  karar: 'decision', kural: 'convention', tercih: 'preference', bilgi: 'fact', not: 'note', hata: 'bug', duzeltme: 'fix', düzeltme: 'fix', yapilacak: 'todo', yapılacak: 'todo',
  proc: 'procedure', procedures: 'procedure', howto: 'procedure', 'how-to': 'procedure', recipe: 'procedure', runbook: 'procedure', steps: 'procedure',
  prosedur: 'procedure', prosedür: 'procedure', yontem: 'procedure', yöntem: 'procedure', tarif: 'procedure',
  önemli: 'note', onemli: 'note', note: 'note', notes: 'note', conventions: 'convention', decisions: 'decision', facts: 'fact', fixes: 'fix', bugs: 'bug', todos: 'todo',
};

// Object.hasOwn: "constructor" / "__proto__" are not kinds (a marker ⟦mem constructor: …⟧ used to crash capture)
export function normKind(k) {
  if (!k) return 'note';
  const s = String(k).toLowerCase().trim();
  if (Object.hasOwn(KINDS, s)) return s;
  return Object.hasOwn(ALIASES, s) ? ALIASES[s] : 'note';
}
/** true for a real kind name or alias (marker kinds are allow-listed). */
export function isKnownKind(k) {
  const s = String(k || '').toLowerCase().trim();
  return Object.hasOwn(KINDS, s) || Object.hasOwn(ALIASES, s);
}

// Negations / temporal words that make two near-identical sentences mean opposite things.
const POL_RE = /\b(not|no|never|always|don'?t|do not|without|before|after|disable[ds]?|enable[ds]?|değil|asla|hiçbir|önce|sonra|yok)\b/giu;
export function polarity(t) { return (String(t).toLowerCase().match(POL_RE) || []).sort().join(','); }

// Kinds that hold a standing value: topic keys, announced replacements and negations retire the old row.
export const STANDING = new Set(['decision', 'convention', 'preference', 'fact', 'procedure']);
// Kinds that do not decay by age (supersession retires them). search.js / inject.js should use this set.
export const DURABLE_KINDS = new Set(['decision', 'convention', 'preference', 'procedure']);

/**
 * The "live row" predicate every read path (search, inject, card, mem_search, ls) must use:
 * not superseded, status active (not quarantined / pending review), inside its validity window.
 * It has TWO placeholders, both bound to "now" in ms: liveArgs() returns them (with or without includeHeld).
 *   db.prepare(`SELECT … FROM memories m WHERE ${liveSql('m')} AND …`).all(...liveArgs(), …)
 */
export function liveSql(alias = '', { includeHeld = false } = {}) {
  const a = alias ? alias + '.' : '';
  // includeHeld (CLI `sam q --include-quarantined`): also quarantined / pending rows; still never superseded or out of window
  return `${a}superseded_by IS NULL AND ${includeHeld ? '' : `${a}status = 'active' AND `}(${a}valid_from IS NULL OR ${a}valid_from <= ?) AND (${a}valid_to IS NULL OR ${a}valid_to > ?)`;
}
export const LIVE_SQL = liveSql();
export const liveArgs = (t = Date.now()) => [t, t];
/** JS twin of liveSql for rows already in hand. */
export function isLive(m, t = Date.now()) {
  return !!m && m.superseded_by == null && (m.status == null || m.status === 'active') && (m.valid_from == null || m.valid_from <= t) && (m.valid_to == null || m.valid_to > t);
}

/** ms epoch from a number, Date or date string; null for empty; throws on garbage. */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) { if (Number.isNaN(v.getTime())) throw new Error('invalid date'); return v.getTime(); }
  if (typeof v === 'number' || /^\d{10,14}$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('invalid date ' + v);
    return n < 1e12 ? n * 1000 : n; // seconds → ms
  }
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new Error('invalid date ' + v);
  return t;
}

// ---------- two-stage dedup (stage 1: SimHash candidate; stage 2: token Jaccard + same polarity/negation) ----------
export const DEDUP_JACCARD = 0.6;
const wordSet = (s) => new Set(oneLine(fold(s)).match(/[\p{L}\p{N}_']+/gu) || []);
export function jaccard(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size && !B.size) return 1;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
/**
 * Stage 2: two near-duplicate candidates say the same thing (not "use X" vs "don't use X"). Polarity and negation
 * are read from the gists (the statement); word overlap from the full texts when given (what SimHash hashed).
 */
export function sameMeaning(a, b, { aFull, bFull, threshold = DEDUP_JACCARD } = {}) {
  if (polarity(a) !== polarity(b)) return false;
  if (NEG_RE.test(a) !== NEG_RE.test(b)) return false;
  return jaccard(aFull || a, bFull || b) >= threshold;
}

// Additive cues: "X also", "additionally Y", "ayrıca", "bunun yanında", "Z de ekle". A memory with one adds to the
// subject; it does not replace the old value (both rows stay). An explicit replacement phrase still wins.
const ADDITIVE_RE = /(?:^|[^\p{L}])(?:also|additionally|as well|in addition|on top of that|ayrıca|ayrica|bunun yanında|bunun yaninda|bunun yanı sıra|bunun yani sira|ek olarak|ilaveten)(?![\p{L}-])|(?:^|\s)(?:de|da)\s+ekle/iu;
// "plus" only lower-case and not after a capitalized word: "Cloud SQL Enterprise Plus", "Disney Plus" are names
const PLUS_RE = /(?<![A-Z][\p{L}\p{N}-]*\s)(?<![\p{L}\p{N}-])plus(?![\p{L}-])/u;
export const isAdditive = (t) => ADDITIVE_RE.test(String(t)) || PLUS_RE.test(String(t));

// ---------- tombstones: fingerprints of purged / hard-forgotten content (the text itself is gone) ----------
// Normalization: NFKC, invisible characters dropped, case + diacritics folded (Turkish İ/ı safe), every run of
// non-letters/digits is a separator. So "Use  PNPM!" and "use pnpm" share a fingerprint.
// fp = 'x:' + sha256(project \0 tokens)            exact content (a memory's gist / full text)
//      's:' + n + ':' + sha256(project \0 tokens)  any text containing that n-token sequence (sam purge --all-matching)
// A tombstone in 'global' blocks the content in every project.
function tokSpans(text) {
  const t = sanitize(String(text || ''));
  const out = [];
  for (const m of t.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const w = fold(m[0]);
    if (w) out.push({ w, s: m.index, e: m.index + m[0].length });
  }
  return { t, out };
}
export const normTokens = (text) => tokSpans(text).out.map((x) => x.w);
const H = (project, toks) => createHash('sha256').update(String(project) + '\0' + toks.join(' ')).digest('hex').slice(0, 32);
export const fpExact = (project, text) => { const k = normTokens(text); return k.length ? 'x:' + H(project, k) : null; };
export const fpSub = (project, text) => { const k = normTokens(text); return k.length ? `s:${k.length}:` + H(project, k) : null; };

/** Record tombstones (inside or outside a transaction). Returns how many were new. */
export function addTombstones(db, project, texts, { substring = false } = {}) {
  const st = db.prepare('INSERT OR IGNORE INTO tombstones(fp, project, created_at) VALUES (?, ?, ?)');
  let n = 0;
  const t = now();
  for (const x of texts) {
    const fp = substring ? fpSub(project, x) : fpExact(project, x);
    if (fp) n += st.run(fp, project, t).changes;
  }
  return n;
}

function subTombs(db) {
  try {
    if (!db.prepare('SELECT 1 FROM tombstones LIMIT 1').get()) return null;
    const rows = db.prepare("SELECT fp FROM tombstones WHERE fp >= 's:' AND fp < 's;'").all();
    if (!rows.length) return { set: new Set(), ns: [] };
    const set = new Set(rows.map((r) => r.fp));
    const ns = [...new Set(rows.map((r) => Number(r.fp.split(':')[1])))].filter((n) => n > 0).sort((a, b) => a - b);
    return { set, ns };
  } catch { return null; } // pre-v3 / read-only snapshot without the table
}

/** Spans [s, e) of `text` covered by a tombstone for `project` (or global); `whole` when the text itself is tombstoned. */
function tombstoneHits(db, project, text) {
  const { t, out } = tokSpans(text);
  if (!out.length) return { t, spans: [], whole: false };
  let any;
  try { any = db.prepare('SELECT 1 FROM tombstones LIMIT 1').get(); } catch { any = null; }
  if (!any) return { t, spans: [], whole: false };
  const scopes = project && project !== 'global' ? [project, 'global'] : ['global'];
  const words = out.map((x) => x.w);
  const has = db.prepare('SELECT 1 FROM tombstones WHERE fp = ?');
  const whole = scopes.some((p) => has.get('x:' + H(p, words)));
  const spans = [];
  const sub = subTombs(db);
  if (sub && sub.ns.length) {
    for (const n of sub.ns) {
      if (n > words.length) break;
      for (let i = 0; i + n <= words.length; i++) {
        const w = words.slice(i, i + n);
        if (scopes.some((p) => sub.set.has(`s:${n}:` + H(p, w)))) spans.push([out[i].s, out[i + n - 1].e]);
      }
    }
  }
  return { t, spans, whole };
}

/** true when saving `text` in `project` would re-create purged / forgotten content. */
export function isTombstoned(project, text, db = openDb()) {
  const h = tombstoneHits(db, project, text);
  return h.whole || h.spans.length > 0;
}

/** `text` with every tombstoned span replaced by [purged] (capture uses this for raw events and digests). */
export function scrubTombstoned(project, text, db = openDb()) {
  if (!text) return text;
  const h = tombstoneHits(db, project, text);
  if (h.whole) return '[purged]';
  if (!h.spans.length) return text;
  h.spans.sort((a, b) => a[0] - b[0]);
  let res = '', last = 0;
  for (const [s, e] of h.spans) {
    if (e <= last) continue;
    res += h.t.slice(last, Math.max(s, last)) + (s >= last ? '[purged]' : '');
    last = e;
  }
  return res + h.t.slice(last);
}

function uniqueId(db) {
  for (let len = 4; len < 12; len++) {
    for (let i = 0; i < 6; i++) {
      const id = newId(len);
      if (!db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)) return id;
    }
  }
  return newId(12);
}

// Provenance (S4/S15). Only `user` rows may pin, and only they may supersede or rewrite a pinned or user row.
export const SOURCES = new Set(['user', 'agent', 'auto', 'team', 'import']);
const protectedRow = (r) => !!r.pinned || r.source === 'user';

// "X instead of Y" / "switched from Y to X" / "Y → X" / "artık Y değil X" / "replaced Y with X": the old term Y.
const W = String.raw`([\p{L}\p{N}_.\-/@+#]{2,40}(?:\s+[\p{L}\p{N}_.\-/@+#]{2,40}){0,1})`;
const REPLACE_RES = [
  [new RegExp(String.raw`\b(?:switched|migrated|moved|changed|went|switch|migrate|move|changing|migrating|moving)\s+(?:over\s+)?from\s+${W}\s+(?:to|→|->)\s+${W}`, 'iu'), 1, 2],
  [new RegExp(String.raw`\breplaced?\s+${W}\s+(?:with|by)\s+${W}`, 'iu'), 1, 2],
  [new RegExp(String.raw`${W}\s+(?:instead\s+of|rather\s+than|in\s+place\s+of)\s+${W}`, 'iu'), 2, 1],
  [new RegExp(String.raw`(?:^|\s)${W}\s*(?:→|->)\s*${W}`, 'u'), 1, 2],
  [new RegExp(String.raw`\b(?:artık|artik|bundan sonra)\s+${W}\s+(?:değil|degil)[,;]?\s+${W}`, 'iu'), 1, 2],
  [new RegExp(String.raw`${W}\s+yerine\s+${W}`, 'iu'), 1, 2],
  [new RegExp(String.raw`\bno\s+longer\s+(?:use|using|uses)\s+${W}`, 'iu'), 1, 0],
];
const GENERIC = new Set(['it', 'this', 'that', 'them', 'one', 'the', 'a', 'an', 'we', 'i', 'use', 'using', 'now', 'bu', 'şu', 'onu']);
/** { old: [folded tokens], new: [folded tokens] } when the text announces a replacement. */
export function replacementOf(text) {
  const t = oneLine(text);
  for (const [re, oi, ni] of REPLACE_RES) {
    const m = t.match(re);
    if (!m) continue;
    const toks = (s) => (s ? keywords(s, 3).filter((w) => !GENERIC.has(w)) : []);
    const old = toks(m[oi]).slice(0, 2), nu = ni ? toks(m[ni]).slice(0, 2) : [];
    if (old.length && !old.some((w) => nu.includes(w))) return { old, new: nu };
  }
  return null;
}

const NEG_RE = /\b(?:not|no|never|don'?t|do not|does not|doesn'?t|stop using|avoid|without|değil|degil|asla|hiçbir zaman|hicbir zaman|kullanma|yapma)\b/iu;
const tokset = (s) => new Set(keywords(s, 24));
function overlap(a, b) {
  const A = tokset(a), B = tokset(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / Math.min(A.size, B.size);
}

/**
 * Save a memory. Returns { id, status: 'created'|'merged'|'superseded'|'conflict'|'forgotten'|'tombstoned', supersedes? }.
 * - text is NFKC-normalized, stripped of invisible characters, then redacted
 * - exact / near-duplicates (SimHash distance <= 3, same project+kind) are merged, not duplicated
 * - same topic key ("package manager: pnpm"), a replacement ("pnpm instead of npm") or a negation of an existing
 *   decision supersedes the older memory
 * - provenance: only `source: 'user'` may pin, or supersede / rewrite a pinned or user memory
 * - text the user forgot is not re-created by non-user writers (re-harvested transcripts, teammates, agents)
 * - purged / hard-forgotten content (a tombstone fingerprint in this project or global) is never re-created by
 *   anyone: status 'tombstoned', id null. `allowTombstoned` (only `sam add --force`) lifts the exact tombstone.
 *   Session digests are scrubbed ([purged]) instead of refused.
 * - near-duplicates merge only when they also mean the same (two-stage: SimHash, then Jaccard + polarity)
 * - an additive memory ("also", "ayrıca", "de ekle") never retires the old value on its subject: both stay
 * - validFrom / validTo (ms, Date or ISO string) bound when the memory is live (LIVE_SQL)
 */
export function saveMemory({ project = 'global', kind, text, gist: gistOverride, body, tags = [], files = [], topic, importance, pin = false, source, agent, session, afterInsert, confirm, validFrom, validTo, allowTombstoned = false }) {
  const k = normKind(kind);
  // legacy callers passed the agent name as `source`
  if (source && !SOURCES.has(source)) { agent = agent || source; source = undefined; }
  const src = source || 'agent';
  const isUser = src === 'user';
  const vFrom = toMs(validFrom), vTo = toMs(validTo);
  if (vFrom != null && vTo != null && vTo <= vFrom) throw new Error('validTo must be after validFrom');
  let raw = redact(oneLine(sanitize(text || '')));
  if (!raw) throw new Error('empty memory');
  let full = redact(body ? sanitize(String(body)) : '');
  let gistIn = gistOverride ? redact(oneLine(sanitize(gistOverride))) : '';
  if (k === 'session') { // a digest is rebuilt from raw activity: drop purged spans, keep the rest
    raw = oneLine(scrubTombstoned(project, raw)); full = scrubTombstoned(project, full); gistIn = gistIn && oneLine(scrubTombstoned(project, gistIn));
  } else if (isTombstoned(project, raw) || (gistIn && isTombstoned(project, gistIn)) || (full && isTombstoned(project, full))) {
    if (!(allowTombstoned && isUser)) return { id: null, status: 'tombstoned' };
    // the user re-adds it on purpose: lift the exact fingerprints (substring tombstones stay, so the text must not contain one)
    const db0 = openDb();
    for (const p of new Set([project, 'global'])) for (const x of [raw, gistIn, gistOf(raw, k === 'fix' || k === 'convention' || k === 'procedure' ? 160 : 110)]) {
      const fp = x && fpExact(p, x); if (fp) db0.prepare('DELETE FROM tombstones WHERE fp = ?').run(fp);
    }
    if (isTombstoned(project, raw) || (full && isTombstoned(project, full))) return { id: null, status: 'tombstoned' };
  }
  const gist = gistIn ? gistOf(gistIn, 140) : gistOf(raw, k === 'fix' || k === 'convention' || k === 'procedure' ? 160 : 110);
  // never lose the text beyond the gist: with an explicit body, keep the full sentence on top of it
  const fullBody = full ? (raw.length > gist.length && !full.includes(raw) ? raw + '\n\n' + full : full) : (raw.length > gist.length ? raw : '');
  const tagStr = [...(Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/)).filter(Boolean).map((t) => String(t).toLowerCase())].join(' ');
  // FTS's unicode61 folding does not map Turkish ı→i (nor İ cleanly); index folded twins as hidden tags
  const twins = [...new Set([
    ...(raw.match(/[\p{L}\p{N}_]*[ıİ][\p{L}\p{N}_]*/gu) || []).map(fold),
    // identifiers are one FTS token ("useauthstore"); index their parts so "auth store" finds useAuthStore
    ...(raw.match(/\b[A-Za-z][A-Za-z0-9]*(?:[a-z][A-Z]|_[A-Za-z])[A-Za-z0-9_]*\b/g) || []).flatMap(splitIdent),
  ])].join(' ');
  const fileList = (Array.isArray(files) ? files : String(files).split(/[,\s]+/)).filter(Boolean).map((f) => sanitize(String(f)).normalize('NFC'));
  const fileStr = fileList.join(' ');
  const tagAll = [tagStr, twins].filter(Boolean).join(' ');
  const sh = simhash(raw + ' ' + full);
  const tp = topicOf(k, raw, topic);
  const imp = Math.max(0, Math.min(1, importance ?? KINDS[k].importance));
  const doPin = !!pin && isUser;
  const t = now();
  const lower = gist.toLowerCase();

  return tx((db) => {
    const g = guardOnSave(db, { project, kind: k, source: src, explicit: !!source, session, text, body }); // v2-guard: active|quarantined|pending
    // rows whose validity window already closed are history: a new statement never merges into them
    const cands = db.prepare(
      `SELECT id, simhash, gist, body, files, tags, pinned, source, updated_at FROM memories
       WHERE project = ? AND kind = ? AND superseded_by IS NULL AND (valid_to IS NULL OR valid_to > ?) AND (status = 'active' OR ?)
       ORDER BY updated_at DESC LIMIT 400`
    ).all(project, k, t, isUser ? 0 : 1); // v2-guard: the user's words never merge into a held (hidden) row
    // 0) the user forgot this: a re-harvest / teammate / agent must not resurrect it
    if (!isUser && k !== 'session') {
      const dead = db.prepare("SELECT id, simhash, gist FROM memories WHERE project = ? AND kind = ? AND superseded_by = 'forgotten' ORDER BY updated_at DESC LIMIT 200").all(project, k);
      const hit = dead.find((c) => c.gist.toLowerCase() === lower || (sh && c.simhash && hamming(c.simhash, sh) <= 3 && polarity(c.gist) === polarity(gist)));
      if (hit) return { id: hit.id, status: 'forgotten' };
    }
    // 1) exact (case-insensitive) duplicate, even without a SimHash fingerprint ("done", emoji-only text)
    const exact = k === 'session' ? null : cands.find((c) => c.gist.toLowerCase() === lower);
    if (exact) {
      if (!protectedRow(exact) || isUser) {
        db.prepare('UPDATE memories SET updated_at = ?, importance = MAX(importance, ?), pinned = MAX(pinned, ?) WHERE id = ?').run(t, imp, doPin ? 1 : 0, exact.id);
        if (vFrom != null || vTo != null) db.prepare('UPDATE memories SET valid_from = ?, valid_to = ? WHERE id = ?').run(vFrom, vTo, exact.id);
      }
      bump(project, 'mem_merged');
      return { id: exact.id, status: 'merged' };
    }
    // 2) near-duplicate merge
    for (const c of k === 'session' || !sh ? [] : g.status === 'quarantined' ? cands.filter(protectedRow) : cands) { // v2-guard: poison never rewrites a live row
      // stage 1: SimHash candidate; stage 2: same words (Jaccard) and same polarity / negation
      if (c.simhash && hamming(c.simhash, sh) <= 3 && sameMeaning(c.gist, gist, { aFull: c.gist + ' ' + (c.body || ''), bFull: raw + ' ' + full })) {
        if (c.pinned || (c.source === 'user' && !isUser)) {
          // a pinned gist is never rewritten, and nobody but the user rewrites the user's words
          bump(project, 'mem_merged');
          return { id: c.id, status: 'merged' };
        }
        // the newest wording wins; file anchors and tags are unioned
        const files2 = [...new Set([...(c.files || '').split(' '), ...fileList])].filter(Boolean).join(' ');
        const tags2 = [...new Set([...(c.tags || '').split(' '), ...tagAll.split(' ')])].filter(Boolean).join(' ');
        db.prepare(
          `UPDATE memories SET gist = ?, files = ?, tags = ?, updated_at = ?, importance = MAX(importance, ?), pinned = MAX(pinned, ?),
           body = CASE WHEN length(?) > length(body) THEN ? ELSE body END WHERE id = ?`
        ).run(gist, files2, tags2, t, imp, doPin ? 1 : 0, fullBody, fullBody, c.id);
        if (vFrom != null || vTo != null) db.prepare('UPDATE memories SET valid_from = ?, valid_to = ? WHERE id = ?').run(vFrom, vTo, c.id);
        bump(project, 'mem_merged');
        return { id: c.id, status: 'merged' };
      }
    }
    // 3) supersession: same topic key, an announced replacement, or a negation of the same statement
    const retire = new Map();
    // additive cue ("also", "ayrıca", "de ekle"): the new memory adds to its subject, the old value stays live
    const additive = isAdditive(raw);
    if (tp && !additive) {
      for (const o of db.prepare('SELECT id, gist, pinned, source FROM memories WHERE project = ? AND topic = ? AND superseded_by IS NULL').all(project, tp)) retire.set(o.id, o);
    }
    if (STANDING.has(k)) {
      const rep = replacementOf(raw);
      for (const c of cands) {
        if (retire.has(c.id)) continue;
        const ct = new Set(keywords(c.gist, 24));
        if (rep && rep.old.every((w) => ct.has(w)) && !rep.new.some((w) => ct.has(w))) {
          retire.set(c.id, c); continue;
        }
        if (!additive && NEG_RE.test(gist) !== NEG_RE.test(c.gist) && overlap(gist, c.gist) >= 0.75) retire.set(c.id, c);
      }
    }
    // fixes recorded for the tool that was just replaced ("`npm test` failed …" after "pnpm instead of npm") are stale
    if (['decision', 'convention', 'procedure'].includes(k)) {
      const rep = replacementOf(raw);
      if (rep && rep.old.length === 1) {
        for (const f of db.prepare("SELECT id, gist, pinned, source FROM memories WHERE project = ? AND kind = 'fix' AND superseded_by IS NULL AND gist LIKE ?").all(project, '`' + rep.old[0] + ' %')) {
          if (!protectedRow(f)) retire.set(f.id, f);
        }
      }
    }
    // An agent may replace a (non-pinned) user value only when the user just asked for the new one: a distinctive
    // token of the new value appears in the user's own recent prompts in this session ("switch tests to node:test").
    const confirmed = (o) => {
      if (isUser || o.pinned || !confirm || src !== 'agent') return false;
      const said = new Set(keywords(confirm, 64));
      const oldT = new Set(keywords(o.gist || db.prepare('SELECT gist FROM memories WHERE id = ?').get(o.id)?.gist || '', 32));
      const val = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      return keywords(val, 16).some((w) => w.length >= 3 && !oldT.has(w) && said.has(w));
    };
    for (const o of retire.values()) if (o.source === 'user' && confirmed(o)) o.source = 'user-confirmed';
    const blocked = [...retire.values()].filter((o) => protectedRow(o) && !isUser);
    if (blocked.length && tp && blocked.length === retire.size) {
      // an agent / teammate / import cannot overwrite the user's own or pinned value: keep the user's
      return { id: blocked[0].id, status: 'conflict', conflicts: blocked.map((o) => o.id) };
    }
    const supersedes = g.status !== 'active' ? [] : [...retire.values()].filter((o) => isUser || !protectedRow(o)).map((o) => o.id); // v2-guard: a held row retires nothing
    const id = uniqueId(db);
    db.prepare(
      `INSERT INTO memories(id, project, kind, gist, body, tags, files, topic, importance, pinned, agent, source, session, simhash, valid_from, valid_to, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, project, k, gist, fullBody, tagAll, fileStr, tp, imp, doPin ? 1 : 0, agent || null, src, session || null, sh, vFrom, vTo, t, t, g.status); // v2-guard: + status
    applyGuard(db, id, g); // v2-guard: record why it was held
    if (supersedes.length) {
      const wasPinned = db.prepare(`SELECT MAX(pinned) p FROM memories WHERE id IN (${supersedes.map(() => '?').join(',')})`).get(...supersedes).p;
      for (const o of supersedes) db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(id, o);
      if (wasPinned && isUser) db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(id); // only the user's own value inherits a pin
    }
    afterInsert?.(db, id);
    bump(project, 'mem_saved');
    return { id, status: supersedes.length ? 'superseded' : 'created', supersedes: supersedes.length ? supersedes : undefined, held: g.status !== 'active' ? g.status : undefined }; // v2-guard: held
  });
}

/** Full rows for ids. `project` scopes the lookup to that project + global (MCP: an agent in one repo cannot read another). */
export function getMemories(ids, { touch = true, project } = {}) {
  const db = openDb();
  const out = [];
  for (const raw of ids) {
    const id = String(raw).replace(/^#/, '').trim();
    if (!id) continue;
    const m = project
      ? db.prepare("SELECT * FROM memories WHERE id = ? AND (project = ? OR project = 'global')").get(id, project)
      : db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (m) {
      out.push(m);
      if (touch) { try { db.prepare('UPDATE memories SET last_access = ?, access_count = access_count + 1 WHERE id = ?').run(now(), id); } catch { /* read-only */ } }
    }
  }
  return out;
}

/** The texts a memory row is fingerprinted by: its gist and the full sentence kept above its body. */
export function contentTexts(m) {
  const out = [m.gist];
  const first = String(m.body || '').split(/\n\s*\n/)[0];
  if (first && oneLine(first) !== m.gist) out.push(oneLine(first));
  return out.filter(Boolean);
}

/**
 * Retire a memory (soft) or delete it (hard). Hard delete runs with secure_delete on, drops the FTS entries
 * (trigger), merges the FTS segments and checkpoints the WAL, so the text does not linger in free pages (S16).
 * Tombstones: a hard delete leaves a fingerprint by default (`tombstone: false` to skip), so a re-harvested
 * transcript, a teammate's file or an agent cannot bring the text back; a soft forget keeps the row (which
 * already blocks non-user writers) and adds a fingerprint only with `tombstone: true`.
 */
export function forget(id, { hard = false, project, tombstone = hard } = {}) {
  const db = openDb();
  const clean = String(id).replace(/^#/, '');
  const scope = project ? " AND (project = ? OR project = 'global')" : '';
  const args = project ? [clean, project] : [clean];
  const fingerprint = (d) => {
    if (!tombstone) return;
    const m = d.prepare(`SELECT project, gist, body FROM memories WHERE id = ?${scope}`).get(...args);
    if (m) addTombstones(d, m.project, contentTexts(m));
  };
  if (hard) {
    const n = tx((d) => {
      fingerprint(d);
      const c = d.prepare(`DELETE FROM memories WHERE id = ?${scope}`).run(...args).changes;
      // memories it had replaced stay retired, never dangling
      if (c) d.prepare("UPDATE memories SET superseded_by = 'archived' WHERE superseded_by = ?").run(clean);
      if (c) d.prepare('DELETE FROM injections WHERE mem_id = ?').run(clean);
      return c;
    });
    if (n) {
      try {
        db.exec('PRAGMA secure_delete=ON;');
        db.exec("INSERT INTO mem_fts(mem_fts) VALUES('optimize'); INSERT INTO mem_tri(mem_tri) VALUES('optimize');");
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch { /* another process holds the WAL: the next gc checkpoints it */ }
    }
    return n;
  }
  return tx((d) => {
    fingerprint(d);
    return d.prepare(`UPDATE memories SET superseded_by = 'forgotten', updated_at = ? WHERE id = ?${scope}`).run(now(), ...args).changes;
  });
}

/** Pinning is a user act (CLI). The row becomes user-owned so agents cannot overwrite it. */
export function setPinned(id, pinned = true) {
  return openDb().prepare(`UPDATE memories SET pinned = ?${pinned ? ", source = 'user'" : ''} WHERE id = ?`).run(pinned ? 1 : 0, String(id).replace(/^#/, '')).changes;
}

export function listMemories({ project, kind, limit = 50, all = false } = {}) {
  const where = [];
  const args = [];
  if (project) { where.push('(project = ? OR project = \'global\')'); args.push(project); }
  if (kind) { where.push('kind = ?'); args.push(normKind(kind)); }
  if (!all) { where.push(LIVE_SQL); args.push(...liveArgs()); }
  const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pinned DESC, updated_at DESC LIMIT ?`;
  return openDb().prepare(sql).all(...args, limit);
}

/** One compact line per memory. This is the unit SAM shows to agents. */
export function line(m, { withAge = false, gistMax = 0 } = {}) {
  const tag = KINDS[m.kind]?.tag || 'N';
  const fl = m.files && m.kind !== 'session' ? m.files.split(' ').filter((f) => f && !m.gist.includes(f.split('/').pop())) : [];
  const files = fl.length ? ' {' + compactPaths(fl, 2) + '}' : '';
  const age = withAge ? ' ' + agoShort(m.updated_at) : '';
  const gist = gistMax && m.gist.length > gistMax ? gistOf(m.gist.replace(/…$/, ''), gistMax) : m.gist;
  return `[${tag}] ${esc(gist)}${esc(gistMax ? '' : files)} #${esc(m.id)}${age}`;
}

// Memory text is data: angle brackets can never close the <memory> wrapper or open a tag (fullwidth forms
// are NFKC-folded first; invisible / bidi characters are dropped).
export const esc = (s) => escCard(s);

function agoShort(ms) {
  const d = Math.max(0, (Date.now() - ms) / 86400000); // a future timestamp (clock jump) reads as new
  if (d < 1) return '<1d';
  if (d < 60) return Math.round(d) + 'd';
  return Math.round(d / 30) + 'mo';
}
