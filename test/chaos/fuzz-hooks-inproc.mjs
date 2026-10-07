// In-process hook fuzzer: drives runHook() exactly the way `sam hook` does (raw bytes → utf8 →
// JSON.parse or {} → runHook → JSON.stringify(out) when non-empty), for every event of one dialect.
//
//   node fuzz-hooks-inproc.mjs --agent claude [--event Stop] [--n 5000] [--seed 1] [--out result.json]
//
// It reports, per event: internal exceptions (swallowed by the CLI → silent functional loss),
// invalid / mis-shaped replies, budget overruns, latency p50/p99/max, then DB integrity.
// Special files that block (FIFO) are exercised by fuzz-hooks-proc.mjs, never in-process.
import { writeFileSync, mkdirSync, appendFileSync, openSync, ftruncateSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { freshEnv, quietSqlite, sam, rng, pct, payloadBytes, DIALECTS } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const agent = args.agent || 'claude';
const events = args.event ? [args.event] : DIALECTS[agent];
const N = Number(args.n || 5000);
const seed = Number(args.seed || 1);
const env = freshEnv('fuzz-' + agent);
quietSqlite();

const { runHook } = await sam('hooks.js');
const { openDb } = await sam('db.js');
const { tokens } = await sam('text.js');
const { config } = await sam('config.js');

// transcripts: a real growing JSONL, empty, /dev/zero, a directory, a 2 GB sparse file, an unreadable file, missing
const tdir = join(env.tmp, 't');
mkdirSync(tdir, { recursive: true });
const grow = join(tdir, 'grow.jsonl');
writeFileSync(grow, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok ⟦mem decision: transcripts are offset-tracked⟧' }] } }) + '\n');
const sparse = join(tdir, 'sparse.bin');
{ const fd = openSync(sparse, 'w'); ftruncateSync(fd, 2 * 1024 ** 3); closeSync(fd); }
const noperm = join(tdir, 'noperm.jsonl');
writeFileSync(noperm, '{"role":"user","content":"x"}\n');
chmodSync(noperm, 0o000);
const ctx = {
  repo: env.repo,
  sessions: ['s1', 's2', 's3', 'x'.repeat(300), '', '../../etc', 's1\u0000'],
  cwds: [env.repo, join(env.repo, 'src'), env.tmp, '/', 'relative/dir', '/nonexistent/zzz', '\u0000/x'],
  transcripts: [grow, grow, grow, '/dev/zero', '/dev/null', tdir, sparse, noperm, join(tdir, 'missing.jsonl'), ''],
  events,
};

const SHAPES = {
  hookSpecific: (o, ev) => Object.keys(o).length === 1 && o.hookSpecificOutput && typeof o.hookSpecificOutput.additionalContext === 'string'
    && typeof o.hookSpecificOutput.hookEventName === 'string',
};
function validShape(out, ev, p) {
  if (agent === 'claude' && p && p.cursor_version) return validShapeAs('cursor', out, ev === 'UserPromptSubmit' ? 'beforeSubmitPrompt' : ev === 'SessionStart' ? 'sessionStart' : ev === 'PostToolUse' ? 'postToolUse' : ev);
  return validShapeAs(agent, out, ev);
}
function validShapeAs(agent, out, ev) {
  if (agent === 'antigravity') {
    if (!Object.keys(out).length) return true;
    if (out.decision === 'allow' && Object.keys(out).length === 1) return ev === 'Stop';
    return Array.isArray(out.injectSteps) && out.injectSteps.length === 1 && typeof out.injectSteps[0].ephemeralMessage === 'string';
  }
  if (agent === 'cursor') {
    if (!Object.keys(out).length) return true;
    if (out.continue === true && Object.keys(out).length === 1) return ev === 'beforeSubmitPrompt';
    return typeof out.additional_context === 'string' && Object.keys(out).length === 1 && ['sessionStart', 'postToolUse', 'postToolUseFailure', 'PostToolUseFailure'].includes(ev);
  }
  if (!Object.keys(out).length) return true;
  if (!SHAPES.hookSpecific(out, ev)) return false;
  const expected = { SessionStart: 'SessionStart', UserPromptSubmit: 'UserPromptSubmit', BeforeAgent: 'BeforeAgent', PostToolUse: 'PostToolUse', PostToolUseFailure: 'PostToolUseFailure', AfterTool: 'AfterTool' }[ev];
  return out.hookSpecificOutput.hookEventName === expected;
}
const contextOf = (o) => o?.hookSpecificOutput?.additionalContext ?? o?.additional_context ?? o?.injectSteps?.[0]?.ephemeralMessage ?? '';

const norm = (m) => String(m).replace(/\/[^\s'"]+/g, '<path>').replace(/\d+/g, 'N').slice(0, 140);
const results = {};
const t0 = Date.now();
for (const ev of events) {
  const r = rng(seed * 1000 + events.indexOf(ev));
  const res = { n: 0, exceptions: {}, badShape: 0, badShapeEx: [], overBudget: 0, overBudgetEx: [], lat: [], maxCtxTokens: 0, examples: {} };
  for (let i = 0; i < N; i++) {
    if (r.chance(0.3)) appendFileSync(grow, (r.chance(0.5) ? JSON.stringify({ role: 'assistant', content: `step ${i} ⟦mem note: fuzz marker number ${i % 50} for ${ev}⟧` }) : '{"partial": "no newline yet') + '\n');
    const bytes = payloadBytes(r, ctx, { big: r.chance(1 / 250) });
    const raw = bytes.toString('utf8');
    let p;
    try { p = raw ? JSON.parse(raw) : {}; } catch { p = {}; }
    const s = performance.now();
    let printed = '';
    try {
      // runHook coerces a JSON null / array / scalar payload to {} (fix-core #12)
      const o = await runHook(ev, { agent, payload: typeof p === 'object' ? p : Object(p) });
      if (o?.out && Object.keys(o.out).length) printed = JSON.stringify(o.out);
    } catch (e) {
      const key = (e?.constructor?.name || 'Error') + ': ' + norm(e?.message || e);
      res.exceptions[key] = (res.exceptions[key] || 0) + 1;
      if (!res.examples[key]) res.examples[key] = { i, seed, rawHead: raw.slice(0, 300), stack: String(e?.stack || '').split('\n').slice(1, 4).join(' | ') };
    }
    res.lat.push(performance.now() - s);
    res.n++;
    if (printed) {
      let o;
      try { o = JSON.parse(printed); } catch { res.badShape++; continue; }
      if (printed.includes('\n')) res.badShape++;
      if (!validShape(o, ev, p)) { res.badShape++; if (res.badShapeEx.length < 3) res.badShapeEx.push(printed.slice(0, 300)); }
      const c = contextOf(o);
      const tk = tokens(c);
      res.maxCtxTokens = Math.max(res.maxCtxTokens, tk);
      const cfg = config();
      const cap = cfg.budgetSessionStart + cfg.budgetPrompt + 10; // antigravity can carry card + recall together
      if (tk > cap) { res.overBudget++; if (res.overBudgetEx.length < 3) res.overBudgetEx.push({ tk, head: c.slice(0, 200) }); }
    }
  }
  res.p50 = +pct(res.lat, 50).toFixed(2); res.p99 = +pct(res.lat, 99).toFixed(2); res.max = +Math.max(...res.lat).toFixed(1);
  delete res.lat;
  results[ev] = res;
}

const db = openDb();
const integrity = db.prepare('PRAGMA integrity_check').all().map((x) => x.integrity_check).join(';');
let fts = 'ok', tri = 'ok';
try { db.exec("INSERT INTO mem_fts(mem_fts) VALUES('integrity-check')"); } catch (e) { fts = e.message; }
try { db.exec("INSERT INTO mem_tri(mem_tri) VALUES('integrity-check')"); } catch (e) { tri = e.message; }
const counts = Object.fromEntries(['memories', 'events', 'sessions', 'injections', 'stats'].map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
const orphans = {
  supersededByMissing: db.prepare("SELECT COUNT(*) c FROM memories m WHERE superseded_by IS NOT NULL AND superseded_by NOT IN ('forgotten','archived') AND NOT EXISTS (SELECT 1 FROM memories x WHERE x.id = m.superseded_by)").get().c,
  digestMissing: db.prepare('SELECT COUNT(*) c FROM sessions s WHERE digest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = s.digest_id)').get().c,
  badKind: db.prepare("SELECT COUNT(*) c FROM memories WHERE kind NOT IN ('decision','convention','preference','fact','fix','bug','todo','note','session')").get().c,
  nanImportance: db.prepare('SELECT COUNT(*) c FROM memories WHERE importance IS NULL OR importance != importance OR importance < 0 OR importance > 1').get().c,
};
const summary = { agent, N, seed, seconds: (Date.now() - t0) / 1000, rssMB: Math.round(process.memoryUsage().rss / 1048576), integrity, fts, tri, counts, orphans, results };
const out = args.out || join(env.tmp, `fuzz-${agent}.json`);
writeFileSync(out, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ agent, seconds: summary.seconds, rssMB: summary.rssMB, integrity, fts, tri, orphans,
  perEvent: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { n: v.n, exc: Object.values(v.exceptions).reduce((a, b) => a + b, 0), badShape: v.badShape, overBudget: v.overBudget, p50: v.p50, p99: v.p99, max: v.max }])) }));
try { chmodSync(noperm, 0o600); } catch { /* noop */ }
