import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeConsistent, applyFormulary, mergeZoom, cropFilter, guardRead, GUARD_MODES } from '../src/guard/guards.mjs';
import { runProbe, planProbe } from '../src/probe/probe.mjs';
import { loadLabels, loadFormulary } from '../src/data.mjs';
import { renderLabels } from '../src/forge/forge.mjs';
import { degradeAll, ffmpegAvailable } from '../src/degrade/ladder.mjs';
import { startMock, MOCK_KEY } from '../src/api/mock.mjs';
import { buildReport } from '../src/report/report.mjs';

const formulary = loadFormulary();
const a = { name: 'Hydralazine', strength_value: '25', strength_unit: 'mg', directions: 'Take 1 tablet twice daily', expiry: '01/09/2027', allergens: [], may_contain: [], can_read: 'yes', confidence: 'high' };

test('consistency keeps agreeing fields and blanks disagreeing ones', () => {
  const m = mergeConsistent([a, { ...a, strength_value: '25mg', strength_unit: '' }, { ...a, name: 'Hydroxyzine', confidence: 'medium' }]);
  assert.equal(m.strength_value, '25');
  assert.equal(m.name, '');
  assert.equal(m.can_read, 'partial');
  assert.equal(m.confidence, 'medium');
  assert.deepEqual(mergeConsistent([a, a, a]), a);
});

test('formulary blanks impossible strengths only', () => {
  assert.deepEqual(applyFormulary(a, formulary), a);
  const impossible = applyFormulary({ ...a, strength_value: '40' }, formulary);
  assert.equal(impossible.strength_value, '');
  assert.equal(impossible.can_read, 'partial');
  const wrongUnit = applyFormulary({ ...a, strength_unit: 'mcg' }, formulary);
  assert.equal(wrongUnit.strength_value, '');
  const food = { ...a, name: 'Oat Milk', strength_value: '' };
  assert.deepEqual(applyFormulary(food, formulary), food);
});

test('zoom takes name and strength from the crop', () => {
  const full = { ...a, name: 'Hydroxyzine', strength_value: '10' };
  assert.equal(mergeZoom(full, a).name, 'Hydralazine');
  const unreadable = mergeZoom(full, { ...a, can_read: 'no' });
  assert.equal(unreadable.name, '');
  assert.equal(unreadable.strength_value, '');
  assert.equal(unreadable.directions, full.directions);
});

test('crop filter pads, enforces a minimum height and stays inside the image', () => {
  assert.equal(cropFilter({ x0: 100, y0: 300, x1: 600, y1: 400 }), 'crop=676:307:20:115,scale=iw*2:ih*2:flags=lanczos');
  const f = cropFilter({ x0: 1200, y0: -50, x1: -10, y1: 2000 });
  const [w, h, x, y] = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(f).slice(1).map(Number);
  assert.ok(x + w <= 1024 && y + h <= 768);
});

const canRun = process.platform === 'win32' && ffmpegAvailable();
test('every guard runs end to end on the mock and lowers confident-wrong answers', { skip: !canRun && 'needs Windows and ffmpeg' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squint-guard-'));
  const server = await startMock(0, { root: dir });
  process.env.META_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.MODEL_API_KEY = MOCK_KEY;
  try {
    const labels = loadLabels().filter((l) => l.kind === 'rx').slice(0, 4);
    const clean = renderLabels(labels, path.join(dir, 'clean'));
    const { images } = await degradeAll(clean, path.join(dir, 'images'), { conditions: ['blur'], levels: [0, 6, 7] });
    const raw = path.join(dir, 'raw');
    const base = await runProbe(planProbe({ images, models: ['muse-spark-1.1'], modes: ['baseline', 'abstain'] }), raw);
    const opts = { formulary, cropRoot: path.join(dir, 'crops') };
    const guarded = await runProbe(planProbe({ images, models: ['muse-spark-1.1'], modes: GUARD_MODES }), raw, { reader: (j, r) => guardRead(j, r, opts) });
    assert.equal(guarded.failures.length, 0, JSON.stringify(guarded.failures.slice(0, 2)));
    assert.equal(guarded.results.length, images.length * GUARD_MODES.length);
    const rep = buildReport([...base.results, ...guarded.results], loadLabels());
    const h = Object.fromEntries(rep.headline.map((x) => [x.mode, x]));
    assert.ok(h.stack.wrong_confident < h.baseline.wrong_confident, `stack ${h.stack.wrong_confident} vs baseline ${h.baseline.wrong_confident}`);
    assert.ok(rep.money.every((m) => m.calls === images.length));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
