import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDifficultyExamples, matchesLibraryFilters } from '../public/difficulty-examples.js';
import { estimatePatternEffort } from '../public/pattern-effort.js';
import { createProjectSummary } from '../public/library-store.js';

const palette = JSON.parse(await readFile(new URL('../public/palette.json', import.meta.url), 'utf8'));

test('three original examples use real catalogue codes and span the actual difficulty levels', () => {
  const examples = createDifficultyExamples(palette);
  assert.equal(examples.length, 3);
  assert.deepEqual(examples.map(e => estimatePatternEffort(e.project).level), [1, 2, 3]);
  assert.equal(new Set(examples.map(e => e.id)).size, 3);
  const codes = new Set(palette.colors.map(c => c.code));
  for (const example of examples) {
    const p = example.project;
    assert.equal(p.format, 'bead-studio');
    assert.equal(p.version, 1);
    assert.equal(p.cells.length, p.width * p.height);
    assert.ok(p.cells.every(code => code === null || codes.has(code)));
    assert.ok(p.cells.some(Boolean));
    assert.ok(p.width >= 8 && p.width <= 160 && p.height >= 8 && p.height <= 160);
    assert.equal(p.isDemo, false, 'examples reopen from their saved raster, not the legacy fox generator');
    assert.ok(p.settings.maxColors >= new Set(p.cells.filter(Boolean)).size);
    const summary = createProjectSummary({ id: 'example-' + example.id, project: p, name: example.name, createdAt: '2026-10-25', updatedAt: '2026-10-25' });
    assert.equal(summary.effort.level, estimatePatternEffort(p).level);
  }
});

test('example creation is deterministic and does not mutate or alias the input catalogue', () => {
  const before = structuredClone(palette);
  const examples = createDifficultyExamples(palette.colors);
  const repeated = createDifficultyExamples(palette.colors);
  assert.deepEqual(examples, repeated);
  assert.deepEqual(palette, before);
  examples[0].project.palette.colors[0].hex = '#000000';
  assert.equal(palette.colors[0].hex, before.colors[0].hex);
  assert.equal(examples[1].project.palette.colors[0].hex, before.colors[0].hex);
  assert.throws(() => createDifficultyExamples([]), /有效色卡/);
});

test('difficulty and time filters combine, using estimate midpoint with non-overlapping boundaries', () => {
  const summary = (level, min, max) => ({ effort: { level, minutesMin: min, minutesMax: max } });
  const flower = summary(1, 20, 45), medium = summary(2, 90, 195), high = summary(3, 540, 1050);
  assert.equal(matchesLibraryFilters(flower), true);
  assert.equal(matchesLibraryFilters(flower, { levels: [1], time: 'under60' }), true);
  assert.equal(matchesLibraryFilters(flower, { levels: [2], time: 'under60' }), false);
  assert.equal(matchesLibraryFilters(medium, { levels: ['2'], time: '60to180' }), true);
  assert.equal(matchesLibraryFilters(high, { levels: [1, 3], time: 'over180' }), true);
  assert.equal(matchesLibraryFilters(summary(1, 59, 61), { time: 'under60' }), false);
  assert.equal(matchesLibraryFilters(summary(1, 59, 61), { time: '60to180' }), true);
  assert.equal(matchesLibraryFilters(summary(2, 170, 190), { time: '60to180' }), true);
  assert.equal(matchesLibraryFilters(summary(2, 170, 190), { time: 'over180' }), false);
  assert.equal(matchesLibraryFilters(summary(2, 171, 191), { time: 'over180' }), true);
  assert.equal(matchesLibraryFilters({}, { time: 'all' }), true);
  assert.equal(matchesLibraryFilters({}, { time: 'under60' }), false);
});
