// `sam` command-line interface. Agents can use it directly from their shell tool,
// which costs zero tool-schema tokens (no MCP needed at all).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveProject, projectByName } from './project.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, closeDb, healthCheck, moveAside, salvage, corruptCopies, dbState, SCHEMA_VERSION } from './db.js';
import { search } from './search.js';
import { saveMemory, getMemories, forget, setPinned, listMemories, line, LIVE_SQL, liveArgs } from './store.js';
import { sessionContext, promptContext } from './inject.js';
import { runCommand, readVault, isVaultId } from './vault.js';
import { recordTool } from './capture.js';
import { gc, purge } from './gc.js';
import { exportMarkdown, importMarkdown, exportJsonl, importJsonl, writeTeamFile, syncTeamFile, setTrusted, isTrusted, previewTeamFile, readTeamFile, contentHash } from './portable.js';
import { install, detect, AGENTS, genericSnippet, SKILL, selfTest, installedCommands, stalePaths, dbLocationWarning } from './install.js';
import { runHook } from './hooks.js';
import { serveMcp, toolSchemaTokens } from './mcp.js';
import { backfill } from './embed.js';
import { config, configWarnings, nativeBudgetLine, nativeTokens } from './config.js';
import { tokens } from './text.js';
import { KINDS, normKind } from './store.js';
import { VERSION } from './version.js';
import { pickShell, quoteArgvFor, hasShellMeta } from './platform.js';

const BOOL = new Set(['off', 'pin', 'all', 'json', 'hard', 'team', 'jsonl', 'md', 'dry-run', 'all-projects', 'global', 'sessions', 'help', 'yes', 'repair', 'trusted', 'force', 'shell', 'no-self-test', 'include-backups', 'no-tombstone', 'tombstone', 'include-quarantined', 'quarantined', 'list']);
/** A user error: bin/sam.js prints the message only (no stack) and exits 2. */
const usage = (msg) => Object.assign(new Error(msg), { usage: true });
const notFound = (msg) => { out(msg); process.exitCode = 1; };

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { flags['--'] = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1); // --grep=KEY=val keeps "KEY=val"
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k)) flags[k] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (/^-[a-z]$/.test(a)) {
      const k = { '-k': 'kind', '-n': 'n', '-p': 'project', '-g': 'global', '-j': 'json' }[a] || a.slice(1);
      if (['global', 'json'].includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); }); // `sam ls | head`

function currentProject(flags) {
  if (flags.global) return { id: 'global', name: 'global' };
  if (flags.project) {
    const p = projectByName(flags.project);
    if (!p) throw new Error('unknown project ' + flags.project);
    return p;
  }
  return resolveProject(process.cwd());
}

const HELP = `sam ${VERSION} — super-agent-memory: one persistent, token-frugal memory for every coding agent
(also installed as \`sam-memory\` and \`super-agent-memory\`, for machines where \`sam\` is the AWS SAM CLI)

setup
  sam install [agent…|--all] [--dry-run]   wire hooks + MCP + rules (${AGENTS.join(', ')})
  sam uninstall [agent…|--all]             remove exactly what install added
  sam doctor [--repair]                    check detection, DB, budgets, broken paths; self-test installed hooks; --repair salvages a corrupt DB
  sam --version

recall / save
  sam q "<words>" [-k kind] [-n 8]         search → "[kind] gist #id" lines
  sam get <id…>                            full detail (memories or vault outputs)
  sam add "<text>" [-k kind] [--pin] [--files a,b] [-g]
  sam forget <id> [--hard [--no-tombstone]] [--tombstone]   sam pin <id>   sam unpin <id>
  sam ls [-k kind] [-n 50] [--all]
  sam context [--prompt "<text>"]          preview what agents get injected
  sam handoff [--to agent] "<note>"        leave a note the next session of another agent gets once
  sam handoff --list [--all]               open (--all: also consumed) handoffs of this project

token savers
  sam run -- <command…>                    run, vault full output, print digest
                                           (one quoted string with ; & | > needs --shell)
  sam out <id> [--grep re] [--tail N] [--lines A:B]

maintenance
  sam stats                                tokens injected vs. saved, counts
  sam gc [--dry-run] [--force]             expire, merge near-dups, archive, reinforce
  sam purge <id> | --query "<words>" | --project <name|id> | --all-matching "<text>"
            [--yes] [--dry-run] [--include-backups] [--no-tombstone]
                                           erase content from every table (memories + older versions, raw events,
                                           first prompts, vault, digests, handoffs, team file), then VACUUM
  sam review [approve|reject <id…>|approve-all [--quarantined]]
                                           inbox of held memories (quarantined / pending); unapproved ones expire
  sam audit [--days 30] [--json]           counts by source/status/kind, most injected, follow-up rate, quarantine reasons
  sam sleep [--dry-run] [--days 14]        consolidate: near-dup clusters, weekly session digests, prune events
  sam skills draft [--min 3] [--dry-run]   SKILL.md drafts from repeated fixes → ~/.sam/drafts (never installed)
  sam export [--md|--jsonl] [--team]       --team writes <repo>/.sam/memory.md for git sharing
  sam trust [--yes] [--off]                review + import this repo's .sam/memory.md (needs a terminal, or --yes)
  sam import <file.md|file.jsonl> [--trusted]  untrusted by default: no pins, no global rows
  sam embed                                backfill optional embeddings (SAM_EMBED_URL/MODEL)
  sam snippet                              MCP JSON + rules for any other client

internal
  sam hook <Event> --agent <name>          host hook entry (reads JSON on stdin)
  sam mcp [--agent <name>]                 stdio MCP server (4 tools)
`;

export async function main(argv) {
  if (argv[0] === '--version' || argv[0] === '-v') return out(VERSION);
  if (argv[0] === '--help' || argv[0] === '-h') return out(HELP);
  const { pos, flags } = parse(argv);
  const cmd = pos.shift();

  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h':
      return out(HELP);
    case 'version': case '--version': case '-v':
      return out(VERSION);

    case 'hook': {
      if (process.env.SAM_SELFTEST) return out('{"sam-selftest-ok":true}'); // `sam doctor` / install self-test
      try {
        const r = await runHook(pos[0], { agent: flags.agent || 'claude', hint: flags.hint || 'mcp' });
        if (r?.out && Object.keys(r.out).length) out(JSON.stringify(r.out));
      } catch (e) {
        if (process.env.SAM_DEBUG) process.stderr.write(String(e.stack || e) + '\n');
        // never break the host agent
      }
      return;
    }
    case 'mcp':
      if (process.env.SAM_SELFTEST) return out('sam-selftest-ok');
      openDb();
      return serveMcp({ agent: flags.agent || 'mcp' });

    case 'install': case 'uninstall': {
      const unknown = pos.filter((a) => !AGENTS.includes(a));
      if (unknown.length) throw usage(`unknown agent: ${unknown.join(', ')} (supported: ${AGENTS.join(', ')})`);
      const det = detect();
      let agents = pos.length ? pos : flags.all ? AGENTS : AGENTS.filter((a) => det[a]);
      if (!agents.length) { out('No supported agents detected. Name them explicitly: sam install claude codex …'); return; }
      const dry = !!flags['dry-run'];
      const res = install(agents, { dry, remove: cmd === 'uninstall' });
      let failed = false;
      for (const [a, log] of Object.entries(res)) {
        const bad = log.some((l) => l.startsWith('ERROR'));
        failed ||= bad;
        if (a === '_launcher') { if (log.length) out('launcher\n  ' + log.join('\n  ')); continue; }
        out(`${bad ? '✖' : cmd === 'install' ? '✔' : '−'} ${a}${log.length ? '\n  ' + log.join('\n  ') : ''}`);
      }
      if (cmd === 'install' && !dry) {
        // run every installed command through the shell its host uses (skipped where that shell is absent)
        if (!flags['no-self-test']) {
          const st = selfTest(installedCommands().filter((e) => agents.includes(e.agent)));
          for (const r of st) if (r.status !== 'ok') out(`self-test ${r.agent} ${r.kind} via ${r.shell}: ${r.status}${r.detail ? ' — ' + r.detail : ''}`);
          if (st.some((r) => r.status === 'failed')) failed = true;
          else if (st.length) out(`self-test: ${st.filter((r) => r.status === 'ok').length}/${st.length} commands ran through their host shell`);
        }
        const w = dbLocationWarning(config().dbPath);
        if (w) out(w);
        out('\nDone. Restart your agents.' + (agents.includes('codex') ? ' Codex: run /hooks once to trust the new hooks.' : ''));
      }
      if (failed) process.exitCode = 1;
      return;
    }
    case 'doctor': {
      const cfg = config();
      const det = detect();
      openDb();
      if (dbState.newerSchema) {
        out(`DB schema ${dbState.newerSchema} is NEWER than this SAM ${VERSION} (schema ${SCHEMA_VERSION}): opened read-only so it is not damaged; searches and cards work, nothing is saved until you upgrade SAM (reinstall it the way you installed it, then run "sam install")`);
        process.exitCode = 1;
      }
      if (flags.repair && dbState.newerSchema) out('repair skipped: this SAM cannot safely write a newer-schema database');
      else if (flags.repair) out(repair(cfg.dbPath));
      else {
        const h = healthCheck();
        if (h) out(`DB problem: ${h}\n  → run \`sam doctor --repair\` (moves the file aside and salvages every readable row)`);
        const left = corruptCopies(cfg.dbPath).filter((f) => !openDb().prepare('SELECT 1 FROM meta WHERE k = ?').get('salvaged:' + f));
        if (left.length) out(`found ${left.length} unrecovered corrupt DB cop${left.length > 1 ? 'ies' : 'y'} (${left[0]}) → \`sam doctor --repair\` salvages it`);
        if (dbState.readOnly && !dbState.newerSchema) out('DB is read-only: searches and cards work, nothing new is saved');
        if (dbState.journal === 'DELETE') out(`journal: rollback (not WAL) because the DB is on ${dbState.sharedFs}; SAM_ALLOW_SHARED_FS=1 forces WAL`);
      }
      const c = openDb().prepare(`SELECT COUNT(*) c FROM memories WHERE ${LIVE_SQL}`).get(...liveArgs()).c;
      let held = 0;
      try { held = openDb().prepare("SELECT COUNT(*) c FROM memories WHERE superseded_by IS NULL AND status != 'active'").get().c; } catch { /* older file */ }
      let tombs = 0;
      try { tombs = openDb().prepare('SELECT COUNT(*) c FROM tombstones').get().c; } catch { /* older file */ }
      out(`node ${process.versions.node} · db ${cfg.dbPath} (schema ${dbState.newerSchema || SCHEMA_VERSION}${dbState.newerSchema ? ', newer than this SAM' : ''}) · ${c} live memories${held ? ` · ${held} held for review (sam review)` : ''}${tombs ? ` · ${tombs} tombstones` : ''}`);
      out(`privacy: PII redaction ${cfg.redactPII === false ? 'OFF (redactPII=false)' : 'on (e-mail, phone, IBAN, TCKN)'}`);
      out('agents detected: ' + Object.entries(det).map(([k, v]) => `${k}${v ? '✔' : '·'}`).join(' '));
      out(`budgets (o200k): session-start ≤${cfg.budgetSessionStart} tok, per-prompt ≤${cfg.budgetPrompt} tok` + (cfg.budgetProfile ? ` · profile ${cfg.budgetProfile}` : ''));
      out('native estimate: ' + nativeBudgetLine(cfg));
      out(`MCP tool schema: ~${toolSchemaTokens()} tokens for all 4 tools`);
      out(`embeddings: ${cfg.embedUrl && cfg.embedModel ? cfg.embedModel + ' @ ' + cfg.embedUrl : 'off (lexical BM25+trigram hybrid)'}`);
      const here = resolveProject(process.cwd());
      if (here.root && existsSync(join(here.root, '.sam', 'memory.md'))) {
        const tf = readTeamFile(here);
        const rec = isTrusted(here);
        let state = 'present but NOT trusted — review it, then run `sam trust`';
        if (!tf) state = 'present but not a regular file (symlink?) — ignored';
        else if (rec) {
          const v = openDb().prepare('SELECT v FROM meta WHERE k = ?').get('trustroot:' + (await import('./text.js')).sha(here.root, 16))?.v;
          state = JSON.parse(v || '{}').hash === contentHash(tf.content) ? 'trusted (this exact content), imported' : 'CHANGED since you trusted it — review with `sam trust`';
        }
        out(`team file: ${state}`);
      }
      if (det.codex) out('codex: hooks run only after you approve them once with /hooks inside Codex');
      for (const w of configWarnings()) out('config: ' + w);
      const loc = dbLocationWarning(cfg.dbPath);
      if (loc) out(loc);
      const entries = installedCommands();
      const stale = stalePaths(entries);
      if (stale.length) { out(`BROKEN: installed hooks/MCP point at missing paths (node upgraded/removed, package moved, or configs from another machine): ${stale.join(', ')} → run \`sam install\``); process.exitCode = 1; }
      if (entries.length) {
        const st = selfTest(entries);
        out('self-test: ' + st.map((r) => `${r.agent}/${r.kind}:${r.status === 'ok' ? '✔' : r.status === 'skipped' ? '·' : '✖'}`).join(' '));
        for (const r of st) if (r.status === 'failed') { out(`  ${r.agent} ${r.kind} via ${r.shell}: ${r.detail}`); process.exitCode = 1; }
      }
      return;
    }

    case 'q': case 'search': case 'find': {
      const query = pos.join(' ');
      if (!query.trim()) throw usage('usage: sam q "<words>" [-k kind] [-n 8]');
      const project = flags['all-projects'] ? { id: '*' } : currentProject(flags);
      const hits = await search(query, { project: project.id, k: Number(flags.n) || 8, kind: flags.kind, includeHeld: !!flags['include-quarantined'] });
      if (flags.json) return out(JSON.stringify(hits.map((h) => ({ score: +h.score.toFixed(4), ...h.m, embedding: undefined }))));
      return out(hits.length ? hits.map((h) => line(h.m, { withAge: true })).join('\n') : 'no matches');
    }
    case 'get': case 'show': {
      const ids = pos.flatMap((p) => p.split(/[\s,]+/)).filter(Boolean);
      // an id is a vault output only if the vault has it (memory ids may also start with "o")
      const mems = [];
      for (const id of ids) {
        const v = isVaultId(id) ? readVault(id, { grep: flags.grep, tail: Number(flags.tail) || undefined, lines: flags.lines }) : null;
        if (v) out(v.header + '\n' + v.text); else mems.push(id);
      }
      const found = getMemories(mems);
      if (!ids.length) throw usage('usage: sam get <id…>');
      for (const id of mems.filter((i) => !found.some((m) => m.id === i.replace(/^#/, '')))) notFound(`#${id} not found`);
      for (const m of found) {
        // v2-guard: held rows show their status only, unless the user asks for the text explicitly
        if (m.status !== 'active' && !flags['include-quarantined']) { out(`#${m.id} ${m.status}: content withheld (sam review, or sam get ${m.id} --include-quarantined)`); continue; }
        out(`#${m.id} [${m.kind}]${m.status !== 'active' ? ' (' + m.status + ')' : ''} ${m.gist}${m.body ? '\n' + m.body : ''}${m.files ? '\nfiles: ' + m.files : ''}\n(${new Date(m.updated_at).toISOString().slice(0, 10)}${m.source ? ' · ' + m.source : ''}${m.superseded_by ? ' · superseded by ' + m.superseded_by : ''})`);
      }
      return;
    }
    case 'add': case 'remember': case 'save': {
      const text = (pos.join(' ') || (flags['--'] || []).join(' ')).trim();
      if (!text) throw usage('usage: sam add "<text>" [-k kind] [--pin] [--files a,b] [-g]');
      if (text.length < 6) throw usage('text too short: save one self-contained sentence');
      // same validation as the MCP mem_save tool
      const kind = flags.kind ? normKind(flags.kind) : undefined;
      const kinds = Object.keys(KINDS).filter((x) => x !== 'session');
      if (flags.kind && (kind === 'note' && !/^(n|note|not)$/i.test(String(flags.kind)))) throw usage(`unknown kind "${flags.kind}"; use one of ${kinds.join('|')}`);
      if (kind === 'session') throw usage('session digests are written automatically');
      const p = currentProject(flags);
      const r = saveMemory({ project: p.id, kind, text, body: flags.body, files: flags.files ? String(flags.files).split(',') : [], topic: flags.topic, pin: !!flags.pin, source: 'user', agent: typeof flags.source === 'string' ? flags.source : 'cli',
        validFrom: flags['valid-from'], validTo: flags['valid-to'], allowTombstoned: !!flags.force });
      if (r.status === 'tombstoned') { process.exitCode = 1; return out('not saved: this content was purged/forgotten (tombstone). `sam add --force` re-adds it on purpose'); }
      return out(`${r.status} #${r.id}${r.supersedes ? ' (replaces #' + r.supersedes.join(' #') + ')' : ''}`);
    }
    case 'forget': case 'pin': case 'unpin': {
      if (!pos[0]) throw usage(`usage: sam ${cmd} <id>`);
      // tombstones: --hard leaves a fingerprint by default (--no-tombstone skips it); a soft forget only with --tombstone
      const tomb = flags.hard ? !flags['no-tombstone'] : !!flags.tombstone;
      const ok = cmd === 'forget' ? forget(pos[0], { hard: !!flags.hard, tombstone: tomb }) : setPinned(pos[0], cmd === 'pin');
      const fmsg = (flags.hard ? 'deleted (secure delete + FTS purge)' : 'forgotten') + (tomb ? '; fingerprint kept so it is not re-captured' : '') +
        (flags.hard ? '. Copies in raw events / vault / digests: `sam purge ' + pos[0] + '`' : '');
      return ok ? out({ forget: fmsg, pin: 'pinned', unpin: 'unpinned' }[cmd]) : notFound(`#${pos[0]} not found`);
    }
    case 'purge': {
      openDb();
      if (dbState.readOnly) throw new Error(dbState.newerSchema ? `the database uses schema ${dbState.newerSchema}, newer than this SAM (${SCHEMA_VERSION}): upgrade SAM to purge` : 'the database is read-only: nothing can be purged');
      const sel = { ids: [], match: null, project: null };
      let what = '';
      if (typeof flags['all-matching'] === 'string') { sel.match = flags['all-matching']; what = `everything containing "${sel.match}" (all projects)`; }
      else if (flags['all-matching']) throw usage('usage: sam purge --all-matching "<text>"');
      if (typeof flags.query === 'string') {
        const scope = flags['all-projects'] ? '*' : resolveProject(process.cwd()).id;
        const hits = await search(flags.query, { project: scope, k: Number(flags.n) || 20 });
        sel.ids.push(...hits.map((h) => h.m.id));
        what = what || `${hits.length} memories matching "${flags.query}"`;
        for (const h of hits) out('  ' + line(h.m));
      } else if (flags.query) throw usage('usage: sam purge --query "<words>"');
      if (typeof flags.project === 'string') {
        const p = projectByName(flags.project);
        if (!p || p.id === 'global' && flags.project !== 'global') throw usage('unknown project ' + flags.project);
        sel.project = p.id; what = what || `the whole project ${p.name || p.id}`;
      } else if (flags.project) throw usage('usage: sam purge --project <name|id>');
      for (const x of pos) sel.ids.push(...x.split(/[\s,]+/).filter(Boolean).map((i) => i.replace(/^#/, '')));
      if (pos.length) {
        const found = getMemories(sel.ids, { touch: false });
        if (!found.length && !sel.match && !sel.project && !flags.query) return notFound(`#${pos.join(' #')} not found`);
        for (const m of found) out('  ' + line(m));
        what = what || `${found.length} memor${found.length === 1 ? 'y' : 'ies'}`;
      }
      if (!sel.ids.length && !sel.match && !sel.project) {
        if (flags.query) return out('nothing matched: nothing purged');
        throw usage('usage: sam purge <id> | --query "<words>" | --project <name|id> | --all-matching "<text>" [--yes] [--include-backups] [--no-tombstone]');
      }
      const opts = { ...sel, tombstone: !flags['no-tombstone'], includeBackups: !!flags['include-backups'] };
      const preview = purge({ ...opts, dryRun: true });
      out(`purge ${what}: ${fmtPurge(preview)}`);
      if (flags['dry-run']) return out('(dry run: nothing deleted)');
      if (!flags.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) { process.exitCode = 1; return out('not purged: run it in a terminal to confirm, or add --yes'); }
        const ans = await ask('Erase this permanently? It cannot be undone. [y/N] ');
        if (!/^y(es)?$/i.test(ans.trim())) return out('not purged');
      }
      const r = purge(opts);
      out(`purged: ${fmtPurge(r)}${r.vacuum ? '; database vacuumed, WAL truncated' : r.vacuumError ? `; VACUUM deferred (${r.vacuumError}): run \`sam purge\` again or \`sam gc\` when no agent is running` : ''}`);
      for (const f of r.teamFiles) out(f.error ? `team file ${f.file}: not changed (${f.error})` : `team file ${f.file}: removed ${f.removed} line(s); commit it, and note git history still has the old text`);
      if (r.backupsDeleted) out(`deleted ${r.backupsDeleted} backup cop${r.backupsDeleted === 1 ? 'y' : 'ies'} (sam.db.corrupt-*)`);
      if (r.backups.length) out(`${r.backups.length} backup cop${r.backups.length === 1 ? 'y' : 'ies'} of the database still hold old content (${r.backups[0]}${r.backups.length > 1 ? ', …' : ''}): re-run with --include-backups to delete ${r.backups.length === 1 ? 'it' : 'them'}`);
      out('not reachable from here: files you exported yourself (sam export -o …), and copies host agents keep in their own transcripts.');
      return;
    }
    case 'ls': case 'list': {
      const p = flags['all-projects'] ? {} : { project: currentProject(flags).id };
      const rows = listMemories({ ...p, kind: flags.kind, limit: Number(flags.n) || 50, all: !!flags.all });
      return out(rows.length ? rows.map((m) => (m.pinned ? '📌 ' : '') + line(m, { withAge: true }) + (m.superseded_by ? ` (→${m.superseded_by})` : '') + (m.status !== 'active' ? ` (${m.status})` : '')).join('\n') : 'empty');
    }
    case 'context': {
      const p = currentProject(flags);
      const start = sessionContext({ project: p, session: null, hint: flags.hint || 'mcp' });
      out(start.text || '(nothing to inject yet)');
      out(`\n[session-start: ${start.tokens} tokens]`);
      if (flags.prompt) {
        const r = await promptContext({ project: p, session: null, prompt: String(flags.prompt) });
        out('\n' + (r.text || '(no recall above threshold)') + `\n[prompt recall: ${r.tokens} tokens]`);
      }
      return;
    }

    case 'run': {
      const parts = flags['--'] || pos;
      if (!parts.length) throw usage('usage: sam run [--shell] -- <command…>');
      // one arg = a shell string the agent wrote; several args = argv that must keep its quoting.
      // S13: a single string with chaining/substitution/redirection is a whole shell program, which a
      // host's "always allow `sam run`" prefix rule would approve unseen, so it needs an explicit --shell.
      if (parts.length === 1 && hasShellMeta(parts[0]) && !flags.shell) {
        throw usage('refusing to run a single argument containing shell operators (; & | < > ` $( ) without --shell.\n' +
          '  pass the command as separate words:  sam run -- npm test\n  or opt in explicitly:                sam run --shell -- "npm test && npm run lint"');
      }
      const shell = pickShell();
      const command = parts.length === 1 ? parts[0] : quoteArgvFor(shell.kind, parts);
      const p = resolveProject(process.cwd());
      const r = await runCommand(command, {
        project: p, shell, maxLines: Number(flags.lines) || 40,
        onEvent: ({ ok, output }) => recordTool({ session: process.env.SAM_SESSION || null, project: p, agent: 'vault', tool: 'bash', input: { command }, response: { output }, ok, root: p.root }),
      });
      out(r.text);
      process.exitCode = r.code ?? 1;
      return;
    }
    case 'out': {
      if (!pos[0]) throw usage('usage: sam out <id> [--grep re] [--tail N] [--lines A:B]');
      const v = readVault(pos[0], { grep: flags.grep, tail: Number(flags.tail) || undefined, lines: flags.lines });
      return v ? out(v.header + '\n' + v.text) : notFound(`${pos[0]} not found (vault entries expire after ${config().vaultRetentionDays}d)`);
    }

    case 'stats': {
      const db = openDb();
      const scope = flags['all-projects'] ? null : currentProject(flags).id;
      const rows = db.prepare(`SELECT metric, SUM(value) v FROM stats ${scope ? 'WHERE project = ?' : ''} GROUP BY metric`).all(...(scope ? [scope] : []));
      const m = Object.fromEntries(rows.map((r) => [r.metric, r.v]));
      const live = db.prepare(`SELECT kind, COUNT(*) c FROM memories WHERE ${LIVE_SQL} ${scope ? "AND (project = ? OR project='global')" : ''} GROUP BY kind`).all(...liveArgs(), ...(scope ? [scope] : []));
      const vault = db.prepare(`SELECT COALESCE(SUM(bytes),0) b, COALESCE(SUM(shown_bytes),0) s, COUNT(*) n FROM vault ${scope ? 'WHERE project = ?' : ''}`).get(...(scope ? [scope] : []));
      out(`memories: ${live.map((r) => `${r.kind} ${r.c}`).join(' · ') || 'none'}`);
      out(`saved ${m.mem_saved || 0} · merged dups ${m.mem_merged || 0} · auto-fixes ${m.fixes_detected || 0} · inline markers ${m.markers_harvested || 0}`);
      out(`injected: ${m.tokens_injected || 0} tokens (o200k) over ${(m.injections_start || 0)} session cards (${m.card_full_dump || 0} full dumps), ${(m.injections_prompt || 0)} prompt recalls, ${(m.injections_file || 0)} file notes, ${(m.injections_fix || 0)} fix pushes`);
      out(`  native estimate: ${['claude-4.6', 'claude-4.7', 'gemini-3'].map((t) => `${t} ≈${nativeTokens(m.tokens_injected || 0, t)}`).join(' · ')}`);
      if (m.native_dropped || m.native_conflicts) out(`native memory: ${m.native_dropped || 0} card lines skipped (already in CLAUDE.md/AGENTS.md/…), ${m.native_conflicts || 0} contradictions noted`);
      out(`output vault: ${vault.n} runs live, ${(vault.b / 1024).toFixed(0)}KB captured → ${(vault.s / 1024).toFixed(0)}KB shown; ~${m.tokens_saved_vault || 0} tokens kept out of context (all-time)`);
      return;
    }
    case 'review': {
      const rv = await import('./review.js');
      const scope = flags['all-projects'] ? undefined : currentProject(flags).id;
      const sub = pos.shift();
      rv.expireHeld();
      if (!sub || sub === 'ls' || sub === 'list') {
        const rows = rv.inbox({ project: scope, status: typeof flags.status === 'string' ? flags.status : undefined });
        return out(flags.json ? JSON.stringify(rows) : rv.formatInbox(rows));
      }
      if (sub === 'approve-all') {
        const r = rv.approveAll({ project: scope, quarantined: !!flags.quarantined });
        return out(`approved ${r.length}${r.some((x) => x.supersedes.length) ? ' (replaced #' + r.flatMap((x) => x.supersedes).join(' #') + ')' : ''}`);
      }
      if (sub === 'approve' || sub === 'reject') {
        const ids = pos.flatMap((p) => p.split(/[\s,]+/)).filter(Boolean);
        if (!ids.length) throw usage(`usage: sam review ${sub} <id…>`);
        const r = sub === 'approve' ? rv.approve(ids, { project: scope }).map((x) => x.id) : rv.reject(ids, { project: scope, hard: !!flags.hard });
        for (const id of ids.map((i) => i.replace(/^#/, '')).filter((i) => !r.includes(i))) notFound(`#${id} is not in the review inbox`);
        return r.length ? out(`${sub === 'approve' ? 'approved' : 'rejected'} #${r.join(' #')}`) : undefined;
      }
      throw usage('usage: sam review [approve <id…> | reject <id…> [--hard] | approve-all [--quarantined]] [--json]');
    }
    case 'audit': {
      const rv = await import('./review.js');
      rv.expireHeld();
      const a = rv.audit({ project: flags['all-projects'] ? undefined : currentProject(flags).id, days: Number(flags.days) || 30, top: Number(flags.n) || 10 });
      return out(flags.json ? JSON.stringify(a) : rv.formatAudit(a));
    }
    case 'gc': return out(JSON.stringify(gc({ dryRun: !!flags['dry-run'], force: !!flags.force })));
    case 'handoff': case 'handoffs': {
      const { writeHandoff, listHandoffs, handoffRow } = await import('./handoff.js');
      const p = currentProject(flags);
      const note = (pos.join(' ') || (flags['--'] || []).join(' ')).trim();
      if (flags.list || cmd === 'handoffs' || !note) {
        if (!note && !flags.list && cmd !== 'handoffs' && flags.to) throw usage('usage: sam handoff [--to agent] "<note>"');
        const rows = listHandoffs({ project: p, all: !!flags.all, limit: Number(flags.n) || 20 });
        return out(rows.length ? rows.map(handoffRow).join('\n') : 'no ' + (flags.all ? '' : 'open ') + 'handoffs');
      }
      if (note.length < 3) throw usage('handoff note too short');
      const to = typeof flags.to === 'string' ? flags.to : undefined;
      const from = typeof flags.from === 'string' ? flags.from : process.env.SAM_AGENT || 'cli';
      const id = writeHandoff({ project: p, note, to, from, files: flags.files ? String(flags.files).split(',') : [] });
      return out(`handoff ${id} → ${to || 'next other agent'} in ${p.name}`);
    }
    case 'sleep': {
      const { sleep } = await import('./sleep.js');
      const n = (k) => (flags[k] !== undefined && Number.isFinite(Number(flags[k])) ? Number(flags[k]) : undefined);
      return out(JSON.stringify(sleep({ dryRun: !!flags['dry-run'], days: n('days'), eventDays: n('event-days'), drafts: flags.drafts ? true : undefined })));
    }
    case 'skills': {
      if (pos[0] !== 'draft') throw usage('usage: sam skills draft [--min 3] [--dry-run] [--all-projects]');
      const { draftSkills, DRAFTS_DIR } = await import('./skilldraft.js');
      const r = draftSkills({ dryRun: !!flags['dry-run'], min: Number(flags.min) || undefined, project: flags['all-projects'] ? undefined : currentProject(flags).id });
      if (!r.length) return out(`no fix pattern repeated ≥${Number(flags.min) || config().skillDraftMin} times yet`);
      out(r.map((x) => `${flags['dry-run'] ? 'would write' : 'wrote'} ${x.file} (${x.count} fixes)`).join('\n'));
      return out(`drafts only: review, edit, then copy into a skills directory yourself (${DRAFTS_DIR()})`);
    }
    case 'trust': {
      const p = resolveProject(process.cwd());
      if (!p.root) throw new Error('not inside a project (run it inside a git repo, or add a .sam-project file)');
      if (flags.off) { setTrusted(p, false); return out(`untrusted ${p.name}: its .sam/memory.md will not be imported`); }
      const pv = previewTeamFile(p);
      if (!pv) return notFound(`no regular .sam/memory.md in ${p.root} (symlinks are ignored); nothing to trust`);
      out(`${pv.file}: ${pv.count} team memories, e.g.\n` + pv.lines.map((l) => '  ' + l).join('\n') + (pv.count > pv.lines.length ? `\n  … ${pv.count - pv.lines.length} more` : ''));
      // S12: a human decides. An agent running `sam trust` from its shell has no terminal; scripts pass --yes.
      if (!flags.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) { process.exitCode = 1; return out('not trusted: run `sam trust` in a terminal to confirm, or `sam trust --yes`'); }
        const ans = await ask(`Import these into ${p.name} and trust this exact file content? [y/N] `);
        if (!/^y(es)?$/i.test(ans.trim())) return out('not trusted');
      }
      setTrusted(p, true, pv.hash);
      openDb().prepare('DELETE FROM meta WHERE k = ?').run('team:' + p.id); // import the reviewed content now
      return out(`trusted ${p.name} (this content only; later changes need a new review): imported ${syncTeamFile(p)} team memories`);
    }
    case 'export': {
      const p = currentProject(flags);
      if (flags.team) return out('wrote ' + writeTeamFile(p));
      const text = flags.jsonl ? exportJsonl(flags['all-projects'] ? null : p.id) : exportMarkdown(p.id, { includeSessions: !!flags.sessions });
      if (flags.o) { writeFileSync(flags.o, text); return out('wrote ' + flags.o); }
      return out(text);
    }
    case 'import': {
      const file = pos[0];
      if (!file) throw usage('usage: sam import <file.md|file.jsonl>');
      if (!existsSync(file)) throw new Error(`no such file: ${file}`);
      const text = readFileSync(file, 'utf8');
      const pid = currentProject(flags).id;
      const n = file.endsWith('.jsonl') ? importJsonl(text, { projectId: pid, trusted: !!flags.trusted }) : importMarkdown(pid, text, { trusted: !!flags.trusted });
      return out(`imported ${n}${flags.trusted ? '' : ' (untrusted: no pins, kept in this project; --trusted for your own backups)'}`);
    }
    case 'embed': {
      const cfg = config();
      if (!cfg.embedUrl || !cfg.embedModel) { process.exitCode = 1; return out('embeddings are off: set embedUrl and embedModel in ~/.sam/config.json (or SAM_EMBED_URL / SAM_EMBED_MODEL for a localhost endpoint)'); }
      return out(`embedded ${await backfill()} memories (${cfg.embedModel} @ ${cfg.embedUrl})`);
    }
    case 'snippet': return out(genericSnippet());
    case 'skill': return out(SKILL);
    case 'tokens': return out(String(tokens(pos.join(' ') || readFileSync(0, 'utf8'))));
    default:
      throw usage(`unknown command: ${cmd} (run \`sam --help\` for the list)`);
  }
}

function fmtPurge(r) {
  const parts = [['memories', r.memories], ['raw events', r.events], ['first prompts', r.sessions], ['vault outputs', r.vault], ['ledger rows', r.injections], ['handoffs', r.handoffs]]
    .filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  if (r.teamFiles?.length) parts.push(`${r.teamFiles.reduce((a, f) => a + (f.removed || 0), 0)} team-file lines`);
  if (r.tombstones) parts.push(`${r.tombstones} tombstones`);
  return parts.length ? parts.join(', ') : 'nothing found';
}

function ask(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    let s = '';
    process.stdin.setEncoding('utf8');
    const onData = (d) => { s += d; if (s.includes('\n')) { process.stdin.off('data', onData); process.stdin.pause(); resolve(s); } };
    process.stdin.on('data', onData);
    process.stdin.once('end', () => resolve(s));
  });
}

/** `sam doctor --repair`: rebuild FTS, or move a corrupt DB aside and salvage every readable row (#4). */
function repair(dbPath) {
  const msgs = [];
  let h = healthCheck();
  if (h && /fts|mem_fts|mem_tri|vtable|malformed/i.test(h)) {
    try {
      openDb().exec("INSERT INTO mem_fts(mem_fts) VALUES('rebuild'); INSERT INTO mem_tri(mem_tri) VALUES('rebuild');");
      h = healthCheck();
      if (!h) msgs.push('search indexes rebuilt');
    } catch (e) { msgs.push('index rebuild failed: ' + e.message); }
  }
  if (h) {
    closeDb();
    const aside = moveAside(dbPath);
    openDb();
    const r = salvage(aside);
    openDb().prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('salvaged:' + aside, String(Date.now()));
    msgs.push(`DB was damaged (${h.slice(0, 120)}); moved to ${aside} and salvaged ${r.memories?.copied ?? 0} memories (${r.memories?.lostRows ?? 0} unreadable rows lost)`);
  }
  for (const f of corruptCopies(dbPath)) {
    if (openDb().prepare('SELECT 1 FROM meta WHERE k = ?').get('salvaged:' + f)) continue;
    try {
      const r = salvage(f);
      msgs.push(`salvaged ${r.memories?.copied ?? 0} memories from ${f}`);
    } catch (e) { msgs.push(`could not read ${f}: ${e.message}`); }
    openDb().prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('salvaged:' + f, String(Date.now()));
  }
  return msgs.length ? msgs.join('\n') : 'DB healthy: nothing to repair';
}
