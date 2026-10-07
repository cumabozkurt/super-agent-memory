// Tabulate results/*.json: node bench/retrieval/compare.mjs label1 label2 ...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
const labels = process.argv.slice(2);
const head = ['variant', 'R@1', 'R@3', 'R@5', 'MRR', 'nDCG5', 'R@3 zero-ovl', 'R@3 xl', 'R@3 held', 'p.hit', 'p.FIR', 'p.prec', 'tok/prompt', 'card cov', 'card tok', 's40 tok', 's40 vis', 'ms/q'];
console.log('| ' + head.join(' | ') + ' |\n|' + head.map(() => '---').join('|') + '|');
for (const l of labels) {
  const r = JSON.parse(readFileSync(join(ROOT, 'results', l + '.json'), 'utf8'));
  const S = r.search, P = r.prompt, bt = S.byType;
  const xl = ((bt['xl-tr']?.r3 || 0) * bt['xl-tr'].n + (bt['xl-en']?.r3 || 0) * bt['xl-en'].n) / (bt['xl-tr'].n + bt['xl-en'].n);
  console.log('| ' + [l, S.all.r1, S.all.r3, S.all.r5, S.all.mrr, S.all.ndcg5, S.byOverlap.zero.r3, xl.toFixed(3), S.bySplit.heldout.r3, P.hit, P.fir, P.precision, P.tikTokAll, r.cardSummary.avgCoverage, r.cardSummary.avgTik, r.ledger.on.tik, r.ledger.on.visible, S.msPerQuery].join(' | ') + ' |');
}
