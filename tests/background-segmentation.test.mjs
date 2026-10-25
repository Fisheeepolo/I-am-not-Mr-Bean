import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentBackground } from '../public/background-segmentation.js';

const field = (width, height, rgba = [255, 255, 255, 255]) => new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat());
const alphaAt = (data, width, x, y) => data[(y * width + x) * 4 + 3];
function rect(data, width, x, y, w, h, rgba) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set(rgba, (yy * width + xx) * 4);
}

test('preserve is the default and owns an exact RGBA copy', () => {
  const source = new Uint8ClampedArray([255, 255, 255, 255, 17, 33, 55, 0, 230, 240, 245, 64, 0, 0, 0, 255]);
  const result = segmentBackground(source, 2, 2);
  assert.deepEqual(result.data, source); assert.notEqual(result.data, source);
  assert.equal(result.diagnostics.reason, 'preserve-mode');
  assert.equal(result.diagnostics.foregroundPixels, 3);
  assert.equal(result.mask.reduce((sum, v) => sum + v, 0), 0);
});

test('all-white and near-uniform opaque images are retained instead of becoming empty', () => {
  for (const value of [0, 128, 250, 255]) {
    const source = field(32, 32, [value, value, value, 255]);
    const result = segmentBackground(source, 32, 32, { mode: 'edge' });
    assert.deepEqual(result.data, source);
    assert.equal(result.diagnostics.status, 'preserved');
    assert.equal(result.diagnostics.reason, 'uniform-image');
    assert.equal(result.diagnostics.foregroundPixels, 1024);
  }
});

test('edge removes supported exterior while preserving a pale outlined white object and a narrow seam', () => {
  for (const gap of [false, true]) {
    const source = field(64, 64);
    rect(source, 64, 16, 16, 32, 32, [245, 245, 245, 255]);
    rect(source, 64, 17, 17, 30, 30, [255, 255, 255, 255]);
    if (gap) source.set([255, 255, 255, 255], (16 * 64 + 32) * 4);
    const copy = source.slice();
    const result = segmentBackground(source, 64, 64, { mode: 'edge', tolerance: 20, scale: 4 });
    assert.equal(result.diagnostics.status, 'segmented');
    assert.equal(alphaAt(result.data, 64, 32, 32), 255, 'white interior remains solid');
    assert.equal(alphaAt(result.data, 64, 16, 32), 255, 'pale outline is not deleted');
    assert.equal(alphaAt(result.data, 64, 0, 0), 0, 'explicit exterior is actually removed');
    assert.equal(result.diagnostics.foregroundPixels, 32 * 32, 'edge protection does not add an exterior white halo');
    assert.deepEqual(source, copy);
    assert.deepEqual(result.data, segmentBackground(source, 64, 64, { mode: 'edge', tolerance: 20, scale: 4 }).data);
    assert.equal(result.mask.reduce((sum, v) => sum + v, 0), result.diagnostics.removedPixels);
    for (let i = 0; i < source.length; i += 4) assert.deepEqual(result.data.slice(i, i + 3), source.slice(i, i + 3), 'only alpha changes');
  }
});

test('native-grid outlines retain exactly their enclosed cells, including one-pixel exterior margins', () => {
  for (const [size, start, span] of [[9, 2, 5], [9, 1, 7], [7, 1, 5]]) {
    const source = field(size, size);
    rect(source, size, start, start, span, span, [0, 0, 0, 255]);
    rect(source, size, start + 1, start + 1, span - 2, span - 2, [255, 255, 255, 255]);
    const result = segmentBackground(source, size, size, { mode: 'edge', scale: 1 });
    assert.equal(result.diagnostics.status, 'segmented');
    assert.equal(result.diagnostics.foregroundPixels, span * span);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const inside = x >= start && x < start + span && y >= start && y < start + span;
      assert.equal(alphaAt(result.data, size, x, y), inside ? 255 : 0);
    }
  }
});

test('background colour is inferred rather than assumed white', () => {
  const source = field(48, 48, [45, 120, 210, 255]);
  rect(source, 48, 12, 12, 24, 24, [245, 110, 80, 255]);
  const result = segmentBackground(source, 48, 48, { mode: 'edge' });
  assert.equal(result.diagnostics.status, 'segmented');
  assert.equal(alphaAt(result.data, 48, 24, 24), 255);
  assert.equal(alphaAt(result.data, 48, 0, 0), 0);
  const exact = segmentBackground(source, 48, 48, { mode: 'edge', tolerance: 0 });
  assert.equal(exact.diagnostics.status, 'segmented');
  assert.equal(alphaAt(exact.data, 48, 0, 0), 0, 'zero tolerance accepts the exact repeated background colour');
});

test('existing alpha, including a genuine transparent hole, is authoritative', () => {
  const source = field(48, 48, [77, 88, 99, 0]);
  rect(source, 48, 7, 7, 34, 34, [255, 255, 255, 255]);
  rect(source, 48, 22, 22, 4, 4, [255, 255, 255, 0]);
  source[(7 * 48 + 8) * 4 + 3] = 128;
  const result = segmentBackground(source, 48, 48, { mode: 'edge' });
  assert.equal(result.diagnostics.reason, 'existing-alpha');
  assert.deepEqual(result.data, source);
});

test('known fractional contain padding is distinct from transparency in the original image', () => {
  const source = field(32, 32, [11, 22, 33, 0]);
  const contentBounds = { x: 4.25, y: 2.5, width: 23.5, height: 26.75 };
  for (let y = 2; y < 30; y++) for (let x = 4; x < 28; x++) {
    const coverage = Math.max(0, Math.min(x + 1, 27.75) - Math.max(x, 4.25)) * Math.max(0, Math.min(y + 1, 29.25) - Math.max(y, 2.5));
    source.set([255, 255, 255, Math.round(coverage * 255)], (y * 32 + x) * 4);
  }
  rect(source, 32, 10, 10, 12, 12, [230, 110, 65, 255]);
  assert.equal(segmentBackground(source, 32, 32, { mode: 'edge' }).diagnostics.reason, 'existing-alpha');
  const result = segmentBackground(source, 32, 32, { mode: 'edge', contentBounds, scale: 4 });
  assert.equal(result.diagnostics.status, 'segmented');
  assert.equal(alphaAt(result.data, 32, 16, 16), 255);
  assert.equal(alphaAt(result.data, 32, 4, 2), 0);
  assert.deepEqual(result.data.slice(0, 4), source.slice(0, 4));
  source[(15 * 32 + 15) * 4 + 3] = 0;
  assert.equal(segmentBackground(source, 32, 32, { mode: 'edge', contentBounds }).diagnostics.reason, 'existing-alpha');
});

test('inconsistent edges and near-total deletion cause explicit abstention', () => {
  const striped = field(32, 32);
  rect(striped, 32, 0, 0, 16, 32, [0, 0, 0, 255]);
  const unclear = segmentBackground(striped, 32, 32, { mode: 'edge' });
  assert.equal(unclear.diagnostics.reason, 'uncertain-boundary');
  assert.deepEqual(unclear.data, striped);
  const dots = field(128, 128);
  rect(dots, 128, 60, 60, 5, 5, [0, 0, 0, 255]);
  const almostEmpty = segmentBackground(dots, 128, 128, { mode: 'edge' });
  assert.equal(almostEmpty.diagnostics.reason, 'excessive-removal');
  assert.deepEqual(almostEmpty.data, dots);
});

test('invalid sizes, modes, bounds and tolerances fail clearly', () => {
  const source = field(4, 4);
  assert.throws(() => segmentBackground(source, 0, 4));
  assert.throws(() => segmentBackground(source, 5, 4));
  assert.throws(() => segmentBackground(source, 4, 4, { mode: 'invent' }));
  assert.throws(() => segmentBackground(source, 4, 4, { mode: 'edge', tolerance: NaN }));
  assert.throws(() => segmentBackground(source, 4, 4, { mode: 'edge', contentBounds: { x: 0, y: 0, width: -1, height: 4 } }));
});
