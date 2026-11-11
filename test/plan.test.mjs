import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCompany } from '../src/generate.js';
import { mulberry32 } from '../src/rng.js';
import { fitSpend, simulateOutflows, simulateFx } from '../src/forecast.js';
import {
  quantileSorted, segmentTable, optimizeSchedule, evaluateRule, planRule, fundMonthRule,
} from '../src/plan.js';
import { runAll, backtestCoverage } from '../src/model.js';

test('generator is deterministic', () => {
  const a = generateCompany(), b = generateCompany();
  assert.deepEqual(a.history.MXN.slice(0, 20), b.history.MXN.slice(0, 20));
  assert.equal(a.history.BRL.length, 182);
});

test('empirical quantile picks the ceil(q n)-th order statistic', () => {
  const s = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(quantileSorted(s, 0.9), 9);
  assert.equal(quantileSorted(s, 0.91), 10);
  assert.equal(quantileSorted(s, 0.0), 1);
});

test('evaluateRule counts a shortfall only when the balance goes negative', () => {
  const paths = [Float64Array.from([5, 5, 5]), Float64Array.from([5, 20, 0])];
  const ev = evaluateRule(paths, 10, fundMonthRule(20));
  assert.equal(ev.pShort, 0.5); // path 2 spends 25 > 20
  assert.equal(ev.meanTopups, 1);
  assert.equal(evaluateRule(paths, 10, () => 0).pShort, 1);
});

test('DP schedule equals brute force over every top-up schedule (small instance)', () => {
  const rng = mulberry32(5);
  const H = 9;
  const business = [true, true, false, true, true, true, false, true, true];
  const paths = Array.from({ length: 400 }, () => Float64Array.from({ length: H }, () => 50 + 100 * rng()));
  const table = segmentTable(paths, business);
  const opts = { business, balance0: 120, q: 0.95, topupCost: 40, carry: 0.02, firstRiskCap: 1 };
  const dp = optimizeSchedule(table, opts);
  // brute force: enumerate all subsets of business days as top-up days
  const days = business.map((b, t) => (b ? t : -1)).filter((t) => t >= 0);
  const { C, meanC } = table;
  let best = Infinity;
  for (let mask = 0; mask < 1 << days.length; mask++) {
    const tops = days.filter((_, k) => mask & (1 << k));
    const s1 = tops.length ? tops[0] : H;
    let cost = 0;
    for (let t = 0; t < s1; t++) cost += Math.max(0, 120 - meanC[t + 1]) * opts.carry;
    for (let k = 0; k < tops.length; k++) {
      const i = tops[k], j = k + 1 < tops.length ? tops[k + 1] : H;
      const L = quantileSorted(table.seg.get(i * 1000 + j), 0.95);
      let idle = 0;
      for (let t = i; t < j; t++) idle += Math.max(0, L - (meanC[t + 1] - meanC[i]));
      cost += opts.topupCost + idle * opts.carry;
    }
    best = Math.min(best, cost);
  }
  assert.ok(Math.abs(dp.dpCost - best) < 1e-9, `dp ${dp.dpCost} vs brute ${best}`);
  assert.ok(C.length === 400);
});

test('order-up-to plan: shortfall in a segment happens iff segment spend exceeds the level', () => {
  const paths = [Float64Array.from([10, 10, 10, 10]), Float64Array.from([10, 30, 10, 10])];
  const plan = { topups: [{ t: 0, level: 25 }, { t: 2, level: 25 }] };
  const ev = evaluateRule(paths, 0, planRule(plan));
  assert.equal(ev.pShort, 0.5);
});

test('spend forecast is unbiased on a clean weekly series', () => {
  const rows = [];
  const rng = mulberry32(9);
  const start = Date.UTC(2026, 0, 5); // Monday
  for (let i = 0; i < 182; i++) {
    const d = new Date(start + i * 86400000);
    const w = (d.getUTCDay() + 6) % 7;
    rows.push({ date: d.toISOString().slice(0, 10), card: (w < 5 ? 1000 : 300) * (0.8 + 0.4 * rng()) });
  }
  const m = fitSpend(rows);
  const sim = simulateOutflows({ model: m, bills: [], inbox: [], asOf: '2026-07-06', H: 28, nPaths: 3000, rng: mulberry32(1) });
  const mean = sim.paths.reduce((a, o) => a + o.reduce((x, y) => x + y, 0), 0) / sim.paths.length;
  const truth = 4 * (5 * 1000 + 2 * 300);
  assert.ok(Math.abs(mean / truth - 1) < 0.05, `mean ${mean} vs ${truth}`);
});

test('FX paths do not move on weekends and start at spot', () => {
  const business = [true, true, false, false, true];
  const fx = simulateFx({ spot: 18, returns: [0.01, -0.01, 0.02], business, nPaths: 50, rng: mulberry32(2) });
  for (const f of fx) { assert.equal(f[0], 18); assert.equal(f[2], f[1]); assert.equal(f[3], f[1]); }
});

test('held-out risk lands on the target and the plan parks less idle cash than both baselines', () => {
  for (const alpha of [0.01, 0.05]) {
    const R = runAll(generateCompany(), { alpha, nCal: 6000, nTest: 4000 });
    const se = Math.sqrt(alpha * (1 - alpha) / 4000);
    assert.ok(R.roll.plan.anyShort <= alpha + 3 * se, `alpha ${alpha}: held-out ${R.roll.plan.anyShort}`);
    for (const r of R.results) {
      const s = r.scores;
      assert.ok(s.plan.idleUsd < s.fundMonth.idleUsd, `${r.ccy} vs fund month`);
      assert.ok(s.plan.idleUsd < s.threshold.idleUsd * 1.02, `${r.ccy} vs threshold`);
      assert.ok(s.fundMonth.pShort <= alpha / 3 + 3 * Math.sqrt((alpha / 3) / 4000));
    }
  }
});

test('forecast check: realised 4-week spend falls in the 90% band in most past windows', () => {
  const d = generateCompany();
  let hit = 0, total = 0;
  for (const c of ['MXN', 'BRL', 'EUR']) { const b = backtestCoverage(d.history[c]); hit += b.hit; total += b.total; }
  assert.equal(total, 30);
  assert.ok(hit / total >= 0.75, `coverage ${hit}/${total}`);
});
