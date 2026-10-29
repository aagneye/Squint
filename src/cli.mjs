#!/usr/bin/env node
// Squint command line.  node src/cli.mjs <command> [options]   (run with --help for the list)
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadLabels, loadFormulary, OUT } from './data.mjs';
import { GUARD_MODES, GUARD_CALLS, guardRead } from './guard/guards.mjs';
import { renderLabels } from './forge/forge.mjs';
import { degradeAll, CONDITIONS, LEVELS, imagePath } from './degrade/ladder.mjs';
import { planProbe, estimate, runProbe, MODELS, BASE_MODES } from './probe/probe.mjs';
import { isMock } from './api/meta.mjs';
import { loadRecords, buildReport, writeReport } from './report/report.mjs';

const HELP = `Squint: does your vision AI know when it can't read the label?

Usage: node src/cli.mjs <command> [options]

Commands
  forge      render clean label images            -> out/clean/
  degrade    build the degradation ladder         -> out/images/<id>/<cond>/<level>.jpg
  probe      ask the model(s) to read the images  -> out/raw/ (cached; re-runs never re-bill)
  report     score every stored answer            -> out/results.json, out/summary.md, out/slider/
  all        forge + degrade + probe + report

Options
  --labels N|id,id   how many labels (spread across kinds) or exact ids   (default: all)
  --conds c,c        conditions: ${CONDITIONS.join(', ')}               (default: all)
  --levels 0,3,7     ladder levels 0-7                                    (default: all)
  --models m,m       ${MODELS.join(', ')}  (default: muse-spark-1.3)
  --modes m,m        prompts: ${BASE_MODES.join(', ')}; guards: ${GUARD_MODES.join(', ')}  (default: baseline)
  --dry-run          show call count and cost estimate, call nothing
  --yes              do not ask before spending
  --concurrency N    parallel API calls (default 4)
  --slider id        label shown on the demo slider (default rx_hydralazine; --slider-cond blur)

Environment
  MODEL_API_KEY      your Meta Model API key (never written to disk)
  META_BASE_URL      defaults to https://api.meta.ai/v1; point it at the mock for offline runs`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const o = { command, flags: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    o.flags[k] = v;
  }
  return o;
}

const list = (v, all) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : all);

// N labels spread round-robin across kinds, or an explicit id list.
export function pickLabels(labels, sel) {
  if (!sel || sel === true) return labels;
  if (/^\d+$/.test(String(sel))) {
    const byKind = Object.values(Object.groupBy(labels, (l) => l.kind));
    const picked = [];
    for (let i = 0; picked.length < Number(sel) && i < labels.length; i++)
      for (const group of byKind) if (group[i] && picked.length < Number(sel)) picked.push(group[i]);
    return picked;
  }
  const ids = new Set(list(sel));
  const out = labels.filter((l) => ids.has(l.id));
  if (out.length !== ids.size) throw new Error(`unknown label id in ${sel}`);
  return out;
}

// Real results and mock results never share a folder.
export const runRoot = () => (isMock() ? path.join(OUT, 'mock') : OUT);

export function selection(flags) {
  const labels = pickLabels(loadLabels(), flags.labels);
  return {
    labels,
    conds: list(flags.conds, CONDITIONS),
    levels: list(flags.levels, LEVELS).map(Number),
    models: list(flags.models, [MODELS[0]]),
    modes: list(flags.modes, ['baseline']),
  };
}

export function imagesFor(sel) {
  const imgs = [];
  for (const l of sel.labels) for (const cond of sel.conds) for (const level of sel.levels)
    imgs.push({ id: l.id, cond, level, file: imagePath(path.join(OUT, 'images'), l.id, cond, level) });
  return imgs;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(question);
  rl.close();
  return /^y/i.test(a);
}

export async function cmdForge(sel) {
  const out = renderLabels(sel.labels, path.join(OUT, 'clean'));
  console.log(`rendered ${out.length} labels -> ${path.join('out', 'clean')}`);
  return out;
}

export async function cmdDegrade(sel) {
  const clean = sel.labels.map((l) => ({ id: l.id, file: path.join(OUT, 'clean', `${l.id}.png`) }));
  const r = await degradeAll(clean, path.join(OUT, 'images'), { conditions: sel.conds, levels: sel.levels });
  console.log(`ladder: ${r.total} images (${r.made} new) -> ${path.join('out', 'images')}`);
  return r;
}

export async function cmdProbe(sel, flags, modes = sel.modes) {
  for (const m of modes) if (!BASE_MODES.includes(m) && !GUARD_MODES.includes(m)) throw new Error(`unknown mode ${m}; choose from ${[...BASE_MODES, ...GUARD_MODES].join(', ')}`);
  const images = imagesFor(sel);
  const jobs = planProbe({ images, models: sel.models, modes: modes.filter((m) => BASE_MODES.includes(m)) });
  const guardJobs = planProbe({ images, models: sel.models, modes: modes.filter((m) => GUARD_MODES.includes(m)) });
  const rawRoot = path.join(runRoot(), 'raw');
  const est = estimate(jobs, rawRoot);
  // Guards: worst case is every inner call uncached (reused reads make it cheaper in practice).
  for (const j of guardJobs) {
    const e = (est[j.model] ??= { calls: 0, uncached: 0, dollars: 0 });
    const one = estimate([{ ...j, mode: '_guard' }], rawRoot)[j.model];
    e.calls += GUARD_CALLS[j.mode];
    e.uncached += GUARD_CALLS[j.mode];
    e.dollars += one.dollars * GUARD_CALLS[j.mode];
  }
  let dollars = 0;
  for (const [m, e] of Object.entries(est)) {
    console.log(`  ${m}: ${e.calls} reads, ${e.uncached} not cached, about $${e.dollars.toFixed(2)}`);
    dollars += e.dollars;
  }
  console.log(`  target: ${isMock() ? 'MOCK API (offline)' : 'Meta Model API'}; estimated new spend $${dollars.toFixed(2)}`);
  if (flags['dry-run']) return { results: [], failures: [] };
  if (dollars > 0 && !isMock() && !flags.yes && !(await confirm('Spend it? (y/N) '))) return { results: [], failures: [] };
  const progress = (label) => (d, n) => { if (d % 25 === 0 || d === n) process.stdout.write(`\r  ${label} ${d}/${n}`); };
  const concurrency = Number(flags.concurrency ?? 4);
  const r = await runProbe(jobs, rawRoot, { concurrency, onProgress: progress('reads') });
  if (jobs.length) process.stdout.write('\n');
  if (guardJobs.length) {
    const guardOpts = { formulary: loadFormulary(), cropRoot: path.join(runRoot(), 'crops') };
    const g = await runProbe(guardJobs, rawRoot, { concurrency, onProgress: progress('guarded reads'), reader: (job, root) => guardRead(job, root, guardOpts) });
    process.stdout.write('\n');
    r.results.push(...g.results);
    r.failures.push(...g.failures);
  }
  const spent = r.results.filter((x) => !x.cached).reduce((s, x) => s + x.cost, 0);
  console.log(`  done: ${r.results.length} answers (${r.results.filter((x) => x.cached).length} from cache), ${r.failures.length} failed, spent $${spent.toFixed(3)}`);
  for (const f of r.failures.slice(0, 5)) console.log(`  FAILED ${f.job.id}/${f.job.cond}/${f.job.level} ${f.job.model}: ${f.error}`);
  return r;
}

export async function cmdReport(sel, flags) {
  const root = runRoot();
  const records = loadRecords(path.join(root, 'raw'));
  if (!records.length) throw new Error(`no answers under ${path.join(root, 'raw')}; run probe first`);
  const rep = buildReport(records, loadLabels(), { sliderId: flags.slider ?? 'rx_hydralazine', sliderCond: flags['slider-cond'] ?? 'blur', imagesRoot: path.join(OUT, 'images') });
  writeReport(rep, root);
  console.log(`report: ${records.length} answers -> ${path.join(path.relative(process.cwd(), root), 'results.json')} and summary.md`);
  for (const h of rep.headline) console.log(`  ${h.model} ${h.mode}: ${(100 * h.correct).toFixed(0)}% correct, ${(100 * h.wrong_confident).toFixed(0)}% confidently wrong, ${(100 * h.unsafe).toFixed(0)}% unsafe answers`);
  return rep;
}

export async function cmdAll(sel, flags) {
  await cmdForge(sel, flags);
  await cmdDegrade(sel, flags);
  const r = await cmdProbe(sel, flags);
  if (flags['dry-run'] || !r.results.length) return r;
  return cmdReport(sel, flags);
}

export const COMMANDS = { forge: cmdForge, degrade: cmdDegrade, probe: cmdProbe, report: cmdReport, score: cmdReport, all: cmdAll };

export async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (!command || flags.help || command === 'help' || !COMMANDS[command]) {
    console.log(HELP);
    return command && !COMMANDS[command] && command !== 'help' ? 1 : 0;
  }
  await COMMANDS[command](selection(flags), flags);
  return 0;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('cli.mjs')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error('ERROR:', e.message); process.exit(1); });
}
