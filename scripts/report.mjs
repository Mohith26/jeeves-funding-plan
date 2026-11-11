// Prints every headline number shown on the page (same code path as the UI).
import { generateCompany } from '../src/generate.js';
import { runAll } from '../src/model.js';
const alpha = Number(process.argv[2] || 0.01);
const t0 = Date.now();
const R = runAll(generateCompany(), { alpha });
const f = (x, d = 0) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
for (const r of R.results) {
  console.log(`\n== ${r.ccy} balance ${f(r.acct.balance)} spot ${r.spot} avgDaily ${f(r.avgDaily)} mean30 ${f(r.meanOutflow)}`);
  console.log(`  plan q=${r.plan && r.plan.q.toFixed(5)} calRisk=${r.calRisk} firstTopup=day ${r.firstTopup}`);
  for (const t of r.topups) console.log(`   topup ${t.date} to ${f(t.level)} (amt med ${f(t.amtMed)} [${f(t.amtLo)}-${f(t.amtHi)}]) covers through ${t.coversThrough}`);
  for (const [k, s] of Object.entries(r.scores)) console.log(`  ${k.padEnd(9)} risk ${(s.pShort*100).toFixed(2)}%  idle $${f(s.idleUsd)}  yieldLost $${f(s.yieldLost)}  topups ${s.meanTopups.toFixed(1)}  usd ${f(s.usdMed)} [${f(s.usdLo)}-${f(s.usdHi)}]`);
  console.log(`  threshold m=${r.thresholdParams.m.toFixed(2)}  backtest ${r.backtest.hit}/${r.backtest.total}`);
}
console.log('\nROLL', JSON.stringify(R.roll, null, 1));
console.log('ms', Date.now() - t0);
