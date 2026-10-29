// Collects every stored answer, scores it, and writes results.json (for the demo page),
// summary.md (tables for the README) and the slider frames.
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aggregate, boundaries, overCaution, scoreAnswer, OUTCOMES } from '../score/judge.mjs';
import { imagePath } from '../degrade/ladder.mjs';

export function loadRecords(rawRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) {
        const r = JSON.parse(readFileSync(p, 'utf8'));
        if (r.answer && r.id) out.push(r);
      }
    }
  };
  if (existsSync(rawRoot)) walk(rawRoot);
  return out;
}

const pct = (x) => `${(100 * x).toFixed(0)}%`;

export function buildReport(records, labels, { sliderId = 'rx_hydralazine', sliderCond = 'blur', imagesRoot } = {}) {
  const byId = new Map(labels.map((l) => [l.id, l]));
  // Guards combine several reads into one record per image. Seeds > 0 and zoom crops are their inner
  // reads: they are already counted (answer and cost) inside the guard's own record.
  const scored = records.filter((r) => (r.seed ?? 0) === 0 && !String(r.mode).endsWith('-crop'));
  const rows = aggregate(scored, byId);
  const bounds = boundaries(rows);
  const caution = overCaution(rows);

  const headline = Object.values(Object.groupBy(rows, (r) => `${r.model}|${r.mode}`)).map((rs) => {
    const sum = (f) => rs.reduce((s, r) => s + f(r), 0);
    const fields = sum((r) => r.fields), answers = sum((r) => r.answers);
    const hard = rs.filter((r) => r.level >= 5);
    return {
      model: rs[0].model, mode: rs[0].mode, answers,
      ...Object.fromEntries(OUTCOMES.map((o) => [o, sum((r) => r.counts[o]) / fields])),
      unsafe: sum((r) => r.unsafeAnswers) / answers,
      unsafeHard: hard.length ? hard.reduce((s, r) => s + r.unsafeAnswers, 0) / hard.reduce((s, r) => s + r.answers, 0) : null,
    };
  });

  // Cost per mode is what running that mode costs per image, including the reads it reuses.
  const money = Object.values(Object.groupBy(scored, (r) => `${r.model}|${r.mode}`)).map((rs) => ({
    model: rs[0].model, mode: rs[0].mode, calls: rs.length,
    dollars: rs.reduce((s, r) => s + (r.cost ?? 0), 0),
    perThousandReads: (1000 * rs.reduce((s, r) => s + (r.cost ?? 0), 0)) / rs.length,
    medianMs: [...rs.map((r) => r.ms ?? 0)].sort((a, b) => a - b)[Math.floor(rs.length / 2)],
  }));

  const sliderRecs = scored.filter((r) => r.id === sliderId && r.cond === sliderCond);
  const frames = [...new Set(sliderRecs.map((r) => r.level))].sort((a, b) => a - b).map((level) => ({
    level,
    image: `slider/${sliderId}/${sliderCond}/${level}.jpg`,
    source: imagesRoot ? imagePath(imagesRoot, sliderId, sliderCond, level) : null,
    answers: Object.fromEntries(sliderRecs.filter((r) => r.level === level).map((r) => [`${r.model}|${r.mode}`, {
      name: r.answer.name, strength: `${r.answer.strength_value} ${r.answer.strength_unit}`.trim(), can_read: r.answer.can_read, confidence: r.answer.confidence,
      fields: scoreAnswer(byId.get(sliderId), r.answer).map((s) => ({ field: s.field, outcome: s.outcome })),
    }])),
  }));
  const label = byId.get(sliderId);
  return {
    generated: new Date().toISOString(),
    labels: labels.length,
    records: records.length,
    headline, rows, boundaries: bounds, overCaution: caution, money,
    slider: { id: sliderId, cond: sliderCond, truth: label ? { name: label.name, strength: label.strength ? `${label.strength.value} ${label.strength.unit}` : '' } : null, frames },
  };
}

export function summaryMarkdown(rep) {
  const L = [`# Squint results`, '', `${rep.records} answers on ${rep.labels} labels. Generated ${rep.generated}.`, ''];
  L.push('## Headline', '', '| model | mode | correct | confident wrong | hedged wrong | abstain | unsafe answers | unsafe at levels 5-7 |', '|---|---|---|---|---|---|---|---|');
  for (const h of rep.headline) L.push(`| ${h.model} | ${h.mode} | ${pct(h.correct)} | ${pct(h.wrong_confident)} | ${pct(h.wrong_hedged)} | ${pct(h.abstain)} | ${pct(h.unsafe)} | ${h.unsafeHard === null ? '-' : pct(h.unsafeHard)} |`);
  L.push('', 'Unsafe answer = at least one confidently wrong name, strength or allergen list.', '');
  const conds = [...new Set(rep.boundaries.map((b) => b.cond))];
  L.push('## Legibility boundary', '', 'First ladder level (0-7) where fewer than half the fields are read correctly. "-" means the model never dropped below half.', '');
  L.push(`| model | mode | ${conds.join(' | ')} |`, `|---|---|${conds.map(() => '---').join('|')}|`);
  for (const g of Object.values(Object.groupBy(rep.boundaries, (b) => `${b.model}|${b.mode}`)))
    L.push(`| ${g[0].model} | ${g[0].mode} | ${conds.map((c) => g.find((b) => b.cond === c)?.boundary ?? '-').join(' | ')} |`);
  L.push('', '## Over-caution', '', 'Abstain rate on images every model reads at least 90% correctly in baseline.', '', '| model | mode | abstain |', '|---|---|---|');
  for (const o of rep.overCaution) L.push(`| ${o.model} | ${o.mode} | ${pct(o.rate)} |`);
  L.push('', '## Cost', '', 'Per mode, including any reads a guard reuses from other modes (so modes do not add up to total spend).', '', '| model | mode | images | spent | per 1,000 reads | median latency |', '|---|---|---|---|---|---|');
  for (const m of rep.money) L.push(`| ${m.model} | ${m.mode} | ${m.calls} | $${m.dollars.toFixed(2)} | $${m.perThousandReads.toFixed(2)} | ${(m.medianMs / 1000).toFixed(1)} s |`);
  return L.join('\n') + '\n';
}

export function writeReport(rep, outRoot) {
  mkdirSync(outRoot, { recursive: true });
  for (const f of rep.slider.frames) {
    if (!f.source || !existsSync(f.source)) continue;
    const dest = path.join(outRoot, f.image);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(f.source, dest);
    delete f.source;
  }
  writeFileSync(path.join(outRoot, 'results.json'), JSON.stringify(rep, null, 2));
  writeFileSync(path.join(outRoot, 'summary.md'), summaryMarkdown(rep));
}
