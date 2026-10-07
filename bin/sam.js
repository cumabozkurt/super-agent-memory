#!/usr/bin/env node
// Super Agent Memory (SAM) — entry point.
// Node < 24.15 prints "ExperimentalWarning: SQLite is an experimental feature" on stderr; hosts
// show hook stderr to the user, so that one warning is filtered (stdout JSON is never affected).
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return origEmit.call(process, warning, ...rest);
};

// V8 compile cache (Node >= 22.1): module compilation is most of a hook's cold start, and every
// host prompt spawns a fresh process. Honors NODE_COMPILE_CACHE; SAM_NO_COMPILE_CACHE=1 opts out.
if (!process.env.SAM_NO_COMPILE_CACHE) {
  try {
    const mod = await import('node:module');
    // default dir (NODE_COMPILE_CACHE or <tmp>/node-compile-cache) first; on a shared /tmp it can be
    // another user's, so fall back to SAM's own home
    const r = mod.enableCompileCache?.();
    if (r && r.status === mod.constants?.compileCacheStatus?.FAILED) {
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      mod.enableCompileCache(join(process.env.SAM_HOME || join(homedir(), '.sam'), 'cache', 'v8'));
    }
  } catch { /* never fatal */ }
}

const argv = process.argv.slice(2);
const inHook = argv[0] === 'hook';
// Under the ~/.sam/bin launcher this exit code means "unsupported runtime, try the next node".
const RETRY = 86;
function unsupported(msg) {
  if (process.env.SAM_LAUNCHER) process.exit(RETRY);
  if (!inHook || process.env.SAM_DEBUG) process.stderr.write(msg + '\n');
  process.exit(inHook ? 0 : 1); // never fail (or block) a host hook
}

// node:sqlite ships FTS5 only from Node 22.16 (22.x) and 24.0; 22.13–22.15 and every 23.x lack it.
const [major, minor] = process.versions.node.split('.').map(Number);
const isBunOrDeno = !!(process.versions.bun || globalThis.Deno);
if (!isBunOrDeno && !((major === 22 && minor >= 16) || major >= 24)) {
  unsupported(`sam: Node.js 22.16+ (22.x) or 24+ is required: node:sqlite needs FTS5 (found ${process.versions.node}).`);
}

// Feature probe: distro builds (--shared-sqlite) or exotic runtimes may still lack FTS5 / trigram.
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE p USING fts5(a, tokenize='trigram')");
  } catch (e) {
    let ver = '?';
    try { ver = db.prepare('select sqlite_version() v').get().v; } catch { /* ignore */ }
    unsupported(`sam: this runtime's SQLite lacks FTS5/trigram (node ${process.versions.node}, sqlite ${ver}: ${e.message}). Use the official Node.js 22.16+ or 24+ build.`);
  }
  db.close();
} catch (e) {
  unsupported(`sam: node:sqlite is not available in this runtime (${e.message}). Use Node.js 22.16+ or 24+.`);
}

// Hook fast path: load only the hook module graph (not the CLI, installer, MCP, vault, embeddings).
if (inHook) {
  if (process.env.SAM_SELFTEST) { process.stdout.write('{"sam-selftest-ok":true}\n'); process.exit(0); }
  const flag = (k, d) => {
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--' + k && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) return argv[i + 1];
      if (argv[i].startsWith('--' + k + '=')) return argv[i].slice(k.length + 3);
    }
    return d;
  };
  const event = argv.slice(1).find((a, i, xs) => !a.startsWith('-') && !(i > 0 && /^--(agent|hint)$/.test(xs[i - 1])));
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
  try {
    const { runHook } = await import('../src/hooks.js');
    const r = await runHook(event, { agent: flag('agent', 'claude'), hint: flag('hint', 'mcp') });
    if (r?.out && Object.keys(r.out).length) process.stdout.write(JSON.stringify(r.out) + '\n');
  } catch (e) {
    if (process.env.SAM_DEBUG) process.stderr.write(String(e?.stack || e) + '\n'); // never break the host agent
  }
} else {
const { main } = await import('../src/cli.js');
main(argv).catch((err) => {
  // user errors print one line; SAM_DEBUG shows the stack
  const msg = process.env.SAM_DEBUG ? err?.stack || String(err) : err?.message || String(err);
  process.stderr.write(`sam: ${msg}\n`);
  process.exit(err?.usage ? 2 : 1);
});
}
