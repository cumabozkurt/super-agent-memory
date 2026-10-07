// Optional embeddings via any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenAI…).
// SAM works fully without them; when configured they become a third RRF signal.
import { config } from './config.js';
import { openDb } from './db.js';

export async function embed(texts) {
  const cfg = config();
  if (!cfg.embedUrl || !cfg.embedModel) return [];
  const url = cfg.embedUrl.replace(/\/+$/, '') + (cfg.embedUrl.includes('/embeddings') ? '' : '/embeddings');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.embedKey ? { authorization: 'Bearer ' + cfg.embedKey } : {}) },
      body: JSON.stringify({ model: cfg.embedModel, input: texts }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('embed HTTP ' + res.status);
    const j = await res.json();
    return (j.data || []).map((d) => Float32Array.from(d.embedding));
  } finally {
    clearTimeout(timer);
  }
}

export function packVec(v) { return Buffer.from(new Float32Array(v).buffer); }
export function unpackVec(b) {
  if (!b) return null;
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Backfill embeddings for memories that do not have one yet. */
export async function backfill({ batch = 32, max = 2000 } = {}) {
  const db = openDb();
  let done = 0;
  while (done < max) {
    const rows = db.prepare("SELECT id, gist, body FROM memories WHERE embedding IS NULL AND superseded_by IS NULL LIMIT ?").all(batch);
    if (!rows.length) break;
    const vecs = await embed(rows.map((r) => (r.gist + '\n' + r.body).slice(0, 2000)));
    if (!vecs.length) break;
    rows.forEach((r, i) => vecs[i] && db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(packVec(vecs[i]), r.id));
    done += rows.length;
  }
  return done;
}
