import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLabels, loadFormulary, validateLabel } from '../src/data.mjs';

test('every label spec is valid and ids are unique', () => {
  const labels = loadLabels();
  assert.ok(labels.length >= 30, `expected at least 30 labels, got ${labels.length}`);
  const kinds = Object.groupBy(labels, (l) => l.kind);
  assert.ok(kinds.rx.length >= 15 && kinds.otc.length >= 8 && kinds.food.length >= 7);
});

test('every drug label has a formulary entry that includes its printed strength', () => {
  const formulary = loadFormulary();
  for (const l of loadLabels().filter((x) => x.kind !== 'food')) {
    const entry = formulary[l.name.toLowerCase()];
    assert.ok(entry, `${l.id}: missing formulary entry`);
    assert.equal(entry.unit, l.strength.unit, `${l.id}: unit mismatch`);
    assert.ok(entry.strengths.includes(l.strength.value), `${l.id}: ${l.strength.value} not in formulary`);
  }
});

test('validateLabel catches bad specs', () => {
  assert.ok(validateLabel({ id: 'Bad Id', kind: 'rx', name: 'X', distractor: 'x', expiry: 'soon' }).length >= 4);
  assert.deepEqual(validateLabel({ id: 'ok', kind: 'food', name: 'Rice', distractor: 'Corn', expiry: '2027-01-01', allergens: [], may_contain: [] }), []);
});
