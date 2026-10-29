import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatJSON, cached, cost, isMock } from '../src/api/meta.mjs';
import { startMock, MOCK_KEY, mockRead } from '../src/api/mock.mjs';
import { loadLabels } from '../src/data.mjs';

const PING = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };

test('chatJSON talks to the mock and accounts cost', async () => {
  const server = await startMock(0);
  const port = server.address().port;
  process.env.META_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.MODEL_API_KEY = MOCK_KEY;
  try {
    assert.equal(isMock(), true);
    const r = await chatJSON({ model: 'muse-spark-1.3', content: 'ping', schemaName: 'ping', schema: PING });
    assert.deepEqual(r.data, { ok: true });
    assert.ok(r.usage.prompt_tokens > 0 && r.cost > 0);
  } finally {
    server.close();
  }
});

test('a bad key fails fast without retrying', async () => {
  const server = await startMock(0);
  process.env.META_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.MODEL_API_KEY = 'wrong';
  try {
    await assert.rejects(chatJSON({ model: 'muse-spark-1.3', content: 'x', schemaName: 'ping', schema: PING }), /HTTP 401/);
  } finally {
    server.close();
  }
});

test('cached() runs the function once per key', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squint-cache-'));
  let calls = 0;
  const fn = async () => ({ value: ++calls });
  try {
    const a = await cached(dir, { k: 1 }, fn);
    const b = await cached(dir, { k: 1 }, fn);
    const c = await cached(dir, { k: 2 }, fn);
    assert.deepEqual([a.value, b.value, c.value, b.cached], [1, 1, 2, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cost uses the price table', () => {
  assert.equal(cost('muse-wonder-1.0', { prompt_tokens: 1e6, completion_tokens: 1e6 }), 24);
  assert.equal(cost('unknown', { prompt_tokens: 1e6 }), 0);
});

test('mock reads are right at level 0 and degrade past the boundary', () => {
  const label = loadLabels()[0];
  const clean = mockRead({ label, level: 0, cond: 'blur', model: 'muse-spark-1.3', seed: '0' });
  assert.equal(clean.name, label.name);
  const far = Array.from({ length: 20 }, (_, s) => mockRead({ label, level: 7, cond: 'blur', model: 'muse-spark-1.1', seed: String(s) }));
  assert.ok(far.filter((a) => a.name !== label.name || a.strength_value !== String(label.strength.value)).length >= 15);
});
