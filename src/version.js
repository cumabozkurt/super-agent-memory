// Single source of the version: package.json (works from a checkout, npm link and a global install).
import { readFileSync } from 'node:fs';

let v = '0.0.0';
try { v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || v; } catch { /* stripped package */ }
export const VERSION = v;
