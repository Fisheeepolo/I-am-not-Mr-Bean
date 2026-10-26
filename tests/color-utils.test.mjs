import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deltaE2000, rgbToLab } from '../public/color-utils.js';

// Author-maintained supplementary data, downloaded unchanged 2026-10-26:
// https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
// Sharma, Wu & Dalal, Color Research & Application 30(1), 2005, doi:10.1002/col.20070.
test('CIEDE2000 matches all 34 author-supplied reference pairs including hue discontinuities', async () => {
  const pairs = (await readFile(new URL('./fixtures/ciede2000-sharma.txt', import.meta.url), 'utf8')).trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number));
  assert.equal(pairs.length, 34);
  for (let i = 0; i < pairs.length; i++) {
    const row = pairs[i], a = row.slice(0, 3), b = row.slice(3, 6), expected = row[6];
    assert(Math.abs(deltaE2000(a, b) - expected) <= .00005, `Reference pair ${i + 1}`);
    assert(Math.abs(deltaE2000(a, b) - deltaE2000(b, a)) < 1e-11, `Symmetry pair ${i + 1}`);
    assert.equal(deltaE2000(a, a), 0);
  }
});
test('CIEDE2000 is finite at black/white/neutral and sRGB boundaries', () => {
  const values = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255]].map(rgbToLab);
  for (const a of values) for (const b of values) assert(Number.isFinite(deltaE2000(a, b)));
});
