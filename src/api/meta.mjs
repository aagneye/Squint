// Meta Model API client: OpenAI-compatible Chat Completions with strict JSON output,
// retries on 429/5xx, cost accounting and an on-disk response cache (re-runs never re-bill).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BASE = () => (process.env.META_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, '');
export const isMock = () => !BASE().includes('api.meta.ai');

// $ per 1M tokens [input, output], from Meta's pricing page (Oct 2026).
export const PRICE = {
  'muse-wonder-1.0': [4, 20],
  'muse-spark-1.3': [1.25, 4.25],
  'muse-spark-1.2': [1.25, 4.25],
  'muse-spark-1.1': [1.25, 4.25],
};
export const IMAGE_TOKENS_ESTIMATE = 1400; // about 1,300-1,500 tokens per 1024-1280 px image (Meta docs)

export function cost(model, usage = {}) {
  const [pin, pout] = PRICE[model] ?? [0, 0];
  return ((usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout) / 1e6;
}

export const sha256 = (x) => createHash('sha256').update(x).digest('hex');

export function imagePart(file) {
  const buf = readFileSync(file);
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  return { part: { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }, hash: sha256(buf) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(pathname, body, { tries = 5 } = {}) {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error('MODEL_API_KEY is not set (PowerShell: $env:MODEL_API_KEY = "LLM_...")');
  let last;
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(BASE() + pathname, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return { json: JSON.parse(text), ms: performance.now() - t0 };
      last = Object.assign(new Error(`HTTP ${res.status} on ${pathname}: ${text.slice(0, 400)}`), { status: res.status });
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (e) {
      last = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;
    }
    await sleep(Math.min(30000, 1000 * 2 ** i) + Math.random() * 250);
  }
  throw last;
}

// One structured call. Returns { data, usage, ms, cost, finish }.
export async function chatJSON({ model, system, content, schemaName, schema, effort = 'low', maxTokens = 2000 }) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
    reasoning_effort: effort,
    max_tokens: maxTokens,
  };
  const { json, ms } = await post('/chat/completions', body);
  const choice = json.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error('empty completion: ' + JSON.stringify(json).slice(0, 300));
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`non-JSON answer (finish_reason=${choice.finish_reason}): ${text.slice(0, 200)}`); }
  const usage = json.usage ?? {};
  return { data, usage, ms, cost: cost(model, usage), finish: choice.finish_reason };
}

// Disk cache keyed by a hash of everything that changes the answer.
export function cacheFile(dir, keyObj) {
  return path.join(dir, `${sha256(JSON.stringify(keyObj)).slice(0, 32)}.json`);
}

export async function cached(dir, keyObj, fn) {
  const file = cacheFile(dir, keyObj);
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true };
  const value = await fn();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ key: keyObj, ...value }, null, 2));
  return { ...value, cached: false };
}
