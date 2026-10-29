// Turns free-form model answers into comparable values: names, strengths, dose frequency, dates, allergens.

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
const squash = (s) => norm(s).replace(/[\s.]/g, '');

export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// 'match' | 'distractor' | 'other' | 'empty'. The look-alike distractor always counts as wrong.
export function nameVerdict(answer, truth, distractor) {
  const a = squash(answer);
  if (!a) return 'empty';
  const t = squash(truth), x = squash(distractor);
  if (x && a.includes(x) && !a.includes(t)) return 'distractor';
  if (a.includes(t)) return 'match';
  // one typo of slack on the key word (the longest word of the true name)
  const key = norm(truth).split(' ').sort((p, q) => q.length - p.length)[0];
  const words = norm(answer).split(' ');
  if (key.length >= 6 && words.some((w) => editDistance(w, key) <= 1) && !words.some((w) => w === norm(distractor))) return 'match';
  return 'other';
}

const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, fifty: 50, hundred: 100 };
const UNIT_ALIASES = [
  [/^(mg|milligrams?)$/, 'mg'],
  [/^(mcg|µg|ug|micrograms?)$/, 'mcg'],
  [/^(g|grams?)$/, 'g'],
  [/^(ml|milliliters?|millilitres?)$/, 'mL'],
];
export function normUnit(u) {
  const s = String(u ?? '').toLowerCase().replace(/µ/g, 'u').trim();
  for (const [re, out] of UNIT_ALIASES) if (re.test(s)) return out;
  return s;
}

// Accepts "25", "25 mg", "0.1mg", "twenty five" with an optional separate unit. Returns { value, unit } or null.
export function parseStrength(value, unit) {
  const raw = String(value ?? '').toLowerCase().replace(/,/g, '').trim();
  if (!raw) return null;
  const m = /(\d+(?:\.\d+)?|\.\d+)\s*([a-zµ]+)?/.exec(raw);
  let v = m ? parseFloat(m[1]) : NaN;
  if (Number.isNaN(v)) v = raw.split(/[\s-]+/).reduce((s, w) => s + (NUM_WORDS[w] ?? NaN), 0);
  if (Number.isNaN(v)) return null;
  return { value: v, unit: normUnit(unit || m?.[2] || '') };
}

export function strengthMatch(answer, truth) {
  if (!answer) return false;
  return Math.abs(answer.value - truth.value) < 1e-9 && answer.unit === truth.unit;
}

// Doses per day from directions text, or null if it cannot tell.
export function perDay(text) {
  const t = norm(text);
  if (!t) return null;
  const every = /every (\d+|four|six|eight|twelve) hours?/.exec(t);
  if (every) return 24 / (Number(every[1]) || NUM_WORDS[every[1]]);
  if (/\b(three times|3 times|tid)\b/.test(t)) return 3;
  if (/\b(four times|4 times|qid)\b/.test(t)) return 4;
  if (/\b(twice|two times|2 times|bid)\b/.test(t)) return 2;
  if (/\b(once|one time|1 time|qd|daily|at bedtime|in the morning|every day)\b/.test(t)) return 1;
  return null;
}

// Units per dose ("Take 2 caplets"), or null.
export function perDose(text) {
  const m = /take (\d+|one|two|three)\b/.exec(norm(text));
  return m ? Number(m[1]) || NUM_WORDS[m[1]] : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

// ISO date from common label formats (US month-first for slashes), or null.
export function parseDate(text) {
  const t = String(text ?? '').toLowerCase().trim();
  let m;
  if ((m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t))) return iso(+m[1], +m[2], +m[3]);
  if ((m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t))) return iso(+m[3], +m[1], +m[2]);
  if ((m = /(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(t)) && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1]);
  if ((m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(t)) && MONTHS[m[1]]) return iso(+m[3], MONTHS[m[1]], +m[2]);
  return null;
}

const singular = (w) => w.replace(/(nuts|nut)$/, 'nut').replace(/(ies)$/, 'y').replace(/s$/, '');
export function allergenSet(list) {
  return new Set((list ?? []).flatMap((x) => String(x).split(/,|\band\b/)).map((x) => singular(norm(x))).filter(Boolean));
}
export const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
