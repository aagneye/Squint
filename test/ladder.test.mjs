import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONDITIONS, LEVELS, ladderFilter, ffmpegAvailable, degradeAll } from '../src/degrade/ladder.mjs';
import { loadLabels } from '../src/data.mjs';
import { renderLabels } from '../src/forge/forge.mjs';

test('level 0 is the clean image and every other level has a filter', () => {
  for (const c of CONDITIONS) {
    assert.equal(ladderFilter(c, 0), 'null');
    const filters = LEVELS.slice(1).map((l) => ladderFilter(c, l));
    assert.equal(new Set(filters).size, 7, `${c}: every level must differ`);
  }
});

test('filters get stronger with level', () => {
  assert.match(ladderFilter('blur', 7), /sigma=18/);
  assert.match(ladderFilter('dark', 7), /noise=alls=42/);
  assert.match(ladderFilter('cover', 7), /w=iw\*0\.84/);
});

test('rejects unknown conditions and levels', () => {
  assert.throws(() => ladderFilter('rain', 1));
  assert.throws(() => ladderFilter('blur', 8));
});

const canRun = process.platform === 'win32' && ffmpegAvailable();
test('builds one image per condition and level', { skip: !canRun && 'needs Windows and ffmpeg' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squint-ladder-'));
  try {
    const clean = renderLabels([loadLabels()[0]], path.join(dir, 'clean'));
    const r = await degradeAll(clean, path.join(dir, 'images'), { levels: [0, 4, 7] });
    assert.equal(r.total, CONDITIONS.length * 3);
    assert.equal(r.made, r.total);
    for (const img of r.images) assert.ok(existsSync(img.file), img.file);
    const again = await degradeAll(clean, path.join(dir, 'images'), { levels: [0, 4, 7] });
    assert.equal(again.made, 0, 'second run must reuse the cache');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
