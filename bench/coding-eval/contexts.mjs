// Builds a real SAM store from the session-1 memories (via the repo's src API, in a temp SAM_HOME) and renders the
// memory text each arm prepends to a task prompt. Output: results/contexts.json (deterministic for a given src).
//   node bench/coding-eval/contexts.mjs
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS, FILLER } from './tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');
process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-codingeval-'));
for (const k of Object.keys(process.env)) if (k.startsWith('SAM_') && k !== 'SAM_HOME' && !k.startsWith('SAM_CE_')) delete process.env[k]; // defaults only
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));

const { saveMemory } = await import(join(SRC, 'store.js'));
const { openDb } = await import(join(SRC, 'db.js'));
const { sessionContext, promptContext, cardLine } = await import(join(SRC, 'inject.js'));
const { search } = await import(join(SRC, 'search.js'));
const { tokens } = await import(join(SRC, 'text.js'));
const { getMemories, line } = await import(join(SRC, 'store.js'));
const { TOOLS } = await import(join(SRC, 'mcp.js'));

const PROJECT = { id: 'shop', name: 'shop', root: null };
const db = openDb();
db.prepare('INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)').run('shop', 'shop', null, Date.now());

// ── 1. session-1 memories → store (oldest first, so a newer value can supersede an older one) ──
const rows = [];
for (const t of TASKS) for (const m of t.mem || []) rows.push({ ...m, task: t.id });
for (const m of FILLER) rows.push({ ...m, task: null });
// SAM_CE_STORE=large: ~210 more rows of a realistic size, taken from bench/retrieval's other corpora (kervan, atlas,
// global, auto-captured noise), relabelled into this project. Rows on any topic the tasks test are dropped so the
// store stays consistent (no second, contradicting package manager / logger / validation library ...).
export const STORE = process.env.SAM_CE_STORE === 'large' ? 'large' : 'small';
const TOPICS = /zod|valibot|axios|\bky\b|pnpm|\bnpm\b|yarn|bun\b|vitest|jest|node --test|console\.log|logger|logging|uuid|cuid|nanoid|ulid|money|float|kuruş|kurus|decimal|retry|retries|timestamp|iso|feature flag|flags|analytics|posthog|track\(|AppError|error message|hata mesaj|cache key|soft.delete|deleted_at|table name|tablo ad|phone|telefon|tarih|date format|sort|lint|eslint|biome|localhost|8787|bigint|lock_timeout|migration|busy_timeout|sqlite|import.*\.js|extension|kdv|vat|kargo|shipping|cut-?off|paraşüt|parasut|pagination|cursor|valid|config|process\.env|env var|\.env/i;
if (STORE === 'large') {
  for (const f of ['memories_kervan.txt', 'memories_atlas.txt', 'memories_global.txt', 'memories_noise.txt']) {
    for (const l of readFileSync(join(HERE, '..', 'retrieval', 'data', f), 'utf8').split('\n')) {
      if (!l.includes('|') || l.startsWith('#') || l.startsWith('@')) continue;
      const [head, body] = l.split(' || ');
      const p = head.split('|').map((x) => x.trim());
      const text = p.slice(5).join('|').trim();
      if (TOPICS.test(text) || TOPICS.test(body || '')) continue;
      const kind = p[1] === 'gotcha-note' ? 'note' : p[1];
      rows.push({ kind, text, source: f.includes('noise') ? 'auto' : 'user', age: Number(p[2]) || 30, task: null, extra: true });
    }
  }
}
rows.sort((a, b) => b.age - a.age);
const t0 = Date.now();
const owner = {}; // mem id → task id
const saveLog = [];
for (const m of rows) {
  const r = saveMemory({ project: 'shop', kind: m.kind, text: m.text, source: m.source });
  saveLog.push({ task: m.task, stale: !!m.stale, kind: m.kind, status: r.status, id: r.id, supersedes: r.supersedes });
  if (r.status !== 'merged') db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(t0 - m.age * 86400000, t0 - m.age * 86400000, r.id);
  if (m.task && !m.stale) owner[r.id] = m.task;
}
const staleIds = new Set(saveLog.filter((l) => l.stale).map((l) => l.id));
const superseded = new Set(db.prepare('SELECT id FROM memories WHERE superseded_by IS NOT NULL').all().map((r) => r.id));
const live = db.prepare("SELECT * FROM memories WHERE superseded_by IS NULL AND project = 'shop' ORDER BY kind, updated_at DESC").all();

// ── 2. arms ──
const wrapHook = (event, text) => (text ? `<system-reminder>\n${event} hook additional context: ${text}\n</system-reminder>` : '');
// full dump: every live memory of the project, labelled like recall lines (no card budget)
const dumpText = '<memory project="shop" all="true">\n' + live.map((m) => cardLine(m, { label: true })).join('\n') + '\n</memory>';
// irrelevant control: another project's memories (bench/retrieval pulsar corpus), same line format, cut to the token size
const pulsar = readFileSync(join(HERE, '..', 'retrieval', 'data', 'memories_pulsar.txt'), 'utf8').split('\n')
  .filter((l) => l.includes('|') && !l.startsWith('#') && !l.startsWith('@'))
  .map((l) => { const p = l.split(' || ')[0].split('|').map((s) => s.trim()); return `- (${p[1] === 'gotcha-note' ? 'note' : p[1]}) ${p.slice(5).join('|')}`; });
function irrelevant(target) {
  if (!target) return '';
  const lines = [];
  let i = 0;
  const wrap = (ls) => '<memory project="pulsar">\n' + ls.join('\n') + '\n</memory>';
  while (tokens(wrap([...lines, pulsar[i % pulsar.length]])) <= target && i < 400) lines.push(pulsar[i++ % pulsar.length]);
  return lines.length ? wrap(lines) : '';
}

export const out = { built: new Date().toISOString(), store: { size: STORE, live: live.length, staleSaved: staleIds.size, staleSuperseded: [...staleIds].filter((i) => superseded.has(i)).length, saveLog }, tasks: {} };
let sid = 0;
for (const t of TASKS) {
  const session = 'ce:' + t.id + ':' + (++sid);
  const card = sessionContext({ project: PROJECT, session, hint: 'mcp' });
  const recall = await promptContext({ project: PROJECT, session, prompt: t.prompt });
  const sam = [wrapHook('SessionStart', card.text), wrapHook('UserPromptSubmit', recall.text)].filter(Boolean).join('\n');
  // push only (no MCP server): the host would install SAM with hint 'none'
  const s2 = session + ':push';
  const cardP = sessionContext({ project: PROJECT, session: s2, hint: 'none' });
  const recallP = await promptContext({ project: PROJECT, session: s2, prompt: t.prompt });
  const samPush = [wrapHook('SessionStart', cardP.text), wrapHook('UserPromptSubmit', recallP.text)].filter(Boolean).join('\n');
  const samIds = [...card.ids, ...recall.ids];
  // 1-experience push: the top-1 fix/bug memory for this prompt is always pushed (no gate), unless already shown
  const fixHits = [...await search(t.prompt, { project: 'shop', kind: 'fix', k: 1 }), ...await search(t.prompt, { project: 'shop', kind: 'bug', k: 1 })].sort((a, b) => b.score - a.score);
  const top1 = fixHits[0];
  const pushLine = top1 && !samIds.includes(top1.m.id) ? '<memory recall>\n' + cardLine(top1.m, { label: true }) + '\n</memory>' : '';
  const top1Text = [sam, pushLine ? wrapHook('UserPromptSubmit', pushLine) : ''].filter(Boolean).join('\n');
  const own = Object.keys(owner).filter((id) => owner[id] === t.id);
  const ctx = {
    none: '',
    irr: wrapHook('SessionStart', irrelevant(tokens(samPush))),
    dump: wrapHook('SessionStart', dumpText),
    samPush,
    sam,
    top1: top1Text,
  };
  out.tasks[t.id] = {
    ctx,
    tokens: Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, tokens(v)])),
    retrieval: {
      ownIds: own,
      inCard: own.some((i) => card.ids.includes(i)),
      inRecall: own.some((i) => recall.ids.includes(i)),
      recallIds: recall.ids,
      recallForeign: recall.ids.filter((i) => !own.includes(i)).length,
      staleShown: samIds.filter((i) => staleIds.has(i)).length,
      top1Id: top1?.m.id || null,
      top1Own: !!top1 && own.includes(top1.m.id),
      top1Added: !!pushLine,
    },
  };
}

// push-after-failure lookup: the compact fix card for an error message (search keyed on the error text only)
export async function fixCard(errMsg) {
  const hits = [...await search(errMsg.slice(0, 600), { project: 'shop', kind: 'fix', k: 1 }), ...await search(errMsg.slice(0, 600), { project: 'shop', kind: 'bug', k: 1 })].sort((a, b) => b.score - a.score);
  const h = hits[0];
  if (!h) return { text: '', id: null };
  return { text: '<memory fix>\n' + cardLine(h.m, { label: true }) + '\n</memory>', id: h.m.id, owner: owner[h.m.id] || null };
}
// MCP pull tools (read-only twins of src/mcp.js callTool for project 'shop'; mem_get does not touch access counters
// so one task's pulls cannot reorder another task's card)
export const MCP_TOOLS = TOOLS.filter((t) => t.name === 'mem_search' || t.name === 'mem_get');
export async function callMemTool(name, args = {}) {
  if (name === 'mem_search') {
    const k = Math.max(1, Math.min(20, Math.trunc(Number(args.k)) || 8));
    const hits = await search(String(args.q || '').slice(0, 1000), { project: 'shop', k, kind: args.kind || undefined });
    return { text: hits.length ? hits.map((h) => line(h.m, { withAge: true })).join('\n') : 'no matches', ids: hits.map((h) => h.m.id) };
  }
  if (name === 'mem_get') {
    const ids = String(args.ids || '').replace(/#/g, '').split(/[\s,]+/).filter(Boolean).slice(0, 20);
    const parts = getMemories(ids, { project: 'shop', touch: false }).map((m) => `#${m.id} [${m.kind}] ${m.gist}` + (m.body ? '\n' + m.body : '') + `\n(${new Date(m.updated_at).toISOString().slice(0, 10)}${m.source ? ' · ' + m.source : ''}${m.superseded_by ? ' · superseded by ' + m.superseded_by : ''})`);
    return { text: parts.join('\n---\n') || 'not found', ids };
  }
  return { text: 'unknown tool ' + name, ids: [] };
}
// precompute cards for every fix task's own realistic error (the run also calls fixCard on live messages)
out.fixCards = {};
for (const t of TASKS.filter((x) => x.err)) out.fixCards[t.id] = await fixCard(t.err);
out.owner = owner;

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, 'results', `contexts-${STORE}.json`), JSON.stringify(out, null, 1));
  const pairs = TASKS.filter((t) => t.set === 'pair');
  const r = (f) => pairs.filter((t) => f(out.tasks[t.id].retrieval)).length;
  console.log(`store: ${live.length} live rows; stale saved ${out.store.staleSaved}, superseded by SAM ${out.store.staleSuperseded}`);
  console.log(`pairs: own memory in card ${r((x) => x.inCard)}/${pairs.length}, in recall ${r((x) => x.inRecall)}, in card∪recall ${r((x) => x.inCard || x.inRecall)}; top1 fix is own ${r((x) => x.top1Own)}`);
  const fx = TASKS.filter((x) => x.err);
  console.log(`fix cards on realistic error: own hit ${fx.filter((t) => out.fixCards[t.id].owner === t.id).length}/${fx.length}`);
  const mean = (k, set) => { const ts = TASKS.filter((t) => t.set === set); return Math.round(ts.reduce((a, t) => a + out.tasks[t.id].tokens[k], 0) / ts.length); };
  for (const k of ['irr', 'dump', 'samPush', 'sam', 'top1']) console.log(`tokens ${k}: pairs ${mean(k, 'pair')}  harm ${mean(k, 'harm')}`);
}
