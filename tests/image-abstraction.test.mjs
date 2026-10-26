import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImageStructure, abstractImageForPattern } from '../public/image-abstraction.js';

const field = (w, h, color = [128, 128, 128, 255]) => new Uint8ClampedArray(Array.from({ length: w * h }, () => color).flat());
const maps = ['saliency', 'gradient', 'defocus', 'defocusConfidence', 'orientation', 'anisotropy'];

test('structure maps are finite and normalized; textureless regions have no defocus evidence', () => {
  const source = field(25, 17);
  const result = analyzeImageStructure(source, 25, 17);
  for (const key of maps) { assert.equal(result[key].length, 425); assert.ok(result[key].every(Number.isFinite)); }
  assert.ok(result.defocus.every(v => v === 0));
  assert.ok(result.defocusConfidence.every(v => v === 0));
  assert.equal(result.diagnostics.opticalDefocus, false);
  assert.equal(result.diagnostics.semanticSaliency, false);
});

test('structure tensor follows an edge tangent and sparse eye prominence exceeds its surroundings', () => {
  const edge = field(48, 48, [240, 240, 240, 255]);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 24; x++) edge.set([30, 60, 100, 255], (y * 48 + x) * 4);
  const analysis = analyzeImageStructure(edge, 48, 48), i = 24 * 48 + 23;
  assert.ok(Math.abs(Math.cos(analysis.orientation[i])) < .01, 'vertical edge has a vertical tangent');
  assert.ok(analysis.anisotropy[i] > .95);
  assert.ok(analysis.gradient[i] > analysis.gradient[24 * 48 + 5]);
  const eyes = field(20, 20, [255, 255, 255, 255]);
  for (let y = 9; y < 11; y++) for (let x = 9; x < 11; x++) eyes.set([0, 0, 0, 255], (y * 20 + x) * 4);
  const eyeAnalysis = analyzeImageStructure(eyes, 20, 20);
  assert.ok(eyeAnalysis.saliency[9 * 20 + 9] > eyeAnalysis.saliency[8 * 20 + 9] + .5, 'rare features must not saturate together with neighbouring background');
});

test('hidden transparent RGB cannot affect analysis and all analysis maps are deterministic', () => {
  const a = field(32, 32, [255, 255, 255, 0]);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) a.set([x * 8, y * 8, 110, 255], (y * 32 + x) * 4);
  const b = a.slice();
  for (let i = 0; i < b.length; i += 4) if (!b[i + 3]) b.set([0, 35, 230, 0], i);
  const aa = analyzeImageStructure(a, 32, 32), bb = analyzeImageStructure(b, 32, 32);
  for (const key of maps) {
    assert.deepEqual(aa[key], bb[key]);
    if (key !== 'orientation') assert.ok(aa[key].every(v => v >= 0 && v <= 1));
  }
});

test('native-resolution pixel art and disabled abstraction are owned exact copies', () => {
  const source = field(8, 8);
  source.set([255, 255, 255, 0], 0); source.set([40, 80, 190, 128], 24);
  const native = abstractImageForPattern(source, 8, 8, { targetWidth: 8, targetHeight: 8 });
  assert.deepEqual(native.data, source); assert.notEqual(native.data, source);
  assert.equal(native.diagnostics.reason, 'native-resolution');
  const disabled = abstractImageForPattern(source, 8, 8, { targetWidth: 4, targetHeight: 4, abstraction: false });
  assert.deepEqual(disabled.data, source); assert.equal(disabled.diagnostics.reason, 'disabled');
});

test('anisotropic abstraction reduces weak within-region noise while preserving the step and every alpha', () => {
  const width = 64, source = field(width, width), truth = new Float32Array(width * width);
  let seed = 177;
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const i = y * width + x, base = x < 32 ? 65 : 210, value = base + seed % 21 - 10;
    truth[i] = base; source.set([value, value, value, y === 0 ? 0 : y === 1 ? 128 : 255], i * 4);
  }
  const copy = source.slice(), result = abstractImageForPattern(source, width, width, { targetWidth: 16, targetHeight: 16 });
  let before = 0, after = 0;
  for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) {
    const i = y * width + x;
    if (x < 29 || x > 34) { before += (source[i * 4] - truth[i]) ** 2; after += (result.data[i * 4] - truth[i]) ** 2; }
  }
  assert.ok(after < before * .9, 'weak texture receives measurable flattening');
  for (let y = 4; y < 60; y++) { assert.ok(result.data[(y * width + 31) * 4] < 100); assert.ok(result.data[(y * width + 32) * 4] > 180); }
  for (let i = 0; i < width * width; i++) assert.equal(result.data[i * 4 + 3], source[i * 4 + 3]);
  assert.deepEqual(source, copy);
  assert.deepEqual(result.data, abstractImageForPattern(source, width, width, { targetWidth: 16, targetHeight: 16 }).data);
});

test('confidence-gated blur proxy continuously increases abstraction rather than inventing optical focus labels', () => {
  const source = field(17, 17), center = 8 * 17 + 8;
  source.set([170, 170, 170, 255], center * 4);
  const analysis = Object.fromEntries(maps.map(key => [key, new Float32Array(17 * 17)]));
  Object.assign(analysis, { width: 17, height: 17 });
  analysis.defocus.fill(1); analysis.defocusConfidence.fill(1);
  const aware = abstractImageForPattern(source, 17, 17, { targetWidth: 8, targetHeight: 8, analysis });
  const unaware = abstractImageForPattern(source, 17, 17, { targetWidth: 8, targetHeight: 8, analysis, defocusAware: false });
  assert.ok(aware.data[center * 4] < unaware.data[center * 4]);
  const broad = field(96, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 96; x++) {
    const value = Math.round(128 + 110 * Math.sin(x * Math.PI * 2 / 24));
    broad.set([value, value, value, 255], (y * 96 + x) * 4);
  }
  const proxy = analyzeImageStructure(broad, 96, 32);
  assert.ok(proxy.defocus.some(v => v > .03));
  assert.ok(proxy.defocus.every((v, i) => v <= proxy.defocusConfidence[i] + 1e-6));
});

test('invalid shapes and mismatched analysis cannot silently turn into black pixels', () => {
  assert.throws(() => analyzeImageStructure(field(4, 4), 4, 0));
  assert.throws(() => analyzeImageStructure(field(4, 4), 4, 3));
  assert.throws(() => abstractImageForPattern(field(4, 4), 4, 4, { optimizationMode: 'invent' }));
  assert.throws(() => abstractImageForPattern(field(4, 4), 4, 4, { analysis: { width: 4, height: 4, saliency: new Float32Array(1) } }));
});
