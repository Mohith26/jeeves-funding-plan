// Outflow forecast for one currency account: card spend (bootstrapped from the
// account's own history) + known Jeeves Pay bills + uncertain Bills-inbox items.
import { parseDate, addDays, iso, dow, normal } from './rng.js';

// Fit a day-of-week x month-start level and keep every whole historical week
// of residual ratios, so simulated weeks keep the real within-week correlation.
export function fitSpend(rows) {
  const n = rows.length;
  const dates = rows.map((r) => parseDate(r.date));
  const x = rows.map((r) => r.card);
  const isMS = dates.map((d) => d.getUTCDate() <= 5);

  // Month-start uplift: ratio of mean spend on days 1-5 vs other days, same weekday mix.
  const sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
  const sumMS = new Array(7).fill(0), cntMS = new Array(7).fill(0);
  for (let i = 0; i < n; i++) {
    const d = dow(dates[i]);
    if (isMS[i]) { sumMS[d] += x[i]; cntMS[d]++; } else { sum[d] += x[i]; cnt[d]++; }
  }
  let num = 0, den = 0;
  for (let d = 0; d < 7; d++) if (cntMS[d] && cnt[d]) { num += sumMS[d]; den += (cntMS[d] * sum[d]) / cnt[d]; }
  const monthStart = den > 0 ? num / den : 1;

  // Weekday level over the whole history (month-start removed).
  const allLv = sum.map((s, d) => s / cnt[d]);
  const ratios = x.map((v, i) => v / (allLv[dow(dates[i])] * (isMS[i] ? monthStart : 1)));

  // Monday-aligned whole weeks of ratios.
  const weeks = [];
  let i0 = 0;
  while (i0 < n && dow(dates[i0]) !== 0) i0++;
  for (let i = i0; i + 7 <= n; i += 7) weeks.push(ratios.slice(i, i + 7));
  const W = weeks.length;

  // Log-linear trend across weeks: log(weekly mean ratio) = a + b * week.
  const lw = weeks.map((w) => Math.log(w.reduce((a, r) => a + r, 0) / 7));
  const wbar = (W - 1) / 2;
  const ybar = lw.reduce((a, b) => a + b, 0) / W;
  let sxx = 0, sxy = 0;
  for (let k = 0; k < W; k++) { sxx += (k - wbar) ** 2; sxy += (k - wbar) * (lw[k] - ybar); }
  const b = sxy / sxx, a = ybar - b * wbar;
  let rss = 0;
  for (let k = 0; k < W; k++) rss += (lw[k] - a - b * k) ** 2;
  const s = Math.sqrt(rss / Math.max(1, W - 2));
  // weeks between the first full week and the forecast origin (end of history)
  const wNext = (n - i0) / 7;
  const sdTrend = s * Math.sqrt(1 / W + (wNext - wbar) ** 2 / sxx);
  // Weekly levels are autocorrelated, so a month of independent bootstrapped
  // weeks would be too narrow: add the extra spread seen in rolling 4-week means.
  const e = lw.map((y, k) => y - a - b * k);
  const r4 = [];
  for (let k = 0; k + 4 <= W; k++) r4.push((e[k] + e[k + 1] + e[k + 2] + e[k + 3]) / 4);
  const m4 = r4.reduce((acc, v) => acc + v, 0) / r4.length;
  const sd4 = Math.sqrt(r4.reduce((acc, v) => acc + (v - m4) ** 2, 0) / Math.max(1, r4.length - 1));
  const sdPersist = Math.sqrt(Math.max(0, sd4 * sd4 - (s * s) / 4));
  const sdLevel = Math.sqrt(sdTrend * sdTrend + sdPersist * sdPersist);
  const levelNow = Math.exp(a + b * wNext);
  const level = allLv.map((v) => v * levelNow);

  // Detrended residual weeks (mean 1), resampled whole to keep within-week shape.
  const detr = weeks.map((w, k) => w.map((r) => r / Math.exp(a + b * k)));
  const m = detr.flat().reduce((acc, r) => acc + r, 0) / (W * 7);
  return { level, monthStart, weeks: detr.map((w) => w.map((r) => r / m)), trendPerDay: b / 7, sdLevel, weeklySd: s };
}

// Simulate nPaths x H daily outflows starting at asOf (day 0 = asOf).
export function simulateOutflows({ model, bills, inbox, asOf, H, nPaths, rng }) {
  const start = parseDate(asOf);
  const days = Array.from({ length: H }, (_, t) => addDays(start, t));
  const dayIdx = new Map(days.map((d, t) => [iso(d), t]));
  const fixed = new Float64Array(H);
  for (const b of bills) {
    const t = dayIdx.get(b.date);
    if (t !== undefined) fixed[t] += b.amount;
  }
  const paths = [];
  const W = model.weeks.length;
  for (let p = 0; p < nPaths; p++) {
    const o = new Float64Array(H);
    // block bootstrap: each calendar week takes one historical week's ratios
    let week = null;
    const lvl = Math.exp(model.sdLevel * normal(rng) - (model.sdLevel ** 2) / 2);
    for (let t = 0; t < H; t++) {
      const d = dow(days[t]);
      if (t === 0 || d === 0) week = model.weeks[Math.floor(rng() * W)];
      const ms = days[t].getUTCDate() <= 5 ? model.monthStart : 1;
      o[t] = model.level[d] * lvl * Math.exp(model.trendPerDay * t) * ms * week[d] + fixed[t];
    }
    for (const it of inbox) {
      if (rng() < it.p) {
        const a = dayIdx.get(it.from), b = dayIdx.get(it.to);
        if (a === undefined || b === undefined) continue;
        o[a + Math.floor(rng() * (b - a + 1))] += it.amount;
      }
    }
    paths.push(o);
  }
  return { days: days.map(iso), business: days.map((d) => dow(d) < 5), paths, fixed: Array.from(fixed) };
}

// Bootstrap FX paths (local currency per USD) from real daily log returns.
export function fxReturns(series) {
  const r = [];
  for (let i = 1; i < series.length; i++) r.push(Math.log(series[i] / series[i - 1]));
  return r;
}
export function simulateFx({ spot, returns, business, nPaths, rng }) {
  const H = business.length;
  const out = [];
  for (let p = 0; p < nPaths; p++) {
    const f = new Float64Array(H);
    let x = spot;
    for (let t = 0; t < H; t++) {
      if (t > 0 && business[t]) x *= Math.exp(returns[Math.floor(rng() * returns.length)]);
      f[t] = x;
    }
    out.push(f);
  }
  return out;
}

export { normal };
