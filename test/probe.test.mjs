import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { READ_SCHEMA, strictProblems, userText } from '../src/probe/questions.mjs';
import { planProbe, runProbe, estimate } from '../src/probe/probe.mjs';
import { pickLabels, parseArgs } from '../src/cli.mjs';
import { loadLabels } from '../src/data.mjs';
import { renderLabels } from '../src/forge/forge.mjs';
import { degradeAll, ffmpegAvailable } from '../src/degrade/ladder.mjs';
import { startMock, MOCK_KEY } from '../src/api/mock.mjs';

test('the read schema follows strict-mode rules', () => {
  assert.deepEqual(strictProblems(READ_SCHEMA), []);
  assert.ok(strictProblems({ type: 'object', properties: { a: { type: 'string' } } }).length === 2);
});

test('only the abstain mode tells the model not to guess', () => {
  assert.doesNotMatch(userText({ mode: 'baseline' }), /Never guess/);
  assert.match(userText({ mode: 'abstain' }), /Never guess/);
  assert.match(userText({ mode: 'baseline', seed: 2 }), /seed:2/);
});

test('plan multiplies images, models, modes and seeds', () => {
  const jobs = planProbe({ images: [{ id: 'a' }, { id: 'b' }], models: ['m1', 'm2'], modes: ['baseline', 'abstain'], seeds: [0, 1, 2] });
  assert.equal(jobs.length, 24);
});

test('pickLabels spreads N labels across kinds', () => {
  const kinds = pickLabels(loadLabels(), '3').map((l) => l.kind).sort();
  assert.deepEqual(kinds, ['food', 'otc', 'rx']);
  assert.throws(() => pickLabels(loadLabels(), 'nope'));
  assert.deepEqual(parseArgs(['probe', '--levels', '0,7', '--dry-run']).flags, { levels: '0,7', 'dry-run': true });
});

const canRun = process.platform === 'win32' && ffmpegAvailable();
test('end to end against the mock: render, degrade, probe, cache', { skip: !canRun && 'needs Windows and ffmpeg' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squint-probe-'));
  const server = await startMock(0, { root: dir });
  process.env.META_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.MODEL_API_KEY = MOCK_KEY;
  try {
    const labels = pickLabels(loadLabels(), '2');
    const clean = renderLabels(labels, path.join(dir, 'clean'));
    const { images } = await degradeAll(clean, path.join(dir, 'images'), { conditions: ['blur'], levels: [0, 7] });
    const jobs = planProbe({ images, models: ['muse-spark-1.3'], modes: ['baseline', 'abstain'] });
    const raw = path.join(dir, 'raw');
    assert.equal(estimate(jobs, raw)['muse-spark-1.3'].uncached, 8);
    const first = await runProbe(jobs, raw);
    assert.equal(first.failures.length, 0, JSON.stringify(first.failures));
    assert.equal(first.results.length, 8);
    const clean0 = first.results.find((r) => r.level === 0 && r.mode === 'baseline');
    assert.equal(clean0.answer.can_read, 'yes');
    const again = await runProbe(jobs, raw);
    assert.ok(again.results.every((r) => r.cached));
    assert.equal(estimate(jobs, raw)['muse-spark-1.3'].uncached, 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
