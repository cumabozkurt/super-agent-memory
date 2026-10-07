// Tables for the coding eval: pass rates with paired task-cluster bootstrap CIs vs no-memory, harm rate, tokens,
// pull behaviour, and the push-after-failure experiment.   node bench/coding-eval/analyze.mjs [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = readFileSync(join(HERE, 'results', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ARMS = ['none', 'irr', 'dump', 'samPush', 'sam', 'top1'];
const NAME = { none: '(a) no memory', irr: '(d) irrelevant control', dump: '(c) full dump', samPush: '(b1) SAM push only', sam: '(b) SAM push + pull tools', top1: '(e) SAM + 1-experience push' };
const B = 10000;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (x) => (Number.isNaN(x) ? '–' : (100 * x).toFixed(1));
const sgn = (x) => (x >= 0 ? '+' : '') + pct(x);
const cond = (r) => `${r.model.split('/')[1]} · ${r.store} store`;
// main tables: the balanced design (every arm at temperatures 0 and 0.7). Extra temperatures (0.35, 1) were run only for
// arms none/irr on fix tasks, to get more failures for the push-after-failure experiment.
const MAIN_TEMPS = new Set([0, 0.7]);
const first = R.filter((r) => r.phase === 'first' && MAIN_TEMPS.has(r.temp));

/** per-task mean over its runs (temps / conditions), for the given arm */
function perTask(rows, arm, f = (r) => +r.pass) {
  const m = new Map();
  for (const r of rows) if (r.arm === arm) { if (!m.has(r.task)) m.set(r.task, []); m.get(r.task).push(f(r)); }
  return new Map([...m].map(([k, v]) => [k, mean(v)]));
}
/** paired cluster bootstrap over tasks of mean(a) - mean(b) */
function bootDiff(A, Bm) {
  const tasks = [...A.keys()].filter((t) => Bm.has(t));
  const d = tasks.map((t) => A.get(t) - Bm.get(t));
  const est = mean(d);
  const bs = [];
  for (let i = 0; i < B; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(rnd() * d.length)]; bs.push(s / d.length); }
  bs.sort((x, y) => x - y);
  return { est, lo: bs[Math.floor(0.025 * B)], hi: bs[Math.floor(0.975 * B)], n: d.length };
}
const ci = (b) => `${sgn(b.est)} [${sgn(b.lo)}, ${sgn(b.hi)}]`;

const out = [];
const P = (s = '') => out.push(s);
const conds = [...new Set(first.map(cond))];
const summary = {};

function armTable(rows, title) {
  const pairs = rows.filter((r) => r.set === 'pair'), harm = rows.filter((r) => r.set === 'harm');
  const none = perTask(pairs, 'none'), noneH = perTask(harm, 'none');
  const n = new Set(pairs.map((r) => r.task)).size, nh = new Set(harm.map((r) => r.task)).size;
  const runs = new Set(rows.map((r) => r.model + r.store + r.temp)).size;
  P(`### ${title}`);
  P(`${n} pair tasks + ${nh} harm tasks × ${runs} run(s) (temperature/condition) per arm. Δ = arm − no memory, percentage points, paired task-cluster bootstrap 95% CI (${B} resamples).`);
  P('');
  P('| arm | pairs pass % | Δ pairs vs (a) [95% CI] | harm-set pass % | Δ harm vs (a) [95% CI] | harm rate % | ctx tokens added (pairs/harm) | prompt tok/call | cost $/task |');
  P('|---|---|---|---|---|---|---|---|---|');
  const s = {};
  for (const a of ARMS) {
    const pa = perTask(pairs, a), ha = perTask(harm, a);
    if (!pa.size) continue;
    const dp = a === 'none' ? null : bootDiff(pa, none), dh = a === 'none' ? null : bootDiff(ha, noneH);
    // harm rate: share of (task, run) where no-memory passed and this arm failed, among those no-memory passed
    const key = (r) => [r.model, r.store, r.temp, r.task].join('|');
    const nonePass = new Map(harm.filter((r) => r.arm === 'none').map((r) => [key(r), r.pass]));
    const hr = harm.filter((r) => r.arm === a && nonePass.get(key(r)) === true);
    const harmRate = mean(hr.map((r) => +!r.pass));
    const ar = rows.filter((r) => r.arm === a);
    const tokP = mean(pairs.filter((r) => r.arm === a).map((r) => r.ctxTokens)), tokH = mean(harm.filter((r) => r.arm === a).map((r) => r.ctxTokens));
    P(`| ${NAME[a]} | ${pct(mean([...pa.values()]))} | ${dp ? ci(dp) : '—'} | ${pct(mean([...ha.values()]))} | ${dh ? ci(dh) : '—'} | ${a === 'none' ? '—' : pct(harmRate)} | ${Math.round(tokP)} / ${Math.round(tokH)} | ${Math.round(mean(ar.map((r) => r.prompt)))} | ${mean(ar.map((r) => r.cost)).toFixed(5)} |`);
    s[a] = { pairs: mean([...pa.values()]), dPairs: dp, harmPass: mean([...ha.values()]), dHarm: dh, harmRate, tokP, tokH };
  }
  P('');
  // head-to-head
  const h2h = [['sam', 'samPush', 'pull tools on top of push'], ['top1', 'sam', '1-experience push on top of SAM'], ['dump', 'sam', 'full dump vs SAM'], ['sam', 'irr', 'SAM vs same-size irrelevant'], ['irr', 'none', 'irrelevant text vs nothing']];
  P('| comparison (pairs) | Δ [95% CI] | harm-set Δ [95% CI] |');
  P('|---|---|---|');
  for (const [a, b, label] of h2h) {
    const A = perTask(pairs, a), Bb = perTask(pairs, b);
    if (!A.size || !Bb.size) continue;
    P(`| ${label}: ${a} − ${b} | ${ci(bootDiff(A, Bb))} | ${ci(bootDiff(perTask(harm, a), perTask(harm, b)))} |`);
  }
  P('');
  return s;
}

P('## Pass rates by condition');
P('');
for (const c of conds) summary[c] = armTable(first.filter((r) => cond(r) === c), c);
summary.pooled = armTable(first, 'Pooled over all conditions (task = cluster; each task averaged over every model/store/temperature)');

// per-type breakdown (pooled)
P('## Pairs by task type (pooled, pass %)');
P('');
const types = [...new Set(first.filter((r) => r.set === 'pair').map((r) => r.type))];
P('| type | n tasks | ' + ARMS.map((a) => a).join(' | ') + ' |');
P('|---|---|' + ARMS.map(() => '---').join('|') + '|');
for (const ty of types) {
  const rows = first.filter((r) => r.set === 'pair' && r.type === ty);
  P(`| ${ty} | ${new Set(rows.map((r) => r.task)).size} | ` + ARMS.map((a) => pct(mean(rows.filter((r) => r.arm === a).map((r) => +r.pass)))).join(' | ') + ' |');
}
for (const lang of ['en', 'tr']) {
  const rows = first.filter((r) => r.set === 'pair' && r.lang === lang);
  P(`| lang=${lang} | ${new Set(rows.map((r) => r.task)).size} | ` + ARMS.map((a) => pct(mean(rows.filter((r) => r.arm === a).map((r) => +r.pass)))).join(' | ') + ' |');
}
P('');

// per-task matrix
P('## Per-task pass counts (passes / runs, pooled)');
P('');
P('| task | set | type | ' + ARMS.join(' | ') + ' |');
P('|---|---|---|' + ARMS.map(() => '---').join('|') + '|');
for (const t of [...new Set(first.map((r) => r.task))]) {
  const rows = first.filter((r) => r.task === t);
  P(`| ${t} | ${rows[0].set} | ${rows[0].type} | ` + ARMS.map((a) => { const x = rows.filter((r) => r.arm === a); return `${x.filter((r) => r.pass).length}/${x.length}`; }).join(' | ') + ' |');
}
P('');

// pull behaviour
P('## Pull (MCP tools) behaviour in tool arms');
P('');
P('| condition | arm | calls with ≥1 tool use % | mean tool calls | mem_search share | pulls that returned the task\'s own memory % | tool-result tokens/call |');
P('|---|---|---|---|---|---|---|');
for (const c of conds) for (const a of ['sam', 'top1']) {
  const rows = first.filter((r) => cond(r) === c && r.arm === a);
  if (!rows.length) continue;
  const calls = rows.flatMap((r) => r.toolCalls);
  P(`| ${c} | ${a} | ${pct(mean(rows.map((r) => +(r.toolCalls.length > 0))))} | ${mean(rows.map((r) => r.toolCalls.length)).toFixed(2)} | ${pct(mean(calls.map((x) => +(x.name === 'mem_search'))))} | ${pct(mean(calls.filter((x) => rows.find((r) => r.toolCalls.includes(x)).set === 'pair').map((x) => +x.ownHit)))} | ${Math.round(mean(rows.map((r) => r.toolCalls.reduce((s, x) => s + x.tokens, 0))))} |`);
}
P('');

// push-after-failure
const retr = R.filter((r) => r.phase.startsWith('retry'));
const pairsRF = new Map();
for (const r of retr) { const k = [r.model, r.store, r.temp, r.arm, r.task].join('|'); if (!pairsRF.has(k)) pairsRF.set(k, {}); pairsRF.get(k)[r.phase] = r; }
const both = [...pairsRF.values()].filter((x) => x['retry-plain'] && x['retry-card']);
P('## Push-after-failure: compact fix card on retry (fix tasks, first-attempt failures)');
P('');
P(`Each failed first attempt on a fix task (arms none/irr/samPush/sam, every condition; none/irr also at temperatures 0.35 and 1 for more failures) is retried twice from the same conversation: plain (error output only) and card (error output + the top-1 fix memory found by searching the error text, rendered as one \`<memory fix>\` line). n = ${both.length} paired retries over ${new Set(both.map((x) => x['retry-plain'].task)).size} tasks.`);
P('');
const plainP = mean(both.map((x) => +x['retry-plain'].pass)), cardP = mean(both.map((x) => +x['retry-card'].pass));
const b01 = both.filter((x) => !x['retry-plain'].pass && x['retry-card'].pass).length, b10 = both.filter((x) => x['retry-plain'].pass && !x['retry-card'].pass).length;
const byTask = (ph) => { const m = new Map(); for (const x of both) { const t = x[ph].task; if (!m.has(t)) m.set(t, []); m.get(t).push(+x[ph].pass); } return new Map([...m].map(([k, v]) => [k, mean(v)])); };
const dRF = bootDiff(byTask('retry-card'), byTask('retry-plain'));
const cardOwn = mean(both.map((x) => +x['retry-card'].cardOwn));
const cardTok = mean(both.map((x) => x['retry-card'].cardTokens));
P('| | retry pass % | |');
P('|---|---|---|');
P(`| plain retry | ${pct(plainP)} | |`);
P(`| retry + fix card | ${pct(cardP)} | Δ ${ci(dRF)} (task-cluster bootstrap) |`);
P(`| discordant pairs | card-only pass ${b01}, plain-only pass ${b10} | exact McNemar p = ${mcnemar(b01, b10).toFixed(4)} |`);
P(`| card retrieved the task's own fix | ${pct(cardOwn)} | mean card size ≈ ${Math.round(cardTok)} tokens |`);
P('');
for (const [label, f] of [["card retrieved the task's own fix", (x) => x['retry-card'].cardOwn], ['card retrieved another fix (miss)', (x) => !x['retry-card'].cardOwn]]) {
  const xs = both.filter(f);
  const bb01 = xs.filter((x) => !x['retry-plain'].pass && x['retry-card'].pass).length, bb10 = xs.filter((x) => x['retry-plain'].pass && !x['retry-card'].pass).length;
  P(`- ${label}: n = ${xs.length} (${new Set(xs.map((x) => x['retry-plain'].task)).size} tasks), plain ${pct(mean(xs.map((x) => +x['retry-plain'].pass)))}% → card ${pct(mean(xs.map((x) => +x['retry-card'].pass)))}% (card-only ${bb01}, plain-only ${bb10}, McNemar p = ${mcnemar(bb01, bb10).toFixed(4)})`);
}
P('');
P('| task | n | plain pass | card pass | card = own fix |');
P('|---|---|---|---|---|');
for (const t of [...new Set(both.map((x) => x['retry-plain'].task))]) {
  const xs = both.filter((x) => x['retry-plain'].task === t);
  P(`| ${t} | ${xs.length} | ${xs.filter((x) => x['retry-plain'].pass).length} | ${xs.filter((x) => x['retry-card'].pass).length} | ${xs.filter((x) => x['retry-card'].cardOwn).length} |`);
}
P('');
P('| arm | condition | n | plain % | card % |');
P('|---|---|---|---|---|');
for (const a of ['none', 'irr', 'samPush', 'sam']) for (const c of conds) {
  const xs = both.filter((x) => x['retry-plain'].arm === a && cond(x['retry-plain']) === c);
  if (xs.length) P(`| ${a} | ${c} | ${xs.length} | ${pct(mean(xs.map((x) => +x['retry-plain'].pass)))} | ${pct(mean(xs.map((x) => +x['retry-card'].pass)))} |`);
}
P('');
summary.retry = { n: both.length, plainP, cardP, d: dRF, b01, b10, cardOwn };

// 1-experience push: where it actually added a line
P('## 1-experience push: runs where it added a line');
P('');
for (const store of ['small', 'large']) {
  let ctx;
  try { ctx = JSON.parse(readFileSync(join(HERE, 'results', `contexts-${store}.json`), 'utf8')); } catch { continue; }
  const added = Object.entries(ctx.tasks).filter(([, v]) => v.retrieval.top1Added).map(([k, v]) => ({ task: k, own: v.retrieval.top1Own }));
  const rows = first.filter((r) => r.store === store);
  const sub = (a, own) => rows.filter((r) => r.arm === a && added.some((x) => x.task === r.task && x.own === own));
  P(`- ${store} store: the push added a line on ${added.length}/44 tasks (${added.filter((x) => x.own).length} the task's own fix, ${added.filter((x) => !x.own).length} unrelated). ` +
    `Own-fix tasks: sam ${pct(mean(sub('sam', true).map((r) => +r.pass)))}% → top1 ${pct(mean(sub('top1', true).map((r) => +r.pass)))}%. ` +
    `Unrelated-push tasks: sam ${pct(mean(sub('sam', false).map((r) => +r.pass)))}% → top1 ${pct(mean(sub('top1', false).map((r) => +r.pass)))}%.`);
  const r = ctx.tasks, pairsIds = Object.keys(r).filter((k) => !k.startsWith('h-'));
  P(`- ${store} store retrieval: task's own memory in the card ${pairsIds.filter((k) => r[k].retrieval.inCard).length}/34, in per-prompt recall ${pairsIds.filter((k) => r[k].retrieval.inRecall).length}/34, in card ∪ recall ${pairsIds.filter((k) => r[k].retrieval.inCard || r[k].retrieval.inRecall).length}/34; recall lines on harm prompts ${Object.keys(r).filter((k) => k.startsWith('h-')).reduce((s, k) => s + r[k].retrieval.recallIds.length, 0)} over 10 prompts; stale row shown ${Object.values(r).reduce((s, v) => s + v.retrieval.staleShown, 0)} time(s); live rows ${ctx.store.live}.`);
}
P('');

// spend
P('## Spend');
P('');
P('| model | calls | prompt tokens | completion tokens (reasoning) | cost $ |');
P('|---|---|---|---|---|');
for (const m of [...new Set(R.map((r) => r.model))]) {
  const rows = R.filter((r) => r.model === m);
  P(`| ${m} | ${rows.length} | ${rows.reduce((s, r) => s + r.prompt, 0)} | ${rows.reduce((s, r) => s + r.completion, 0)} (${rows.reduce((s, r) => s + r.reasoning, 0)}) | ${rows.reduce((s, r) => s + r.cost, 0).toFixed(3)} |`);
}
P(`| total | ${R.length} | | | ${R.reduce((s, r) => s + r.cost, 0).toFixed(3)} |`);

function mcnemar(b, c) { // exact two-sided binomial
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0; const C = (n2, r) => { let x = 1; for (let i = 1; i <= r; i++) x = x * (n2 - r + i) / i; return x; };
  for (let i = 0; i <= k; i++) p += C(n, i);
  return Math.min(1, 2 * p / 2 ** n);
}

console.log(out.join('\n'));
const ji = process.argv.indexOf('--json');
if (ji > 0) writeFileSync(process.argv[ji + 1], JSON.stringify(summary, null, 1));
