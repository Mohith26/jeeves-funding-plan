import { generateCompany } from './src/generate.js';
import { runAll } from './src/model.js';
import { FX } from './src/fxdata.js';

const data = generateCompany();
const state = { alpha: 0.01, cost: 150, sel: 'MXN' };
const cache = new Map();
let R = null;

const FLAG = { USD: 'us', MXN: 'mx', BRL: 'br', EUR: 'european_union' };
const SYM = { USD: '$', MXN: 'MX$', BRL: 'R$', EUR: '€' };
const flag = (c) => `https://cdn.jsdelivr.net/gh/HatScripts/circle-flags@gh-pages/flags/${FLAG[c]}.svg`;
const nf = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (c, x, d = 0) => `${SYM[c]}${nf(x, d)}`;
const short = (c, x) => (Math.abs(x) >= 1e6 ? `${SYM[c]}${nf(x / 1e6, 2)}M` : Math.abs(x) >= 1e4 ? `${SYM[c]}${nf(x / 1e3, 0)}k` : money(c, x));
const pct = (x, d = 1) => `${nf(x * 100, d)}%`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dt = (s, withDow = true) => { const d = new Date(s + 'T00:00:00Z'); return `${withDow ? DOW[d.getUTCDay()] + ', ' : ''}${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const $ = (id) => document.getElementById(id);

function compute() {
  const key = `${state.alpha}|${state.cost}`;
  if (!cache.has(key)) cache.set(key, runAll(data, { alpha: state.alpha, topupCost: state.cost }));
  R = cache.get(key);
}

function renderKpis() {
  const r = R.roll;
  const nConv = R.results.reduce((a, x) => a + x.topups.length, 0);
  $('kpis').innerHTML = `
  <div class="kpi"><div class="l"><i class="ti ti-shield-check"></i>Chance of a decline or failed bill, 30 days</div>
    <div class="v">${pct(r.plan.anyShort, 2)}<small>target ${pct(R.alpha, R.alpha < 0.01 ? 1 : 0)}</small></div>
    <div class="s">Measured on 4,000 fresh simulated months the plan never saw</div></div>
  <div class="kpi"><div class="l"><i class="ti ti-coins"></i>Average idle cash in local accounts</div>
    <div class="v">$${nf(r.plan.idleUsd)}</div>
    <div class="s"><b>${pct(r.idleCut, 0)} less</b> than funding the month today ($${nf(r.fundMonth.idleUsd)})</div></div>
  <div class="kpi"><div class="l"><i class="ti ti-trending-up"></i>Yield kept in your USD Cash Account</div>
    <div class="v">$${nf(r.yieldKeptMonth)}<small>/ month</small></div>
    <div class="s">At ${pct(R.apy, 1)} APY, net of conversion effort: $${nf(r.netSavedMonth)}</div></div>
  <div class="kpi"><div class="l"><i class="ti ti-arrows-diagonal"></i>Conversions planned</div>
    <div class="v">${nConv}<small>across ${R.results.length} accounts</small></div>
    <div class="s">Business days only, each one goes through your approval flow</div></div>`;
}

function renderAccounts() {
  const rows = R.results.map((r) => {
    const next = r.topups[0];
    const covered = next ? dt(r.days[Math.max(0, next.t - 1)]) : dt(r.days[r.days.length - 1]);
    const risk = r.scores.plan.pShort;
    return `<div class="acct ${r.ccy === state.sel ? 'sel' : ''}" data-c="${r.ccy}">
      <img class="flag" src="${flag(r.ccy)}" alt="" />
      <div class="nm"><b>${r.acct.name}</b><span>•••• ${r.acct.mask}</span></div>
      <div class="col"><div class="k">Balance</div><div class="x">${money(r.ccy, r.acct.balance, 2)}<span class="chip">${r.ccy}</span></div></div>
      <div class="col"><div class="k">Next conversion</div><div class="x">${next ? `${dt(next.date)} · ~${short(r.ccy, next.amtMed)}` : 'None needed'}</div></div>
      <div><span class="pill ok">${pct(risk, 2)} risk</span></div>
      <i class="ti ti-chevron-right chev"></i></div>`;
  }).join('');
  const usd = data.accounts.find((a) => a.treasury);
  $('accounts').innerHTML = `<div class="head"><div><h3>Local currency accounts</h3>
    <div class="sub">Funded from your USD Cash Account •••• ${usd.mask}. Covered today; conversions are planned just before each account needs them.</div></div>
    <button class="btn dark" id="sendAll"><i class="ti ti-send"></i>Send ${R.results.reduce((a, x) => a + x.topups.length, 0)} for approval</button></div>${rows}`;
  document.querySelectorAll('.acct').forEach((el) => el.addEventListener('click', () => { state.sel = el.dataset.c; renderAccounts(); renderDetail(); }));
  $('sendAll').addEventListener('click', (e) => { e.currentTarget.innerHTML = '<i class="ti ti-check"></i>Drafts created in Accounts payable'; });
}

function renderControls() {
  const usd = data.accounts.find((a) => a.treasury);
  const opts = [0.005, 0.01, 0.02, 0.05];
  $('controls').innerHTML = `<h3>Plan settings</h3>
  <div class="row"><label>Acceptable chance of a decline or failed bill (all accounts, 30 days)</label>
    <div class="seg">${opts.map((a) => `<button data-a="${a}" class="${a === state.alpha ? 'on' : ''}">${pct(a, a < 0.01 ? 1 : 0)}</button>`).join('')}</div></div>
  <div class="row"><label>Effort per conversion (approval time and fees)</label>
    <div class="range"><input type="range" min="0" max="600" step="25" value="${state.cost}" id="cost" /><b id="costv">$${state.cost}</b></div></div>
  <div class="row"><label>Funding source</label>
    <div class="src"><img src="${flag('USD')}" alt="" /><div><b>USD Cash Account •••• ${usd.mask}</b><span>${money('USD', usd.balance, 2)} · earning ${pct(R.apy, 1)} APY</span></div></div></div>
  <div class="row check"><i class="ti ti-chart-dots-3"></i> Forecast check: in <b>${R.roll.btHit} of ${R.roll.btTotal}</b> past 4-week windows, actual card spend landed inside the forecast's 90% range.</div>`;
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { state.alpha = Number(b.dataset.a); rerun(); }));
  const c = $('cost');
  c.addEventListener('input', () => { $('costv').textContent = `$${c.value}`; });
  c.addEventListener('change', () => { state.cost = Number(c.value); rerun(); });
}

function chart(r) {
  const W = 1150, Hh = 250, padL = 78, padR = 14, padT = 14, padB = 30;
  const bands = r.scores.plan.balanceBands;
  const n = bands.length;
  const days = r.days;
  const x = (t) => padL + ((W - padL - padR) * (t + 0.5)) / n;
  const hi = Math.max(...bands.map((b) => b.p95), ...r.topups.map((t) => t.level), r.acct.balance) * 1.08;
  const lo = Math.min(0, ...bands.map((b) => b.p05));
  const y = (v) => padT + (Hh - padT - padB) * (1 - (v - lo) / (hi - lo));
  const ticks = 4;
  let g = '';
  for (let k = 0; k <= ticks; k++) {
    const v = lo + ((hi - lo) * k) / ticks;
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="#f0efed" />`;
    g += `<text x="${padL - 10}" y="${y(v) + 4}" text-anchor="end">${short(r.ccy, v)}</text>`;
  }
  // weekends
  days.forEach((d, t) => { if (!r.business[t]) g += `<rect x="${x(t) - (W - padL - padR) / n / 2}" y="${padT}" width="${(W - padL - padR) / n}" height="${Hh - padT - padB}" fill="#fafaf9" />`; });
  g += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="#d9d6d0" />`;
  const area = bands.map((b, t) => `${x(t)},${y(b.p95)}`).join(' ') + ' ' + bands.map((b, t) => `${x(n - 1 - t)},${y(bands[n - 1 - t].p05)}`).join(' ');
  g += `<polygon points="${area}" fill="#387c85" fill-opacity="0.13" />`;
  g += `<polyline points="${bands.map((b, t) => `${x(t)},${y(b.p50)}`).join(' ')}" fill="none" stroke="#387c85" stroke-width="2" />`;
  // conversions
  r.topups.forEach((tp) => {
    g += `<line x1="${x(tp.t)}" x2="${x(tp.t)}" y1="${y(0)}" y2="${y(tp.level)}" stroke="#c2ab6d" stroke-dasharray="3 3" />`;
    g += `<circle cx="${x(tp.t)}" cy="${y(tp.level)}" r="5" fill="#fff" stroke="#a88f4a" stroke-width="2" class="hov" data-tip="${dt(tp.date)}: top up to ${money(r.ccy, tp.level)}<br>Expected amount ~${money(r.ccy, tp.amtMed)} (${short(r.ccy, tp.amtLo)} to ${short(r.ccy, tp.amtHi)})<br>Covers through ${dt(tp.coversThrough)}" />`;
  });
  // bills
  r.bills.forEach((b) => {
    const t = days.indexOf(b.date);
    if (t < 0) return;
    g += `<rect x="${x(t) - 4}" y="${Hh - padB + 4}" width="8" height="8" rx="2" fill="#374053" class="hov" data-tip="${b.vendor}<br>${money(r.ccy, b.amount)} · ${dt(b.date)} · ${b.status}" />`;
  });
  days.forEach((d, t) => { if (t % 3 === 0) g += `<text x="${x(t)}" y="${Hh - 2}" text-anchor="middle">${dt(d, false)}</text>`; });
  // hover columns
  bands.forEach((b, t) => {
    g += `<rect x="${x(t) - (W - padL - padR) / n / 2}" y="${padT}" width="${(W - padL - padR) / n}" height="${Hh - padT - padB - 14}" fill="transparent" class="hov" data-tip="<b>${dt(days[t])}</b><br>End-of-day balance: ${short(r.ccy, b.p50)}<br>90% range: ${short(r.ccy, b.p05)} to ${short(r.ccy, b.p95)}" />`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${Hh}" width="100%" >${g}</svg>`;
}

function renderDetail() {
  const r = R.results.find((x) => x.ccy === state.sel);
  const fxDate = FX.dates[FX.dates.length - 1];
  const s = r.scores.plan;
  const conv = r.topups.map((tp) => `<tr>
      <td>${dt(tp.date)}<span class="m">${tp.t === 0 ? 'Today' : `In ${tp.t} days`}</span></td>
      <td>USD → ${r.ccy}<span class="m">USD Cash •••• ${data.accounts[0].mask}</span></td>
      <td class="num">${money(r.ccy, tp.level)}</td>
      <td class="num">${money(r.ccy, tp.amtMed)}<span class="m">${short(r.ccy, tp.amtLo)} to ${short(r.ccy, tp.amtHi)}</span></td>
      <td class="num">$${nf(tp.usdMed)}</td>
      <td>${dt(tp.coversThrough)}</td>
      <td><span class="status">Draft</span></td></tr>`).join('');
  const billRows = r.bills.slice().sort((a, b) => a.date.localeCompare(b.date)).map((b) => `<tr><td>${b.vendor}<span class="m">Jeeves Pay</span></td><td>${dt(b.date)}</td><td class="num">${money(r.ccy, b.amount)}</td><td><span class="status ${b.status === 'Scheduled' ? 'sched' : 'appr'}">${b.status}</span></td></tr>`).join('')
    + r.inbox.map((b) => `<tr><td>${b.vendor}<span class="m">Bills inbox</span></td><td>Between ${dt(b.from, false)} and ${dt(b.to, false)}</td><td class="num">${money(r.ccy, b.amount)}</td><td><span class="status">${pct(b.p, 0)} likely this month</span></td></tr>`).join('');
  $('detail').innerHTML = `<div class="head"><div class="dhead"><img src="${flag(r.ccy)}" alt="" /><div><h3>${r.acct.name} <span class="mini">•••• ${r.acct.mask}</span></h3>
      <div class="sub">Projected end-of-day balance with this plan · ${pct(s.pShort, 2)} chance of going short in 30 days</div></div></div>
      <div class="rate">Rate<span class="live">Live</span><b>1 USD = ${nf(r.spot, 4)} ${r.ccy}</b><span class="mini">ECB reference, ${dt(fxDate, false)}</span></div></div>
    <div class="legend"><span><i class="sw" style="background:#387c85"></i>Median balance</span><span><i class="sw" style="background:rgba(56,124,133,.18)"></i>90% of simulated outcomes</span><span><i class="sw" style="background:#fff;border:2px solid #a88f4a;border-radius:50%;width:10px;height:10px"></i>Planned conversion (top-up level)</span><span><i class="sw" style="background:#374053;width:8px"></i>Bill in Jeeves Pay</span><span><i class="sw" style="background:#f3f2ef"></i>Weekend</span></div>
    ${chart(r)}
    <div><div><h3 style="margin-top:16px">Planned conversions</h3>
      <table class="t"><thead><tr><th>Date</th><th>Route</th><th class="num">Top up to</th><th class="num">Expected amount</th><th class="num">≈ USD</th><th>Covers through</th><th>Status</th></tr></thead><tbody>${conv || '<tr><td colspan="7">No conversion needed this month.</td></tr>'}</tbody></table></div>
      <div><h3 style="margin-top:20px">What this account has to cover</h3>
      <table class="t"><thead><tr><th>Payee</th><th>Due</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${billRows}
      <tr><td>Card spend<span class="m">Forecast from the last 26 weeks; avg ${short(r.ccy, r.avgDaily)} per day lately</span></td><td>Daily</td><td class="num">${short(r.ccy, r.meanOutflow - r.bills.reduce((a, b) => a + b.amount, 0) - r.inbox.reduce((a, b) => a + b.amount * b.p, 0))}</td><td><span class="status">Expected, 30 days</span></td></tr></tbody></table></div></div>`;
  bindTips();
}

function renderCompare() {
  const rr = R.roll;
  const row = (name, desc, k, hl) => `<tr class="${hl ? 'hl' : ''}"><td><b style="font-weight:500">${name}</b><span class="m">${desc}</span></td>
    <td class="num">${pct(rr[k].anyShort, 2)}</td><td class="num">$${nf(rr[k].idleUsd)}</td><td class="num">$${nf(rr[k].yieldLost)}</td><td class="num">${nf(rr[k].topups, 1)}</td></tr>`;
  const thr = R.results.map((r) => `${r.ccy} ${nf(5 * r.thresholdParams.m, 1)}/${nf(15 * r.thresholdParams.m, 1)}`).join(', ');
  $('compare').innerHTML = `<div class="head"><div><h3>How the plan compares</h3><div class="sub">All three strategies are tuned to the same risk target on the same simulations, then scored on 4,000 fresh simulated months per account.</div></div></div>
  <table class="t"><thead><tr><th>Strategy</th><th class="num">Chance of any decline (held out)</th><th class="num">Avg idle cash, USD</th><th class="num">Yield forgone, 30 days</th><th class="num">Conversions</th></tr></thead><tbody>
  ${row('Fund the month today', 'One conversion now, sized to the 30-day forecast', 'fundMonth')}
  ${row('Auto top-up rule', `Top up to N days of average spend when below M days (tuned per account, M/N: ${thr})`, 'threshold')}
  ${row('Funding plan', 'Forecast-driven conversions, timed and sized per account', 'plan', true)}
  </tbody></table>`;
}

function renderHow() {
  $('how').innerHTML = `<h3>How the plan is built</h3>
  <ol>
    <li><b style="font-weight:500">Forecast each account's outflows.</b> Card spend is resampled week by week from the account's own last 26 weeks (weekday shape, month-start bump, trend and level uncertainty), plus scheduled Jeeves Pay bills and Bills-inbox invoices that may or may not be paid this month.</li>
    <li><b style="font-weight:500">Price every possible schedule.</b> For each pair of business days, the simulation gives the spend between them; topping up to its upper quantile protects that stretch. A shortest-path search picks the conversion days that minimise forgone yield plus conversion effort.</li>
    <li><b style="font-weight:500">Calibrate the risk.</b> The quantile is searched on ${nf(6000)} simulated months per account until the chance of any shortfall meets your target (with a finite-sample correction), split evenly across accounts.</li>
    <li><b style="font-weight:500">Check it on data it never saw.</b> The finished plan is replayed on 4,000 fresh simulations, and the spend forecast is backtested on the account's own history.</li>
  </ol>
  <div class="assume">Assumptions: USD Cash yield ${pct(R.apy, 1)} APY (Jeeves advertises up to 5%), no yield on local-currency balances, conversions settle same business day, FX moves resampled from 514 days of ECB reference rates. Expected USD amounts use today's rate; the plan does not try to time FX.</div>`;
}

function bindTips() {
  const tip = $('tip');
  document.querySelectorAll('.hov').forEach((el) => {
    el.addEventListener('mousemove', (e) => { tip.innerHTML = el.dataset.tip; tip.style.opacity = 1; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`; });
    el.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  });
}

function renderAll() { renderKpis(); renderAccounts(); renderControls(); renderDetail(); renderCompare(); renderHow(); }

function rerun() {
  document.querySelector('main').classList.add('busy');
  setTimeout(() => { compute(); renderAll(); document.querySelector('main').classList.remove('busy'); }, 30);
}

$('kpis').innerHTML = '<div class="skel" style="grid-column:1/-1">Simulating 30 days of card spend and bills for each account…</div>';
setTimeout(() => { compute(); renderAll(); }, 20);
