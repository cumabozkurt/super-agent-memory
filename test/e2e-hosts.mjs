// End-to-end host check: `npm run e2e`.
// Installs SAM for every agent into a throw-away SAM_INSTALL_HOME (`sam install --all`), then runs every
// installed hook command exactly as a host would (through `sh -c`, payload on stdin) and checks that it
// exits 0 and prints valid JSON or nothing. MCP entries must answer `initialize` with a JSON-RPC result.
// POSIX only (hosts on Windows run the .cmd launcher; covered by test/platform.test.js forms).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') { console.log('e2e-hosts: POSIX only, skipped'); process.exit(0); }
const SAM_BIN = fileURLToPath(new URL('../bin/sam.js', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'sam-e2e-'));
const env = { ...process.env, SAM_HOME: join(TMP, 'samhome'), SAM_INSTALL_HOME: join(TMP, 'user'), HOME: join(TMP, 'user'), NODE_NO_WARNINGS: '1' };
delete env.SAM_TEST;
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) delete env[k];
mkdirSync(env.HOME, { recursive: true });

const ins = spawnSync(process.execPath, [SAM_BIN, 'install', '--all'], { env, encoding: 'utf8' });
if (ins.status !== 0) { console.error(ins.stdout + ins.stderr); process.exit(1); }

// a real repo with a transcript, so hooks do real work (card, recall, harvest)
const repo = join(TMP, 'repo');
mkdirSync(join(repo, '.git'), { recursive: true });
writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/e2e.git\n');
spawnSync(process.execPath, [SAM_BIN, 'add', 'queue: SQS, not Kafka (ops cost)', '-k', 'decision'], { env, cwd: repo });
const transcript = join(TMP, 'transcript.jsonl');
writeFileSync(transcript, [
  { type: 'user', message: { role: 'user', content: 'which queue do we use?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SQS. ⟦mem convention: api errors: always return RFC 7807 problem+json⟧' }] } },
].map((x) => JSON.stringify(x)).join('\n') + '\n');

// one superset payload per event: every field any host sends for it (extra fields are ignored)
const base = { session_id: 'e2e-1', conversation_id: 'e2e-1', generation_id: 'g1', cwd: repo, workspace_roots: [repo], transcript_path: transcript };
const tool = { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '12 passing', exit_code: 0 }, command: 'npm test', output: '12 passing' };
const payloadFor = (ev) => {
  const e = ev.toLowerCase();
  const p = { ...base, hook_event_name: ev };
  if (/sessionstart/.test(e)) Object.assign(p, { source: 'startup' });
  if (/prompt|beforeagent|beforesubmit/.test(e)) Object.assign(p, { prompt: 'which message queue do we use and why?' });
  if (/tool|shell|mcpexec|readfile|fileedit|afterfile/.test(e)) Object.assign(p, tool, { file_path: join(repo, 'README.md'), edits: [] });
  if (/stop|afteragent|end|compact|compress/.test(e)) Object.assign(p, { last_assistant_message: 'Done. ⟦mem decision: cache: Redis 7, not Memcached⟧', stop_hook_active: false, trigger: 'auto' });
  if (/subagent/.test(e)) Object.assign(p, { agent_id: 'sa1', agent_type: 'Explore', agent_transcript_path: transcript });
  return JSON.stringify(p);
};

Object.assign(process.env, { SAM_HOME: env.SAM_HOME, SAM_INSTALL_HOME: env.SAM_INSTALL_HOME, HOME: env.HOME });
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) delete process.env[k];
const { installedCommands } = await import('../src/install.js');
const entries = installedCommands();
let ok = 0, withJson = 0; const bad = [];
for (const e of entries) {
  if (e.kind === 'hook') {
    const cmd = [e.command, ...(e.args || [])].join(' ');
    const r = spawnSync('sh', ['-c', cmd], { env, cwd: repo, input: payloadFor(e.event), encoding: 'utf8', timeout: 20000 });
    const outp = (r.stdout || '').trim();
    let json = !outp;
    if (outp) { try { JSON.parse(outp); json = true; } catch { json = false; } }
    if (r.status === 0 && json) { ok++; if (outp) withJson++; }
    else bad.push(`${e.agent} ${e.event}: exit ${r.status} ${r.error?.code || ''} stdout=${outp.slice(0, 120)} stderr=${(r.stderr || '').slice(0, 160)}`);
  } else {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } }) + '\n';
    const r = spawnSync(e.command, e.args || [], { env, cwd: repo, input: init, encoding: 'utf8', timeout: 20000 });
    const first = (r.stdout || '').split('\n').find(Boolean) || '';
    let good = false; try { good = !!JSON.parse(first).result?.serverInfo; } catch { /* bad */ }
    if (good) ok++; else bad.push(`${e.agent} mcp: exit ${r.status} ${first.slice(0, 120)} ${(r.stderr || '').slice(0, 160)}`);
  }
}
const hooks = entries.filter((e) => e.kind === 'hook').length;
const mcps = entries.length - hooks;
const byAgent = {};
for (const e of entries) byAgent[e.agent] = (byAgent[e.agent] || 0) + 1;
console.log(`e2e-hosts: ${ok}/${entries.length} OK (${hooks} hook commands via sh, ${mcps} MCP servers; ${withJson} hooks answered with JSON, the rest silently) — ${Object.entries(byAgent).map(([a, n]) => `${a}:${n}`).join(' ')}`);
for (const b of bad) console.log('  FAIL ' + b);
rmSync(TMP, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
