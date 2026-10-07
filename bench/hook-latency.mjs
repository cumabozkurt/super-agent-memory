#!/usr/bin/env node
// Per-prompt hook latency: spawns `sam hook UserPromptSubmit` the way a host does (fresh process per prompt)
// against a throwaway SAM_HOME with N memories, and prints median / p90 next to a bare `node -e ""` floor.
// Usage: node bench/hook-latency.mjs [runs=30] [memories=60]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const runs = Number(process.argv[2]) || 30;
const mems = Number(process.argv[3]) || 60;
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sam.js');
const tmp = mkdtempSync(join(tmpdir(), 'sam-lat-'));
const proj = join(tmp, 'proj');
mkdirSync(join(proj, '.git'), { recursive: true });
const env = { ...process.env, SAM_HOME: join(tmp, 'sam'), SAM_INSTALL_HOME: join(tmp, 'home'), SAM_TEST: '1' };
for (let i = 0; i < mems; i++) {
  spawnSync(process.execPath, [bin, 'save', `decision ${i}: module ${i} uses drizzle migrations on postgres and vitest`], { cwd: proj, env });
}
const payload = JSON.stringify({ session_id: 'lat', cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: 'why does the drizzle migration fail on postgres' });
function time(args, extra = {}) {
  const ts = [];
  for (let i = 0; i < runs + 2; i++) {
    const t = performance.now();
    spawnSync(process.execPath, args, { input: payload, cwd: proj, env: { ...env, ...extra } });
    if (i >= 2) ts.push(performance.now() - t); // 2 warm-ups (compile cache, page cache)
  }
  ts.sort((a, b) => a - b);
  return { median: +ts[Math.floor(ts.length / 2)].toFixed(1), p90: +ts[Math.floor(ts.length * 0.9)].toFixed(1) };
}
const res = {
  platform: `${process.platform}-${process.arch}`, node: process.versions.node, runs, memories: mems,
  node_floor_ms: time(['-e', '']),
  hook_ms: time([bin, 'hook', 'UserPromptSubmit', '--agent', 'claude']),
  hook_no_compile_cache_ms: time([bin, 'hook', 'UserPromptSubmit', '--agent', 'claude'], { SAM_NO_COMPILE_CACHE: '1' }),
};
console.log(JSON.stringify(res, null, 2));
rmSync(tmp, { recursive: true, force: true });
