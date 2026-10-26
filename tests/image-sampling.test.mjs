import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleImageForPattern } from '../public/image-sampling.js';
import { rgbToLab } from '../public/color-utils.js';

const field = (width, height, rgba = [255, 255, 255, 255]) => new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat());
const sample = (data, sw, sh, w, h, mode = 'balanced', extra = {}) => sampleImageForPattern(data, sw, sh, w, h, { optimizationMode: mode, ...extra });
const rgbAt = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

test('saliency ablation changes only exponential weights, not contrast recovery strength', () => {
  const source = field(20, 20);
  for (let y = 9; y < 11; y++) for (let x = 9; x < 11; x++) source.set([0, 0, 0, 255], (y * 20 + x) * 4);
  for (const mode of ['detail', 'balanced', 'easy']) {
    const disabled = sample(source, 20, 20, 5, 5, mode, { saliencySampling: false });
    const zeroWeights = sample(source, 20, 20, 5, 5, mode, { betaSaliency: 0, betaGradient: 0 });
    assert.deepEqual(disabled, zeroWeights);
    assert.notDeepEqual(disabled.data, sample(source, 20, 20, 5, 5, mode, { saliencySampling: false, contrastRecovery: false }).data);
  }
});

test('unchanged resolution is an owned exact copy, including hidden RGB and alpha', () => {
  const source = new Uint8ClampedArray([1, 2, 3, 0, 240, 128, 5, 128]);
  const copy = source.slice();
  for (const mode of ['detail', 'balanced', 'easy']) {
    const result = sample(source, 2, 1, 2, 1, mode);
    assert.deepEqual(result.data, copy); assert.notEqual(result.data, source);
  }
  assert.deepEqual(source, copy);
});

test('fractional footprints use actual overlap area, not nearest pixel counts', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255]);
  // Geometric integration is a separate ablation from v4's colour weighting.
  const result = sample(data, 3, 1, 2, 1, 'balanced', { saliencySampling: false });
  assert.deepEqual([...result.data], [33, 33, 33, 255, 167, 167, 167, 255]);
});

test('premultiplied alpha blocks hidden white from bleeding into a red silhouette', () => {
  const data = new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0]);
  assert.deepEqual([...sample(data, 2, 2, 1, 1).data], [255, 0, 0, 64]);
  const empty = field(4, 4, [255, 96, 43, 0]);
  assert.deepEqual([...sample(empty, 4, 4, 2, 2).data], new Array(16).fill(0));
});

test('sub-cell eyes and thin strokes retain more target-scale contrast than area sampling', () => {
  const eye = field(20, 20);
  for (let y = 9; y < 11; y++) for (let x = 9; x < 11; x++) eye.set([0, 0, 0, 255], (y * 20 + x) * 4);
  const area = sample(eye, 20, 20, 5, 5, 'balanced', { contrastRecovery: false, saliencySampling: false });
  const detail = sample(eye, 20, 20, 5, 5, 'detail');
  const balanced = sample(eye, 20, 20, 5, 5, 'balanced');
  const easy = sample(eye, 20, 20, 5, 5, 'easy');
  assert.equal(rgbAt(area, 2, 2)[0], 191);
  assert.ok(rgbToLab(rgbAt(balanced, 2, 2))[0] < 50, 'a quarter-cell dark eye remains on the dark side of a CIELAB black/white palette');
  assert.ok(rgbAt(detail, 2, 2)[0] < rgbAt(balanced, 2, 2)[0]);
  assert.ok(rgbAt(balanced, 2, 2)[0] < rgbAt(easy, 2, 2)[0]);
  assert.deepEqual(rgbAt(balanced, 1, 1), [255, 255, 255]);
  const stroke = field(28, 28);
  for (let x = 4; x < 24; x++) stroke.set([0, 0, 0, 255], (13 * 28 + x) * 4);
  const line = sample(stroke, 28, 28, 7, 7);
  for (let x = 1; x < 6; x++) assert.ok(rgbToLab(rgbAt(line, x, 3))[0] < 50, 'the connected stroke does not turn into disconnected samples');
});

test('smooth ramps and weak texture are not amplified', () => {
  const ramp = field(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) ramp.set([x * 4, x * 4, x * 4, 255], (y * 64 + x) * 4);
  assert.deepEqual(sample(ramp, 64, 64, 16, 16).data, sample(ramp, 64, 64, 16, 16, 'balanced', { contrastRecovery: false }).data);
  const texture = field(64, 64);
  let seed = 17;
  for (let i = 0; i < 64 * 64; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = 128 + (seed % 17) - 8;
    texture.set([value, value, value, 255], i * 4);
  }
  assert.deepEqual(sample(texture, 64, 64, 16, 16).data, sample(texture, 64, 64, 16, 16, 'balanced', { contrastRecovery: false }).data);
});

test('balanced does not sharpen multi-colour photographic texture merely because its cell means differ', () => {
  const source = field(20, 20);
  const offsets = [[-35, 25, 15], [30, -35, 20], [15, 30, -35], [-15, -10, 35]];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const center = x >= 8 && x < 12 && y >= 8 && y < 12 ? 95 : 170;
    const rgb = offsets[(x + y) % offsets.length].map(value => value + center);
    source.set([...rgb, 255], (y * 20 + x) * 4);
  }
  const area = sample(source, 20, 20, 5, 5, 'balanced', { contrastRecovery: false });
  assert.deepEqual(sample(source, 20, 20, 5, 5).data, area.data);
  // v4 has mode-specific projection weights; compare against the same mode
  // with contrast recovery disabled, not a differently weighted colour mean.
  assert.deepEqual(sample(source, 20, 20, 5, 5, 'easy').data, sample(source, 20, 20, 5, 5, 'easy', { contrastRecovery: false }).data);
});

test('contrast recovery preserves exact area alpha and source channel bounds', () => {
  const source = field(48, 48);
  let seed = 23;
  for (let i = 0; i < 48 * 48; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    source.set([60 + seed % 100, 80 + (seed >>> 8) % 110, 130 + (seed >>> 16) % 90, (seed >>> 24)], i * 4);
  }
  const before = source.slice();
  const area = sample(source, 48, 48, 12, 12, 'balanced', { contrastRecovery: false });
  const processed = sample(source, 48, 48, 12, 12, 'detail');
  assert.deepEqual(source, before);
  for (let i = 0; i < 12 * 12; i++) {
    assert.equal(processed.data[i * 4 + 3], area.data[i * 4 + 3]);
    for (let c = 0; c < 3; c++) {
      const values = [];
      for (let y = Math.floor(i / 12) * 4; y < Math.floor(i / 12) * 4 + 4; y++) for (let x = i % 12 * 4; x < i % 12 * 4 + 4; x++) {
        const p = (y * 48 + x) * 4;
        if (source[p + 3]) values.push(source[p + c]);
      }
      assert.ok(processed.data[i * 4 + c] >= Math.min(...values));
      assert.ok(processed.data[i * 4 + c] <= Math.max(...values));
    }
  }
  assert.deepEqual(processed.data, sample(source, 48, 48, 12, 12, 'detail').data);
});

test('invalid shapes and unknown optimization modes fail clearly', () => {
  assert.throws(() => sample(field(2, 2), 2, 2, 0, 1));
  assert.throws(() => sample(field(2, 2), 3, 2, 1, 1));
  assert.throws(() => sample(field(2, 2), 2, 2, 1, 1, 'toString'));
  assert.throws(() => sample(field(2, 2), 2, 2, 1, 1, 'imaginary'));
});

test('exponential colour weights obey the two-colour mixture while alpha remains geometric coverage', () => {
  const source = new Uint8ClampedArray([0, 0, 0, 64, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  const analysis = { width: 2, height: 2, saliency: new Float32Array([1, 0, 0, 0]), gradient: new Float32Array(4), defocus: new Float32Array([0, .5, .5, .5]), defocusConfidence: new Float32Array([0, 1, 1, 1]) };
  const result = sample(source, 2, 2, 1, 1, 'balanced', { analysis, contrastRecovery: false, betaSaliency: 2, betaGradient: 0 });
  const expected = Math.round(255 * 765 / (64 * Math.exp(2) + 765));
  assert.deepEqual([...result.data], [expected, expected, expected, 207]);
  assert.ok(Math.abs(result.saliency[0] - Math.sqrt(64 / 829)) < 1e-6);
  assert.ok(Math.abs(result.defocus[0] - 382.5 / 829) < 1e-6);
  const unweighted = sample(source, 2, 2, 1, 1, 'balanced', { analysis, contrastRecovery: false, saliencySampling: false });
  assert.equal(unweighted.data[3], result.data[3]);
  assert.ok(result.data[0] < unweighted.data[0]);
});

test('bounded saliency weights do not promise that an arbitrarily thin line survives', () => {
  const source = field(8, 8); source.set([0, 0, 0, 255], 0);
  const saliency = new Float32Array(64), gradient = new Float32Array(64); saliency[0] = 1; gradient[0] = 1;
  const result = sample(source, 8, 8, 1, 1, 'balanced', { contrastRecovery: false, analysis: { width: 8, height: 8, saliency, gradient } });
  assert.ok(rgbToLab(rgbAt(result, 0, 0))[0] > 50, '1/64 area remains background-side even with maximal feature weights');
});
