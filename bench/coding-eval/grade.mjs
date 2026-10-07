// Deterministic grader: writes the repo stubs + solution.mjs + test.mjs into a temp dir and runs the test with node.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { STUBS } from './stubs.mjs';

/** The solution code from a model reply: the first fenced js/ts block that exports something, else the first block. */
export function extractCode(reply) {
  const blocks = [...String(reply || '').matchAll(/```[ \t]*([\w.+-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), code: m[2] }));
  const js = blocks.filter((b) => !b.lang || /^(js|javascript|mjs|ts|typescript|jsx|esm|node)$/.test(b.lang));
  const pick = js.find((b) => /\bexport\b/.test(b.code)) || js[0] || blocks[0];
  return pick ? pick.code : String(reply || '');
}

function header(task) {
  return `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('./solution.mjs', import.meta.url), 'utf8');
const ERR = ${JSON.stringify(task.err || '')};
const fail = (m) => { process.stderr.write('FAIL: ' + m + '\\n'); process.exit(1); };
let S = {};
${task.noImport ? '' : `try { S = await import('./solution.mjs'); } catch (e) {
  if (ERR && e && e.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find module '[^']*\\/(text|text\\.ts)'/.test(e.message)) fail(ERR);
  fail('solution does not load: ' + (e && e.message || e).split('\\n')[0]);
}`}
`;
}

/** { pass, msg } — msg is what a developer would see (the realistic error for fix tasks). */
export function grade(task, code) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-ce-'));
  try {
    for (const [f, src] of Object.entries(STUBS)) writeFileSync(join(dir, f), src);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'solution.mjs'), code);
    writeFileSync(join(dir, 'test.mjs'), header(task) + task.test + '\n');
    const r = spawnSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 10000, encoding: 'utf8', env: { PATH: process.env.PATH, TZ: 'America/New_York' } });
    if (r.status === 0) return { pass: true, msg: '' };
    if (r.error || r.signal) return { pass: false, msg: 'timeout' + (task.err ? ' — ' + task.err : '') };
    const err = (r.stderr || '').trim();
    const m = err.match(/FAIL: ([\s\S]*)$/);
    const msg = m ? m[1].trim() : (err.split('\n').find((l) => /Error|assert/i.test(l)) || err.split('\n')[0] || 'failed');
    return { pass: false, msg: msg.slice(0, 600) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
