// Funding plan: chance-constrained, just-in-time top-ups for one currency account.
//
// Decision: on which business days to convert USD into this account, and the
// balance to top up to each time ("order-up-to level"), so that across the
// horizon P(any card decline or failed bill) <= alpha, while keeping as little
// idle cash out of the yield-earning USD account as possible.
//
// Method
//  1. Simulated outflow paths (forecast.js) give, for every possible top-up day
//     i and next top-up day j, the distribution of spend in [i, j).
//  2. For a per-top-up quantile q, the level for segment [i, j) is the q-quantile
//     of that spend. A shortest-path DP over top-up days picks the schedule that
//     minimises conversion cost + forgone yield on idle cash.
//  3. q is searched on a calibration set of paths: the cheapest plan whose
//     simulated plan-level risk (union over all segments) is <= alpha wins.
//  4. The chosen plan is re-scored on an independent held-out set of paths.

export function quantileSorted(sorted, q) {
  const n = sorted.length;
  const k = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[k];
}

export function prefixSums(paths) {
  return paths.map((o) => {
    const c = new Float64Array(o.length + 1);
    for (let t = 0; t < o.length; t++) c[t + 1] = c[t] + o[t];
    return c;
  });
}

// Pre-sorted segment totals for every (i, j) with i a business day, i < j <= H.
export function segmentTable(paths, business) {
  const H = business.length;
  const C = prefixSums(paths);
  const N = paths.length;
  const meanC = new Float64Array(H + 1);
  for (const c of C) for (let t = 0; t <= H; t++) meanC[t] += c[t] / N;
  const seg = new Map();
  for (let i = 0; i < H; i++) {
    if (!business[i]) continue;
    for (let j = i + 1; j <= H; j++) {
      const a = new Float64Array(N);
      for (let p = 0; p < N; p++) a[p] = C[p][j] - C[p][i];
      a.sort();
      seg.set(i * 1000 + j, a);
    }
  }
  const totals = Float64Array.from(C.map((c) => c[H])).sort();
  return { H, N, C, meanC, seg, totals };
}

// DP over top-up days for a fixed per-segment quantile q.
export function optimizeSchedule(table, { business, balance0, q, topupCost, carry, firstRiskCap }) {
  const { H, C, meanC, seg, N } = table;
  const INF = Infinity;
  const f = new Float64Array(H + 1).fill(INF);
  const prev = new Int32Array(H + 1).fill(-2);
  // First segment [0, s1) is carried by today's balance (no conversion).
  for (let s1 = 0; s1 <= H; s1++) {
    if (s1 < H && !business[s1]) continue;
    let over = 0;
    for (let p = 0; p < N; p++) if (C[p][s1] > balance0) over++;
    if (over / N > firstRiskCap) continue;
    let idle = 0;
    for (let t = 0; t < s1; t++) idle += Math.max(0, balance0 - meanC[t + 1]);
    f[s1] = idle * carry;
    prev[s1] = -1;
  }
  const levels = new Map();
  for (let i = 0; i < H; i++) {
    if (!business[i] || f[i] === INF) continue;
    for (let j = i + 1; j <= H; j++) {
      if (j < H && !business[j]) continue;
      const L = quantileSorted(seg.get(i * 1000 + j), q);
      let idle = 0;
      for (let t = i; t < j; t++) idle += Math.max(0, L - (meanC[t + 1] - meanC[i]));
      const cost = f[i] + topupCost + idle * carry;
      if (cost < f[j]) { f[j] = cost; prev[j] = i; }
      levels.set(i * 1000 + j, L);
    }
  }
  if (f[H] === INF) return null;
  const tops = [];
  let j = H;
  while (prev[j] >= 0) {
    const i = prev[j];
    tops.push({ t: i, until: j, level: levels.get(i * 1000 + j) });
    j = i;
  }
  tops.reverse();
  return { q, firstTopup: j, topups: tops, dpCost: f[H] };
}

// Run a funding rule against outflow paths. rule(t, bal) -> amount to convert.
export function evaluateRule(paths, balance0, rule, fxPaths = null) {
  const N = paths.length, H = paths[0].length;
  let short = 0, idleSum = 0, topups = 0, converted = 0;
  const usd = [];
  const endBal = new Float64Array(N);
  const balQ = Array.from({ length: H }, () => new Float64Array(N));
  for (let p = 0; p < N; p++) {
    const o = paths[p];
    let bal = balance0, s = false, u = 0;
    for (let t = 0; t < H; t++) {
      const amt = rule(t, bal);
      if (amt > 0) {
        bal += amt; topups++; converted += amt;
        if (fxPaths) u += amt / fxPaths[p % fxPaths.length][t];
      }
      bal -= o[t];
      if (bal < -1e-6) s = true;
      idleSum += Math.max(0, bal);
      balQ[t][p] = bal;
    }
    if (s) short++;
    endBal[p] = bal;
    if (fxPaths) usd.push(u);
  }
  for (const a of balQ) a.sort();
  return {
    pShort: short / N,
    meanIdle: idleSum / (N * H), // average end-of-day balance, local currency
    meanTopups: topups / N,
    meanConverted: converted / N,
    usd: fxPaths ? usd.sort((a, b) => a - b) : null,
    balanceBands: balQ.map((a) => ({
      p05: quantileSorted(a, 0.05), p50: quantileSorted(a, 0.5), p95: quantileSorted(a, 0.95), min: a[0],
    })),
  };
}

export const planRule = (plan) => {
  const at = new Map(plan.topups.map((x) => [x.t, x.level]));
  return (t, bal) => (at.has(t) ? Math.max(0, at.get(t) - bal) : 0);
};
export const fundMonthRule = (level) => (t, bal) => (t === 0 ? Math.max(0, level - bal) : 0);
export const thresholdRule = (floor, target, business) => (t, bal) =>
  business[t] && bal < floor ? target - bal : 0;

// Cheapest plan whose simulated plan-level risk on the calibration paths is <= alpha.
export function calibratePlan({ calPaths, business, balance0, alpha, topupCost, carry }) {
  // Cross-fitting: segment quantiles come from one half of the calibration
  // paths, the plan-level risk is scored on the other half, so picking the
  // cheapest feasible q does not reward a q that is lucky on its own data.
  const half = Math.floor(calPaths.length / 2);
  const fitPaths = calPaths.slice(0, half), scorePaths = calPaths.slice(half);
  const table = segmentTable(fitPaths, business);
  const qs = [];
  for (let k = 0; k <= 48; k++) qs.push(1 - alpha * Math.pow(10, -k / 16));
  let best = null;
  const tried = [];
  for (const q of qs) {
    const plan = optimizeSchedule(table, { business, balance0, q, topupCost, carry, firstRiskCap: alpha / 4 });
    if (!plan) continue;
    const ev = evaluateRule(scorePaths, balance0, planRule(plan));
    const cost = ev.meanIdle * scorePaths[0].length * carry + ev.meanTopups * topupCost;
    // Finite-sample (conformal-style) correction: (failures + 1) / (N + 1) <= alpha,
    // so the selection step does not overfit the calibration paths.
    const n = scorePaths.length;
    const risk = (ev.pShort * n + 1) / (n + 1);
    tried.push({ q, risk, cost, topups: plan.topups.length });
    if (risk <= alpha && (!best || cost < best.cost)) best = { plan, cost, calRisk: ev.pShort };
  }
  return best ? { ...best, tried, table } : { plan: null, tried, table };
}

export function calibrateFundMonth({ calPaths, balance0, alpha }) {
  const table = prefixSums(calPaths).map((c) => c[c.length - 1]).sort((a, b) => a - b);
  const n = table.length;
  // same finite-sample correction as the plan: the ceil((1 - alpha)(n + 1))-th order statistic
  const k = Math.min(n - 1, Math.ceil((1 - alpha) * (n + 1)) - 1);
  return Math.max(balance0, table[k]);
}

// Classic auto top-up rule (floor/target in days of average spend), scaled until it meets alpha.
export function calibrateThreshold({ calPaths, business, balance0, alpha, avgDaily }) {
  for (let m = 0.4; m <= 8; m += 0.05) {
    const floor = 5 * m * avgDaily, target = 15 * m * avgDaily;
    const ev = evaluateRule(calPaths, balance0, thresholdRule(floor, target, business));
    const n = calPaths.length;
    if ((ev.pShort * n + 1) / (n + 1) <= alpha) return { floor, target, m };
  }
  return { floor: 40 * avgDaily, target: 120 * avgDaily, m: 8 };
}
