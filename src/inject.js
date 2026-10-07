// Context injection under hard token budgets, with a per-session ledger so the
// same memory is never paid for twice in one session.
import { openDb, bump } from './db.js';
import { tokens, compactPaths, now, escCard, sha, gistOf, truncate, clauseCut } from './text.js';
import { KINDS, DURABLE_KINDS, liveSql, liveArgs } from './store.js';
import { search, TEMPORAL_RE, specificity } from './search.js';
import { stacksIn, isTurkish } from './lexicon.js';
import { config, hostBudget } from './config.js';
import { readTeamFile, contentHash } from './portable.js';
import { bulletOf, recordGate, sourceLegend } from './guard.js'; // v2-guard

function injected(session) {
  if (!session) return new Set();
  return new Set(openDb().prepare('SELECT mem_id FROM injections WHERE session = ?').all(session).map((r) => r.mem_id));
}

export function markInjected(session, ids) {
  if (!session || !ids?.length) return;
  const st = openDb().prepare('INSERT OR IGNORE INTO injections(session, mem_id, ts) VALUES (?, ?, ?)');
  const t = now();
  for (const id of ids) if (id) st.run(session, id, t); // saveMemory results can carry id null (tombstoned)
}

export function resetLedger(session) {
  if (session) openDb().prepare('DELETE FROM injections WHERE session = ?').run(session);
}

// a write that must not cost the caller its context (hooks pass a guarded writer)
const direct = (fn) => fn();
// The estimator is calibrated to +3% on average against o200k, but dense mixes (digits + ids + Turkish) run up to
// ~7% under: cards are packed to 94% of the budget so the REAL token count stays within it.
const SAFE = 0.94;

// Source weight: what the user said outranks what an agent noted; a burst of agent markers cannot evict it.
const SRC_W = { user: 0.25, team: 0.05, import: 0, agent: 0, auto: -0.05 };
// Important standing decisions are retired by supersession, not by age (decay floor).
const DURABLE = DURABLE_KINDS; // decision, convention, preference, procedure
const DAY = 86400000;
const utcDay = (ms) => Math.floor(ms / DAY);
/** Deterministic tie-break: newer UTC day first, then id (so the card is byte-stable for a whole day). */
const byDayThenId = (a, b) => utcDay(b.updated_at) - utcDay(a.updated_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Cache hygiene: age is counted in whole UTC days (the card does not change hour to hour, so the host's prompt
// cache survives), ties break by id, and read counters (mem_get access_count) do not move lines: a read must
// not reshuffle the next session's card.
function rankCore(rows, { project, globalMax = Infinity, diverse = false } = {}) {
  const today = utcDay(Date.now());
  const floor = config().decayFloor || 0;
  const ranked = rows.map((m) => {
    const hl = KINDS[m.kind]?.halfLife || 90;
    const age = Math.max(0, today - utcDay(m.updated_at)); // a future timestamp (clock jump) ranks as "today", never above it
    let decay = Math.pow(0.5, age / hl);
    if (DURABLE.has(m.kind) && (m.importance >= 0.7 || m.pinned)) decay = Math.max(decay, floor);
    return { m, s: Math.round(((m.pinned ? 2 : 0) + (SRC_W[m.source] ?? 0) + m.importance * (0.5 + 0.5 * decay)) * 1e9) / 1e9 };
  }).sort((a, b) => b.s - a.s || byDayThenId(a.m, b.m)).map((r) => r.m);
  if (globalMax === Infinity && !diverse) return ranked;
  // Project knowledge first: cap global lines (pinned ones always pass), and prefer one line per area (first tag)
  // before a second line on the same area.
  const first = [], later = [];
  let globals = 0;
  const areas = new Set();
  for (const m of ranked) {
    if (project && m.project !== project && !m.pinned) { if (globals >= globalMax) continue; globals++; }
    const area = diverse ? (m.tags || '').split(' ')[0] : '';
    if (area && areas.has(area) && !m.pinned) { later.push(m); continue; }
    if (area) areas.add(area);
    first.push(m);
  }
  return [...first, ...later];
}

// card dates are UTC: the same memory renders the same bytes on every machine and in every timezone
const md = (ms) => new Date(Math.min(ms, Date.now())).toISOString().slice(5, 10);
/** Is there more to fetch than the line shows? Only then is the #id worth its tokens. */
const hasMore = (m) => (m.body && m.body.trim() && m.body.trim() !== m.gist) || /…$/.test(m.gist);

// Only identifier-shaped error classes leave the body: command output is attacker-controllable (S6), so the free text
// of the error line never reaches a card, but "TypeError", "TS2345", "ENOENT", "ERR_MODULE_NOT_FOUND" cannot carry prose.
const ERR_CLASS = /\b((?:[A-Z][a-z0-9]+){1,4}(?:Error|Exception)|TS\d{4}|E\d{4}|ERR_[A-Z_]{2,40}|E[A-Z]{3,12}(?=:))\b/;
export function errorClass(s) { const m = String(s || '').match(ERR_CLASS); return m && m[1].length <= 40 ? m[1] : ''; }
const AUTO_FIX = /^`(.+?)` failed → fixed via (.+)$/;
const PROSE_FIX = /^(.{6,}?)\s+(?:was |is |got )?(?:fixed|solved|resolved)\s+(?:by|via|with|in)\s+(.{3,}?)(?:[,;]?\s+(?:because|since|as|when)\s+(.{3,}))?$/i;

/**
 * Compact fix line: `error signature → anchor constraint → fix`. Auto-detected fixes carry the command, an error class
 * from the body and a file:line anchor when the error points into a changed file; prose fixes are reordered only when
 * they say "X fixed by Y because Z". Anything else is shown as written.
 */
export function fixGist(m) {
  const g = String(m.gist || '');
  const a = g.match(AUTO_FIX);
  if (a) {
    const err = (String(m.body || '').match(/^Error: (.*)$/m) || [])[1] || '';
    const cls = errorClass(err);
    const files = String(m.files || '').split(' ').filter(Boolean);
    let anchor = '';
    for (const f of files) {
      const base = f.split('/').pop();
      const at = base && err.match(new RegExp('(?:^|[\\s(/])' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d{1,6})'));
      if (at) { anchor = `${base}:${at[1]}`; break; }
    }
    // the anchor (file:line the error points at) is fused into the fix's file list when it names a changed file
    let fix = a[2];
    if (anchor) {
      const [base, ln] = anchor.split(':');
      const parts = fix.split(' ');
      const i = parts.findIndex((x) => x === base || x.endsWith('/' + base));
      if (i >= 0) { parts[i] += ':' + ln; fix = parts.join(' '); anchor = ''; }
    }
    return [`\`${a[1]}\` ${cls || 'fails'}`, anchor, `fixed in ${fix}`].filter(Boolean).join(' → ');
  }
  const p = g.replace(/…$/, '').match(PROSE_FIX);
  if (p && !/→/.test(g)) return [p[1], p[3], p[2]].filter(Boolean).join(' → ') + (/…$/.test(g) ? '…' : '');
  return g;
}

/**
 * One card line: the gist (escaped: memory text is data), file anchors, a short date on decisions/facts (so the
 * model can tell which of two lines is newer) and #id only when mem_get would return more.
 */
export function cardLine(m, { label = false, gistMax = 0 } = {}) {
  // card gists are cut to gistMax so more areas fit (the full text is one mem_get away); file anchors are then dropped
  const full = m.kind === 'fix' ? fixGist(m) : m.gist;
  // durable rule lines get their own (higher) limit and a clause-boundary cut that never splits a `command`, flag or quoted token
  const durable = gistMax && DURABLE.has(m.kind);
  if (durable) gistMax = Math.max(gistMax, config().cardGistMaxDurable ?? 0);
  const cut = gistMax && full.length > gistMax;
  const g = cut ? (durable ? clauseCut(full, gistMax) : gistOf(full.replace(/…$/, ''), gistMax)) : full;
  const fl = !gistMax && m.files && m.kind !== 'session' ? m.files.split(' ').filter((f) => f && !full.includes(f.split('/').pop())) : [];
  const files = fl.length ? ' {' + compactPaths(fl, 2) + '}' : '';
  const date = ['decision', 'fact'].includes(m.kind) ? ' · ' + md(m.updated_at) : '';
  const id = hasMore(m) || cut || label ? ' #' + escCard(m.id) : '';
  const lab = label ? `(${m.kind}${date ? ' ' + md(m.updated_at) : ''}) ` : '';
  return `${bulletOf(m)} ${lab}${escCard(g)}${escCard(files)}${label ? '' : date}${id}`;
}

// Card sections, in reading order, with spelled-out headings (single-letter tags were undefined for the model).
// Headings and footer are worded as facts, not instructions: Claude Code's prompt-injection defense reacts to
// imperative out-of-band text in hook output, and its docs advise factual statements.
const SECTIONS = [
  ['convention', 'conventions the user recorded'],
  ['procedure', 'how-to steps the user recorded'],
  ['preference', 'user preferences'],
  ['decision', 'decisions (newest wins)'],
  ['fact', 'facts'],
  ['fix', 'past fixes'],
  ['bug', 'known bugs'],
  ['todo', 'open todos'],
  ['session', 'recent sessions'],
];
const TITLE = Object.fromEntries(SECTIONS);
const SECTION_OF = (k) => (k === 'bug' ? 'fix' : k);

const FOOT = {
  mcp: 'saved inline: ⟦mem decision: <subject>: <value>⟧ (same subject replaces the old value; no status notes) · more: mem_search → mem_get(#id)',
  cli: 'saving: `sam-memory add "<subject>: <value>" -k decision` (same subject replaces the old value) · more: `sam-memory q "<words>"` → `sam-memory get <id>`',
  none: '',
};

/** Team file present but changed since the user trusted it: say so (the agent cannot trust it on its own). */
function teamNote(project) {
  if (!project?.root) return '';
  try {
    const rec = openDb().prepare('SELECT v FROM meta WHERE k = ?').get('trustroot:' + sha(project.root, 16))?.v;
    if (!rec) return '';
    const tf = readTeamFile(project);
    const { hash } = JSON.parse(rec);
    if (tf && hash && hash !== contentHash(tf.content)) return 'note: the team memory file changed since it was trusted; the changes are not imported until the user reviews them with `sam trust`';
  } catch { /* optional */ }
  return '';
}

/** Turkish-heavy store (cached per project at session start; the per-prompt hook only reads the flag). */
const TR_KEY = (pid) => 'trheavy:' + pid;
function turkishHeavy(db, project, cfg, { refresh = false, write = direct } = {}) {
  if (!(cfg.turkishBudgetBoost > 0) || cfg.turkishBudgetBoost === 1) return false;
  try {
    if (!refresh) { const v = db.prepare('SELECT v FROM meta WHERE k = ?').get(TR_KEY(project.id))?.v; if (v != null) return v === '1'; }
    const gists = db.prepare(`SELECT gist FROM memories WHERE ${liveSql()} AND (project = ? OR project = 'global') AND kind != 'session' ORDER BY updated_at DESC, id LIMIT 400`).all(...liveArgs(), project.id);
    const heavy = gists.length > 0 && gists.filter((r) => isTurkish(r.gist)).length / gists.length >= (cfg.turkishShare ?? 0.5);
    write(() => db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(TR_KEY(project.id), heavy ? '1' : '0'));
    return heavy;
  } catch { return false; }
}

/**
 * The effective o200k budget: an explicit budget is used as given; the configured default is scaled by the host
 * multiplier (budgetProfile) and by turkishBudgetBoost on Turkish-heavy stores (Turkish costs ≈1.3× o200k tokens).
 */
export function effectiveBudget({ base, agent, project, db = openDb(), refresh = false, write = direct, cfg = config() }) {
  let b = hostBudget(base, agent, cfg);
  // the estimator runs up to ~15% under o200k on dense Turkish + digits: pack those cards to 85% instead of 94%
  if (project && turkishHeavy(db, project, cfg, { refresh, write })) b = Math.floor(b * cfg.turkishBudgetBoost * (SAFE_TR / SAFE));
  return b;
}
const SAFE_TR = 0.85;

const NOTE_ID = (l) => '~native:' + sha(l.src.label + '\0' + l.raw, 12);

/**
 * Compact project card for SessionStart. Typically 120–320 tokens regardless of
 * how many memories exist; everything else is one search away.
 * onlyNew: skip what this ledger already saw (a resumed session still has the earlier card in context).
 * excludeSession: the current session's own digest is not "recent" history.
 * native: matcher from native.js (what the host already loads): duplicates are dropped, contradictions noted once.
 * smallStore: false disables the full dump for this call (explicit budgets, e.g. subagent mini-cards, never dump).
 */
export function sessionContext({ project, projectName, session, budget, agent = null, native = null, smallStore, hint = 'mcp', onlyNew = false, excludeSession = null, write = direct }) {
  const db = openDb();
  const cfg = config();
  const explicit = budget != null;
  if (!explicit) budget = effectiveBudget({ base: cfg.budgetSessionStart, agent, project, db, refresh: true, write });
  const t = Date.now();
  const scopeArgs = [...liveArgs(t), project.id];
  const live = `${liveSql()} AND (project = ? OR project = 'global')`; // one live-row predicate: not superseded, status active (guard), inside its validity window
  const seen = onlyNew || native ? injected(session) : new Set();
  const fresh = (rows) => (onlyNew ? rows.filter((m) => !seen.has(m.id)) : rows);

  const sessions = fresh(db.prepare(
    `SELECT * FROM memories WHERE ${liveSql()} AND project = ? AND kind = 'session' AND COALESCE(session, '') != ? AND gist NOT LIKE '%→ 0 edits'
     ORDER BY updated_at DESC, id LIMIT ?`
  ).all(...liveArgs(t), project.id, excludeSession || '', cfg.recentSessions));
  const total = db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${live}`).get(...scopeArgs).c;
  const hot = onlyNew ? [] : db.prepare(
    `SELECT subject, COUNT(*) c FROM events WHERE project = ? AND type = 'edit' AND ts > ? GROUP BY subject ORDER BY c DESC, subject LIMIT ?`
  ).all(project.id, t - 14 * 86400000, cfg.hotFiles).map((r) => r.subject);
  const team = onlyNew ? '' : teamNote(project);

  if (!total && !hot.length && !team) return { text: '', ids: [], tokens: 0 };

  const name = String(projectName || project.name || '').normalize('NFKC').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 64) || 'project';
  const head = `<memory project="${name}">`;
  const foot = (FOOT[hint] ?? FOOT.mcp) + (FOOT[hint] === '' ? '' : '\n') + '</memory>';

  // native memory: lines the host already loads are dropped; a contradiction becomes one factual note per session
  const notes = [], noteIds = [];
  let dropped = 0;
  const nativeOk = (m) => {
    if (!native || m.kind === 'session') return true;
    try {
      if (native.isDup(m.gist)) { dropped++; return false; }
      const c = native.conflict(m);
      if (!c) return true;
      const nid = NOTE_ID(c);
      if (!seen.has(nid) && !noteIds.includes(nid) && notes.length < (cfg.nativeConflictMax ?? 2)) {
        const when = c.src.mtime && m.updated_at > c.src.mtime ? 'SAM is newer' : 'the file is newer';
        notes.push(`note: ${escCard(c.src.label)} says "${escCard(gistOf(c.raw, 70))}"; SAM memory #${escCard(m.id)} says "${escCard(gistOf(m.gist, 70))}" (${when})`);
        noteIds.push(nid);
      }
      return false; // the note carries SAM's value; the plain line would repeat it
    } catch { return true; }
  };

  const finish = (parts, ids, extraBumps = []) => {
    if (!parts.length) return { text: '', ids: [], tokens: 0 };
    const text = [head, ...parts, foot].join('\n');
    const tk = tokens(text);
    write(() => {
      markInjected(session, [...ids, ...noteIds]);
      bump(project.id, 'tokens_injected', tk);
      bump(project.id, 'injections_start');
      if (dropped) bump(project.id, 'native_dropped', dropped);
      if (noteIds.length) bump(project.id, 'native_conflicts', noteIds.length);
      for (const b of extraBumps) bump(project.id, b);
    });
    return { text, ids, tokens: tk };
  };
  const tail = (parts, used, cap) => {
    if (notes.length) for (const n of notes) { if (used + tokens(n) + 1 <= cap) { parts.push(n); used += tokens(n) + 1; } }
    if (hot.length) {
      const h = 'recently edited: ' + escCard(compactPaths(hot, 4));
      if (used + tokens(h) + 1 <= cap) { parts.push(h); used += tokens(h) + 1; }
    }
    if (team) { parts.push(team); used += tokens(team) + 1; }
    return used;
  };

  // ---- small-store mode: the whole (small) project memory, deterministic, instead of a ranked selection
  if ((smallStore ?? (!explicit && cfg.smallStore)) && cfg.smallStoreMax > 0) {
    const dumpBudget = Math.floor((explicit ? budget : effectiveBudget({ base: cfg.smallStoreTokens, agent, project, db, write })) * SAFE);
    const rows = db.prepare(
      `SELECT * FROM memories WHERE ${live} AND kind NOT IN ('session', 'note')
       AND (kind != 'todo' OR (' ' || tags || ' ') NOT LIKE '% ephemeral %' OR updated_at > ?)
       ORDER BY pinned DESC, importance DESC, updated_at DESC, id LIMIT ?`
    ).all(...scopeArgs, t - 2 * 86400000, cfg.smallStoreMax + 1 + (cfg.cardGlobalMax ?? 3) * 4);
    let globals = 0;
    const scoped = rows.filter((m) => m.project === project.id || m.pinned || globals++ < (cfg.cardGlobalMax ?? Infinity));
    if (scoped.length <= cfg.smallStoreMax) {
      const keep = fresh(scoped).filter(nativeOk);
      const bySec = new Map();
      for (const m of keep) { const sec = SECTION_OF(m.kind); if (!bySec.has(sec)) bySec.set(sec, []); bySec.get(sec).push(m); }
      const parts = [], ids = [];
      for (const [sec, title] of SECTIONS) {
        const list = sec === 'session' ? sessions : bySec.get(sec);
        if (!list?.length) continue;
        list.sort((a, b) => (b.pinned - a.pinned) || byDayThenId(a, b));
        parts.push(title + ':\n' + list.map((m) => cardLine(m)).join('\n'));
        ids.push(...list.map((m) => m.id));
      }
      let used = tokens([head, ...parts, foot].join('\n'));
      used = tail(parts, used, dumpBudget);
      const lg = sourceLegend(keep); // v2-guard: provenance legend for -a/-t/-i bullets
      if (lg) { parts.push(lg); used += tokens(lg) + 1; }
      const chars = [head, ...parts, foot].join('\n').length;
      if (used <= dumpBudget && chars <= (cfg.smallStoreChars || 9000)) return finish(parts, ids, ['card_full_dump']);
    }
  }

  budget = Math.floor(budget * SAFE);
  const core = fresh(rankCore(db.prepare(
    `SELECT * FROM memories WHERE ${live} AND kind IN ('convention','procedure','preference','decision','fact') ORDER BY pinned DESC, importance DESC, updated_at DESC, id LIMIT 120`
  ).all(...scopeArgs), { project: project.id, globalMax: cfg.cardGlobalMax ?? Infinity, diverse: !!cfg.cardDiverse }));
  const fixes = fresh(db.prepare(`SELECT * FROM memories WHERE ${live} AND kind IN ('fix','bug') ORDER BY updated_at DESC, id LIMIT 6`).all(...scopeArgs));
  const todos = fresh(db.prepare(
    `SELECT * FROM memories WHERE ${live} AND kind = 'todo' AND ((' ' || tags || ' ') NOT LIKE '% ephemeral %' OR updated_at > ?) ORDER BY importance DESC, updated_at DESC, id LIMIT 5`
  ).all(...scopeArgs, t - 2 * 86400000));

  // native pass first: duplicates out, contradiction notes paid for up front (they replace the plain line)
  const blocked = new Set();
  if (native) for (const m of [...core, ...fixes, ...todos]) if (!nativeOk(m)) blocked.add(m.id);
  while (notes.length && notes.reduce((s, x) => s + tokens(x) + 1, 0) > budget / 3) { notes.pop(); noteIds.pop(); }
  let used = tokens(head) + tokens(foot) + (team ? tokens(team) + 1 : 0) + notes.reduce((s, x) => s + tokens(x) + 1, 0);
  const picked = new Map(); // section → [lines]
  const ids = [];
  const take = (m, sec) => {
    if (blocked.has(m.id)) return false;
    const l = cardLine(m, { gistMax: cfg.cardGistMax });
    const tk = tokens(l) + 1 + (picked.has(sec) ? 0 : tokens(TITLE[sec] + ':') + 1);
    if (used + tk > budget) return false;
    used += tk;
    if (!picked.has(sec)) picked.set(sec, []);
    picked.get(sec).push({ m, l });
    ids.push(m.id);
    return true;
  };
  const legend = sourceLegend([...core, ...fixes, ...todos]); // v2-guard: reserve the provenance legend
  if (legend) used += tokens(legend) + 1;
  // core: at most cardCoreMax (12) lines, in rank order; agent-marker lines are capped so one chatty turn cannot take the card
  let n = 0, agentN = 0;
  for (const m of core) {
    if (n >= (cfg.cardCoreMax ?? 12)) break;
    if (m.source === 'agent' && !m.pinned && agentN >= 6) continue;
    if (take(m, m.kind)) { n++; if (m.source === 'agent') agentN++; }
  }
  let c = 0; for (const m of fixes) { if (c >= (cfg.cardFixMax ?? 3)) break; if (take(m, SECTION_OF(m.kind))) c++; }
  c = 0; for (const m of todos) { if (c >= 3) break; if (take(m, 'todo')) c++; }
  for (const m of sessions) take(m, 'session');
  const parts = [];
  for (const [sec, title] of SECTIONS) {
    const list = picked.get(sec);
    if (!list) continue;
    // decisions/facts newest first: with a dated pair the newer line is read first
    if (sec === 'decision' || sec === 'fact') list.sort((a, b) => b.m.updated_at - a.m.updated_at || (a.m.id < b.m.id ? -1 : 1));
    parts.push(title + ':\n' + list.map((x) => x.l).join('\n'));
  }
  parts.push(...notes); // already counted
  if (hot.length) {
    const h = 'recently edited: ' + escCard(compactPaths(hot, 4));
    if (used + tokens(h) + 1 <= budget) { parts.push(h); used += tokens(h) + 1; }
  }
  if (team) parts.push(team);
  const lg = sourceLegend([...picked.values()].flat().map((x) => x.m)); // v2-guard: legend for the tags actually shown
  if (lg) parts.push(lg);
  return finish(parts, ids);
}

// ---- v2 project-specificity gate (tuned on bench/retrieval-v2 dev split only) ----------------------------------
// Two vetoes on top of the relevance gate; session-recall (temporal) hits are never touched.
//  1. sibling: the prompt's words are far better explained by a sibling project in this DB than by this project and
//     the global memories (naive-Bayes log-likelihood ratio > specSibLLR nats, e^6.5 ≈ 650×) → inject nothing.
//  2. foreign stack: the prompt names only stack families this project's memories never name (Django in a Next.js
//     store) → keep only hits that themselves name one of those stacks (e.g. a global note about that stack).
const SPEC = { sibLLR: 6.5, minSigN: 8 };
function specGate(prompt, projectId, hits, cfg) {
  if (!projectId || projectId === 'global') return hits;
  let sp;
  try { sp = specificity(prompt.slice(0, 4000), projectId, { minSigN: cfg.specMinSigN ?? SPEC.minSigN }); } catch { return hits; }
  if (sp.llr > (cfg.specSibLLR ?? SPEC.sibLLR)) return hits.filter((h) => h.temporal);
  if (sp.foreign.length) {
    const F = new Set(sp.foreign);
    return hits.filter((h) => h.temporal || [...stacksIn(`${h.m.gist} ${h.m.tags} ${h.m.files} ${h.m.body}`)].some((f) => F.has(f)));
  }
  return hits;
}
// ---- end v2 gate ------------------------------------------------------------------------------------------------

/** Per-prompt recall: only memories that clear a relevance floor and were not shown yet. */
export async function promptContext({ project, session, prompt, budget, agent = null, write = direct }) {
  const cfg = config();
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 8) return { text: '', ids: [], tokens: 0 };
  if (budget == null) budget = effectiveBudget({ base: cfg.budgetPrompt, agent, project, write });
  budget = Math.floor(budget * SAFE);
  const seen = injected(session);
  const hits = await search(prompt.slice(0, 4000), {
    project: project.id, k: 12, includeSessions: cfg.expandQuery !== false && TEMPORAL_RE.test(prompt), useVectors: cfg.embedInHooks,
    minScore: cfg.gateMode === 'coverage' ? 0 : cfg.minPromptScore,
  });
  let gated = hits;
  if (cfg.gateMode === 'coverage' && hits.length) {
    // relevance gate: enough of the query's IDF mass must be covered, by at least gateMinConcepts rare concepts when
    // the prompt has them, and the hit must be in the same league as the best one
    const top = hits[0].score;
    const strong = (h) => h.cov >= cfg.minPromptCoverage && h.matched >= Math.min(cfg.gateMinConcepts ?? 2, h.strongN) || h.cov >= (cfg.singleConceptCoverage ?? 0.45);
    // with embeddings configured, semantic similarity is a second way to clear the gate (paraphrases share no words)
    const semantic = (h) => cfg.minPromptCosine > 0 && h.cos >= cfg.minPromptCosine;
    // evidence must be selective: the concepts it covers occur together in at most rareConceptShare of the store
    // (relative to its size, never an absolute IDF), so the gate behaves the same at 5 or 50,000 memories
    gated = hits.filter((h) => h.temporal || (h.score >= cfg.relPromptFloor * top && (h.selective && strong(h) || semantic(h))));
    // weak tier: a lone, selective best hit is still shown, but only that one line
    if (!gated.length && cfg.weakPromptCoverage > 0 && hits[0].selective && hits[0].cov >= cfg.weakPromptCoverage) gated = [hits[0]];
  }
  if (cfg.specGate !== false && gated.length) gated = specGate(prompt, project.id, gated, cfg);
  const fresh = gated.filter((h) => !seen.has(h.m.id)).slice(0, cfg.maxPromptHits);
  if (hits.length) write(() => recordGate({ project: project.id, session, prompt, hits, passed: fresh })); // v2-guard: gate features for calibration
  if (!fresh.length) return { text: '', ids: [], tokens: 0 };
  const lines = [];
  const ids = [];
  let used = tokens('<memory recall>\n\n</memory>');
  for (const h of fresh) {
    const l = cardLine(h.m, { label: true });
    const tk = tokens(l) + 1;
    if (used + tk > budget) break;
    used += tk; lines.push(l); ids.push(h.m.id);
  }
  if (!lines.length) return { text: '', ids: [], tokens: 0 };
  const text = '<memory recall>\n' + lines.join('\n') + '\n</memory>';
  const tk = tokens(text);
  write(() => {
    markInjected(session, ids);
    bump(project.id, 'tokens_injected', tk);
    bump(project.id, 'injections_prompt');
  });
  return { text, ids, tokens: tk };
}

const likeEsc = (s) => String(s).replace(/[\\%_]/g, '\\$&');

/** File-anchored recall: when the agent reads/edits a file, surface memories tied to it (once per session). */
export function fileContext({ project, session, paths, budget = 90, write = direct }) {
  if (!paths?.length) return { text: '', ids: [], tokens: 0 };
  budget = Math.floor(budget * SAFE);
  const db = openDb();
  const seen = injected(session);
  const lines = [];
  const ids = [];
  let used = tokens('<memory file-notes>\n\n</memory>');
  for (const p of paths.slice(0, 3)) {
    const base = String(p).split('/').pop();
    if (!base || base.length < 3) continue;
    const rows = db.prepare(
      `SELECT * FROM memories WHERE ${liveSql()} AND kind != 'session' AND (project = ? OR project = 'global')
       AND ((' ' || files || ' ') LIKE ? ESCAPE '\\' OR (' ' || files || ' ') LIKE ? ESCAPE '\\')
       ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 4`
    ).all(...liveArgs(), project.id, '% ' + likeEsc(p) + ' %', '%/' + likeEsc(p) + ' %'); // whole path, or a path ending in /<p>
    for (const m of rows) {
      if (seen.has(m.id) || ids.includes(m.id)) continue;
      const l = cardLine(m, { label: true });
      const tk = tokens(l) + 1;
      if (used + tk > budget || lines.length >= 3) break;
      used += tk; lines.push(l); ids.push(m.id);
    }
  }
  if (!lines.length) return { text: '', ids: [], tokens: 0 };
  const text = '<memory file-notes>\n' + lines.join('\n') + '\n</memory>';
  const tk = tokens(text);
  write(() => {
    markInjected(session, ids);
    bump(project.id, 'tokens_injected', tk);
    bump(project.id, 'injections_file');
  });
  return { text, ids, tokens: tk };
}

/**
 * Experience push (P1): right after a command FAILED in this session, surface the compact card line of a past fix
 * for the same command (or the same error class), at most fixPushMax per session and only while it fits budgetFix.
 * Nothing is pushed without a failure: on a healthy session fixes stay one mem_search away.
 */
export function fixContext({ project, session, eventSession = session, cmd, agent = null, write = direct }) {
  const cfg = config();
  if (!cfg.fixPush || !session || !cmd || !(cfg.fixPushMax > 0)) return { text: '', ids: [], tokens: 0 };
  const db = openDb();
  const key = 'fixpush:' + session;
  const pushed = Number(db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v || 0);
  if (pushed >= cfg.fixPushMax) return { text: '', ids: [], tokens: 0 };
  const budget = Math.floor(hostBudget(cfg.budgetFix, agent, cfg) * SAFE);
  const err = db.prepare("SELECT detail FROM events WHERE session = ? AND type = 'cmd' AND subject = ? AND ok = 0 ORDER BY id DESC LIMIT 1").get(eventSession, cmd)?.detail || '';
  const cls = errorClass(err);
  const head = '`' + truncate(cmd, 60) + '`';
  const seen = injected(session);
  const all = db.prepare(
    `SELECT * FROM memories WHERE ${liveSql()} AND (project = ? OR project = 'global') AND kind IN ('fix', 'bug')
     ORDER BY updated_at DESC, id LIMIT 60`
  ).all(...liveArgs(), project.id);
  const rows = all.filter((m) => !seen.has(m.id));
  const sameCmd = (m) => m.gist.startsWith(head) || String(m.body || '').split('\n').some((l) => l === 'Command: ' + cmd);
  // an error class alone is evidence only when it is specific (not the bare "Error"/"Exception")
  const sameErr = (m) => cls && !/^(Error|Exception)$/.test(cls) && errorClass((String(m.body || '').match(/^Error: (.*)$/m) || [])[1] || m.gist) === cls;
  // the same command's own fix wins; another command's fix with the same error class only when this command has none
  const own = all.filter(sameCmd);
  const hit = own.length ? own.find((m) => !seen.has(m.id)) : rows.find(sameErr);
  if (!hit) return { text: '', ids: [], tokens: 0 };
  const l = cardLine(hit, { label: true, gistMax: cfg.cardGistMax });
  const text = '<memory past-fix>\n' + l + '\n</memory>';
  const tk = tokens(text);
  if (tk > budget) return { text: '', ids: [], tokens: 0 };
  write(() => {
    markInjected(session, [hit.id]);
    db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(key, String(pushed + 1));
    bump(project.id, 'tokens_injected', tk);
    bump(project.id, 'injections_fix');
  });
  return { text, ids: [hit.id], tokens: tk };
}
