import assert from 'node:assert/strict';
import { applyImageStyle, IMAGE_STYLES } from '../public/image-styles.js';

const pixel = (...rgba) => new Uint8ClampedArray(rgba);
const input = pixel(117, 149, 186, 255, 52, 78, 90, 128, 27, 32, 41, 0);
const original = input.slice();
for (const style of IMAGE_STYLES) {
  const result = applyImageStyle({ data: input }, 3, 1, style);
  assert.deepEqual(input, original, 'Image processing never alters its source');
  assert.notEqual(result.data, input, 'Output owns its pixels');
  assert.deepEqual([result.width, result.height], [3, 1]);
  assert.deepEqual([result.data[3], result.data[7], result.data[11]], [255, 128, 0]);
  assert.deepEqual([...result.data.slice(8)], [...input.slice(8)], 'Fully transparent pixels are untouched');
}
assert.deepEqual(applyImageStyle(input, 3, 1, 'original').data, input);
assert.notDeepEqual(applyImageStyle(input, 3, 1, 'vivid').data, input);
assert.notDeepEqual(applyImageStyle(input, 3, 1, 'clean').data, input);

const field = () => new Uint8ClampedArray(Array.from({ length: 9 }, () => [96, 128, 160, 255]).flat());
const speck = field(); speck.set([127, 128, 160, 255], 16);
assert.deepEqual([...applyImageStyle(speck, 3, 3, 'clean').data.slice(16, 20)], [96, 128, 160, 255], 'A weak isolated speck is flattened');
const eye = field(); eye.set([0, 0, 0, 255], 16);
assert.deepEqual([...applyImageStyle(eye, 3, 3, 'clean').data.slice(16, 20)], [0, 0, 0, 255], 'Strong outline or eye details survive');
const transparentEdge = speck.slice(); transparentEdge[7] = 0;
assert.deepEqual([...applyImageStyle(transparentEdge, 3, 3, 'clean').data.slice(16, 20)], [128, 128, 160, 255], 'A transparent edge prevents neighbour smoothing');
const partialEdge = speck.slice(); partialEdge[7] = 128;
assert.equal(applyImageStyle(partialEdge, 3, 3, 'clean').data[16], 128, 'An antialiased edge is not smoothed across');
assert.throws(() => applyImageStyle(input, 0, 1));
assert.throws(() => applyImageStyle(input, 2, 1));
assert.throws(() => applyImageStyle(input, 3, 1, 'imaginary'));
console.log('PASS local styles: source immutability, unchanged alpha, gentle flattening, transparent edge and strong detail retention, vivid effect and validation');
