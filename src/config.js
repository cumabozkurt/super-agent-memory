// Runtime configuration: defaults < ~/.sam/config.json < SAM_* env vars.
// Values are type-checked against the defaults; problems (bad JSON, unknown keys, values of
// the wrong type) are collected in configWarnings() and printed on stderr, except inside
// host hooks / the MCP server, where stderr is shown to the user on every event.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const SAM_HOME = process.env.SAM_HOME || join(homedir(), '.sam');

const DEFAULTS = {
  dbPath: join(SAM_HOME, 'sam.db'),
  // Token budgets for what SAM pushes into an agent's context unasked.
  budgetSessionStart: 320, // compact project card at session start
  budgetPrompt: 160, // per-prompt relevant recall
  minPromptScore: 0.012, // RRF-scale relevance floor for per-prompt recall (gateMode 'rrf')
  maxPromptHits: 3, // gate defaults tuned on bench/retrieval's tuning half (odd qids) with npm run bench at 20/20
  // SessionStart card
  cardGlobalMax: 3, // at most this many unpinned global lines in the card's core section
  cardDiverse: true, // one line per area (first tag) before a second line on the same area
  cardGistMax: 80, // shorter gists in the card so more areas fit the budget (full gist via mem_get)
  cardGistMaxDurable: 120, // convention/decision/preference/procedure lines: higher limit + clause-boundary cut (flags/commands/prefixes survive)
  cardCoreMax: 14,
  // Retrieval tuning
  expandQuery: true, // dev-vocabulary aliases (EN/TR), Turkish stems, typo correction
  expansionWeight: 0.7, // RRF weight of the expansion list relative to the user's own words
  decayFloor: 0.75, // important decisions/conventions/preferences never decay below this
  globalFactor: 0.85, // score multiplier for global memories inside a project
  gateMode: 'coverage', // 'coverage' (IDF coverage + rare-concept evidence) or 'rrf' (legacy score floor)
  minPromptCoverage: 0.2, // gateMode 'coverage': share of the query's IDF mass a memory must cover
  relPromptFloor: 0.5, // drop hits scoring below this fraction of the best hit
  weakPromptCoverage: 0.25, // weak tier: if nothing is strong, the single best hit still passes at this coverage (0 = off, precise mode)
  minPromptCosine: 0.6, // with embeddings: a hit with cosine >= this clears the gate without lexical coverage
  absentTermWeight: 0.7, // IDF-mass weight of query words that occur nowhere in memory (1 = precise)
  rareConceptShare: 0.15, // rare = occurs (alone, or jointly with the hit's other concepts) in at most this share of the searchable memories
  gateMinConcepts: 1, // rare query concepts a hit must cover (capped by how many the prompt has)
  singleConceptCoverage: 0.4, // ...unless it alone covers this share of the query's IDF mass
  specGate: true, // v2 project-specificity gate: no recall for prompts about a sibling project or a stack this project never uses
  // Native host memory (CLAUDE.md, AGENTS.md, GEMINI.md, rules, Claude auto memory, Antigravity knowledge): read-only
  nativeDedup: true, // drop card lines the host already loads; flag contradictions once per session
  nativeDedupJaccard: 0.6, // token-Jaccard at or above this (same polarity) counts as already present
  nativeConflictMax: 2, // at most this many contradiction notes per card
  // Small-store mode: a small project gets a deterministic full dump instead of a ranked selection
  smallStore: true,
  smallStoreMax: 40, // live (non-session) memories in scope
  smallStoreTokens: 1500, // o200k budget of the dump
  smallStoreChars: 9000, // hard cap (Claude Code cuts hook output at 10,000 chars)
  // Host-profiled budgets: budgets are o200k units; budgetProfile scales them per host
  // ('' = ×1 everywhere; 'claude-4.7' = Claude budgets ×1.6; or e.g. 'claude=1.6,codex=1')
  budgetProfile: '',
  turkishBudgetBoost: 1.25, // Turkish-heavy stores (≥ turkishShare of gists) get this budget multiplier (1 = off)
  turkishShare: 0.5,
  // Compact fix push: after a failed command, push a matching past fix (≤ fixPushMax per session, ≤ budgetFix tokens)
  fixPush: true,
  fixPushMax: 2,
  budgetFix: 70,
  cardFixMax: 3, // past-fix lines in the session card
  recentSessions: 2,
  hotFiles: 6,
  // Retention
  eventRetentionDays: 21,
  vaultRetentionDays: 14,
  vaultMaxBytes: 2_000_000, // per captured command output
  // Optional embeddings (OpenAI-compatible /v1/embeddings, e.g. Ollama, LM Studio, OpenAI).
  // A non-loopback embedUrl is used only when config.json opts in (see below).
  embedUrl: '',
  embedModel: '',
  embedKey: '',
  embedInHooks: false,
  allowRemoteEmbed: false, // config.json only: permit a non-localhost embedUrl
  // Auto-capture switches
  captureCommands: true,
  captureEdits: true,
  captureDirectives: true, // "remember…", "always…", "never…", "unutma…" in user prompts
  harvestMarkers: true, // ⟦mem …⟧ inline markers in assistant output
  // Privacy
  redactPII: true, // mask e-mail, phone, IBAN (mod-97) and TCKN (checksum) before anything is stored
  // Poisoning guard (src/guard.js) and review inbox (src/review.js)
  guard: true, // quarantine non-user writes that match injection heuristics (hidden from agents until `sam review`)
  reviewAgentRules: false, // agent-written convention/preference/procedure rows start 'pending' until approved
  reviewExpireDays: 14, // pending / quarantined rows not approved within this many days are deleted
  agentCapSession: 6, // max new active agent-sourced rows per kind per session (excess → pending; 0 = off)
  agentCapDay: 30, // max new active agent-written rows (MCP / markers) per kind per project per day (excess → pending; 0 = off)
  sourceTags: true, // card bullets "-a"/"-t"/"-i" mark agent/team/import lines (user/auto lines keep "-")
  gateLog: true, // record per-prompt gate features (meta 'gate:*') for later calibration
  // Agent-to-agent handoff (src/handoff.js): written at Stop/SessionEnd, surfaced once to the next other agent
  handoff: true,
  handoffMaxTokens: 60, // the surfaced handoff line (wrapper included) never exceeds this
  handoffMaxAgeDays: 14, // older unconsumed handoffs are not surfaced
  // P2 (experimental, all off by default; to be judged by the coding eval)
  actr: false, // ACT-R base-level activation ln(Σ t_j^-d) as an extra ranking factor (src/sleep.js actrFactor)
  actrDecay: 0.5, // d
  actrWeight: 0.15, // factor range 1 ± actrWeight
  demote: false, // gc lowers unused memories to a low-importance tier instead of archiving them
  demoteAfterDays: 90, // unused (no access) for this long → demoted
  sleep: false, // run `sam sleep` consolidation automatically, at most once a day (with the auto-gc)
  sleepDigestDays: 14, // session digests older than this are folded into one weekly digest
  sleepEventDays: 7, // raw events of ended sessions older than this are pruned
  sleepHamming: 5, // SimHash distance for near-duplicate clusters (gc uses 3)
  skillDrafts: false, // `sam sleep` also writes skill drafts from repeated fixes to ~/.sam/drafts
  skillDraftMin: 3, // a fix pattern must repeat at least this often
};
// Keys that may only come from config.json (an env var must not be able to flip them).
const FILE_ONLY = new Set(['allowRemoteEmbed']);
// Accepted silently for backward compatibility (no longer used).
const RETIRED = new Set(['autoProjectCard']);

const envName = (k) => 'SAM_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

/** Coerce a raw value to the type of its default. Returns { ok, value }. */
export function coerce(def, raw) {
  if (typeof def === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
  }
  if (typeof def === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 1 || raw === 0) return { ok: true, value: raw === 1 };
    const s = String(raw).trim().toLowerCase();
    if (/^(1|true|yes|on)$/.test(s)) return { ok: true, value: true };
    if (/^(0|false|no|off|)$/.test(s)) return { ok: true, value: false };
    return { ok: false };
  }
  return typeof raw === 'string' ? { ok: true, value: raw } : typeof raw === 'number' ? { ok: true, value: String(raw) } : { ok: false };
}

/** True for http(s) URLs that stay on this machine. */
export function isLoopbackUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0';
  } catch { return false; }
}

let cached;
let warnings = [];
export function config() {
  if (cached) return cached;
  warnings = [];
  let file = {};
  const p = join(SAM_HOME, 'config.json');
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) file = j;
      else warnings.push(`${p}: expected a JSON object; ignored`);
    } catch (e) { warnings.push(`${p} is not valid JSON (${e.message}); using defaults`); }
  }
  const fromFile = {};
  for (const [k, v] of Object.entries(file)) {
    if (RETIRED.has(k)) continue;
    if (!(k in DEFAULTS)) { warnings.push(`${p}: unknown key "${k}" ignored`); continue; }
    const c = coerce(DEFAULTS[k], v);
    if (c.ok) fromFile[k] = c.value; else warnings.push(`${p}: "${k}" must be a ${typeof DEFAULTS[k]} (got ${JSON.stringify(v)}); using default`);
  }
  const fromEnv = {};
  for (const k of Object.keys(DEFAULTS)) {
    const ek = envName(k);
    if (process.env[ek] === undefined || FILE_ONLY.has(k)) continue;
    const c = coerce(DEFAULTS[k], process.env[ek]);
    if (c.ok) fromEnv[k] = c.value; else warnings.push(`${ek}=${JSON.stringify(process.env[ek])} is not a valid ${typeof DEFAULTS[k]}; ignored`);
  }
  const cfg = { ...DEFAULTS, ...fromFile, ...fromEnv };
  // S18: prompts and memories are POSTed to embedUrl. An env var alone (which a repo's host settings,
  // a direnv file or a devcontainer can inject) may only point at this machine; a remote endpoint
  // needs the user's own config.json: either embedUrl itself there, or "allowRemoteEmbed": true.
  if (cfg.embedUrl && !isLoopbackUrl(cfg.embedUrl)) {
    const optedIn = fromFile.allowRemoteEmbed === true || (fromFile.embedUrl && fromFile.embedUrl === cfg.embedUrl);
    if (!optedIn) {
      warnings.push(`embedUrl ${cfg.embedUrl} is not on this machine and was set only via ${envName('embedUrl')}; ignored. To use a remote endpoint put "embedUrl" (or "allowRemoteEmbed": true) in ${p}`);
      cfg.embedUrl = '';
    }
  }
  cached = cfg;
  const quiet = ['hook', 'mcp'].includes(process.argv[2]) || process.env.SAM_SELFTEST;
  if (warnings.length && !quiet) for (const w of warnings) process.stderr.write(`sam: config: ${w}\n`);
  return cached;
}

/** Problems found while loading the config (for `sam doctor`). */
export function configWarnings() { config(); return [...warnings]; }

// Native tokenizer / o200k ratios, measured on SAM cards, recall lines and gists (experiments/native-tokens, 2026-10-07).
export const NATIVE_RATIO = { o200k: 1, 'claude-4.6': 1.15, 'claude-4.7': 1.6, 'gemini-3': 1.06 };
// Which tokenizer a host's default model uses (Claude Code default assumed 4.6-family unless budgetProfile says 4.7+).
const HOST_TOKENIZER = { claude: 'claude-4.6', gemini: 'gemini-3', antigravity: 'gemini-3', codex: 'o200k', cursor: 'o200k', opencode: 'o200k' };
const PROFILES = { 'claude-4.7': { claude: 1.6 }, 'claude-5': { claude: 1.6 }, 'claude-4.6': { claude: 1 } };

/** Per-host budget multipliers from budgetProfile: a preset name or "host=x,host=y". Unknown parts are ignored. */
export function budgetProfile(cfg = config()) {
  const p = String(cfg.budgetProfile || '').trim().toLowerCase();
  if (!p) return {};
  if (PROFILES[p]) return { ...PROFILES[p] };
  const out = {};
  for (const part of p.split(/[,\s]+/)) {
    const m = part.match(/^([a-z]+)\s*[=:]\s*(\d+(?:\.\d+)?)$/);
    if (m && Number(m[2]) > 0 && Number(m[2]) <= 4) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** o200k budget for a host: the configured budget × the host multiplier (default 1). */
export function hostBudget(budget, agent, cfg = config()) {
  const mult = budgetProfile(cfg)[String(agent || '').toLowerCase()] || 1;
  return Math.floor(budget * mult);
}

/** The tokenizer a host is assumed to count with (budgetProfile 'claude-4.7' switches Claude to the 4.7+ tokenizer). */
export function hostTokenizer(agent, cfg = config()) {
  const a = String(agent || '').toLowerCase();
  if (a === 'claude' && (budgetProfile(cfg).claude || 1) >= 1.3) return 'claude-4.7';
  return HOST_TOKENIZER[a] || 'o200k';
}

/** Estimated native tokens for an o200k count. */
export const nativeTokens = (o200k, tokenizer) => Math.round(o200k * (NATIVE_RATIO[tokenizer] || 1));

/** `sam doctor`: each host's session-start / per-prompt budget as o200k and as estimated native tokens. */
export function nativeBudgetLine(cfg = config()) {
  return ['claude', 'codex', 'antigravity'].map((a) => {
    const t = hostTokenizer(a, cfg);
    const s = hostBudget(cfg.budgetSessionStart, a, cfg), p = hostBudget(cfg.budgetPrompt, a, cfg);
    return `${a} (${t}) ≈${nativeTokens(s, t)}/${nativeTokens(p, t)}`;
  }).join(' · ') + ` tok (session-start/prompt; Turkish-heavy stores ×${cfg.turkishBudgetBoost || 1})`;
}

export function resetConfigCache() { cached = undefined; }
export { DEFAULTS as CONFIG_DEFAULTS };
