// super-agent-memory plugin for OpenCode. Installed by `sam install opencode`
// into ~/.config/opencode/plugins/. It forwards OpenCode events to `sam hook`
// (same engine as every other agent) and injects the returned memory context.
import { spawn } from 'node:child_process';

// argv prefix written by `sam install`: the ~/.sam/bin/sam launcher on POSIX, node + sam.js on Windows.
const ARGV = ['__SAM_ARGV__'];

// Async: never block OpenCode's event loop. Resolves to the hook's JSON reply ({} on any failure).
function hook(event, payload) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const c = spawn(ARGV[0], [...ARGV.slice(1), 'hook', event, '--agent', 'opencode'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const t = setTimeout(() => { c.kill(); finish({}); }, 8000);
      c.stdout.on('data', (d) => { out += d; });
      c.on('error', () => { clearTimeout(t); finish({}); });
      c.on('close', () => { clearTimeout(t); try { finish(JSON.parse(out || '{}')); } catch { finish({}); } });
      c.stdin.end(JSON.stringify(payload));
    } catch { finish({}); }
  });
}
const ctxOf = (r) => r?.hookSpecificOutput?.additionalContext || '';

// Last assistant text of a session (for ⟦mem …⟧ marker harvest); best-effort across SDK versions.
async function lastAssistantText(client, sid) {
  try {
    const res = await client?.session?.messages?.({ path: { id: sid } });
    const msgs = res?.data ?? res ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if ((m?.info?.role ?? m?.role) !== 'assistant') continue;
      return (m.parts || []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n');
    }
  } catch { /* older SDK */ }
  return '';
}

export const SamMemory = async ({ directory, client }) => {
  const started = new Set();
  const args = new Map();
  return {
    event: async ({ event }) => {
      const sid = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sid) return;
      if (event.type === 'session.idle') lastAssistantText(client, sid).then((t) => hook('Stop', { session_id: sid, cwd: directory, last_assistant_message: t }));
      if (event.type === 'session.deleted') void hook('SessionEnd', { session_id: sid, cwd: directory });
      if (event.type === 'session.compacted') { started.delete(sid); void hook('PostCompact', { session_id: sid, cwd: directory }); }
    },
    'tool.execute.before': async (input, output) => {
      if (input?.callID) args.set(input.callID, output?.args);
    },
    'tool.execute.after': async (input, output) => {
      const a = args.get(input?.callID);
      args.delete(input?.callID);
      void hook('PostToolUse', {
        session_id: input?.sessionID, cwd: directory, tool_name: input?.tool,
        tool_input: a ?? output?.metadata?.args, tool_response: { output: output?.output, ...(output?.metadata?.exit !== undefined ? { exit_code: output.metadata.exit } : {}) },
      });
    },
    'chat.message': async (input, output) => {
      try {
        const sid = input?.sessionID;
        const prompt = (output?.parts || []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n');
        let ctx = '';
        if (!started.has(sid)) {
          started.add(sid);
          ctx += ctxOf(await hook('SessionStart', { session_id: sid, cwd: directory, source: 'startup' }));
        }
        const rec = ctxOf(await hook('UserPromptSubmit', { session_id: sid, cwd: directory, prompt }));
        if (rec) ctx += (ctx ? '\n' : '') + rec;
        if (ctx && output?.parts) {
          output.parts.push({
            id: 'prt_sam' + Date.now().toString(36), sessionID: sid, messageID: output.message?.id,
            type: 'text', text: ctx, synthetic: true,
          });
        }
      } catch { /* never break the chat */ }
    },
    'experimental.session.compacting': async (input, output) => {
      await hook('PreCompact', { session_id: input?.sessionID, cwd: directory });
      const card = ctxOf(await hook('SessionStart', { session_id: input?.sessionID, cwd: directory, source: 'compact' }));
      if (card && Array.isArray(output?.context)) output.context.push(card);
    },
  };
};
