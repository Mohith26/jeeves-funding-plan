// Seeded synthetic customer: a Mexico-incorporated logistics company that runs
// fuel/toll cards and supplier payments out of MXN, BRL and EUR Cash accounts,
// and keeps its treasury in a yield-earning USD Cash account.
import { mulberry32, normal, parseDate, addDays, iso, dow } from './rng.js';

export const AS_OF = '2026-11-10'; // Tuesday
export const HISTORY_DAYS = 182;

const PROFILES = {
  MXN: { weekday: 385000, weekend: 0.42, sigma: 0.24, growth: 0.0009, bigP: 0.035, monthStart: 1.22 },
  BRL: { weekday: 61000, weekend: 0.35, sigma: 0.28, growth: 0.0012, bigP: 0.03, monthStart: 1.15 },
  EUR: { weekday: 9400, weekend: 0.25, sigma: 0.31, growth: 0.0005, bigP: 0.04, monthStart: 1.1 },
};
// Day-of-week shape (Mon..Sun) on top of the weekday/weekend split.
const DOW_SHAPE = [1.08, 1.0, 0.97, 1.02, 1.12, 1, 0.8];

function dailySpend(p, date, dayIndex, rng, weekShock) {
  const d = dow(date);
  let level = p.weekday * Math.exp(p.growth * dayIndex) * DOW_SHAPE[d];
  if (d >= 5) level *= p.weekend;
  if (date.getUTCDate() <= 5) level *= p.monthStart;
  let x = level * Math.exp(p.sigma * normal(rng) - (p.sigma * p.sigma) / 2 + weekShock);
  if (rng() < p.bigP) x += level * (1.5 + 2.5 * rng()); // occasional large ticket
  return Math.round(x * 100) / 100;
}

export function generateCompany(seed = 20261110) {
  const rng = mulberry32(seed);
  const asOf = parseDate(AS_OF);
  const start = addDays(asOf, -HISTORY_DAYS);
  const history = {};
  for (const ccy of Object.keys(PROFILES)) {
    const p = PROFILES[ccy];
    const rows = [];
    let weekShock = 0;
    for (let i = 0; i < HISTORY_DAYS; i++) {
      const date = addDays(start, i);
      if (dow(date) === 0) weekShock = 0.6 * weekShock + 0.07 * normal(rng);
      rows.push({ date: iso(date), card: dailySpend(p, date, i, rng, weekShock) });
    }
    history[ccy] = rows;
  }

  // Known supplier payments in Jeeves Pay over the next 30 days.
  const bill = (ccy, vendor, date, amount, status) => ({ ccy, vendor, date, amount, status });
  const bills = [
    bill('MXN', 'Combustibles del Bajío', '2026-11-13', 1460000, 'Scheduled'),
    bill('MXN', 'Arrendadora Tractocamiones MX', '2026-12-01', 2380000, 'Scheduled'),
    bill('MXN', 'Combustibles del Bajío', '2026-11-27', 1525000, 'Awaiting approval'),
    bill('MXN', 'Autopistas y Peajes del Norte', '2026-11-20', 612000, 'Scheduled'),
    bill('MXN', 'Seguros Atlas Flotillas', '2026-12-04', 845000, 'Awaiting approval'),
    bill('BRL', 'Locadora Paulista de Veículos', '2026-11-16', 412000, 'Scheduled'),
    bill('BRL', 'Posto Rodovia Sul Ltda', '2026-11-30', 238500, 'Scheduled'),
    bill('BRL', 'Armazéns Santos Logística', '2026-12-07', 356000, 'Awaiting approval'),
    bill('EUR', 'Hafen Logistik GmbH', '2026-11-18', 96400, 'Scheduled'),
    bill('EUR', 'Iberia Cargo Handling SL', '2026-12-02', 58200, 'Awaiting approval'),
  ];
  // Invoices sitting in the Bills inbox: amount known, payment date and
  // whether they get paid this month are not.
  const inbox = [
    { ccy: 'MXN', vendor: 'Llantas y Rines del Norte', amount: 640000, from: '2026-11-12', to: '2026-11-24', p: 0.85 },
    { ccy: 'MXN', vendor: 'Talleres Diesel Monterrey', amount: 318000, from: '2026-11-16', to: '2026-12-04', p: 0.6 },
    { ccy: 'BRL', vendor: 'Pneus Brasil Distribuidora', amount: 127000, from: '2026-11-17', to: '2026-12-01', p: 0.7 },
    { ccy: 'EUR', vendor: 'Rotterdam Port Services BV', amount: 31800, from: '2026-11-19', to: '2026-12-03', p: 0.5 },
  ];

  const accounts = [
    { id: 'usd', ccy: 'USD', name: 'USD Cash Account', mask: '4417', balance: 3184250.12, treasury: true },
    { id: 'mxn', ccy: 'MXN', name: 'MXN Cash Account', mask: '0921', balance: 2365400.55 },
    { id: 'brl', ccy: 'BRL', name: 'BRL Cash Account', mask: '7730', balance: 498300.4 },
    { id: 'eur', ccy: 'EUR', name: 'EUR Cash Account', mask: '5108', balance: 141250.0 },
  ];

  return {
    company: 'Rutas del Norte',
    entity: 'Rutas del Norte - México',
    user: { name: 'Valeria Ortiz', email: 'valeria.ortiz@rutasdelnorte.mx', role: 'Admin' },
    asOf: AS_OF,
    accounts,
    history,
    bills,
    inbox,
  };
}
