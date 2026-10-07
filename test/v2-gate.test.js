// v2 project-specificity gate: stack lexicon, per-project signature (cached in meta), sibling-project and
// foreign-stack vetoes in promptContext. The quality numbers are `npm run bench:v2`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SAM_HOME = mkdtempSync(join(tmpdir(), 'sam-v2gate-'));
const origEmit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
const { saveMemory } = await import('../src/store.js');
const { specificity, projectSignature } = await import('../src/search.js');
const { promptContext } = await import('../src/inject.js');
const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { stacksIn } = await import('../src/lexicon.js');
const P = (id) => { openDb().prepare('INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES (?, ?, ?, ?)').run(id, id, null, Date.now()); return { id, name: id }; };
const save = (project, text, files = [], kind = 'fact') => saveMemory({ project, kind, text, files, source: 'user' });
let sid = 0;
const recall = (p, prompt) => promptContext({ project: P(p), session: 'g' + sid++, prompt });

// shop: Next.js + Prisma web store; mobile: Expo + Supabase app (siblings in one DB)
const shop = {
  logging: save('shop', 'logging: pino logger with a request id on every server action log line', ['src/server/log.ts']),
  db: save('shop', 'database: Prisma with Postgres on Neon, pooled connection string for serverless routes', ['prisma/schema.prisma']),
};
for (const [t, f] of [
  ['checkout uses iyzico 3DS, amounts in integer kuruş', 'src/lib/money.ts'], ['product search runs on Meilisearch, index rebuilt nightly', 'src/server/search.ts'],
  ['cart state lives in a zustand store persisted to localStorage', 'src/store/cart.ts'], ['images are served through next/image with a custom loader', 'next.config.js'],
  ['deploy: fly.io from GitHub Actions on merge to main', '.github/workflows/deploy.yml'], ['emails are rendered with react-email templates', 'emails/order.tsx'],
  ['admin panel lives in apps/admin and requires the ADMIN role', 'apps/admin/page.tsx'], ['unit tests use vitest, e2e uses playwright', 'vitest.config.ts'],
]) save('shop', t, [f]);
const mobile = {
  secrets: save('mobile', 'supabase edge functions read secrets via supabase secrets set, never from the app bundle', ['supabase/functions/pay/index.ts']),
};
for (const [t, f] of [
  ['expo-router file routes live under app/, tabs in app/(tabs)', 'app/(tabs)/_layout.tsx'], ['EAS update channels: preview and production', 'eas.json'],
  ['supabase row level security policies are defined in supabase/migrations', 'supabase/migrations/001.sql'], ['offline trips are cached with expo-sqlite', 'src/db/offline.ts'],
  ['push notifications go through expo-notifications and FCM', 'src/push.ts'], ['RevenueCat handles subscriptions, entitlement "pro"', 'src/iap.ts'],
  ['maps use react-native-maps with Google provider on Android', 'src/map.tsx'], ['supabase auth deep link scheme is atlas://', 'app.json'],
  ['supabase storage bucket trip-photos is private, signed urls only', 'src/photos.ts'], ['supabase types are generated into src/types/supabase.ts', 'src/types/supabase.ts'],
  ['expo config plugins live in plugins/', 'app.config.ts'], ['supabase realtime channel per trip for shared itineraries', 'src/realtime.ts'],
  ['EAS build profiles: development, preview, production', 'eas.json'],
]) save('mobile', t, [f]);
// realistic sizes (the likelihood ratio is smoothed toward DB-wide rates with 20 pseudo-rows, so a 20-note DB barely moves it)
for (let i = 0; i < 40; i++) save('shop', `storefront page ${i}: category listing tweak number ${i} for the campaign banner`, [`src/app/(shop)/c${i}/page.tsx`]);
for (let i = 0; i < 40; i++) save('mobile', `trip screen ${i}: itinerary card tweak number ${i} on the supabase-backed timeline`, [`app/trip/s${i}.tsx`]);
const globalDjango = save('global', 'django projects: I prefer pytest-django over the unittest runner');

test('stacksIn: stack words, -/_ parts and file extensions; ambiguous everyday words are not stacks', () => {
  assert.deepEqual([...stacksIn('How do I write a Django view with DRF?')].sort(), ['django']);
  assert.ok(stacksIn('configure pytest-django fixtures').has('django'));
  assert.ok(stacksIn("kubernetes'te pod restart olmuyor").has('kubernetes'));
  assert.deepEqual([...stacksIn('edit src/app/page.tsx and api/views.py')].sort(), ['js', 'python', 'react']);
  assert.equal(stacksIn('go to the store and express your concerns, then compose a reply').size, 0);
  assert.ok(stacksIn('Spring Boot ile JPA repository').has('jvm'));
  assert.ok(stacksIn('a C# LINQ query').has('dotnet'));
});

test('project signature: stack families from memory text + files, cached in meta and rebuilt when the project changes', () => {
  const db = openDb();
  const s1 = projectSignature(db, 'shop');
  assert.ok(s1.stacks.has('js') && s1.stacks.has('react'), 'shop is a JS/React project');
  assert.ok(!s1.stacks.has('python') && !s1.stacks.has('django'));
  const cached = JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'spec:sig:shop'").get().v);
  assert.equal(cached.stamp, s1.stamp);
  assert.equal(projectSignature(db, 'shop').stamp, s1.stamp, 'reused while nothing changed');
  const extra = save('shop', 'a tiny python script in tools/sync.py imports the product feed', ['tools/sync.py']);
  const s2 = projectSignature(db, 'shop');
  assert.notEqual(s2.stamp, s1.stamp);
  assert.ok(s2.stacks.has('python'), 'rebuilt with the new memory');
  db.prepare("UPDATE memories SET superseded_by = 'forgotten' WHERE id = ?").run(extra.id);
  assert.ok(!projectSignature(db, 'shop').stacks.has('python'), 'and again when it goes away');
});

test('foreign stack: a Django prompt in a Next.js project recalls nothing — except a note that is about Django', async () => {
  const prompt = 'how should logging be set up with request ids in our Django server?';
  const sp = specificity(prompt, 'shop');
  assert.deepEqual(sp.foreign, ['django']);
  const r = await recall('shop', prompt);
  assert.ok(!r.ids.includes(shop.logging.id), 'the pino logging note is not about Django');
  assert.ok(r.ids.every((id) => id === globalDjango.id), 'only the global Django preference may pass');
  // the same question without a foreign stack still finds the logging note
  const own = await recall('shop', 'how should logging be set up with request ids on the server?');
  assert.ok(own.ids.includes(shop.logging.id));
  // naming a stack the project does use switches the foreign rule off
  assert.deepEqual(specificity('Django vs our Next.js server actions for logging', 'shop').foreign, []);
});

test('sibling project: a prompt about the Expo/Supabase app asked in the web store recalls nothing; in its own project it does', async () => {
  // several sibling-only words are needed to clear the e^6.5 likelihood bar; one stray shared word never does
  const prompt = 'where do the supabase edge functions get their secrets from, and does the expo EAS preview channel see them?';
  const sp = specificity(prompt, 'shop');
  assert.equal(sp.llrProject, 'mobile');
  assert.ok(sp.llr > 6.5, `llr ${sp.llr}`);
  assert.deepEqual((await recall('shop', prompt)).ids, []);
  const own = await recall('mobile', prompt);
  assert.ok(own.ids.includes(mobile.secrets.id));
  assert.ok(specificity(prompt, 'mobile').llr < 0, 'the home project explains its own words');
});

test('a tiny sibling that merely lacks the words never explains them (no sibling-only word → no sibling veto)', async () => {
  for (let i = 0; i < 3; i++) save('tinysib', `ci runners use node ${20 + i}`);
  const sp = specificity('how is the cart persisted in localStorage?', 'shop');
  assert.notEqual(sp.llrProject, 'tinysib');
  assert.ok(sp.llr < 6.5);
});

test('an immature project (few memories) is never judged by the foreign-stack rule', async () => {
  const p = 'fresh';
  const m = save(p, 'api auth uses JWT access tokens that expire after 15 minutes', ['src/auth.ts']);
  save(p, 'refresh tokens are rotated on every use');
  const sp = specificity('JWT expiry in our Spring Boot gateway?', p);
  assert.deepEqual(sp.foreign, [], 'signature too thin to call a stack foreign');
  assert.ok((await recall(p, 'how long until a JWT access token expires?')).ids.includes(m.id));
});

test('specGate=false restores the v1.2 behaviour', async () => {
  const cfg = config();
  const prompt = 'how should logging be set up with request ids in our Django server?';
  const prev = cfg.specGate;
  try {
    cfg.specGate = false;
    const off = await recall('shop', prompt);
    cfg.specGate = true;
    const on = await recall('shop', prompt);
    assert.ok(on.ids.length <= off.ids.length);
    assert.ok(!on.ids.includes(shop.logging.id));
  } finally { cfg.specGate = prev; }
});

test('specificity is cheap: well under the 5 ms per-prompt budget on a small store', () => {
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) specificity('where do the supabase edge functions get their secrets from? ' + i, 'shop');
  assert.ok((performance.now() - t0) / 50 < 5);
});
