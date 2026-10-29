// Runs label images x models x modes through the model and stores every raw answer.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chatJSON, cached, cacheFile, imagePart, sha256, PRICE, IMAGE_TOKENS_ESTIMATE } from '../api/meta.mjs';
import { READ_SCHEMA, PROMPT_VERSION, SYSTEM, userText } from './questions.mjs';

export const MODELS = ['muse-spark-1.3', 'muse-wonder-1.0', 'muse-spark-1.1'];
export const BASE_MODES = ['baseline', 'abstain'];

export function jobKey(job, imageHash) {
  return { model: job.model, mode: job.mode, prompt: PROMPT_VERSION, image: imageHash, seed: job.seed ?? 0 };
}

export function planProbe({ images, models = [MODELS[0]], modes = ['baseline'], seeds = [0] }) {
  const jobs = [];
  for (const img of images)
    for (const model of models)
      for (const mode of modes)
        for (const seed of seeds) jobs.push({ ...img, model, mode, seed });
  return jobs;
}

const rawDirFor = (rawRoot, job) => path.join(rawRoot, job.model, job.mode);

// Counts jobs whose answer is not cached yet and estimates what they would cost.
export function estimate(jobs, rawRoot) {
  const byModel = {};
  for (const j of jobs) {
    const hash = sha256(readFileSync(j.file));
    const fresh = !existsSync(cacheFile(rawDirFor(rawRoot, j), jobKey(j, hash)));
    const m = (byModel[j.model] ??= { calls: 0, uncached: 0, dollars: 0 });
    m.calls++;
    if (fresh) {
      m.uncached++;
      const [pin, pout] = PRICE[j.model] ?? [0, 0];
      m.dollars += ((IMAGE_TOKENS_ESTIMATE + 350) * pin + 400 * pout) / 1e6;
    }
  }
  return byModel;
}

export async function readLabel(job, rawRoot) {
  const { part, hash } = imagePart(job.file);
  const rec = await cached(rawDirFor(rawRoot, job), jobKey(job, hash), async () => {
    const r = await chatJSON({
      model: job.model,
      system: SYSTEM,
      content: [{ type: 'text', text: userText({ mode: job.mode, seed: job.seed }) }, part],
      schemaName: 'label_read',
      schema: READ_SCHEMA,
    });
    return { answer: r.data, usage: r.usage, ms: r.ms, cost: r.cost, finish: r.finish };
  });
  return { id: job.id, cond: job.cond, level: job.level, model: job.model, mode: job.mode, seed: job.seed ?? 0, ...rec };
}

export async function runProbe(jobs, rawRoot, { concurrency = 4, onProgress } = {}) {
  const out = new Array(jobs.length);
  let next = 0, done = 0;
  const failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        out[i] = await readLabel(jobs[i], rawRoot);
      } catch (e) {
        failures.push({ job: jobs[i], error: e.message });
        if (/HTTP 40[13]/.test(e.message)) throw e; // a bad key will fail every call: stop early
      }
      onProgress?.(++done, jobs.length);
    }
  }));
  return { results: out.filter(Boolean), failures };
}
