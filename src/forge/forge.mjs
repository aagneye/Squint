// Renders clean label images from the specs by calling render.ps1 once for the whole batch.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Width and height from a PNG's IHDR chunk.
export function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function renderLabels(labels, outDir) {
  if (process.platform !== 'win32') throw new Error('label rendering uses Windows System.Drawing (run on Windows)');
  mkdirSync(outDir, { recursive: true });
  const specsFile = path.join(outDir, '_specs.json');
  writeFileSync(specsFile, JSON.stringify(labels));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'render.ps1'), '-SpecsFile', specsFile, '-OutDir', outDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('render.ps1 failed: ' + (r.stderr || r.stdout || r.error));
  return labels.map((l) => {
    const file = path.join(outDir, `${l.id}.png`);
    if (!existsSync(file)) throw new Error(`render.ps1 produced no image for ${l.id}`);
    return { id: l.id, file, ...pngSize(readFileSync(file)) };
  });
}
