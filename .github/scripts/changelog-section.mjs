#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version (used as GitHub release notes).
// Usage: node .github/scripts/changelog-section.mjs 1.0.0 [CHANGELOG.md]
import { readFileSync } from 'node:fs';

const version = (process.argv[2] || '').replace(/^v/, '');
const file = process.argv[3] || 'CHANGELOG.md';
if (!version) { console.error('usage: changelog-section.mjs <version> [file]'); process.exit(2); }

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${esc}\\]?(\\s|$)`).test(l));
if (start < 0) { console.error(`no "## [${version}]" section in ${file}`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
// drop the heading itself (the release title carries the version) and trailing link refs / blank lines
const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s*https?:\/\//.test(l));
while (body.length && !body[0].trim()) body.shift();
while (body.length && !body[body.length - 1].trim()) body.pop();
if (!body.length) { console.error(`section ${version} is empty`); process.exit(1); }
process.stdout.write(body.join('\n') + '\n');
