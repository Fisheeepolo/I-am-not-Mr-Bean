import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { optimizePatternColors, OPTIMIZER_PARAMETERS } from '../public/pattern-optimizer.js';
import { hexToRgb, rgbToLab } from '../public/color-utils.js';

const palette = [{ code: 'base', hex: '#888888' }, { code: 'speck', hex: '#909090' }, { code: 'ink', hex: '#111111' }];
const labsFor = count => Array.from({ length: 81 }, (_, i) => rgbToLab(hexToRgb(i >= 39 && i < 39 + count ? '#909090' : '#888888')));
const zeros = () => new Float32Array(81);
const run = (count, options = {}) => optimizePatternColors(labsFor(count), 9, 9, palette,
  { maxColors: 3, spatialRegularization: false, saliencyMap: zeros(), defocusMap: zeros(), ...options });

test('the <=2 connected-component penalty is a real step, and high-saliency components are exempt', () => {
  for (const count of [1, 2]) {
    const unprotected = run(count);
    assert.equal(unprotected.counts.speck || 0, 0, `Weak ${count}-cell island is merged`);
    assert(unprotected.diagnostics.solver.componentMerges > 0);
    const saliency = zeros(); for (let i = 39; i < 39 + count; i++) saliency[i] = 1;
    const protectedResult = run(count, { saliencyMap: saliency });
    assert.equal(protectedResult.counts.speck, count);
    assert.equal(protectedResult.diagnostics.energyTrace[0].island, 0);
    assert.equal(protectedResult.diagnostics.finalIslandRates.protected, 1);
    assert.equal(run(count, { islandPenalty: false }).counts.speck, count, 'Disabling both regularizers preserves nearest-colour samples');
  }
  const three = run(3);
  assert.equal(three.counts.speck, 3, 'A connected component above threshold is not charged');
  assert.equal(three.diagnostics.energyTrace[0].island, 0);
});

test('full unary/pairwise/island energy and medoid objectives never increase across accepted stages', () => {
  const colors = ['#828282', '#888888', '#909090', '#171717', '#e0d9bf', '#efdab0', '#b17050', '#705041']
    .map((hex, i) => ({ code: `C${i}`, hex }));
  for (let trial = 1; trial <= 12; trial++) {
    const labs = Array.from({ length: 20 * 20 }, (_, i) => i % 17 === 0 ? null : rgbToLab(hexToRgb(colors[(Math.imul(i + 1, trial * 1619) >>> 7) % colors.length].hex)));
    const saliency = Float32Array.from({ length: labs.length }, (_, i) => i % 9 === 0 ? 1 : .15);
    const defocus = Float32Array.from({ length: labs.length }, (_, i) => i < 200 ? .8 : 0);
    for (const colorMetric of ['de2000', 'lab76']) {
      const result = optimizePatternColors(labs, 20, 20, colors, { maxColors: 4, saliencyMap: saliency, defocusMap: defocus, colorMetric });
      const trace = result.diagnostics.energyTrace;
      for (let i = 0; i < trace.length; i++) {
        assert(Math.abs(trace[i].total - trace[i].data - trace[i].pairwise - trace[i].island) < 1e-7);
        if (i) assert(trace[i].total <= trace[i - 1].total + 1e-7, `${colorMetric} stage ${trace[i].stage}`);
      }
      const paletteTrace = result.diagnostics.paletteSelection.trace;
      for (let i = 1; i < paletteTrace.length; i++) assert(paletteTrace[i].energy <= paletteTrace[i - 1].energy + 1e-7);
      assert(Object.keys(result.counts).length <= 4);
      assert(result.cells.every((code, i) => (code === null) === (labs[i] === null)));
      for (const rate of [result.diagnostics.finalIslandRates.protected, result.diagnostics.finalIslandRates.unprotected]) assert(rate >= 0 && rate <= 1);
    }
  }
});

test('default output is repeatable; timing is opt-in; map and metric errors fail explicitly', () => {
  assert.deepEqual(run(2), run(2));
  assert.equal(run(2).diagnostics.timings, null);
  const timed = run(2, { collectTimings: true });
  for (const value of Object.values(timed.diagnostics.timings)) assert(Number.isFinite(value) && value >= 0);
  assert.throws(() => run(2, { saliencyMap: [0] }));
  assert.throws(() => run(2, { defocusMap: new Float32Array(81).fill(NaN) }));
  assert.throws(() => run(2, { colorMetric: 'RGB' }));
  assert.equal(OPTIMIZER_PARAMETERS.maximumMatrixEntries, 3_000_000);
});

test('microstructure uses a fixed data-margin boundary cap and has an explicit ablation', async () => {
  const catalogue = JSON.parse(await readFile(new URL('../public/palette.json', import.meta.url), 'utf8')).colors;
  const width = 12, height = 12, labs = Array.from({ length: width * height }, () => rgbToLab([174, 186, 172]));
  const one = 5 * width + 4, two = 8 * width + 8;
  labs[one] = rgbToLab([159, 171, 157]); labs[two] = labs[two + 1] = rgbToLab([158, 170, 156]);
  const saliencyMap = new Float32Array(labs.length).fill(.04), defocusMap = new Float32Array(labs.length).fill(.14);
  saliencyMap[one] = .35; saliencyMap[two] = saliencyMap[two + 1] = .29;
  const options = { maxColors: 18, saliencyMap, defocusMap };
  const unregularized = optimizePatternColors(labs, width, height, catalogue, { ...options, spatialRegularization: false, islandPenalty: false });
  const protectedResult = optimizePatternColors(labs, width, height, catalogue, options);
  const noMicro = optimizePatternColors(labs, width, height, catalogue, { ...options, microProtection: false });
  for (const i of [one, two, two + 1]) assert.equal(protectedResult.cells[i], unregularized.cells[i]);
  assert.notEqual(noMicro.cells[one], unregularized.cells[one], 'Ablation demonstrates the low-contrast Potts failure');
  assert.equal(protectedResult.diagnostics.microProtection.protectedComponents, 2);
  assert.equal(protectedResult.diagnostics.microProtection.protectedCells, 3);
  for (const record of protectedResult.diagnostics.microProtection.records) {
    assert(record.boundaryAfter <= .5 * record.margin + 1e-9);
    assert(record.localDataPairwiseLowerBound > 0);
  }
  assert.equal(protectedResult.diagnostics.energyTrace[0].island, 0, 'Protected initial components are exempt from H');
  const defocused = optimizePatternColors(labs, width, height, catalogue, { ...options, defocusMap: new Float32Array(labs.length).fill(.8) });
  assert.equal(defocused.diagnostics.microProtection.protectedComponents, 0, 'Confidently blurred evidence does not trigger microstructure protection');
});
