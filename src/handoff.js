// Agent-to-agent handoff records (P1 sharing). LLM-free.
// - At Stop / SessionEnd a handoff is derived from the session: what was done (the digest's intent + counts),
//   what is still open (todos saved in the session, commands whose last run failed) and the touched files.
//   Stop fires after every turn on some hosts, so there is ONE rolling auto-handoff per session.
// - `sam handoff [--to agent] "note"` writes one by hand.
// - At the next SessionStart in the same project by a DIFFERENT agent (or by the agent named in --to), the newest
//   unconsumed handoff is surfaced once as one factual line (≤ handoffMaxTokens) and marked consumed.
import { openDb, tx } from './db.js';
import { config } from './config.js';
import { tokens, escCard, sha, oneLine, gistOf, compactPaths, truncate, redact, sanitize, newId, now } from './text.js';

const DAY = 86400000;
const AUTO = (session) => 'h' + sha('auto:' + session, 10);
const cleanAgent = (a) => (String(a || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32) || null);
const clean = (s, n) => truncate(redact(oneLine(sanitize(String(s || '')))), n);

/** Derive { summary, open[], files[] } from a session's events and memories, or null when there is nothing to hand off. */
export function deriveHandoff(session) {
  if (!session) return null;
  const db = openDb();
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session);
  if (!s) return null;
  const evs = db.prepare("SELECT id, type, subject, ok, detail FROM events WHERE session = ? AND type IN ('prompt','edit','cmd') ORDER BY id").all(session);
  const edits = [...new Set(evs.filter((e) => e.type === 'edit' && e.subject).map((e) => e.subject))];
  // a command whose LAST run in this session failed is still open (only the command, never its output: S6)
  const lastRun = new Map();
  for (const e of evs) if (e.type === 'cmd' && e.subject && e.ok != null) lastRun.set(e.subject, e.ok);
  const failing = [...lastRun].filter(([, ok]) => !ok).map(([c]) => `\`${truncate(c, 40)}\` failing`);
  const todos = db.prepare("SELECT gist FROM memories WHERE session = ? AND kind = 'todo' AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT 3").all(session).map((r) => r.gist);
  const fixes = db.prepare("SELECT COUNT(*) c FROM memories WHERE session = ? AND kind = 'fix'").get(session).c;
  const open = [...todos, ...failing].slice(0, 4);
  if (!edits.length && !open.length) return null;
  // intent: the digest gist without its date / counts, else the first prompt
  const digest = s.digest_id ? db.prepare('SELECT gist FROM memories WHERE id = ?').get(s.digest_id)?.gist : '';
  const firstPrompt = s.first_prompt || evs.find((e) => e.type === 'prompt')?.detail || '';
  let intent = digest ? digest.replace(/^\d\d-\d\d\s+/, '').replace(/\s*→.*$/, '') : gistOf(firstPrompt, 70);
  if (!intent || intent === 'session') intent = 'worked';
  const did = [edits.length ? `${edits.length} edit${edits.length > 1 ? 's' : ''}` : '', fixes ? `${fixes} fix` : ''].filter(Boolean).join(', ');
  return { summary: clean(intent + (did ? ` (${did})` : ''), 160), open, files: edits.slice(0, 12) };
}

/** Upsert the session's rolling auto-handoff. A changed handoff becomes unconsumed again. */
export function autoHandoff({ session, project, agent }) {
  if (!session || !project?.id || config().handoff === false) return null;
  const h = deriveHandoff(session);
  if (!h) return null;
  const id = AUTO(session);
  const open = h.open.map((o) => clean(o, 120)).join('\n');
  const files = h.files.join(' ');
  return tx((db) => {
    const cur = db.prepare('SELECT summary, open_items, files FROM handoffs WHERE id = ?').get(id);
    if (cur && cur.summary === h.summary && cur.open_items === open && cur.files === files) return { id, status: 'unchanged' };
    if (cur) {
      db.prepare('UPDATE handoffs SET summary = ?, open_items = ?, files = ?, created_at = ?, consumed_at = NULL WHERE id = ?').run(h.summary, open, files, now(), id);
      return { id, status: 'updated' };
    }
    db.prepare('INSERT INTO handoffs(id, project, from_agent, to_agent, session, summary, open_items, files, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(id, project.id, cleanAgent(agent), session, h.summary, open, files, now());
    return { id, status: 'created' };
  });
}

/** A manual handoff (`sam handoff [--to agent] "note"`). */
export function writeHandoff({ project, note, to, from = 'cli', session = null, open = [], files = [] }) {
  const summary = clean(note, 300);
  if (summary.length < 3) throw new Error('handoff note too short');
  const id = 'h' + newId(8);
  openDb().prepare('INSERT INTO handoffs(id, project, from_agent, to_agent, session, summary, open_items, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, project.id, cleanAgent(from), cleanAgent(to), session, summary, open.map((o) => clean(o, 120)).join('\n'), files.join(' '), now());
  return id;
}

/** The handoff the given agent should see now (not consumed, not its own unless addressed to it, not stale). */
export function pendingHandoff({ project, agent, session = null }) {
  const a = cleanAgent(agent);
  return openDb().prepare(
    `SELECT * FROM handoffs WHERE project = ? AND consumed_at IS NULL AND created_at > ? AND COALESCE(session, '') != ?
       AND (to_agent = ? OR (to_agent IS NULL AND COALESCE(from_agent, '') != ?))
     ORDER BY (to_agent IS NOT NULL) DESC, created_at DESC, id LIMIT 1`
  ).get(project.id, now() - (config().handoffMaxAgeDays ?? 14) * DAY, session || '', a || '', a || '') || null;
}

const md = (ms) => { const d = new Date(ms); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };

/** One factual line, ≤ maxTokens including the wrapper. Handoff text is data: escaped like card lines. */
export function formatHandoff(h, { maxTokens = config().handoffMaxTokens ?? 60, wrap = true } = {}) {
  const head = `handoff from ${escCard(h.from_agent || 'agent')} ${md(h.created_at)}: `;
  const open = (h.open_items || '').split('\n').filter(Boolean);
  const files = (h.files || '').split(' ').filter(Boolean);
  const pre = wrap ? '<memory handoff>\n' : '', post = wrap ? '\n</memory>' : '';
  const build = (sum, nOpen, nFiles) => pre + head + escCard(sum) +
    (nOpen ? ' · open: ' + escCard(open.slice(0, nOpen).join('; ')) : '') +
    (nFiles ? ' · files: ' + escCard(compactPaths(files, nFiles)) : '') + post;
  // shed detail until it fits: files, then open items, then the summary itself
  for (const [nOpen, nFiles] of [[2, 3], [2, 2], [1, 2], [1, 1], [1, 0], [0, 0]]) {
    const t = build(h.summary, Math.min(nOpen, open.length), Math.min(nFiles, files.length));
    if (tokens(t) <= maxTokens) return t;
  }
  let sum = h.summary;
  while (sum.length > 8) {
    sum = gistOf(sum, Math.floor(sum.length * 0.8));
    const t = build(sum, 0, 0);
    if (tokens(t) <= maxTokens) return t;
  }
  return '';
}

/**
 * SessionStart: the line to show this agent (or '') and mark it consumed. `write` is the hook's guarded writer:
 * when the DB is locked the line is still shown and simply shows again next time.
 */
export function takeHandoff({ project, agent, session = null, write = (fn) => fn(), wrap = true }) {
  if (config().handoff === false || !project?.id) return '';
  let h;
  try { h = pendingHandoff({ project, agent, session }); } catch { return ''; } // never cost the host its card
  if (!h) return '';
  const text = formatHandoff(h, { wrap });
  if (text) write(() => openDb().prepare('UPDATE handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now(), h.id));
  return text;
}

/** Recent handoffs of a project (newest first). */
export function listHandoffs({ project, all = false, limit = 20 } = {}) {
  return openDb().prepare(
    `SELECT * FROM handoffs WHERE ${project ? 'project = ?' : '1=1'} ${all ? '' : 'AND consumed_at IS NULL'} ORDER BY created_at DESC LIMIT ?`
  ).all(...(project ? [project.id] : []), limit);
}

export function handoffRow(h) {
  const st = h.consumed_at ? `consumed ${new Date(h.consumed_at).toISOString().slice(0, 16).replace('T', ' ')}Z` : 'open';
  const who = `${h.from_agent || '?'} → ${h.to_agent || 'any other agent'}`;
  const open = h.open_items ? `\n  open: ${h.open_items.split('\n').join('; ')}` : '';
  const files = h.files ? `\n  files: ${compactPaths(h.files.split(' '), 6)}` : '';
  return `${h.id} ${new Date(h.created_at).toISOString().slice(0, 16).replace('T', ' ')}Z ${who} [${st}]\n  ${escCard(h.summary)}${escCard(open)}${escCard(files)}`;
}
