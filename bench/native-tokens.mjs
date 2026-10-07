#!/usr/bin/env node
// Measures SAM's own output with each provider's native tokenizer via OpenRouter.
// Usage: OPENROUTER_API_KEY=... node bench/native-tokens.mjs [model ...]
// Count = prompt_tokens(text) - prompt_tokens('x') + 1 (removes the chat-template overhead).
// Ratios in the table are relative to SAM's own estimator (o200k-calibrated).
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-native-'));
process.emitWarning = () => {};
const { saveMemory } = await import('../src/store.js');
const { sessionContext, promptContext } = await import('../src/inject.js');
const { tokens } = await import('../src/text.js');
const { openDb } = await import('../src/db.js');
const mcp = await import('../src/mcp.js');
const db = openDb();
const out = {};
const EN = [
 ['convention','Always use pnpm, never npm, in this repo'],['decision','Chose Postgres over MySQL for billing because of row-level security'],
 ['fact','Staging API runs at https://staging.example.internal; deploy with make deploy-staging'],['fix','vitest OOM on CI fixed by --maxWorkers=2 in package.json test script'],
 ['preference','User prefers short commit messages in imperative mood'],['convention','Wrap every Stripe call in src/payments/lib/stripe.ts'],
 ['decision','Switched from Redux to Zustand for client state (useAuthStore)'],['fact','Integration tests need a local Redis on port 6380'],
 ['todo','Remove the legacy /v1/orders endpoint after the mobile release'],['fix','Prisma migrate failed on CI: set DATABASE_URL to the shadow db first'],
 ['convention','API handlers live in src/api/handlers and return Result<T, AppError>'],['fact','The full e2e suite takes 25 minutes; run only playwright --grep @smoke locally'],
];
const TR = [
 ['convention','Bu repoda her zaman pnpm kullan, asla npm kullanma'],['decision','Faturalama için satır düzeyi güvenlik nedeniyle MySQL yerine Postgres seçildi'],
 ['fact','Test sunucusu https://staging.example.internal adresinde; make deploy-staging ile yayınlanıyor'],['fix','CI üzerindeki vitest bellek hatası package.json test betiğine --maxWorkers=2 eklenerek çözüldü'],
 ['preference','Kullanıcı kısa ve emir kipinde commit mesajlarını tercih ediyor'],['convention','Tüm Stripe çağrılarını src/payments/lib/stripe.ts içinde sarmala'],
 ['decision','İstemci durumu için Redux yerine Zustand kullanılıyor (useAuthStore)'],['fact','Entegrasyon testleri 6380 portunda yerel bir Redis gerektiriyor'],
 ['todo','Mobil sürümden sonra eski /v1/orders uç noktasını kaldır'],['fix','CI üzerinde Prisma migrate hatası: önce DATABASE_URL değişkenini gölge veritabanına ayarla'],
 ['convention','API işleyicileri src/api/handlers altında duruyor ve Result<T, AppError> döndürüyor'],['fact','Tüm uçtan uca test paketi 25 dakika sürüyor; yerelde yalnızca playwright --grep @smoke çalıştır'],
];
for (const [name, rows, prompt] of [['en', EN, 'why does vitest crash with out of memory on CI?'], ['tr', TR, 'CI üzerinde vitest neden bellek hatası veriyor?']]) {
  const project = { id: 'p_' + name, name };
  db.prepare('INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)').run(project.id, name, null, Date.now());
  for (const [kind, text] of rows) saveMemory({ project: project.id, kind, text, source: 'user' });
  const card = sessionContext({ project, session: name + ':s1' });
  const r = await promptContext({ project, session: name + ':s2', prompt });
  out[name + '_card'] = { text: card.text, sam: tokens(card.text) };
  out[name + '_recall'] = { text: r.text || '', sam: tokens(r.text || '') };
  out[name + '_gists'] = { text: rows.map(r => r[1]).join('\n'), sam: tokens(rows.map(r => r[1]).join('\n')) };
}
const T = mcp.TOOLS || mcp.tools || (mcp.listTools && mcp.listTools());
out.mcp_tools = { text: JSON.stringify(T), sam: tokens(JSON.stringify(T)) };

const key = process.env.OPENROUTER_API_KEY;
const models = process.argv.slice(2).length ? process.argv.slice(2)
  : ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash'];
async function count(model, text) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], max_tokens: 16, temperature: 0 }),
  });
  if (!r.ok) throw new Error(model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).usage.prompt_tokens;
}
const rows = Object.entries(out).map(([k, v]) => ({ text: k, sam: v.sam }));
for (const m of models) {
  const base = await count(m, 'x');
  for (const row of rows) { const n = (await count(m, out[row.text].text)) - base + 1; row[m] = `${n} (${(n / row.sam).toFixed(2)}x)`; }
}
console.table(rows);
