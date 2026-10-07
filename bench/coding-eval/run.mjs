// Coding eval runner: every task × arm × temperature through an OpenRouter chat model, graded by grade.mjs.
//   NODE_USE_ENV_PROXY=1 OPENROUTER_API_KEY=... node bench/coding-eval/run.mjs [--model google/gemini-3.8-flash]
//     [--temps 0,0.7] [--arms none,irr,dump,samPush,sam,top1] [--tasks id,id] [--retry] [--concurrency 8] [--budget 8]
// Results are appended to results/runs.jsonl (resumable: a cached key is never re-run). --retry runs the
// push-after-failure phase on first-attempt failures of fix tasks (plain retry vs retry + compact fix card).
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';
import { grade, extractCode } from './grade.mjs';
import * as C from './contexts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('--model', 'google/gemini-3.8-flash');
const TEMPS = opt('--temps', '0,0.7').split(',').map(Number);
const ARMS = opt('--arms', 'none,irr,dump,samPush,sam,top1').split(',');
const ONLY = opt('--tasks', '') ? new Set(opt('--tasks').split(',')) : null;
const REASONING = opt('--reasoning', 'low');
const MAXTOK = Number(opt('--max-tokens', 8000));
const CONC = Number(opt('--concurrency', 8));
const BUDGET = Number(opt('--budget', 8)); // USD, whole results file
const OUT = join(HERE, 'results', 'runs.jsonl');
mkdirSync(join(HERE, 'results'), { recursive: true });
writeFileSync(join(HERE, 'results', `contexts-${C.STORE}.json`), JSON.stringify(C.out, null, 1)); // what this run injected (diagnostics)

const TOOL_ARMS = new Set(['sam', 'top1']);
const SYSTEM = 'You are a coding agent working in the `shop` repository (Node.js, ESM, plain JavaScript). The repo\'s own modules sit next to the file you write and are imported with relative paths. Reply with exactly one ```js code block containing the complete ES module that exports the requested function(s). No explanations.';
const MCP_INSTRUCTIONS = '\n\nMCP server "super-agent-memory": Persistent memory shared by all your coding agents. Search before re-deriving project facts; save durable decisions/conventions/fixes in one line.';
const TOOLS = C.MCP_TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

const done = new Map();
let spent = 0;
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n')) { if (!l) continue; const r = JSON.parse(l); done.set(r.key, r); spent += r.cost || 0; }

async function chat(body) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.OPENROUTER_API_KEY || 'x') },
        body: JSON.stringify({ model: MODEL, usage: { include: true }, ...body }),
        signal: AbortSignal.timeout(Number(process.env.CE_CALL_TIMEOUT_MS || 240000)),
      });
      const j = await r.json();
      if (!r.ok || j.error || !j.choices?.[0]) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 300));
      return j;
    } catch (e) {
      if (e?.name === 'TimeoutError' && a >= 1) return { choices: [{ message: { content: '' } }], usage: {}, timedOut: true };
      if (a >= 3) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (a + 1)));
    }
  }
}

/** One conversation to a final answer; tool arms may call mem_search/mem_get for up to 6 rounds. If the model is
 *  still calling tools after that (or ends a tool conversation without a code block), one last call without tools sees
 *  the tool exchange flattened into text and is asked for the answer (some providers emit raw tool markup as content
 *  under tool_choice:"none"). */
const flatten = (msgs) => {
  const out = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) out.push({ role: 'assistant', content: (m.content ? m.content + '\n' : '') + m.tool_calls.map((t) => `[called ${t.function.name} ${t.function.arguments}]`).join('\n') });
    else if (m.role === 'tool') out.push({ role: 'user', content: '[tool result]\n' + m.content });
    else out.push(m);
  }
  out.push({ role: 'user', content: 'Memory lookups are done. Reply now with the final ```js code block.' });
  return out;
};
async function converse(messages, { temp, tools }) {
  const u = { prompt: 0, completion: 0, reasoning: 0, cost: 0 }, calls = [];
  const msgs = [...messages];
  const add = (j) => {
    u.prompt += j.usage?.prompt_tokens || 0; u.completion += j.usage?.completion_tokens || 0;
    u.reasoning += j.usage?.completion_tokens_details?.reasoning_tokens || 0; u.cost += j.usage?.cost || 0;
  };
  const base = () => ({ temperature: temp, max_tokens: MAXTOK, reasoning: { effort: REASONING } });
  for (let round = 0; round < (tools ? 6 : 1); round++) {
    const body = { ...base(), messages: msgs };
    if (tools) body.tools = TOOLS;
    const j = await chat(body);
    add(j);
    const m = j.choices[0].message;
    if (tools && m.tool_calls?.length) {
      msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let a = {}; try { a = JSON.parse(tc.function.arguments || '{}'); } catch { /* bad args */ }
        const r = await C.callMemTool(tc.function.name, a);
        calls.push({ name: tc.function.name, args: a, ids: r.ids, tokens: Math.ceil(r.text.length / 3.6) });
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: r.text });
      }
      continue;
    }
    if (!tools || !calls.length || /```/.test(m.content || '')) return { content: m.content || '', usage: u, calls, msgs, forced: false };
    break;
  }
  const j = await chat({ ...base(), messages: flatten(msgs) });
  add(j);
  return { content: j.choices[0].message.content || '', usage: u, calls, msgs, forced: true };
}

function userMsg(t, arm) {
  const ctx = C.out.tasks[t.id].ctx[arm];
  return (ctx ? ctx + '\n' : '') + t.prompt;
}

async function first(t, arm, temp) {
  const key = [MODEL + '@' + REASONING + '#' + C.STORE, temp, arm, t.id, 'first'].join('|');
  if (done.has(key)) return done.get(key);
  const tools = TOOL_ARMS.has(arm);
  const messages = [{ role: 'system', content: SYSTEM + (tools ? MCP_INSTRUCTIONS : '') }, { role: 'user', content: userMsg(t, arm) }];
  const t0 = Date.now();
  const r = await converse(messages, { temp, tools });
  const g = grade(t, extractCode(r.content));
  const own = C.out.tasks[t.id].retrieval.ownIds;
  const rec = {
    key, model: MODEL, reasoningEffort: REASONING, store: C.STORE, temp, arm, task: t.id, set: t.set, type: t.type, lang: t.lang, phase: 'first', pass: g.pass, msg: g.msg,
    ctxTokens: C.out.tasks[t.id].tokens[arm], ...r.usage, cost: r.usage.cost, ms: Date.now() - t0,
    toolCalls: r.calls.map((c) => ({ name: c.name, q: c.args.q || c.args.ids, ownHit: c.ids.some((i) => own.includes(i)), tokens: c.tokens })),
    forcedFinal: r.forced, maxTokens: MAXTOK, reply: r.content.slice(0, 4000),
  };
  appendFileSync(OUT, JSON.stringify(rec) + '\n'); done.set(key, rec); spent += rec.cost || 0;
  return rec;
}

/** Push-after-failure: continue the failed conversation with the error; variant 'card' adds the compact fix card. */
async function retry(t, arm, temp, variant, prev) {
  const key = [MODEL + '@' + REASONING + '#' + C.STORE, temp, arm, t.id, 'retry-' + variant].join('|');
  if (done.has(key)) return done.get(key);
  const tools = TOOL_ARMS.has(arm);
  const card = variant === 'card' ? await C.fixCard(prev.msg) : { text: '', id: null };
  const errText = 'I ran it and it failed:\n```\n' + prev.msg + '\n```\nFix the module.';
  const hook = card.text ? `<system-reminder>\nPostToolUseFailure hook additional context: ${card.text}\n</system-reminder>\n` : '';
  const messages = [
    { role: 'system', content: SYSTEM + (tools ? MCP_INSTRUCTIONS : '') },
    { role: 'user', content: userMsg(t, arm) },
    { role: 'assistant', content: prev.reply || '(no answer)' },
    { role: 'user', content: hook + errText },
  ];
  const r = await converse(messages, { temp, tools });
  const g = grade(t, extractCode(r.content));
  const rec = {
    key, model: MODEL, reasoningEffort: REASONING, store: C.STORE, temp, arm, task: t.id, set: t.set, type: t.type, lang: t.lang, phase: 'retry-' + variant, pass: g.pass, msg: g.msg,
    cardId: card.id, cardOwn: card.owner === t.id, cardTokens: card.text ? Math.ceil(card.text.length / 3.6) : 0,
    ...r.usage, cost: r.usage.cost, toolCalls: r.calls.map((c) => ({ name: c.name, q: c.args.q || c.args.ids })), reply: r.content.slice(0, 4000),
  };
  appendFileSync(OUT, JSON.stringify(rec) + '\n'); done.set(key, rec); spent += rec.cost || 0;
  return rec;
}

async function pool(jobs) {
  let i = 0, n = 0;
  const total = jobs.length;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < jobs.length) {
      if (spent > BUDGET) { console.error(`budget $${BUDGET} reached ($${spent.toFixed(3)}), stopping`); return; }
      const j = jobs[i++];
      try { const r = await j(); n++; if (n % 20 === 0 || n === total) console.error(`${n}/${total} spent $${spent.toFixed(3)}`); if (r && !r.pass && process.env.VERBOSE) console.error(r.key, r.msg.split('\n')[0]); } catch (e) { console.error('job failed:', e.message); }
    }
  }));
}

const tasks = TASKS.filter((t) => !ONLY || ONLY.has(t.id));
const jobs = [];
for (const temp of TEMPS) for (const arm of ARMS) for (const t of tasks) jobs.push(() => first(t, arm, temp));
await pool(jobs);
if (args.includes('--retry')) {
  const rj = [];
  for (const temp of TEMPS) for (const arm of ARMS.filter((a) => ['none', 'irr', 'samPush', 'sam'].includes(a))) for (const t of tasks.filter((x) => x.err)) {
    const prev = done.get([MODEL + '@' + REASONING + '#' + C.STORE, temp, arm, t.id, 'first'].join('|'));
    if (prev && !prev.pass) for (const v of ['plain', 'card']) rj.push(() => retry(t, arm, temp, v, prev));
  }
  await pool(rj);
}
console.error(`done; results file spend $${spent.toFixed(4)}`);
