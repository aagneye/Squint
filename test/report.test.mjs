import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRecords, buildReport, summaryMarkdown, writeReport } from '../src/report/report.mjs';
import { loadLabels } from '../src/data.mjs';

const labels = loadLabels();
const good = { name: 'Hydralazine', strength_value: '25', strength_unit: 'mg', directions: 'Take 1 tablet by mouth twice daily', expiry: '01/09/2027', allergens: [], may_contain: [], can_read: 'yes', confidence: 'high' };
const bad = { ...good, name: 'Hydroxyzine', strength_value: '10', expiry: '01/09/2021' };
const shrug = { ...good, name: '', strength_value: '', strength_unit: '', directions: '', expiry: '', can_read: 'no', confidence: 'low' };

function records() {
  const r = [];
  for (const level of [0, 3, 6]) {
    r.push({ id: 'rx_hydralazine', cond: 'blur', level, model: 'muse-spark-1.3', mode: 'baseline', seed: 0, answer: level === 6 ? bad : good, cost: 0.002, ms: 900 });
    r.push({ id: 'rx_hydralazine', cond: 'blur', level, model: 'muse-spark-1.3', mode: 'abstain', seed: 0, answer: level === 6 ? shrug : good, cost: 0.002, ms: 950 });
  }
  return r;
}

test('report: headline, boundary, money and slider', () => {
  const rep = buildReport(records(), labels);
  const base = rep.headline.find((h) => h.mode === 'baseline');
  const guard = rep.headline.find((h) => h.mode === 'abstain');
  assert.ok(base.wrong_confident > 0 && guard.wrong_confident === 0);
  assert.equal(base.unsafe, 1 / 3);
  assert.equal(guard.unsafe, 0);
  assert.equal(rep.boundaries.find((b) => b.mode === 'baseline').boundary, 6);
  assert.equal(rep.slider.frames.length, 3);
  assert.equal(rep.slider.frames[2].answers['muse-spark-1.3|baseline'].name, 'Hydroxyzine');
  assert.equal(rep.money[0].calls, 3);
  const md = summaryMarkdown(rep);
  assert.match(md, /## Legibility boundary/);
  assert.match(md, /\| muse-spark-1.3 \| baseline \|/);
});

test('loadRecords reads cached answers and writeReport writes the files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squint-report-'));
  try {
    const raw = path.join(dir, 'raw', 'muse-spark-1.3', 'baseline');
    mkdirSync(raw, { recursive: true });
    records().forEach((r, i) => writeFileSync(path.join(raw, `${i}.json`), JSON.stringify({ key: {}, ...r })));
    writeFileSync(path.join(raw, 'junk.json'), JSON.stringify({ ok: true }));
    const recs = loadRecords(path.join(dir, 'raw'));
    assert.equal(recs.length, 6);
    writeReport(buildReport(recs, labels), dir);
    assert.ok(existsSync(path.join(dir, 'summary.md')));
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')).records, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
