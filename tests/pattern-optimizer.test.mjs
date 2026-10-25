import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizePatternColors, OPTIMIZATION_MODES } from '../public/pattern-optimizer.js';
import { rgbToLab, hexToRgb } from '../public/color-utils.js';

const lab = hex => rgbToLab(hexToRgb(hex));
const palette = [
  { code: 'cream1', hex: '#F6EEE4' }, { code: 'cream2', hex: '#EFE7DE' },
  { code: 'eye', hex: '#222222' }, { code: 'red', hex: '#C44040' },
];

test('budgeted palette keeps rare contrasting eyes and accents ahead of redundant cream shades', () => {
  const labs = Array.from({ length: 32 * 32 }, (_, i) => lab(palette[i % 32 < 16 ? 0 : 1].hex));
  for (const at of [330, 334, 458, 462]) labs[at] = lab('#222222');
  for (const at of [590, 591, 622, 623]) labs[at] = lab('#C44040');
  const result = optimizePatternColors(labs, 32, 32, palette, { maxColors: 3, optimizationMode: 'balanced' });
  assert.equal(result.counts.eye, 4);
  assert.equal(result.counts.red, 4);
  assert.equal(Object.keys(result.counts).length, 3);
  assert.equal(result.cells[330], 'eye');
  assert.equal(result.cells[590], 'red');
});

test('strong one-bead details and thin outlines survive every mode while weak single noise is reduced', () => {
  const colors = [
    { code: 'base', hex: '#888888' }, { code: 'weak', hex: '#909090' },
    { code: 'ink', hex: '#141414' },
  ];
  const labs = Array.from({ length: 81 }, () => lab(colors[0].hex));
  labs[20] = lab(colors[1].hex);
  labs[60] = lab(colors[2].hex);
  for (let y = 1; y < 8; y++) labs[y * 9 + 5] = lab(colors[2].hex);
  const snapshot = structuredClone(labs);
  for (const mode of OPTIMIZATION_MODES) {
    const result = optimizePatternColors(labs, 9, 9, colors, { maxColors: 3, optimizationMode: mode });
    assert.equal(result.cells[60], 'ink');
    for (let y = 1; y < 8; y++) assert.equal(result.cells[y * 9 + 5], 'ink');
    assert.equal(result.cells[20], mode === 'detail' ? 'weak' : 'base');
  }
  assert.deepEqual(labs, snapshot);
});

test('null mask, legal stock colours, counts and hard budget survive all modes', () => {
  const labs = Array.from({ length: 23 * 19 }, (_, i) => i % 7 === 0 ? null : lab(palette[i % palette.length].hex));
  for (const mode of OPTIMIZATION_MODES) for (const maximum of [1, 2, 4, 20]) {
    const result = optimizePatternColors(labs, 23, 19, palette, { maxColors: maximum, optimizationMode: mode });
    assert.equal(result.cells.length, labs.length);
    assert.ok(Object.keys(result.counts).length <= Math.min(maximum, palette.length));
    assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), labs.filter(Boolean).length);
    for (let i = 0; i < labs.length; i++) {
      assert.equal(result.cells[i] == null, labs[i] == null);
      if (result.cells[i]) assert.ok(palette.some(c => c.code === result.cells[i]));
    }
    assert.deepEqual(result, optimizePatternColors(labs, 23, 19, [...palette].reverse(), { maxColors: maximum, optimizationMode: mode }));
  }
});

test('exact flat palette art is unchanged in detail mode, including ties and empty images', () => {
  const labs = [lab('#F6EEE4'), lab('#EFE7DE'), null, lab('#222222'), lab('#C44040'), null];
  assert.deepEqual(optimizePatternColors(labs, 3, 2, palette, { maxColors: 4, optimizationMode: 'detail' }).cells,
    ['cream1', 'cream2', null, 'eye', 'red', null]);
  const result = optimizePatternColors([null, null], 2, 1, palette);
  assert.deepEqual(result.cells, [null, null]);
  assert.deepEqual(result.counts, {});
  assert.equal(result.diagnostics.weightedRmse, 0);
  const same = [{ code: 'Z', hex: '#ffffff' }, { code: 'A', hex: '#ffffff' }];
  assert.equal(optimizePatternColors([lab('#ffffff')], 1, 1, same).cells[0], 'A');
  const unusualCodes = [{ code: '__proto__', hex: '#ffffff' }, { code: 'constructor', hex: '#000000' }];
  const unusual = optimizePatternColors([lab('#fff'), lab('#000')], 2, 1, unusualCodes);
  assert.deepEqual(Object.entries(unusual.counts), [['__proto__', 1], ['constructor', 1]]);
});

test('bad dimensions, duplicate codes, malformed pixels and unknown modes fail explicitly', () => {
  assert.throws(() => optimizePatternColors([], 0, 1, palette));
  assert.throws(() => optimizePatternColors([], 2, 1, palette));
  assert.throws(() => optimizePatternColors([lab('#000')], 1, 1, []));
  assert.throws(() => optimizePatternColors([lab('#000')], 1, 1, [palette[0], palette[0]]));
  assert.throws(() => optimizePatternColors([[NaN, 0, 0]], 1, 1, palette));
  assert.throws(() => optimizePatternColors([lab('#fff'), [0, Infinity, 0]], 2, 1, palette));
  assert.throws(() => optimizePatternColors(['abc'], 1, 1, palette));
  assert.throws(() => optimizePatternColors([lab('#000')], 1, 1, palette, { optimizationMode: 'unknown' }));
});

test('160 square output with a 1000-colour catalogue remains within constraints', () => {
  const colors = Array.from({ length: 1000 }, (_, i) => ({ code: `C${String(i).padStart(4, '0')}`, hex: '#' + ((i * 2654435761 >>> 0) & 0xffffff).toString(16).padStart(6, '0') }));
  const labs = Array.from({ length: 160 * 160 }, (_, i) => rgbToLab([i % 251, (i * 13) % 253, (i * 7) % 255]));
  const start = performance.now();
  const result = optimizePatternColors(labs, 160, 160, colors, { maxColors: 16 });
  const elapsed = performance.now() - start;
  assert.equal(result.cells.length, 25600);
  assert.ok(Object.keys(result.counts).length <= 16);
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), 25600);
  // Log timing as evidence; avoid a machine-dependent pass/fail time threshold.
  console.log(`160×160 / 1000 catalogue / 16 colours: ${elapsed.toFixed(1)} ms`);
});
