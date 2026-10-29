// The fix. Each guard turns a would-be confident guess into an honest "please retake",
// and each is a probe mode so its effect can be measured on its own:
//   abstain      prompt says never guess                         (questions.mjs)
//   consistency  three independent reads; disagreement -> blank
//   formulary    a strength that does not exist for that drug -> blank
//   zoom         ask for the name/strength line box, crop, re-read the crop
//   stack        abstain prompt x3 reads + consistency + formulary
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chatJSON, cached, imagePart } from '../api/meta.mjs';
import { readLabel, jobKey } from '../probe/probe.mjs';
import { PROMPT_VERSION } from '../probe/questions.mjs';
import { norm, nameVerdict, parseStrength, perDay, perDose, parseDate, allergenSet, sameSet } from '../score/normalize.mjs';

export const GUARD_MODES = ['consistency', 'formulary', 'zoom', 'stack'];

const BLANK = { name: '', strength_value: '', strength_unit: '', directions: '', expiry: '', allergens: [], may_contain: [] };
const CONF = ['low', 'medium', 'high'];

// Comparable signature of each field, so "25 mg" and "25mg" agree.
const SIG = {
  name: (a) => norm(a.name).replace(/\s/g, ''),
  strength: (a) => { const s = parseStrength(a.strength_value, a.strength_unit); return s ? `${s.value}${s.unit}` : ''; },
  directions: (a) => `${perDay(a.directions)}x${perDose(a.directions)}`,
  expiry: (a) => parseDate(a.expiry) ?? norm(a.expiry),
  allergens: (a) => [...allergenSet(a.allergens)].sort().join(','),
  may_contain: (a) => [...allergenSet(a.may_contain)].sort().join(','),
};
const FIELD_KEYS = { name: ['name'], strength: ['strength_value', 'strength_unit'], directions: ['directions'], expiry: ['expiry'], allergens: ['allergens'], may_contain: ['may_contain'] };

// Keep a field only if every read agrees on it.
export function mergeConsistent(answers) {
  if (answers.length === 1) return answers[0];
  const out = { ...answers[0] };
  let blanked = 0;
  for (const [field, sig] of Object.entries(SIG)) {
    const sigs = new Set(answers.map(sig));
    if (sigs.size > 1) {
      for (const k of FIELD_KEYS[field]) out[k] = BLANK[k];
      blanked++;
    }
  }
  if (answers.every((a) => a.can_read === 'no')) out.can_read = 'no';
  else if (blanked && out.can_read === 'yes') out.can_read = 'partial';
  out.confidence = CONF[Math.min(...answers.map((a) => CONF.indexOf(a.confidence)))];
  return out;
}

// Blank a strength that is not a real strength of the drug that was read (and fix nothing else).
export function applyFormulary(answer, formulary) {
  const drug = Object.keys(formulary).find((d) => nameVerdict(answer.name, d, '') === 'match');
  if (!drug) return answer;
  const s = parseStrength(answer.strength_value, answer.strength_unit);
  if (!s) return answer;
  const f = formulary[drug];
  if (s.unit === f.unit && f.strengths.some((v) => Math.abs(v - s.value) < 1e-9)) return answer;
  return { ...answer, strength_value: '', strength_unit: '', can_read: answer.can_read === 'yes' ? 'partial' : answer.can_read };
}

// Take name and strength (or allergens) from the zoomed crop; everything else from the full image.
export function mergeZoom(full, crop) {
  const keys = ['name', 'strength_value', 'strength_unit', 'allergens', 'may_contain'];
  const out = { ...full };
  for (const k of keys) {
    const v = crop[k];
    const empty = Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim();
    if (crop.can_read === 'no') out[k] = BLANK[k];
    else if (!empty) out[k] = v;
  }
  if (crop.can_read !== 'yes' && out.can_read === 'yes') out.can_read = 'partial';
  return out;
}

export const LOCATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'x0', 'y0', 'x1', 'y1'],
  properties: { found: { type: 'boolean' }, x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' } },
};
const LOCATE_TEXT = 'Find the part of this label that shows the product name and its strength (on a food package: the CONTAINS allergen statement). Return its bounding box on a 0-1000 grid, where (0,0) is the top-left of the image and (1000,1000) the bottom-right. Set found to false if you cannot find it.';

const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
// Converts a 0-1000 box to an ffmpeg crop on a 1024x768 image, padded by 8% and at least 40% tall.
export function cropFilter(box, W = 1024, H = 768) {
  let [x0, y0, x1, y1] = [box.x0, box.y0, box.x1, box.y1].map(clamp);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const padX = 80, padY = 80;
  x0 = Math.max(0, x0 - padX); x1 = Math.min(1000, x1 + padX);
  y0 = Math.max(0, y0 - padY); y1 = Math.min(1000, y1 + padY);
  if (y1 - y0 < 400) { const c = (y0 + y1) / 2; y0 = Math.max(0, c - 200); y1 = Math.min(1000, y0 + 400); }
  const px = (v, size) => Math.round((v / 1000) * size);
  const w = Math.max(16, px(x1 - x0, W)), h = Math.max(16, px(y1 - y0, H));
  return `crop=${w}:${h}:${px(x0, W)}:${px(y0, H)},scale=iw*2:ih*2:flags=lanczos`;
}

function ffmpeg(input, vf, output) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf, '-q:v', '3', output]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve(output) : reject(new Error(`ffmpeg crop failed: ${err.trim()}`))));
    p.on('error', reject);
  });
}

async function zoomRead(job, rawRoot, cropRoot) {
  const full = await readLabel({ ...job, mode: 'abstain', seed: 0 }, rawRoot);
  const { part, hash } = imagePart(job.file);
  const loc = await cached(path.join(rawRoot, job.model, '_locate'), { model: job.model, prompt: PROMPT_VERSION, image: hash, kind: 'locate' }, async () => {
    const r = await chatJSON({ model: job.model, content: [{ type: 'text', text: LOCATE_TEXT }, part], schemaName: 'locate', schema: LOCATE_SCHEMA, maxTokens: 400 });
    return { box: r.data, usage: r.usage, ms: r.ms, cost: r.cost };
  });
  if (!loc.box.found) return { answer: full.answer, cost: full.cost + loc.cost, ms: full.ms + loc.ms };
  const cropFile = path.join(cropRoot, job.model, job.id, job.cond, `${job.level}_crop.jpg`);
  if (!existsSync(cropFile)) {
    mkdirSync(path.dirname(cropFile), { recursive: true });
    await ffmpeg(job.file, cropFilter(loc.box), cropFile);
  }
  const crop = await readLabel({ ...job, file: cropFile, mode: 'zoom-crop', seed: 0 }, rawRoot);
  return { answer: mergeZoom(full.answer, crop.answer), cost: full.cost + loc.cost + crop.cost, ms: full.ms + loc.ms + crop.ms };
}

async function seededReads(job, mode, rawRoot) {
  const reads = [];
  for (const seed of [0, 1, 2]) reads.push(await readLabel({ ...job, mode, seed }, rawRoot));
  return { answer: mergeConsistent(reads.map((r) => r.answer)), cost: reads.reduce((s, r) => s + (r.cost ?? 0), 0), ms: Math.max(...reads.map((r) => r.ms ?? 0)) };
}

export async function guardRead(job, rawRoot, { formulary, cropRoot }) {
  const { hash } = imagePart(job.file);
  const key = { ...jobKey(job, hash), composite: true };
  const rec = await cached(path.join(rawRoot, job.model, job.mode), key, async () => {
    let r;
    switch (job.mode) {
      case 'consistency': r = await seededReads(job, 'baseline', rawRoot); break;
      case 'formulary': {
        const b = await readLabel({ ...job, mode: 'baseline', seed: 0 }, rawRoot);
        r = { answer: applyFormulary(b.answer, formulary), cost: b.cost, ms: b.ms };
        break;
      }
      case 'zoom': r = await zoomRead(job, rawRoot, cropRoot); break;
      case 'stack': {
        const s = await seededReads(job, 'abstain', rawRoot);
        r = { ...s, answer: applyFormulary(s.answer, formulary) };
        break;
      }
      default: throw new Error(`unknown guard mode ${job.mode}`);
    }
    return { id: job.id, cond: job.cond, level: job.level, model: job.model, mode: job.mode, seed: 0, derived: true, ...r };
  });
  return { ...rec, id: job.id, cond: job.cond, level: job.level, model: job.model, mode: job.mode, seed: 0 };
}

// Extra API calls each guard needs per image beyond what it can reuse (for the dry-run estimate).
export const GUARD_CALLS = { consistency: 3, formulary: 1, zoom: 3, stack: 3 };
