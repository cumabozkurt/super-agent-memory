// Grader self-check: every reference solution must pass and every naive (memory-less) solution must fail.
//   node bench/coding-eval/validate.mjs
import { TASKS } from './tasks.mjs';
import { grade } from './grade.mjs';
let bad = 0;
for (const t of TASKS) {
  const r = grade(t, t.ref);
  if (!r.pass) { bad++; console.log('REF FAILS', t.id, r.msg); }
  if (t.naive) { const n = grade(t, t.naive); if (n.pass) { bad++; console.log('NAIVE PASSES', t.id); } }
}
console.log(`${TASKS.filter((t) => t.set === 'pair').length} pairs, ${TASKS.filter((t) => t.set === 'harm').length} harm tasks; ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
