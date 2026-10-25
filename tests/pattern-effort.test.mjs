import assert from 'node:assert/strict';
import { estimatePatternEffort, getPatternBounds } from '../public/pattern-effort.js';

const drawing = (width, height, value) => ({ width, height, cells: Array.from({ length: width * height }, (_, i) => typeof value === 'function' ? value(i, i % width, Math.floor(i / width)) : value) });
const solid = drawing(32, 32, 'A');
const blocks = drawing(32, 32, (_i, x) => x < 16 ? 'A' : 'B');
const scattered = drawing(32, 32, (_i, x, y) => (x + y) % 2 ? 'A' : 'B');
const simple = estimatePatternEffort(solid), grouped = estimatePatternEffort(blocks), fragmented = estimatePatternEffort(scattered);
assert(fragmented.level > grouped.level, 'Scattered colors are harder than same-sized contiguous color regions');
assert(fragmented.minutesMin > grouped.minutesMin, 'Repeatedly locating isolated colors requires more planning time');
assert(fragmented.minutesMax > grouped.minutesMax);
const larger = estimatePatternEffort(drawing(80, 80, 'A'));
assert(larger.level >= simple.level);
assert(larger.minutesMin > simple.minutesMin && larger.minutesMax > simple.minutesMax, 'More beads increase the time range');
assert.equal(estimatePatternEffort({ ...solid, done: [1, 2, 3] }).label, simple.label, 'Estimate describes the full project, independent of completion marks');
const padded = drawing(50, 50, (_i, x, y) => x >= 9 && x < 41 && y >= 6 && y < 38 ? 'A' : null);
assert.deepEqual(estimatePatternEffort(padded), simple, 'Blank margins cannot inflate difficulty or estimated placement time');
assert.deepEqual(getPatternBounds(padded), { minX: 9, minY: 6, maxX: 40, maxY: 37, width: 32, height: 32 });
assert.deepEqual(getPatternBounds(drawing(8, 8, (_i, x, y) => x === 7 && y === 0 ? 'A' : null)), { minX: 7, minY: 0, maxX: 7, maxY: 0, width: 1, height: 1 });
assert.equal(getPatternBounds(drawing(8, 8, null)), null);
assert.equal(estimatePatternEffort(drawing(8, 8, null)).minutesMax, 0);
for (const pattern of [solid, blocks, scattered, padded, drawing(1, 1, 'A'), drawing(160, 160, (i) => String(i % 64))]) {
  const value = estimatePatternEffort(pattern);
  assert([1, 2, 3].includes(value.level));
  assert(Number.isFinite(value.minutesMin) && value.minutesMin >= 0 && value.minutesMax > value.minutesMin);
  assert.match(value.label, /^约 /, 'Time labels must explicitly describe an estimate');
}
assert.throws(() => estimatePatternEffort({ width: 8, height: 8, cells: [] }));
console.log('PASS effort estimates: fragmented vs contiguous colors, larger drawings, empty margins, incomplete progress, range bounds and explicit estimate labels');
console.log('PASS occupied thumbnail bounds retain every bead and handle empty/single-cell patterns');
