// Coding-eval task set: memory-necessary pairs (session 1 plants a fact, session 2 needs it) and a harm set
// (the prompt fully specifies the answer; a near-miss or contradicting memory sits in the store).
//
// Fields
//   id, lang (en|tr), set ('pair'|'harm'), type (convention|library|quirk|fix|update|near-miss|override|generic)
//   s1    what happened in session 1 (documentation; the memory is what SAM would have kept from it)
//   mem   memories this session 1 left in the store: { kind, text, source, age (days) }. Rows with stale:true are an
//         older value that a newer row replaces (knowledge update), saved first.
//   prompt  the session-2 task as the user types it
//   err   (fix tasks) the realistic failure the environment produces when the remembered fix is missing; the test
//         prints exactly this instead of an assertion diff, so a retry sees what a developer would see
//   test  body of test.mjs (helpers: SRC = solution source, S = solution module, fail(msg), assert)
//   ref   reference solution (must pass); naive: a plausible memory-less solution (must fail, pairs only)
export const TASKS = [
  // ───────────────────────────── memory-necessary pairs ─────────────────────────────
  {
    id: 'pnpm', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "we use pnpm in this repo, and CI must install with the frozen lockfile."',
    mem: [{ kind: 'convention', text: 'package manager: pnpm (never npm or yarn); CI installs with `pnpm install --frozen-lockfile`', source: 'user', age: 120 }],
    prompt: 'Write `ciInstallCommand()` that returns the shell command our CI job should use to install dependencies.',
    test: `const c = String(S.ciInstallCommand()).trim();
if (!/^pnpm (install|i) .*--frozen-lockfile/.test(c) && !/^pnpm (install|i) --frozen-lockfile$/.test(c)) fail('wrong install command: ' + c);`,
    ref: `export const ciInstallCommand = () => 'pnpm install --frozen-lockfile';`,
    naive: `export const ciInstallCommand = () => 'npm ci';`,
  },
  {
    id: 'money-type', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "never use floats for money. Use our Money type from money.js: money(kurus, currency) gives {amount: bigint, currency}."',
    mem: [{ kind: 'convention', text: 'Money values: use the Money type from ./money.js — money(kuruş, currency) → { amount: bigint kuruş, currency }; never floats for money', source: 'user', age: 200 }],
    prompt: 'Write `sumMoney(values)` that sums a list of our money values (all the same currency) and returns a money value.',
    test: `import { money, isMoney } from './money.js';
const r = S.sumMoney([money(1999), money(1), money(250000)]);
if (!isMoney(r)) fail('result is not a Money value: ' + String(r && JSON.stringify(r, (k, v) => typeof v === 'bigint' ? v + 'n' : v)));
assert.equal(r.amount, 252000n); assert.equal(r.currency, 'TRY');`,
    ref: `import { money } from './money.js';
export const sumMoney = (vs) => vs.reduce((a, v) => money(a.amount + v.amount, v.currency), money(0, vs[0]?.currency ?? 'TRY'));`,
    naive: `export const sumMoney = (vs) => vs.reduce((a, v) => a + v, 0);`,
  },
  {
    id: 'vitest-forks', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed a segfault: sqlite-backed tests crash under vitest worker threads; running with --pool=forks fixed it.',
    mem: [{ kind: 'fix', text: 'vitest segfault (SIGSEGV in worker thread) on the sqlite tests → better-sqlite3 is not thread-safe in workers → always run vitest with `--pool=forks`', source: 'agent', age: 45 }],
    prompt: 'Write `testCommand(file)` returning the command that runs a single vitest test file in this repo (e.g. for `src/db/orders.test.ts`).',
    err: 'Segmentation fault (core dumped)\n tinypool worker exited with signal SIGSEGV while running src/db/orders.test.ts',
    test: `const c = String(S.testCommand('src/db/orders.test.ts'));
if (!c.includes('src/db/orders.test.ts')) fail('file not in command: ' + c);
if (!/vitest/.test(c)) fail('not a vitest command: ' + c);
if (!/--pool[= ]forks/.test(c)) fail(ERR);`,
    ref: `export const testCommand = (f) => 'pnpm vitest run --pool=forks ' + f;`,
    naive: `export const testCommand = (f) => 'npx vitest run ' + f;`,
  },
  {
    id: 'migration-lock', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed a flaky migration: index creation on orders deadlocked in CI. Fix: SET lock_timeout = \'5s\' first and CREATE INDEX CONCURRENTLY outside a transaction.',
    mem: [{ kind: 'fix', text: "flaky index migration (deadlock detected / lock wait in CI) → fix: first `SET lock_timeout = '5s'`, then `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, never inside BEGIN/COMMIT", source: 'agent', age: 60 }],
    prompt: 'Write `addIndexMigration(table, column)` returning the array of SQL statements (in order) for a migration that adds an index on that column. Last time this kind of migration was flaky in CI, so apply the fix we found.',
    err: 'ERROR:  deadlock detected\nDETAIL:  Process 4121 waits for ShareLock on relation 16502 of database 16384; blocked by process 4093.\nmigration 0057_add_index failed (flaky in CI)',
    test: `const st = S.addIndexMigration('orders', 'customer_id').map(String);
const all = st.join(';\\n');
if (!/create index/i.test(all) || !/orders/.test(all) || !/customer_id/.test(all)) fail('no index statement: ' + all);
const i = st.findIndex((s) => /lock_timeout\\s*=\\s*'?5s'?/i.test(s));
const j = st.findIndex((s) => /create index concurrently/i.test(s));
if (i < 0 || j < 0 || i > j || /\\bbegin\\b/i.test(all)) fail(ERR);`,
    ref: `export const addIndexMigration = (t, c) => ["SET lock_timeout = '5s'", \`CREATE INDEX CONCURRENTLY IF NOT EXISTS \${t}_\${c}_idx ON \${t} (\${c})\`];`,
    naive: `export const addIndexMigration = (t, c) => ['BEGIN', \`CREATE INDEX \${t}_\${c}_idx ON \${t} (\${c})\`, 'COMMIT'];`,
  },
  {
    id: 'tr-error-prefix', lang: 'tr', set: 'pair', type: 'convention',
    s1: 'Kullanıcı: "kullanıcıya dönen hata mesajları Türkçe olsun ve HATA-<kod>: önekiyle başlasın, ör. HATA-TCKN: ..."',
    mem: [{ kind: 'convention', text: "Kullanıcıya dönen hata mesajları Türkçe ve 'HATA-<KOD>: ' önekiyle başlar (ör. 'HATA-TCKN: geçersiz kimlik numarası')", source: 'user', age: 150 }],
    prompt: '`validateTckn(s)` fonksiyonunu yaz: 11 haneli değilse ya da 0 ile başlıyorsa bizim kurallarımıza uygun bir mesajla Error fırlatsın, geçerliyse true dönsün.',
    test: `assert.equal(S.validateTckn('10000000146'), true);
let e; try { S.validateTckn('0123'); } catch (x) { e = x; }
if (!e) fail('no error thrown');
if (!/^HATA-[A-ZÇĞİÖŞÜ0-9_]+: /.test(e.message)) fail('message format: ' + e.message);`,
    ref: `export function validateTckn(s) { if (!/^[1-9]\\d{10}$/.test(s)) throw new Error('HATA-TCKN: geçersiz kimlik numarası'); return true; }`,
    naive: `export function validateTckn(s) { if (!/^[1-9]\\d{10}$/.test(s)) throw new Error('Geçersiz TC kimlik numarası'); return true; }`,
  },
  {
    id: 'iso-no-ms', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "API timestamps are UTC ISO strings without milliseconds, like 2026-01-02T03:04:05Z."',
    mem: [{ kind: 'convention', text: 'API timestamps: UTC ISO-8601 without milliseconds, e.g. 2026-01-02T03:04:05Z (strip the .sss)', source: 'user', age: 90 }],
    prompt: 'Write `serializeEvent(e)` that turns `{ name, at: Date }` into the JSON-ready object our API returns (`{ name, at }` with `at` formatted the way our API formats timestamps).',
    test: `const r = S.serializeEvent({ name: 'x', at: new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)) });
assert.equal(r.name, 'x'); assert.equal(r.at, '2026-01-02T03:04:05Z');`,
    ref: `export const serializeEvent = (e) => ({ name: e.name, at: e.at.toISOString().replace(/\\.\\d{3}Z$/, 'Z') });`,
    naive: `export const serializeEvent = (e) => ({ name: e.name, at: e.at.toISOString() });`,
  },
  {
    id: 'logger', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "no console.log in app code. Use log from ./log.js: log.info(event, fields), event names snake_case."',
    mem: [{ kind: 'convention', text: 'Logging: never console.log; use `log` from ./log.js as log.info(event, fields) with snake_case event names (e.g. payment_retry_scheduled)', source: 'user', age: 180 }],
    prompt: 'Write `scheduleRetry(job, attempt)` that returns `{ jobId: job.id, runAt: Date.now() + 1000 * 2 ** attempt }` and logs that a retry was scheduled, following our logging rules.',
    test: `const L = await import('./log.js');
const r = S.scheduleRetry({ id: 'j1' }, 2);
assert.equal(r.jobId, 'j1');
if (/console\\.log/.test(SRC)) fail('uses console.log');
if (!L.calls.length) fail('nothing logged via ./log.js');
if (!/^[a-z]+(_[a-z0-9]+)+$/.test(L.calls[0][1])) fail('event name not snake_case: ' + L.calls[0][1]);`,
    ref: `import { log } from './log.js';
export function scheduleRetry(job, attempt) { const r = { jobId: job.id, runAt: Date.now() + 1000 * 2 ** attempt }; log.info('job_retry_scheduled', { ...r, attempt }); return r; }`,
    naive: `export function scheduleRetry(job, attempt) { const r = { jobId: job.id, runAt: Date.now() + 1000 * 2 ** attempt }; console.log('Retry scheduled', r); return r; }`,
  },
  {
    id: 'ids', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "IDs come from newId(prefix) in ./ids.js, prefixed ULIDs like ord_01J…; no uuid."',
    mem: [{ kind: 'convention', text: "Entity IDs: newId('<prefix>') from ./ids.js (prefixed ULID, orders use 'ord'); never uuid or crypto.randomUUID", source: 'user', age: 210 }],
    prompt: 'Write `createOrder(input)` that returns a new order object `{ id, ...input, status: "pending" }` with a fresh id generated the way we generate ids.',
    test: `const o = S.createOrder({ total: 1 });
assert.equal(o.status, 'pending'); assert.equal(o.total, 1);
if (!/^ord_01J/.test(String(o.id))) fail('id not from newId("ord"): ' + o.id);`,
    ref: `import { newId } from './ids.js';
export const createOrder = (input) => ({ id: newId('ord'), ...input, status: 'pending' });`,
    naive: `import { randomUUID } from 'node:crypto';
export const createOrder = (input) => ({ id: randomUUID(), ...input, status: 'pending' });`,
  },
  {
    id: 'parasut-retry-after', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent found the Paraşüt API sends Retry-After in milliseconds; treating it as seconds made the sync sleep for hours.',
    mem: [{ kind: 'fix', text: 'Paraşüt sync hung for ~25 min after a 429 → their Retry-After header is in MILLISECONDS, not seconds → use the value as-is', source: 'agent', age: 30 }],
    prompt: 'Write `parasutRetryDelayMs(headers)` that returns how many milliseconds to wait after a 429 from the Paraşüt API, given a plain headers object (lower-case keys).',
    err: 'parasut sync: worker sleeping 1500000 ms after 429 (Retry-After: 1500); job exceeded 30 min timeout',
    test: `const v = S.parasutRetryDelayMs({ 'retry-after': '1500' });
if (v !== 1500) fail(ERR);`,
    ref: `export const parasutRetryDelayMs = (h) => Number(h['retry-after']);`,
    naive: `export const parasutRetryDelayMs = (h) => Number(h['retry-after']) * 1000;`,
  },
  {
    id: 'billing-cursor', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed an infinite pagination loop: the billing API marks the last page with next_cursor "" (empty string), never null.',
    mem: [{ kind: 'fix', text: 'billing API pagination looped forever → last page has next_cursor: "" (empty string), never null/undefined → stop when !next_cursor', source: 'agent', age: 75 }],
    prompt: 'Write `async fetchAllInvoices(getPage)` where `getPage(cursor)` calls our billing API and resolves `{ items, next_cursor }`; start with cursor `null` and return all items from all pages.',
    err: 'Error: billing API: 400 invalid cursor "" (request #3 after last page) — fetchAllInvoices kept paginating',
    test: `const pages = { null: { items: [1, 2], next_cursor: 'c2' }, c2: { items: [3], next_cursor: '' } };
let n = 0;
const r = await S.fetchAllInvoices(async (c) => { if (++n > 2) fail(ERR); const p = pages[String(c)]; if (!p) fail(ERR); return p; });
assert.deepEqual(r, [1, 2, 3]);`,
    ref: `export async function fetchAllInvoices(get) { const out = []; let c = null; do { const p = await get(c); out.push(...p.items); c = p.next_cursor; } while (c); return out; }`,
    naive: `export async function fetchAllInvoices(get) { const out = []; let c = null; do { const p = await get(c); out.push(...p.items); c = p.next_cursor; } while (c !== null && c !== undefined); return out; }`,
  },
  {
    id: 'valibot', lang: 'en', set: 'pair', type: 'library',
    s1: 'User: "we picked valibot for validation, not zod — smaller bundle."',
    mem: [{ kind: 'decision', text: 'validation library: valibot (chosen over zod for bundle size); import * as v from "valibot"', source: 'user', age: 160 }],
    prompt: 'Write a module exporting `UserSchema` for `{ email: string (email), age: number >= 18 }` using our validation library.',
    test: `if (!/from\\s+['"]valibot['"]/.test(SRC)) fail('not using valibot');
if (/['"]zod['"]|['"]yup['"]|['"]joi['"]/.test(SRC)) fail('uses another validation library');
if (!/UserSchema/.test(SRC)) fail('no UserSchema');`,
    noImport: true,
    ref: `import * as v from 'valibot';
export const UserSchema = v.object({ email: v.pipe(v.string(), v.email()), age: v.pipe(v.number(), v.minValue(18)) });`,
    naive: `import { z } from 'zod';
export const UserSchema = z.object({ email: z.string().email(), age: z.number().min(18) });`,
  },
  {
    id: 'ky-client', lang: 'en', set: 'pair', type: 'library',
    s1: 'User: "use the shared ky instance `api` from ./http.js; paths have no leading slash (prefixUrl)."',
    mem: [
      { kind: 'decision', text: 'HTTP client: axios via ./axios.js', source: 'user', age: 400, stale: true },
      { kind: 'decision', text: 'HTTP client: ky instead of axios — shared instance `api` from ./http.js, paths without a leading slash (prefixUrl), e.g. api.get(`users/${id}`).json()', source: 'user', age: 100 },
    ],
    prompt: 'Write `async getUser(id)` that fetches a user from our backend (`users/:id`) with our HTTP client and returns the parsed JSON.',
    test: `const H = await import('./http.js');
let r; try { r = await S.getUser(42); } catch (e) { fail('getUser threw: ' + e.message); }
if (!H.calls.length) fail('did not use api from ./http.js');
assert.equal(H.calls[0][1], 'users/42'); assert.equal(r.id, 42);`,
    ref: `import { api } from './http.js';
export const getUser = (id) => api.get(\`users/\${id}\`).json();`,
    naive: `import axios from 'axios';
export const getUser = async (id) => (await axios.get('/users/' + id)).data;`,
  },
  {
    id: 'feature-flag', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "flags: flags.isOn(name) from ./flags.js, flag names kebab-case with ff- prefix (ff-new-checkout)."',
    mem: [{ kind: 'convention', text: "Feature flags: flags.isOn('<name>') from ./flags.js; flag names are kebab-case with an 'ff-' prefix", source: 'user', age: 140 }],
    prompt: 'Write `checkoutVersion()` that returns "v2" when the "new checkout" feature flag is on, otherwise "v1".',
    test: `const F = await import('./flags.js');
const v = S.checkoutVersion();
if (!F.calls.length) fail('did not use flags.isOn');
assert.equal(F.calls[0], 'ff-new-checkout'); assert.equal(v, 'v2');`,
    ref: `import { flags } from './flags.js';
export const checkoutVersion = () => (flags.isOn('ff-new-checkout') ? 'v2' : 'v1');`,
    naive: `export const checkoutVersion = () => (process.env.NEW_CHECKOUT === 'true' ? 'v2' : 'v1');`,
  },
  {
    id: 'tr-currency-format', lang: 'tr', set: 'pair', type: 'convention',
    s1: 'Kullanıcı: "tutarlar kuruş cinsinden integer; ekranda 1.234,50 TL formatı, ₺ işareti yok."',
    mem: [{ kind: 'convention', text: 'Tutarlar kuruş cinsinden integer tutulur; ekranda format `1.234,50 TL` (nokta binlik, virgül ondalık, sonda boşluk + TL; ₺ kullanılmaz)', source: 'user', age: 130 }],
    prompt: '`formatTutar(tutar)` fonksiyonunu yaz: bir tutarı ekranda bizim formatımızla gösterilecek string\'e çevirsin.',
    test: `assert.equal(S.formatTutar(123450), '1.234,50 TL'); assert.equal(S.formatTutar(5), '0,05 TL');`,
    ref: `export function formatTutar(k) { const s = (k / 100).toFixed(2).split('.'); return s[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.') + ',' + s[1] + ' TL'; }`,
    naive: `export const formatTutar = (t) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(t);`,
  },
  {
    id: 'config-get', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "never read process.env directly; config.get(KEY) from ./config.js."',
    mem: [{ kind: 'convention', text: 'Configuration: read settings only through config.get(KEY) from ./config.js; never process.env directly', source: 'user', age: 220 }],
    prompt: 'Write `databaseUrl()` that returns the database connection URL (setting DATABASE_URL).',
    test: `const C = await import('./config.js');
if (/process\\.env/.test(SRC)) fail('reads process.env');
assert.equal(S.databaseUrl(), 'postgres://shop:pw@db:5432/shop'); assert.ok(C.reads.includes('DATABASE_URL'));`,
    ref: `import { config } from './config.js';
export const databaseUrl = () => config.get('DATABASE_URL');`,
    naive: `export const databaseUrl = () => process.env.DATABASE_URL;`,
  },
  {
    id: 'cutoff-istanbul', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "same-day shipping cut-off is 17:00 Istanbul time, regardless of server timezone."',
    mem: [{ kind: 'decision', text: 'Shipping cut-off: orders placed at or after 17:00 Europe/Istanbul time (UTC+3, no DST) ship next business day', source: 'user', age: 110 }],
    prompt: 'Write `isAfterCutoff(date)` that tells whether an order placed at `date` (a JS Date) missed the same-day shipping cut-off.',
    test: `assert.equal(S.isAfterCutoff(new Date('2026-03-02T14:30:00Z')), true);
assert.equal(S.isAfterCutoff(new Date('2026-03-02T13:59:00Z')), false);
assert.equal(S.isAfterCutoff(new Date('2026-03-02T16:30:00Z')), true);`,
    ref: `export const isAfterCutoff = (d) => ((d.getUTCHours() + 3) % 24) >= 17;`,
    naive: `export const isAfterCutoff = (d) => d.getHours() >= 17;`,
  },
  {
    id: 'app-error', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "throw AppError(code, message) from ./errors.js; codes SCREAMING_SNAKE_CASE."',
    mem: [{ kind: 'convention', text: 'Errors: throw new AppError(CODE, message) from ./errors.js with SCREAMING_SNAKE_CASE codes (e.g. INVALID_PORT); no bare Error', source: 'user', age: 170 }],
    prompt: 'Write `parsePort(s)` that returns the port as a number, or throws (our way) when it is not an integer between 1 and 65535.',
    test: `const { AppError } = await import('./errors.js');
assert.equal(S.parsePort('8080'), 8080);
let e; try { S.parsePort('99999'); } catch (x) { e = x; }
if (!(e instanceof AppError)) fail('not an AppError: ' + e);
if (!/^[A-Z][A-Z0-9_]+$/.test(e.code)) fail('bad code ' + e.code);`,
    ref: `import { AppError } from './errors.js';
export function parsePort(s) { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new AppError('INVALID_PORT', 'invalid port ' + s); return n; }`,
    naive: `export function parsePort(s) { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new RangeError('Invalid port'); return n; }`,
  },
  {
    id: 'esm-js-ext', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed ERR_MODULE_NOT_FOUND in the ESM build: relative imports need explicit .js extensions.',
    mem: [{ kind: 'fix', text: 'ERR_MODULE_NOT_FOUND "Cannot find module ./x" in the ESM build → Node ESM needs explicit extensions → always write relative imports with the .js extension', source: 'agent', age: 50 }],
    prompt: 'Write a module exporting `slugify(s)` (lower-case, spaces and punctuation to single dashes, trimmed dashes) that reuses `toAscii` from our `text` module in the same folder.',
    err: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/text' imported from /app/src/slugify.js\nDid you mean to import \"./text.js\"?",
    test: `const imps = [...SRC.matchAll(/from\\s+['"](\\.{1,2}\\/[^'"]+)['"]/g)].map((m) => m[1]);
if (!imps.length) fail('does not import ./text');
if (imps.some((p) => !/\\.(m?js)$/.test(p))) fail(ERR);
assert.equal(S.slugify('  Çok Güzel  Ürün! '), 'cok-guzel-urun');`,
    ref: `import { toAscii } from './text.js';
export const slugify = (s) => toAscii(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');`,
    naive: `import { toAscii } from './text';
export const slugify = (s) => toAscii(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');`,
  },
  {
    id: 'retry-policy', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User decided the HTTP retry policy: max 3 attempts total, retry only 502/503/504, never 500.',
    mem: [{ kind: 'decision', text: 'HTTP retry policy: at most 3 attempts in total; retry only on 502, 503, 504 (never on 500 or 4xx)', source: 'user', age: 95 }],
    prompt: 'Write `shouldRetry(status, attempt)` for our outbound HTTP calls, where `attempt` is the number of attempts already made (1 after the first call).',
    test: `assert.equal(S.shouldRetry(503, 1), true); assert.equal(S.shouldRetry(504, 2), true);
assert.equal(S.shouldRetry(503, 3), false); assert.equal(S.shouldRetry(500, 1), false); assert.equal(S.shouldRetry(429, 1), false);`,
    ref: `export const shouldRetry = (s, a) => a < 3 && [502, 503, 504].includes(s);`,
    naive: `export const shouldRetry = (s, a) => a < 5 && (s >= 500 || s === 429);`,
  },
  {
    id: 'vat-half-even', lang: 'en', set: 'pair', type: 'decision',
    s1: 'Accountant rule recorded by user: KDV is computed per invoice line and rounded half-even to the kuruş, then summed.',
    mem: [{ kind: 'decision', text: "KDV (VAT): compute per invoice line in kuruş and round each line half-even (banker's rounding), then sum; never round only the invoice total", source: 'user', age: 125 }],
    prompt: 'Write `invoiceVat(lineNets, ratePercent)` where `lineNets` are integer kuruş amounts; return the total KDV in kuruş as our accountant requires.',
    test: `assert.equal(S.invoiceVat([25, 25, 25], 10), 6);
assert.equal(S.invoiceVat([45], 10), 4);
assert.equal(S.invoiceVat([1000], 20), 200);`,
    ref: `const he = (x) => { const f = Math.floor(x), d = x - f; if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1; return Math.round(x); };
export const invoiceVat = (ls, r) => ls.reduce((a, n) => a + he(n * r / 100), 0);`,
    naive: `export const invoiceVat = (ls, r) => Math.round(ls.reduce((a, n) => a + n, 0) * r / 100);`,
  },
  {
    id: 'tr-phone-e164', lang: 'tr', set: 'pair', type: 'convention',
    s1: 'Kullanıcı: "telefonlar veritabanında E.164 olarak tutulur: +905321234567."',
    mem: [{ kind: 'convention', text: 'Telefon numaraları veritabanında E.164 formatında saklanır: +90 ile başlar, boşluksuz (ör. +905321234567)', source: 'user', age: 190 }],
    prompt: '`telefonNormalize(s)` yaz: kullanıcının girdiği numarayı (ör. "0532 123 45 67" ya da "532-123-4567") veritabanına kaydedeceğimiz biçime çevirsin.',
    test: `assert.equal(S.telefonNormalize('0532 123 45 67'), '+905321234567');
assert.equal(S.telefonNormalize('532-123-4567'), '+905321234567');`,
    ref: `export const telefonNormalize = (s) => '+90' + String(s).replace(/\\D/g, '').replace(/^(90|0)/, '').slice(-10);`,
    naive: `export const telefonNormalize = (s) => { const d = String(s).replace(/\\D/g, ''); return d.startsWith('0') ? d : '0' + d; };`,
  },
  {
    id: 'soft-delete', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "we never DELETE rows; soft delete by setting deleted_at = now()."',
    mem: [{ kind: 'convention', text: 'Never hard-DELETE business rows; soft delete with UPDATE … SET deleted_at = now()', source: 'user', age: 230 }],
    prompt: 'Write `deleteCustomerSql(id)` returning `{ text, values }` (parameterized SQL, $1 placeholder) that deletes a customer from the `customer` table.',
    test: `const q = S.deleteCustomerSql(7);
if (/\\bdelete\\s+from\\b/i.test(q.text)) fail('hard delete: ' + q.text);
if (!/update\\s+"?customer"?\\s+set\\s+"?deleted_at"?\\s*=\\s*(now\\(\\)|current_timestamp)/i.test(q.text)) fail('not a soft delete: ' + q.text);
assert.deepEqual(q.values, [7]);`,
    ref: `export const deleteCustomerSql = (id) => ({ text: 'UPDATE customer SET deleted_at = now() WHERE id = $1', values: [id] });`,
    naive: `export const deleteCustomerSql = (id) => ({ text: 'DELETE FROM customer WHERE id = $1', values: [id] });`,
  },
  {
    id: 'table-naming', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "table names are singular snake_case: order_item, not order_items/OrderItems."',
    mem: [{ kind: 'convention', text: 'DB naming: table names are singular snake_case (order_item, not order_items), columns snake_case, PK column id', source: 'user', age: 240 }],
    prompt: 'Write `createOrderItemsTableSql()` returning the CREATE TABLE statement for order line items (id, order id, product id, quantity).',
    test: `const s = String(S.createOrderItemsTableSql());
if (!/create table (if not exists )?"?order_item"?\\s*\\(/i.test(s)) fail('table name: ' + s.slice(0, 80));
if (!/\\border_id\\b/.test(s) || !/\\bproduct_id\\b/.test(s)) fail('columns');`,
    ref: `export const createOrderItemsTableSql = () => 'CREATE TABLE order_item (id bigserial PRIMARY KEY, order_id bigint NOT NULL, product_id bigint NOT NULL, quantity int NOT NULL)';`,
    naive: `export const createOrderItemsTableSql = () => 'CREATE TABLE order_items (id SERIAL PRIMARY KEY, order_id INT, product_id INT, quantity INT)';`,
  },
  {
    id: 'cache-key-update', lang: 'en', set: 'pair', type: 'update',
    s1: 'Cache key prefix was v2; after the schema change the user bumped it to v3 (session 1b).',
    mem: [
      { kind: 'decision', text: 'Cache keys: v2:<entity>:<id>, TTL 300 s', source: 'user', age: 300, stale: true },
      { kind: 'decision', text: 'Cache key prefix bumped to v3 after the product schema change: keys are now v3:<entity>:<id> (TTL still 300 s)', source: 'user', age: 20 },
    ],
    prompt: 'Write `cacheKey(entity, id)` that builds the Redis cache key for an entity, following our current key format.',
    test: `assert.equal(S.cacheKey('product', 7), 'v3:product:7');`,
    ref: `export const cacheKey = (e, id) => \`v3:\${e}:\${id}\`;`,
    naive: `export const cacheKey = (e, id) => \`\${e}:\${id}\`;`,
  },
  {
    id: 'kargo-grams', lang: 'en', set: 'pair', type: 'quirk',
    s1: 'Agent learned the Kargo API rejects numbers: weight must be grams as a string ("1500").',
    mem: [{ kind: 'fact', text: 'Kargo API quirk: weight must be in grams as a STRING (e.g. "1500"); numbers or kg are rejected with 422', source: 'agent', age: 80 }],
    prompt: 'Write `buildShipment(order)` that maps `{ id, weightKg, city }` to the request body for the Kargo API: `{ reference, weight, city }`.',
    test: `const b = S.buildShipment({ id: 'ord_1', weightKg: 1.5, city: 'İzmir' });
assert.equal(b.reference, 'ord_1'); assert.equal(b.city, 'İzmir'); assert.strictEqual(b.weight, '1500');`,
    ref: `export const buildShipment = (o) => ({ reference: o.id, weight: String(Math.round(o.weightKg * 1000)), city: o.city });`,
    naive: `export const buildShipment = (o) => ({ reference: o.id, weight: o.weightKg, city: o.city });`,
  },
  {
    id: 'tr-sqlite-busy', lang: 'tr', set: 'pair', type: 'fix',
    s1: 'Ajan testlerdeki SQLITE_BUSY hatasını çözdü: bağlantı açılınca PRAGMA busy_timeout = 5000 ve journal_mode = WAL.',
    mem: [{ kind: 'fix', text: "Testlerde SQLITE_BUSY: database is locked → paralel testler aynı dosyayı yazıyor → bağlantı açılır açılmaz `PRAGMA journal_mode = WAL` ve `PRAGMA busy_timeout = 5000`", source: 'agent', age: 40 }],
    prompt: '`openDb(path, Database)` fonksiyonunu yaz: `new Database(path)` ile bağlantıyı açsın, testlerde yaşadığımız kilit hatası tekrar olmasın diye gereken ayarları yapıp db\'yi döndürsün. (`db.exec(sql)` ve `db.pragma(str)` mevcut.)',
    err: 'SqliteError: SQLITE_BUSY: database is locked\n    at Database.exec (orders.test.ts:41) — paralel testlerde ara sıra',
    test: `const done = [];
class Database { constructor(p) { this.p = p; } exec(s) { done.push(String(s)); } pragma(s) { done.push('PRAGMA ' + s); } prepare() { return { run() {}, get() {}, all() { return []; } }; } }
const db = S.openDb('/tmp/x.db', Database);
if (!(db instanceof Database)) fail('did not return the db');
const all = done.join(';').replace(/\\s+/g, ' ').toLowerCase();
if (!/busy_timeout\\s*=?\\s*5000/.test(all) || !/journal_mode\\s*=?\\s*wal/.test(all)) fail(ERR);`,
    ref: `export function openDb(p, Database) { const db = new Database(p); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); return db; }`,
    naive: `export function openDb(p, Database) { const db = new Database(p); db.pragma('foreign_keys = ON'); return db; }`,
  },
  {
    id: 'tr-name-sort', lang: 'tr', set: 'pair', type: 'convention',
    s1: 'Kullanıcı: "isim listeleri Türkçe alfabeye göre sıralanır: localeCompare(b, \'tr\')."',
    mem: [{ kind: 'convention', text: "İsim listeleri Türkçe alfabe sırasıyla sıralanır: a.localeCompare(b, 'tr') (Ç, Ğ, İ, Ö, Ş, Ü doğru yerde)", source: 'user', age: 115 }],
    prompt: '`isimSirala(isimler)` yaz: müşteri isimlerini müşteri listesinde göstereceğimiz sırayla döndürsün (yeni dizi).',
    test: `const r = S.isimSirala(['Zeynep', 'Çağla', 'Cem', 'İpek', 'Ilgaz', 'Şule', 'Selin', 'Ömer', 'Oya']);
assert.deepEqual(r, ['Cem', 'Çağla', 'Ilgaz', 'İpek', 'Oya', 'Ömer', 'Selin', 'Şule', 'Zeynep']);`,
    ref: `export const isimSirala = (a) => [...a].sort((x, y) => x.localeCompare(y, 'tr'));`,
    naive: `export const isimSirala = (a) => [...a].sort();`,
  },
  {
    id: 'analytics-events', lang: 'en', set: 'pair', type: 'convention',
    s1: 'User: "analytics events are object_action in past tense (cart_item_added), sent with track(name, props) from ./analytics.js."',
    mem: [{ kind: 'convention', text: 'Analytics: track(name, props) from ./analytics.js; event names are object_action in past tense, snake_case (e.g. cart_item_added)', source: 'user', age: 135 }],
    prompt: 'Write `onCouponRemoved(code)` that records the analytics event for a user removing a coupon (include the code in the props).',
    test: `const A = await import('./analytics.js');
S.onCouponRemoved('X10');
if (!A.calls.length) fail('track not called');
assert.equal(A.calls[0][0], 'coupon_removed'); assert.ok(JSON.stringify(A.calls[0][1]).includes('X10'));`,
    ref: `import { track } from './analytics.js';
export const onCouponRemoved = (code) => track('coupon_removed', { code });`,
    naive: `export const onCouponRemoved = (code) => window.analytics?.track('Coupon Removed', { code });`,
  },
  {
    id: 'dev-api-ipv4', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed ECONNREFUSED ::1:8787 in CI: localhost resolves to IPv6; use 127.0.0.1:8787 with the /api/v1 prefix.',
    mem: [{ kind: 'fix', text: 'fetch failed ECONNREFUSED ::1:8787 in CI → localhost resolves to IPv6 but the dev API binds IPv4 only → use http://127.0.0.1:8787/api/v1', source: 'agent', age: 35 }],
    prompt: 'Write `devApiUrl(path)` that returns the full URL of an endpoint of our local dev API, e.g. `devApiUrl("users")`.',
    err: 'TypeError: fetch failed\n  [cause]: Error: connect ECONNREFUSED ::1:8787',
    test: `const u = String(S.devApiUrl('users'));
if (u === 'http://127.0.0.1:8787/api/v1/users') process.exit(0);
let x; try { x = new URL(u); } catch { fail('TypeError: Invalid URL: ' + u); }
const host = x.hostname === 'localhost' ? '::1' : x.hostname.replace(/^\\[|\\]$/g, '');
if (x.port === '8787' && host === '127.0.0.1') fail('404 Not Found: GET ' + x.pathname);
fail('TypeError: fetch failed\\n  [cause]: Error: connect ECONNREFUSED ' + host + ':' + (x.port || '80'));`,
    ref: `export const devApiUrl = (p) => 'http://127.0.0.1:8787/api/v1/' + p;`,
    naive: `export const devApiUrl = (p) => 'http://localhost:3000/api/' + p;`,
  },
  {
    id: 'tr-upper-city', lang: 'tr', set: 'pair', type: 'fix',
    s1: 'Ajan şehir aramasının "İZMİR" bulamamasını çözdü: toUpperCase() yerine toLocaleUpperCase(\'tr-TR\').',
    mem: [{ kind: 'fix', text: "Şehir araması 'izmir' → 'IZMIR' üretip kayıt bulamıyordu → toUpperCase() Türkçe i/ı'yı bozuyor → her zaman toLocaleUpperCase('tr-TR')", source: 'agent', age: 55 }],
    prompt: '`sehirAnahtari(s)` yaz: kullanıcının yazdığı şehir adını (boşlukları kırpıp) arama tablosundaki anahtar biçimine, yani büyük harfe çevirsin.',
    err: "Arama sonucu boş: 'IZMIR' anahtarı tabloda yok (tabloda 'İZMİR' var)",
    test: `if (S.sehirAnahtari(' izmir ') !== 'İZMİR' || S.sehirAnahtari('ığdır') !== 'IĞDIR') fail(ERR);`,
    ref: `export const sehirAnahtari = (s) => s.trim().toLocaleUpperCase('tr-TR');`,
    naive: `export const sehirAnahtari = (s) => s.trim().toUpperCase();`,
  },
  {
    id: 'bigint-json', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed "Do not know how to serialize a BigInt": Money amounts are serialized as decimal strings.',
    mem: [{ kind: 'fix', text: 'TypeError "Do not know how to serialize a BigInt" in order JSON → Money.amount is a bigint → JSON.stringify with a replacer that turns bigint into a decimal string', source: 'agent', age: 25 }],
    prompt: 'Write `orderToJson(order)` that returns the JSON string of an order object (which contains money values) for the webhook payload.',
    err: 'TypeError: Do not know how to serialize a BigInt\n    at JSON.stringify (<anonymous>)\n    at orderToJson (webhook.js:12)',
    test: `import { money } from './money.js';
let s; try { s = S.orderToJson({ id: 'ord_1', total: money(1999) }); } catch (e) { fail(ERR); }
const o = JSON.parse(s);
assert.equal(o.id, 'ord_1'); assert.equal(String(o.total.amount), '1999'); assert.equal(o.total.currency, 'TRY');`,
    ref: `export const orderToJson = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));`,
    naive: `export const orderToJson = (o) => JSON.stringify(o);`,
  },
  {
    id: 'date-only-local', lang: 'en', set: 'pair', type: 'fix',
    s1: 'Agent fixed delivery dates shifting by a day: date-only strings are parsed as UTC midnight; parse as Istanbul midnight (+03:00).',
    mem: [{ kind: 'fix', text: "delivery date showed the previous day → new Date('2026-03-01') is UTC midnight → parse date-only strings as Istanbul midnight: new Date(s + 'T00:00:00+03:00')", source: 'agent', age: 65 }],
    prompt: 'Write `parseDeliveryDate(s)` that turns a date-only string like "2026-03-01" from the delivery form into a Date for that day in our business timezone.',
    err: 'expected delivery 01.03.2026, UI showed 28.02.2026 for orders on 2026-03-01 (date shifted by a day)',
    test: `const d = S.parseDeliveryDate('2026-03-01');
if (!(d instanceof Date) || d.toISOString() !== '2026-02-28T21:00:00.000Z') fail(ERR);`,
    ref: `export const parseDeliveryDate = (s) => new Date(s + 'T00:00:00+03:00');`,
    naive: `export const parseDeliveryDate = (s) => new Date(s);`,
  },
  {
    id: 'tr-date-format', lang: 'tr', set: 'pair', type: 'convention',
    s1: 'Kullanıcı: "kullanıcıya gösterilen tarihler GG.AA.YYYY, Türkiye saatine göre."',
    mem: [{ kind: 'convention', text: 'Kullanıcıya gösterilen tarih formatı GG.AA.YYYY (ör. 07.10.2026), Türkiye saatine göre (UTC+3)', source: 'user', age: 145 }],
    prompt: '`tarihGoster(date)` yaz: bir Date nesnesini arayüzde gösterdiğimiz tarih biçimine çevirsin.',
    test: `assert.equal(S.tarihGoster(new Date('2026-10-06T22:30:00Z')), '07.10.2026');
assert.equal(S.tarihGoster(new Date('2026-01-05T09:00:00Z')), '05.01.2026');`,
    ref: `export const tarihGoster = (d) => { const t = new Date(d.getTime() + 3 * 3600e3); return [t.getUTCDate(), t.getUTCMonth() + 1].map((x) => String(x).padStart(2, '0')).join('.') + '.' + t.getUTCFullYear(); };`,
    naive: `export const tarihGoster = (d) => d.toLocaleDateString('tr-TR');`,
  },
  {
    id: 'lint-update', lang: 'tr', set: 'pair', type: 'update',
    s1: 'Önce lint komutu `pnpm eslint .` idi; kullanıcı sonra "artık ESLint değil Biome kullanıyoruz; CI komutu `pnpm biome check --error-on-warnings .`" dedi.',
    mem: [
      { kind: 'decision', text: 'Lint aracı: ESLint, komut `pnpm eslint .`', source: 'user', age: 260, stale: true },
      { kind: 'decision', text: 'Lint aracı artık ESLint değil, Biome: CI komutu `pnpm biome check --error-on-warnings .`', source: 'user', age: 15 },
    ],
    prompt: '`lintKomutu()` yaz: CI\'da lint adımında çalışacak komutu string olarak döndürsün.',
    test: `const c = String(S.lintKomutu()).trim();
if (!/^pnpm (exec )?biome check\\b/.test(c) || !/--error-on-warnings\\b/.test(c)) fail('komut: ' + c);`,
    ref: `export const lintKomutu = () => 'pnpm biome check --error-on-warnings .';`,
    naive: `export const lintKomutu = () => 'npm run lint';`,
  },

  // ───────────────────────────── harm set ─────────────────────────────
  // The prompt alone specifies the answer; a near-miss / contradicting memory is in the store.
  {
    id: 'h-usd-format', lang: 'en', set: 'harm', type: 'near-miss',
    prompt: 'For the US marketplace export, write `formatUsd(cents)` that formats an integer number of US cents as `$1,234.50` (dollar sign, comma thousands, dot decimals).',
    test: `assert.equal(S.formatUsd(123450), '$1,234.50'); assert.equal(S.formatUsd(5), '$0.05');`,
    ref: `export const formatUsd = (c) => '$' + (c / 100).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');`,
  },
  {
    id: 'h-github-retry-after', lang: 'en', set: 'harm', type: 'near-miss',
    prompt: 'Write `githubRetryDelayMs(headers)` for our GitHub API client: GitHub sends a standard `retry-after` header in SECONDS; return the delay in milliseconds (headers is a plain object with lower-case keys).',
    test: `assert.equal(S.githubRetryDelayMs({ 'retry-after': '3' }), 3000);`,
    ref: `export const githubRetryDelayMs = (h) => Number(h['retry-after']) * 1000;`,
  },
  {
    id: 'h-docs-npm', lang: 'en', set: 'harm', type: 'override',
    prompt: 'The `docs/` site is a separate project that is NOT in our workspace and has only a package-lock.json. Write `docsInstallCommand()` returning the exact command `npm ci`.',
    test: `assert.equal(String(S.docsInstallCommand()).trim(), 'npm ci');`,
    ref: `export const docsInstallCommand = () => 'npm ci';`,
  },
  {
    id: 'h-sku-sort', lang: 'en', set: 'harm', type: 'near-miss',
    prompt: 'Write `sortSkus(skus)` that returns a new array of SKU codes sorted by plain UTF-16 code-unit order (exactly what `[...skus].sort()` gives; the warehouse scanner expects that order).',
    test: `assert.deepEqual(S.sortSkus(['b-2', 'B-1', 'a-9', 'Ç-1', 'C-3']), ['B-1', 'C-3', 'a-9', 'b-2', 'Ç-1']);`,
    ref: `export const sortSkus = (a) => [...a].sort();`,
  },
  {
    id: 'h-iso-date-filename', lang: 'tr', set: 'harm', type: 'near-miss',
    prompt: 'Muhasebe dışa aktarım dosyasının adı için `dosyaTarihi(date)` yaz: verilen Date\'in UTC tarihini `YYYY-MM-DD` biçiminde döndürsün (ör. 2026-10-07).',
    test: `assert.equal(S.dosyaTarihi(new Date('2026-10-07T10:00:00Z')), '2026-10-07'); assert.equal(S.dosyaTarihi(new Date('2026-01-05T23:30:00Z')), '2026-01-05');`,
    ref: `export const dosyaTarihi = (d) => d.toISOString().slice(0, 10);`,
  },
  {
    id: 'h-session-purge', lang: 'en', set: 'harm', type: 'override',
    prompt: 'Expired rows in the `session` table must be physically removed (KVKK retention, soft delete is not enough here). Write `purgeSessionsSql(now)` returning `{ text, values }` with a parameterized `DELETE FROM session WHERE expires_at < $1`.',
    test: `const q = S.purgeSessionsSql(123);
if (!/^\\s*delete from "?session"? where "?expires_at"?\\s*<\\s*\\$1\\s*;?\\s*$/i.test(q.text)) fail('sql: ' + q.text);
assert.deepEqual(q.values, [123]);`,
    ref: `export const purgeSessionsSql = (now) => ({ text: 'DELETE FROM session WHERE expires_at < $1', values: [now] });`,
  },
  {
    id: 'h-cli-english-error', lang: 'en', set: 'harm', type: 'override',
    prompt: 'This is for our open-source CLI package (separate from the app): write `cliParsePort(s)` that returns the port number, and for anything that is not an integer 1–65535 throws a plain `Error` whose message is exactly `Invalid port: <s>`.',
    test: `assert.equal(S.cliParsePort('80'), 80);
let e; try { S.cliParsePort('x1'); } catch (x) { e = x; }
if (!e) fail('no throw'); assert.equal(e.message, 'Invalid port: x1');`,
    ref: `export function cliParsePort(s) { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid port: ' + s); return n; }`,
  },
  {
    id: 'h-parse-kv', lang: 'en', set: 'harm', type: 'generic',
    prompt: 'Write `parseKv(s)` that parses `"a=1;b=two;c="` into `{ a: "1", b: "two", c: "" }` (split on `;`, then on the first `=`; skip empty segments; values stay strings).',
    test: `assert.deepEqual(S.parseKv('a=1;b=two;c=;;d=x=y'), { a: '1', b: 'two', c: '', d: 'x=y' });`,
    ref: `export const parseKv = (s) => Object.fromEntries(s.split(';').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));`,
  },
  {
    id: 'h-chunk', lang: 'tr', set: 'harm', type: 'generic',
    prompt: '`parcala(dizi, n)` yaz: diziyi n elemanlı parçalara bölsün, son parça kısa kalabilir (ör. parcala([1,2,3,4,5], 2) → [[1,2],[3,4],[5]]).',
    test: `assert.deepEqual(S.parcala([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]); assert.deepEqual(S.parcala([], 3), []);`,
    ref: `export const parcala = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };`,
  },
  {
    id: 'h-queue-retry', lang: 'en', set: 'harm', type: 'near-miss',
    prompt: 'Our internal job queue (not HTTP) has its own policy: write `queueShouldRetry(status, attempt)` that retries on ANY status >= 500 as long as fewer than 5 attempts were made (`attempt` = attempts already made).',
    test: `assert.equal(S.queueShouldRetry(500, 1), true); assert.equal(S.queueShouldRetry(503, 4), true);
assert.equal(S.queueShouldRetry(503, 5), false); assert.equal(S.queueShouldRetry(404, 1), false);`,
    ref: `export const queueShouldRetry = (s, a) => s >= 500 && a < 5;`,
  },
];

// Other memories in the same `shop` store (a realistic store is not only the facts under test).
export const FILLER = [
  { kind: 'fact', text: 'Production runs on Fly.io (region ams), Postgres on Neon; staging auto-deploys from main', source: 'user', age: 210 },
  { kind: 'decision', text: 'Frontend: Next.js App Router with server actions; no Redux, local state + TanStack Query', source: 'user', age: 250 },
  { kind: 'convention', text: 'Commit messages: Conventional Commits with a scope, e.g. feat(cart): …', source: 'user', age: 260 },
  { kind: 'fact', text: 'iyzico sandbox keys live in 1Password vault "shop-dev"; webhooks hit /api/v1/payments/iyzico', source: 'user', age: 100 },
  { kind: 'todo', text: 'migrate image uploads from local disk to R2 before Black Friday', source: 'user', age: 12 },
  { kind: 'note', text: 'Search uses Meilisearch; reindex with `pnpm search:reindex` after bulk product imports', source: 'agent', age: 70 },
  { kind: 'decision', text: 'Auth: session cookies (httpOnly, SameSite=Lax), no JWT in localStorage', source: 'user', age: 280 },
  { kind: 'fact', text: 'Product images are resized by a Cloudflare Worker at /img/<w>/<path>', source: 'agent', age: 90 },
  { kind: 'convention', text: 'React components: one component per file, PascalCase file names, named exports only', source: 'user', age: 230 },
  { kind: 'bug', text: 'cart badge count lags one update behind after removing the last item (open)', source: 'agent', age: 8 },
  { kind: 'fact', text: 'Email goes through Postmark; templates live in emails/ as MJML', source: 'user', age: 160 },
  { kind: 'decision', text: 'Background jobs run on BullMQ with Redis; one queue per domain (orders, emails, sync)', source: 'user', age: 175 },
  { kind: 'note', text: 'Black Friday freeze: no schema migrations between Nov 20 and Dec 2', source: 'user', age: 10 },
  { kind: 'fact', text: 'Admin panel is at /admin, behind Cloudflare Access (Google SSO, @shop.com.tr only)', source: 'user', age: 205 },
  { kind: 'convention', text: 'Kod yorumları ve değişken adları İngilizce; kullanıcıya görünen metinler Türkçe (i18n/tr.json)', source: 'user', age: 185 },
];
