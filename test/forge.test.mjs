import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLabels } from '../src/data.mjs';
import { renderLabels } from '../src/forge/forge.mjs';

test('renders one label of each kind at 1024x768', { skip: process.platform !== 'win32' && 'needs Windows' }, () => {
  const labels = loadLabels();
  const sample = ['rx', 'otc', 'food'].map((k) => labels.find((l) => l.kind === k));
  const dir = mkdtempSync(path.join(tmpdir(), 'squint-forge-'));
  try {
    const out = renderLabels(sample, dir);
    assert.equal(out.length, 3);
    for (const img of out) assert.deepEqual([img.width, img.height], [1024, 768], img.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
