// Small seeded RNG so every number on the page is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Dates are handled as UTC midnight to avoid timezone drift.
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}
export function iso(date) {
  return date.toISOString().slice(0, 10);
}
export function dow(date) {
  // 0 = Monday ... 6 = Sunday
  return (date.getUTCDay() + 6) % 7;
}
export function isBusinessDay(date) {
  return dow(date) < 5;
}
