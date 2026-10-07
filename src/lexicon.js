// LLM-free query understanding for retrieval: a small bilingual (EN/TR) dev-vocabulary alias table,
// a light Turkish suffix stripper, identifier splitting and corpus-vocabulary typo correction.
// Everything here is applied to the QUERY only (except splitIdent, also used for index twins).
import { fold } from './text.js';

// Each group is one concept. Entries are folded (no diacritics, ı→i). An entry of 4+ chars also matches as a
// prefix ("deploy" matches "deployment"); shorter entries match exactly.
export const ALIAS_GROUPS = [
  ['deploy', 'ship', 'release', 'rollout', 'prod', 'production', 'canli', 'canliya', 'yayin', 'dagitim', 'publish', 'golive'],
  ['database', 'db', 'postgres', 'postgresql', 'mysql', 'sqlite', 'veritabani', 'sql'],
  ['migration', 'migrate', 'schema', 'sema', 'alembic'],
  ['test', 'tests', 'spec', 'e2e', 'vitest', 'jest', 'pytest', 'playwright', 'cypress'],
  ['auth', 'authentication', 'login', 'signin', 'logout', 'oauth', 'jwt', 'oturum', 'giris'],
  ['permission', 'role', 'rbac', 'authorization', 'yetki', 'rol', 'izin'],
  ['payment', 'pay', 'checkout', 'charge', 'charged', 'billing', 'odeme', 'tahsilat', 'cekim'],
  ['price', 'money', 'amount', 'cost', 'fiyat', 'tutar', 'kurus', 'cents', 'currency'],
  ['cart', 'basket', 'sepet'],
  ['coupon', 'discount', 'promo', 'voucher', 'kupon', 'indirim'],
  ['email', 'mail', 'eposta', 'smtp'],
  ['spam', 'junk', 'deliverability', 'dkim'],
  ['i18n', 'translation', 'translate', 'locale', 'localization', 'l10n', 'ceviri', 'intl'],
  ['image', 'picture', 'photo', 'img', 'gorsel', 'resim'],
  ['hosting', 'hosted', 'cdn', 'bucket', 'storage'],
  ['cache', 'caching', 'cached', 'onbellek'],
  ['queue', 'job', 'jobs', 'worker', 'background', 'kuyruk', 'celery', 'bullmq', 'sidekiq'],
  ['log', 'logs', 'logging', 'logger', 'gunluk', 'loglar'],
  ['error', 'exception', 'crash', 'hata', 'sentry'],
  ['trace', 'traces', 'tracing', 'opentelemetry', 'otel', 'span'],
  ['secret', 'secrets', 'credential', 'credentials', 'apikey', 'gizli', 'sifre'],
  ['env', 'environment', 'dotenv', 'ortam', 'degisken'],
  ['timezone', 'utc', 'tz', 'saat'],
  ['ratelimit', 'rate-limit', 'throttle', 'throttling', '429'],
  ['request', 'requests', 'istek'],
  ['version', 'surum', 'versiyon'],
  ['pull', 'pr', 'merge', 'onay'],
  ['commit', 'commits'],
  ['branch', 'branches', 'dal'],
  ['sign', 'signing', 'signed', 'signature', 'imza', 'imzala', 'gpg'],
  ['dependency', 'dependencies', 'deps', 'package', 'library', 'kutuphane', 'paket', 'npm', 'pnpm', 'yarn', 'pip'],
  ['component', 'components', 'bilesen', 'widget'],
  ['style', 'styling', 'css', 'tailwind', 'theme', 'color', 'colour', 'renk'],
  ['notification', 'notifications', 'bildirim', 'fcm', 'apns'],
  ['appstore', 'magaza', 'testflight'],
  ['build', 'builds', 'archive', 'xcode', 'gradle'],
  ['hotfix', 'ota', 'over-the-air'],
  ['state', 'zustand', 'redux'],
  ['navigation', 'router', 'routing', 'navigasyon'],
  ['offline', 'cevrimdisi'],
  ['column', 'kolon', 'sutun', 'field'],
  ['table', 'tablo', 'tables'],
  ['plural', 'cogul'],
  ['character', 'characters', 'karakter', 'encoding', 'utf', 'unicode', 'font', 'fonts'],
  ['report', 'reports', 'rapor', 'pdf'],
  ['tenant', 'tenancy', 'multitenancy', 'rls'],
  ['memory', 'oom', 'oomkilled', 'ram', 'bellek', 'leak'],
  ['twice', 'duplicate', 'double', 'mukerrer'],
  ['delete', 'deletion', 'erase', 'gdpr', 'kvkk', 'silme', 'sil'],
  ['pii', 'phone', 'telefon', 'kimlik'],
  ['flaky', 'intermittent', 'unstable'],
  ['slow', 'perf', 'performance', 'latency', 'yavas'],
  ['lint', 'linter', 'eslint', 'ruff', 'prettier', 'formatter', 'mypy', 'typecheck'],
  ['shipping', 'cargo', 'kargo', 'delivery', 'tracking', 'takip'],
  ['invoice', 'fatura', 'tax', 'vat', 'kdv', 'vergi', 'accounting', 'muhasebe'],
  ['admin', 'backoffice', 'yonetim'],
  ['flag', 'flags', 'toggle', 'unleash'],
  ['subscription', 'subscriptions', 'abonelik', 'iap', 'purchase', 'premium', 'entitlement'],
  ['webhook', 'webhooks', 'callback'],
  ['endpoint', 'endpoints', 'route', 'handler'],
  ['cron', 'schedule', 'scheduled', 'periodic', 'zamanla'],
  ['setup', 'kurulum', 'onboarding'],
  ['mac', 'macbook', 'laptop', 'arm64', 'makine'],
  ['hang', 'hangs', 'stuck', 'freeze', 'takil'],
  ['rollback', 'revert', 'geri'],
  ['friday', 'cuma', 'weekend'],
  ['expire', 'expired', 'expires', 'expiry', 'suresi'],
  ['monorepo', 'workspace', 'turborepo'],
  ['small', 'big', 'large', 'size', 'kucuk', 'buyuk', 'satir'],
  ['answer', 'reply', 'respond', 'cevap', 'yanit'],
  ['turkish', 'turkce', 'english', 'ingilizce', 'language'],
  ['naming', 'abbreviation', 'kisaltma', 'isim'],
  ['indent', 'indentation', 'tabs', 'spaces', 'girinti'],
  ['feedback', 'review', 'inceleme', 'severity'],
  ['persist', 'persisted', 'stored', 'sakla', 'saklama', 'tutul'],
  ['security', 'guvenlik', 'csp'],
  ['policy', 'policies', 'politika'],
  ['date', 'dates', 'tarih'],
  ['customer', 'customers', 'musteri', 'kullanici'],
];

const INDEX = new Map(); // entry -> group ids
ALIAS_GROUPS.forEach((g, gi) => g.forEach((e) => { if (!INDEX.has(e)) INDEX.set(e, []); INDEX.get(e).push(gi); }));
const EN_INFL = new Set(['s', 'es', 'ed', 'd', 'ing', 'ment', 'ments', 'er', 'ers', 'ion', 'ions', 'y', 'ly', 'e', 'ize', 'ized']);
const PREFIX_ENTRIES = [...INDEX.keys()].filter((e) => e.length >= 4);

/** Alias forms for one folded query term (not including the term itself). */
export function aliasesOf(term) {
  const t = fold(term);
  const gids = new Set(INDEX.get(t) || []);
  if (!gids.size) {
    for (const e of PREFIX_ENTRIES) {
      if (t.length <= e.length || !t.startsWith(e)) continue;
      const rest = t.slice(e.length);
      if (EN_INFL.has(rest) || trStem(t) === e) INDEX.get(e).forEach((g) => gids.add(g));
    }
    // a stripped Turkish stem can be shorter than the entry: veritaban -> veritabani, imzal -> imzala
    if (!gids.size && t.length >= 5) for (const e of PREFIX_ENTRIES) if (e.startsWith(t) && e.length - t.length <= 2) INDEX.get(e).forEach((g) => gids.add(g));
  }
  const out = new Set();
  for (const g of gids) for (const e of ALIAS_GROUPS[g]) if (e !== t && !e.includes('-')) out.add(e);
  return [...out];
}

// Prompt words that say what to DO rather than what it is ABOUT. They still match, but carry little
// weight in the relevance gate ("write a haiku about refactoring" must not count "write" as evidence).
export const GENERIC = new Set(('write add create make fix update change rename format convert implement generate summarize explain ' +
  'show tell give help check run open look find try work works working keep set put let see thanks thank good great ok okay ' +
  'function variable file code line lines thing stuff way again still ever really yap ekle duzelt acikla goster anlat yaz').split(' '));

const TR_HINT = /[çğıöşüÇĞİÖŞÜ]|\b(mi|mı|mu|mü|nasıl|nasil|neden|nerede|hangi|nedir|neydi|miyim|mısın|misin|var mı|yok)\b/i;
export const isTurkish = (s) => TR_HINT.test(String(s));

// Longest first. Light, inflectional only; derivational suffixes are left alone.
const TR_SUFFIXES = ['iyoruz', 'ıyoruz', 'uyoruz', 'üyoruz', 'iyorum', 'ıyorum', 'uyorum', 'üyorum', 'iyor', 'ıyor', 'uyor', 'üyor', 'abilir', 'ebilir', 'mış', 'miş', 'muş', 'müş', 'acak', 'ecek', 'ılır', 'ilir', 'mak', 'mek', 'dı', 'di', 'du', 'dü', 'tı', 'ti', 'tu', 'tü', 'larından', 'lerinden', 'lardaki', 'lerdeki', 'larının', 'lerinin', 'ları', 'leri', 'lardan', 'lerden', 'larda', 'lerde',
  'ların', 'lerin', 'lara', 'lere', 'lar', 'ler', 'ndaki', 'ndeki', 'daki', 'deki', 'taki', 'teki', 'ndan', 'nden', 'dan', 'den', 'tan', 'ten',
  'nda', 'nde', 'yla', 'yle', 'ınız', 'iniz', 'unuz', 'ünüz', 'ımız', 'imiz', 'umuz', 'ümüz', 'sını', 'sini', 'sunu', 'sünü',
  'nın', 'nin', 'nun', 'nün', 'yı', 'yi', 'yu', 'yü', 'ya', 'ye', 'da', 'de', 'ta', 'te', 'ın', 'in', 'un', 'ün', 'ı', 'i', 'u', 'ü', 'a', 'e'];
const TR_SUFFIXES_F = [...new Set(TR_SUFFIXES.map(fold))].sort((a, b) => b.length - a.length);

/** Strip up to two inflectional suffixes from a folded Turkish word; never below 4 chars. */
export function trStem(word) {
  let w = fold(word);
  for (let round = 0; round < 2; round++) {
    const s = TR_SUFFIXES_F.find((x) => w.endsWith(x) && w.length - x.length >= 4);
    if (!s) break;
    w = w.slice(0, -s.length);
  }
  return w;
}

/** useAuthStore -> [use, auth, store]; PG_POOL_MAX -> [pg, pool, max]; kebab-case too. */
export function splitIdent(w) {
  const s = String(w);
  if (!/[a-z][A-Z]|_|-/.test(s)) return [];
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_\-./]+/).map((x) => x.toLowerCase()).filter((x) => x.length >= 2);
}

function damerau(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}
const enLite = (w) => w.replace(/(ions?|ings?|ed|es|s)$/, '');

/**
 * Typo correction against the FTS vocabulary (porter stems). Only for terms that occur nowhere in the corpus.
 * vocab: Array<{term, doc}> from fts5vocab. Returns the best correction or null.
 */
export function correct(term, vocab) {
  const t = fold(term);
  if (t.length < 5 || /\d/.test(t)) return null;
  const max = t.length >= 6 ? 2 : 1;
  let best = null;
  for (const v of vocab) {
    if (v.term.length < 4 || v.term[0] !== t[0]) continue;
    const d = Math.min(damerau(t, v.term, max), damerau(enLite(t), v.term, max));
    if (d <= max && (!best || d < best.d || (d === best.d && v.doc > best.doc))) best = { term: v.term, d, doc: v.doc };
  }
  return best ? best.term : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Stack families for the project-specificity gate (v2). A prompt that names only stacks this project's memories
// never mention ("a Django view" in a Next.js store) is about another stack. Entries are folded; an entry of 5+
// chars also matches with a short suffix ("djangos", "kubernetes'te" → kubernetes). Ambiguous everyday words
// (go, express, compose, cargo, lambda, spring as a season…) are deliberately left out: a missed stack only means
// the gate falls back to v1.2 behaviour, a false one would hide a relevant memory.
export const STACKS = {
  js: ['javascript', 'typescript', 'nodejs', 'node.js', 'npm', 'pnpm', 'yarn', 'deno', 'bun', 'tsconfig', 'eslint', 'vitest', 'jest', 'nestjs', 'fastify', 'esm'],
  react: ['react', 'reactjs', 'jsx', 'tsx', 'nextjs', 'next.js', 'usestate', 'useeffect', 'remix', 'zustand', 'redux'],
  vue: ['vue', 'vuejs', 'vuex', 'pinia', 'nuxt', 'nuxtjs'],
  angular: ['angular', 'rxjs', 'ngrx', 'ngmodule'],
  svelte: ['svelte', 'sveltekit'],
  reactnative: ['react-native', 'expo', 'eas', 'metro'],
  python: ['python', 'pip', 'pytest', 'pydantic', 'sqlalchemy', 'alembic', 'poetry', 'virtualenv', 'venv', 'uvicorn', 'gunicorn', 'pandas', 'numpy', 'jupyter', 'celery', 'asyncio', 'mypy', 'ruff'],
  django: ['django', 'drf', 'makemigrations', 'manage.py', 'queryset'],
  flask: ['flask', 'werkzeug', 'jinja'],
  fastapi: ['fastapi', 'starlette'],
  ruby: ['ruby', 'rails', 'rubocop', 'rspec', 'gemfile', 'bundler', 'sidekiq', 'activerecord', 'rake', 'erb'],
  php: ['php', 'laravel', 'symfony', 'artisan', 'eloquent', 'wordpress', 'composer.json', 'blade'],
  jvm: ['java', 'spring', 'springboot', 'spring-boot', 'hibernate', 'jpa', 'maven', 'junit', 'lombok', 'tomcat', 'quarkus', 'scala'],
  kotlin: ['kotlin', 'jetpack', 'androidx', 'ktor'],
  dotnet: ['dotnet', '.net', 'csharp', 'c#', 'asp.net', 'nuget', 'blazor', 'efcore', 'linq', 'xamarin', 'maui'],
  golang: ['golang', 'goroutine', 'goroutines', 'go.mod', 'gin', 'gorm'],
  rust: ['rust', 'rustc', 'tokio', 'actix', 'axum', 'serde', 'cargo.toml'],
  flutter: ['flutter', 'dart', 'pubspec', 'riverpod'],
  swift: ['swift', 'swiftui', 'uikit', 'objective-c', 'swiftdata'],
  elixir: ['elixir', 'phoenix', 'ecto', 'liveview'],
  mongodb: ['mongodb', 'mongo', 'mongoose'],
  mysql: ['mysql', 'mariadb', 'planetscale'],
  firebase: ['firebase', 'firestore'],
  dynamodb: ['dynamodb'],
  elastic: ['elasticsearch', 'opensearch', 'kibana'],
  clickhouse: ['clickhouse'],
  kubernetes: ['kubernetes', 'k8s', 'kubectl', 'helm', 'argocd', 'kustomize'],
  aws: ['aws', 'ec2', 'cloudformation', 'cloudwatch', 'sqs', 'ecs', 'fargate'],
  azure: ['azure'],
  gcp: ['gcp', 'gke', 'bigquery', 'cloudrun'],
  terraform: ['terraform', 'pulumi', 'ansible'],
};
const EXT_STACKS = { py: ['python'], rb: ['ruby'], php: ['php'], java: ['jvm'], kt: ['kotlin'], kts: ['kotlin'], cs: ['dotnet'], go: ['golang'], rs: ['rust'], dart: ['flutter'], swift: ['swift'], ex: ['elixir'], exs: ['elixir'], ts: ['js'], tsx: ['js', 'react'], js: ['js'], jsx: ['js', 'react'], mjs: ['js'], vue: ['vue'], svelte: ['svelte'] };
const STACK_EXACT = new Map();
const STACK_PREFIX = [];
for (const [fam, terms] of Object.entries(STACKS)) for (const t of terms) {
  if (!STACK_EXACT.has(t)) STACK_EXACT.set(t, []);
  STACK_EXACT.get(t).push(fam);
  if (t.length >= 5 && /^[a-z]+$/.test(t)) STACK_PREFIX.push([t, fam]);
}

/** Stack families named in a text (prompt or memory): stack words, plus file extensions in paths. */
export function stacksIn(text) {
  const out = new Set();
  const toks = fold(text).match(/[\p{L}\p{N}_.#+\-/]+/gu) || [];
  for (let raw of toks) {
    raw = raw.replace(/^[.\-/]+|[.\-/,]+$/g, '');
    if (!raw) continue;
    // whole token, path segments and its -/_ parts ("pytest-django", "views.py" in a path)
    for (const tok of new Set([raw, ...raw.split(/[/\-_]/)])) {
      const ex = STACK_EXACT.get(tok);
      if (ex) { ex.forEach((f) => out.add(f)); continue; }
      const m = /\.([a-z]{1,6})$/.exec(tok);
      if (m && EXT_STACKS[m[1]] && tok.length > m[0].length) { EXT_STACKS[m[1]].forEach((f) => out.add(f)); continue; }
      for (const [t, fam] of STACK_PREFIX) if (tok.length > t.length && tok.length - t.length <= 4 && tok.startsWith(t)) out.add(fam);
    }
  }
  return out;
}
