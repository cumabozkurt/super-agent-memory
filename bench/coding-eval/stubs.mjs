// Modules that exist in the fictional `shop` repo. Every graded solution is written next to all of them, so a
// solution may import any of these with a relative path. Their APIs are only knowable from memory.
export const STUBS = {
  'money.js': `export function money(amount, currency = 'TRY') { return { amount: BigInt(amount), currency }; }
export const isMoney = (m) => !!m && typeof m === 'object' && typeof m.amount === 'bigint' && typeof m.currency === 'string';
`,
  'log.js': `export const calls = [];
const rec = (lvl) => (event, fields) => { calls.push([lvl, event, fields]); };
export const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
export default log;
`,
  'ids.js': `let n = 0;
export function newId(prefix) {
  if (!prefix || typeof prefix !== 'string') throw new Error('newId(prefix) needs a prefix');
  return prefix + '_01J' + String(++n).padStart(23, '0');
}
`,
  'http.js': `export const calls = [];
const req = (method) => (path, opts) => {
  calls.push([method, path, opts]);
  if (typeof path === 'string' && path.startsWith('/')) throw new TypeError("ky: 'input' must not begin with a slash when using 'prefixUrl'");
  return { json: async () => ({ id: 42, path }), text: async () => '' };
};
export const api = { get: req('get'), post: req('post'), put: req('put'), patch: req('patch'), delete: req('delete') };
export default api;
`,
  'config.js': `export const reads = [];
const VALUES = { DATABASE_URL: 'postgres://shop:pw@db:5432/shop', REDIS_URL: 'redis://cache:6379', PORT: '8787' };
export const config = { get(k) { reads.push(k); if (!(k in VALUES)) throw new Error('config: unknown key ' + k); return VALUES[k]; } };
export default config;
`,
  'errors.js': `export class AppError extends Error {
  constructor(code, message, meta) { super(message); this.name = 'AppError'; this.code = code; this.meta = meta; }
}
`,
  'flags.js': `export const calls = [];
export const flags = { isOn(name) { calls.push(name); return name === 'ff-new-checkout'; } };
export default flags;
`,
  'analytics.js': `export const calls = [];
export function track(name, props) { calls.push([name, props]); }
`,
  'text.js': `export const toAscii = (s) => String(s).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'I');
`,
};
