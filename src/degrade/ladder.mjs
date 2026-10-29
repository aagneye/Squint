// The degradation ladder: five real-world capture conditions, eight levels each (0 = clean).
// Each level is an ffmpeg -vf chain, so every image is reproducible from the clean render.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const CONDITIONS = ['blur', 'dark', 'tilt', 'glare', 'cover'];
export const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7];

const W = 1024, H = 768;
const r2 = (x) => Math.round(x * 100) / 100;

// Returns the ffmpeg -vf string for one condition at one level. Level 0 is always the clean image.
export function ladderFilter(cond, level) {
  if (!LEVELS.includes(level)) throw new Error(`level must be 0..7, got ${level}`);
  if (!CONDITIONS.includes(cond)) throw new Error(`unknown condition ${cond}`);
  if (level === 0) return 'null';
  const k = level;
  switch (cond) {
    case 'blur': // defocus or motion: Gaussian blur, sigma rising until the dose line is unreadable
      return `gblur=sigma=${[0, 2, 4, 6, 8, 11, 14, 18][k]}`;
    case 'dark': // dim room: brightness and contrast down, sensor noise up
      return `eq=brightness=${r2(-0.08 * k)}:contrast=${r2(1 - 0.1 * k)},noise=alls=${6 * k}:allf=t`;
    case 'tilt': { // bottle held at an angle and too far away: rotation, foreshortening, shrink
      const inset = Math.round(0.06 * k * W);
      const scale = r2(1 - 0.11 * k);
      return [
        `perspective=x0=${inset}:y0=0:x1=${W - inset}:y1=0:x2=0:y2=${H}:x3=${W}:y3=${H}:sense=destination`,
        `rotate=${r2((3 * k * Math.PI) / 180)}:fillcolor=0x808080`,
        `scale=${Math.round(W * scale)}:${Math.round(H * scale)}`,
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x808080`,
      ].join(',');
    }
    case 'glare': { // overhead light reflecting off a glossy label: a diagonal band washed toward white
      const a = r2(k / 7);
      const band = `${a}*exp(-pow(Y-(300+0.25*(X-512)),2)/16200)`;
      return `format=rgb24,geq=r='r(X,Y)+(255-r(X,Y))*${band}':g='g(X,Y)+(255-g(X,Y))*${band}':b='b(X,Y)+(255-b(X,Y))*${band}'`;
    }
    case 'cover': // a thumb or another box covering part of the label
      return `drawbox=x=0:y=180:w=iw*${r2(0.12 * k)}:h=420:color=0x5a4032@1:t=fill`;
  }
}

export function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0;
}

export function imagePath(outDir, id, cond, level) {
  return path.join(outDir, id, cond, `${level}.jpg`);
}

function runFfmpeg(input, vf, output) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf, '-q:v', '3', output]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`ffmpeg failed on ${output}: ${err.trim()}`))));
    p.on('error', reject);
  });
}

// Builds the ladder for every clean image. Skips images that already exist unless fresh is set.
export async function degradeAll(clean, outDir, { conditions = CONDITIONS, levels = LEVELS, fresh = false, concurrency = 6 } = {}) {
  const jobs = [];
  for (const img of clean)
    for (const cond of conditions)
      for (const level of levels) {
        const out = imagePath(outDir, img.id, cond, level);
        jobs.push({ id: img.id, cond, level, input: img.file, out });
      }
  let next = 0, made = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (!fresh && existsSync(j.out)) continue;
      mkdirSync(path.dirname(j.out), { recursive: true });
      await runFfmpeg(j.input, ladderFilter(j.cond, j.level), j.out);
      made++;
    }
  }));
  return { total: jobs.length, made, images: jobs.map(({ id, cond, level, out }) => ({ id, cond, level, file: out })) };
}
