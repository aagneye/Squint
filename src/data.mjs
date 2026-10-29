// Loads and validates the ground-truth label specs and the formulary.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const OUT = path.join(ROOT, 'out');

const KINDS = new Set(['rx', 'otc', 'food']);
const UNITS = new Set(['mg', 'mcg', 'g', 'mL']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Returns a list of problems; empty means the spec is valid.
export function validateLabel(l) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  need(typeof l.id === 'string' && /^[a-z0-9_]+$/.test(l.id), 'id must be snake_case');
  need(KINDS.has(l.kind), `kind must be one of ${[...KINDS].join(', ')}`);
  need(typeof l.name === 'string' && l.name.length > 1, 'name required');
  need(typeof l.distractor === 'string' && l.distractor.toLowerCase() !== String(l.name).toLowerCase(), 'distractor must differ from name');
  need(ISO_DATE.test(l.expiry) && !Number.isNaN(Date.parse(l.expiry)), 'expiry must be an ISO date');
  if (l.kind === 'food') {
    need(Array.isArray(l.allergens), 'food needs allergens[]');
    need(Array.isArray(l.may_contain), 'food needs may_contain[]');
  } else {
    need(l.strength && typeof l.strength.value === 'number' && l.strength.value > 0, 'strength.value must be a positive number');
    need(l.strength && UNITS.has(l.strength.unit), `strength.unit must be one of ${[...UNITS].join(', ')}`);
    need(typeof l.directions === 'string' && l.directions.length > 5, 'directions required');
    need(Number.isInteger(l.per_day) && l.per_day >= 1 && l.per_day <= 12, 'per_day must be 1..12');
    need(typeof l.form === 'string', 'form required');
  }
  return p;
}

export function loadLabels(file = path.join(DATA, 'labels.json')) {
  const labels = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  const ids = new Set();
  for (const l of labels) {
    for (const msg of validateLabel(l)) problems.push(`${l.id ?? '?'}: ${msg}`);
    if (ids.has(l.id)) problems.push(`${l.id}: duplicate id`);
    ids.add(l.id);
  }
  if (problems.length) throw new Error('invalid label specs:\n  ' + problems.join('\n  '));
  return labels;
}

export function loadFormulary(file = path.join(DATA, 'formulary.json')) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  delete f._note;
  return f;
}
