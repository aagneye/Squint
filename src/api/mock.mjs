// Fake Meta Model API on localhost for offline development and tests. It knows the ground truth
// (it looks images up by hash in out/) and degrades its answers with the level, so the whole
// pipeline can be exercised without a key. Its numbers say NOTHING about real models.
//
//   node src/api/mock.mjs [port]        then   $env:META_BASE_URL = "http://127.0.0.1:8787/v1"
//                                               $env:MODEL_API_KEY = "LLM_0_mock"
import http from 'node:http';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './meta.mjs';
import { loadLabels, OUT } from '../data.mjs';

export const MOCK_KEY = 'LLM_0_mock';

// Per-model skill: how many ladder levels the model reads before it starts failing.
const SKILL = { 'muse-wonder-1.0': 4.5, 'muse-spark-1.3': 3.5, 'muse-spark-1.2': 3.2, 'muse-spark-1.1': 2.5 };
const unit = (s) => parseInt(sha256(s).slice(0, 8), 16) / 0xffffffff;

let index = null;
// Maps sha256(image bytes) -> { id, cond, level } by scanning out/**/images/<id>/<cond>/<level>.jpg and out/**/crops.
function buildIndex(root) {
  const map = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jpe?g|png)$/i.test(name)) {
        const m = /([a-z0-9_]+)[\\/](blur|dark|tilt|glare|cover)[\\/](\d)(?:_crop)?\.(jpe?g|png)$/i.exec(p);
        if (m) map.set(sha256(readFileSync(p)), { id: m[1], cond: m[2], level: +m[3], crop: /_crop/.test(name) });
        else if (/clean[\\/]([a-z0-9_]+)\.png$/i.test(p)) map.set(sha256(readFileSync(p)), { id: /([a-z0-9_]+)\.png$/i.exec(p)[1], cond: 'blur', level: 0, crop: false });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return map;
}
function lookup(hash) {
  if (!index || !index.has(hash)) index = buildIndex(OUT);
  return index.get(hash);
}

const fmtStrength = (l) => (l.strength ? String(l.strength.value) : '');

// Builds a mock answer for a label read. "guarded" prompts make the mock abstain where it would guess.
export function mockRead({ label, level, cond, model, seed, guarded, crop }) {
  const skill = (SKILL[model] ?? 3) + (crop ? 1.5 : 0) - (cond === 'tilt' ? 0.5 : 0);
  const over = level - skill; // > 0 means past this model's boundary
  const r = unit(`${label.id}|${cond}|${level}|${model}|${seed}`);
  const pRight = 1 / (1 + Math.exp(2.2 * over));
  const right = r < pRight;
  const base = {
    name: label.name, strength_value: fmtStrength(label), strength_unit: label.strength?.unit ?? '',
    directions: label.directions ?? '', expiry: label.expiry,
    allergens: label.allergens ?? [], may_contain: label.may_contain ?? [],
    can_read: 'yes', confidence: 'high',
  };
  if (right) return base;
  if (guarded && unit(`g|${label.id}|${level}|${seed}`) < 0.85) {
    return { ...base, name: '', strength_value: '', directions: '', expiry: '', allergens: [], may_contain: [], can_read: 'no', confidence: 'low' };
  }
  // Past the boundary the mock guesses: a look-alike name or a wrong strength, often still "confident".
  const wrongStrength = label.strength ? String(label.strength.value * [0.4, 2, 10][Math.floor(r * 3)]) : '';
  return {
    ...base,
    name: r < pRight + (1 - pRight) / 2 ? label.distractor : label.name,
    strength_value: wrongStrength,
    allergens: (label.allergens ?? []).slice(1),
    can_read: unit(`c|${label.id}|${level}`) < 0.7 ? 'yes' : 'partial',
    confidence: unit(`k|${label.id}|${level}`) < 0.6 ? 'high' : 'medium',
  };
}

export function startMock(port = 8787) {
  const labels = new Map(loadLabels().map((l) => [l.id, l]));
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) return send(401, { error: 'bad key' });
    if (!req.url.startsWith('/v1/chat/completions')) return send(404, { error: 'not found' });
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const name = body.response_format?.json_schema?.name;
    const userContent = body.messages.at(-1).content;
    const parts = Array.isArray(userContent) ? userContent : [{ type: 'text', text: userContent }];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') + '\n' + (body.messages[0]?.content ?? '');
    const img = parts.find((p) => p.type === 'image_url');
    const hash = img ? sha256(Buffer.from(img.image_url.url.split(',')[1], 'base64')) : null;
    const where = hash ? lookup(hash) : null;
    const seed = /seed:(\d+)/.exec(text)?.[1] ?? '0';
    let out;
    if (name === 'ping') out = { ok: true };
    else if (name === 'label_read') {
      if (!where || !labels.has(where.id)) return send(400, { error: 'mock: unknown image (render and degrade first)' });
      out = mockRead({ label: labels.get(where.id), level: where.level, cond: where.cond, model: body.model, seed, guarded: /GUARD:abstain/.test(text), crop: where.crop });
    } else if (name === 'locate') {
      out = { found: true, x0: 60, y0: 220, x1: 960, y1: 560 };
    } else return send(400, { error: `mock: unknown schema ${name}` });
    const prompt_tokens = (img ? 1400 : 0) + Math.ceil(text.length / 4);
    send(200, { choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens, completion_tokens: 120 } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8787);
  await startMock(port);
  console.log(`mock Meta API on http://127.0.0.1:${port}/v1  (key: ${MOCK_KEY}). Ctrl+C to stop.`);
}
