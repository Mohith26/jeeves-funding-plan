// Orchestration: forecast -> calibrated plan -> held-out validation -> baselines.
import { mulberry32, parseDate, addDays, iso } from './rng.js';
import { fitSpend, simulateOutflows, fxReturns, simulateFx } from './forecast.js';
import {
  calibratePlan, calibrateFundMonth, calibrateThreshold, evaluateRule,
  planRule, fundMonthRule, thresholdRule, quantileSorted, prefixSums,
} from './plan.js';
import { FX } from './fxdata.js';

export const H = 30;

// Rolling-origin check of the spend forecast on the account's own history:
// fit on data before each origin, predict the next 28 days of card spend,
// count how often the realised total lands inside the central 90% band.
export function backtestCoverage(rows, { origins = 10, horizon = 28, nPaths = 600, seed = 11 } = {}) {
  const rng = mulberry32(seed);
  const n = rows.length;
  let hit = 0, total = 0;
  const pits = [];
  for (let k = 0; k < origins; k++) {
    const cut = n - horizon - 7 * (origins - 1 - k);
    if (cut < 70) continue;
    const model = fitSpend(rows.slice(0, cut));
    const sim = simulateOutflows({ model, bills: [], inbox: [], asOf: rows[cut].date, H: horizon, nPaths, rng });
    const tot = sim.paths.map((o) => o.reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
    const real = rows.slice(cut, cut + horizon).reduce((a, r) => a + r.card, 0);
    const lo = quantileSorted(tot, 0.05), hi = quantileSorted(tot, 0.95);
    if (real >= lo && real <= hi) hit++;
    total++;
    pits.push(tot.filter((v) => v <= real).length / tot.length);
  }
  return { hit, total, pits };
}

export function runAll(data, { alpha = 0.01, topupCost = 150, apy = 0.04, nCal = 6000, nTest = 4000, seed = 7 } = {}) {
  const spot = {};
  for (const c of ['MXN', 'BRL', 'EUR']) spot[c] = FX[c][FX[c].length - 1];
  const results = [];
  const locals = data.accounts.filter((a) => !a.treasury);
  // Company-level target: P(any decline or failed bill in any account) <= alpha.
  // Split evenly across accounts (union bound), so each account gets alpha / k.
  const alphaAcct = alpha / locals.length;
  for (const acct of locals) {
    const ccy = acct.ccy;
    const model = fitSpend(data.history[ccy]);
    const bills = data.bills.filter((b) => b.ccy === ccy);
    const inbox = data.inbox.filter((b) => b.ccy === ccy);
    const cal = simulateOutflows({ model, bills, inbox, asOf: data.asOf, H, nPaths: nCal, rng: mulberry32(seed * 101 + ccy.charCodeAt(0)) });
    const test = simulateOutflows({ model, bills, inbox, asOf: data.asOf, H, nPaths: nTest, rng: mulberry32(seed * 997 + ccy.charCodeAt(1) + 5) });
    const fx = simulateFx({ spot: spot[ccy], returns: fxReturns(FX[ccy]), business: cal.business, nPaths: 1000, rng: mulberry32(seed * 31 + ccy.charCodeAt(2)) });
    const carry = apy / 365 / spot[ccy]; // forgone USD yield per local unit per day
    const avgDaily = data.history[ccy].slice(-56).reduce((a, r) => a + r.card, 0) / 56;

    const cp = calibratePlan({ calPaths: cal.paths, business: cal.business, balance0: acct.balance, alpha: alphaAcct, topupCost, carry });
    const fundLevel = calibrateFundMonth({ calPaths: cal.paths, balance0: acct.balance, alpha: alphaAcct });
    const thr = calibrateThreshold({ calPaths: cal.paths, business: cal.business, balance0: acct.balance, alpha: alphaAcct, avgDaily });

    const score = (rule) => {
      const ev = evaluateRule(test.paths, acct.balance, rule, fx);
      const idleUsd = ev.meanIdle / spot[ccy];
      return {
        ...ev, idleUsd,
        yieldLost: idleUsd * apy / 365 * H,
        opsCost: ev.meanTopups * topupCost,
        usdMed: quantileSorted(ev.usd, 0.5), usdLo: quantileSorted(ev.usd, 0.05), usdHi: quantileSorted(ev.usd, 0.95),
      };
    };
    const plan = cp.plan ? score(planRule(cp.plan)) : null;
    const fundMonth = score(fundMonthRule(fundLevel));
    const threshold = score(thresholdRule(thr.floor, thr.target, cal.business));

    // Planned conversions with the amount distribution implied by the plan.
    const C = prefixSums(test.paths);
    const topups = (cp.plan ? cp.plan.topups : []).map((tp) => {
      const amts = [];
      const prevLevels = cp.plan.topups.filter((x) => x.t < tp.t);
      for (let p = 0; p < test.paths.length; p++) {
        // replay the rule up to day tp.t on this path to get the pre-top-up balance
        let bal = acct.balance;
        for (let t = 0; t < tp.t; t++) {
          const pl = prevLevels.find((x) => x.t === t);
          if (pl) bal = Math.max(bal, pl.level);
          bal -= test.paths[p][t];
        }
        amts.push(Math.max(0, tp.level - bal));
      }
      amts.sort((a, b) => a - b);
      const covered = tp.until;
      return {
        date: cal.days[tp.t], t: tp.t, until: tp.until,
        coversThrough: cal.days[Math.min(covered, H) - 1],
        level: tp.level,
        amtMed: quantileSorted(amts, 0.5), amtLo: quantileSorted(amts, 0.05), amtHi: quantileSorted(amts, 0.95),
        usdMed: quantileSorted(amts, 0.5) / spot[ccy],
      };
    });
    const firstCover = cp.plan ? cal.days[Math.max(0, cp.plan.firstTopup) - 1] || cal.days[0] : null;
    const bt = backtestCoverage(data.history[ccy]);
    results.push({
      acct, ccy, spot: spot[ccy], avgDaily, days: cal.days, business: cal.business,
      bills, inbox, plan: cp.plan, calRisk: cp.calRisk, tried: cp.tried,
      topups, firstTopup: cp.plan ? cp.plan.firstTopup : null, firstCover,
      scores: { plan, fundMonth, threshold },
      thresholdParams: thr, fundLevel, backtest: bt,
      meanOutflow: C.reduce((a, c) => a + c[H], 0) / C.length,
    });
  }
  // Company-level roll-up (USD).
  const sum = (k, s) => results.reduce((a, r) => a + r.scores[s][k], 0);
  const anyShort = (s) => 1 - results.reduce((a, r) => a * (1 - r.scores[s].pShort), 1); // accounts simulated independently
  const roll = {};
  for (const s of ['plan', 'fundMonth', 'threshold']) {
    roll[s] = { idleUsd: sum('idleUsd', s), yieldLost: sum('yieldLost', s), opsCost: sum('opsCost', s), topups: sum('meanTopups', s), anyShort: anyShort(s), maxShort: Math.max(...results.map((r) => r.scores[s].pShort)) };
  }
  roll.idleCut = 1 - roll.plan.idleUsd / roll.fundMonth.idleUsd;
  roll.idleCutVsThreshold = 1 - roll.plan.idleUsd / roll.threshold.idleUsd;
  roll.yieldKeptMonth = roll.fundMonth.yieldLost - roll.plan.yieldLost;
  roll.netSavedMonth = (roll.fundMonth.yieldLost + roll.fundMonth.opsCost) - (roll.plan.yieldLost + roll.plan.opsCost);
  roll.btHit = results.reduce((a, r) => a + r.backtest.hit, 0);
  roll.btTotal = results.reduce((a, r) => a + r.backtest.total, 0);
  return { results, roll, alpha, alphaAcct, topupCost, apy, H, spot };
}

export { iso, parseDate, addDays };
