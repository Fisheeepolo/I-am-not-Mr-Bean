import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { verifyLock } from './lock-protocol.mjs';
import { segmentBackground } from '../../public/background-segmentation.js';
import { abstractImageForPattern } from '../../public/image-abstraction.js';
import { sampleImageForPattern } from '../../public/image-sampling.js';
import { applyImageStyle } from '../../public/image-styles.js';
import { optimizePatternColors } from '../../public/pattern-optimizer.js';
import { hexToRgb, rgbToLab, deltaE2000 } from '../../public/color-utils.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const byCode = (a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const options = Object.freeze({ maxColors: 18, optimizationMode: 'balanced', imageStyle: 'original',
  backgroundTolerance: 20, removeBackground: false, colorMetric: 'de2000' });

function sameCells(a, b, description) {
  if (!a || !b || a.length !== b.length || a.some((c, i) => c !== b[i])) throw new Error(description);
}

async function sourceGraph(file, out = {}) {
  const source = await fs.readFile(file, 'utf8'), key = path.relative(root, file).replaceAll('\\', '/');
  if (key in out) return out;
  out[key] = sha(source.replace(/\r\n?/g, '\n'));
  for (const match of source.matchAll(/(?:from|import)\s*['"](\.\/[^'"]+)['"]/g)) {
    await sourceGraph(path.resolve(path.dirname(file), match[1]), out);
  }
  return out;
}

// This is the frozen production pipeline through Lab construction, performed
// once per paired repetition. Every full output is compared with the saved main
// experiment's identical frozen production-pipeline result, outside timing.
function prepare(raw, fixture) {
  const { sourceWidth: sw, sourceHeight: sh, width, height } = fixture;
  const segmented = segmentBackground({ data: raw }, sw, sh, {
    mode: 'preserve', tolerance: options.backgroundTolerance, scale: Math.max(sw / width, sh / height),
  });
  const abstracted = abstractImageForPattern(segmented, sw, sh, { ...options, targetWidth: width, targetHeight: height });
  const sampled = sampleImageForPattern(abstracted, sw, sh, width, height, { ...options, analysis: abstracted.analysis });
  const styled = applyImageStyle(sampled, width, height, 'original');
  const labs = Array.from({ length: width * height }, (_, i) => {
    const p = i * 4, alphaByte = styled.data[p + 3];
    if (alphaByte < 100) return null;
    const alpha = alphaByte / 255;
    return rgbToLab([styled.data[p], styled.data[p + 1], styled.data[p + 2]].map(c => c * alpha + 255 * (1 - alpha)));
  });
  return { labs, saliencyMap: sampled.saliency, defocusMap: sampled.defocus,
    backgroundDiagnostics: segmented.diagnostics, abstractionDiagnostics: abstracted.diagnostics };
}

// Exact nearest-full-catalogue hard votes with precisely the production unary
// weights. Means/bins are not used. Equal distances are broken by code order.
export function frequencyPalette(labs, width, height, palette, saliencyMap, defocusMap, maximum = 18) {
  const colors = palette.map(color => ({ ...color, code: String(color.code), lab: rgbToLab(hexToRgb(color.hex)) })).sort(byCode);
  const contrast = new Float64Array(labs.length), histogram = colors.map(color => ({ code: color.code, weight: 0, count: 0 }));
  for (let i = 0; i < labs.length; i++) {
    if (labs[i] == null) continue;
    const x = i % width;
    for (const j of [x + 1 < width ? i + 1 : -1, i + width < width * height ? i + width : -1]) {
      if (j < 0 || labs[j] == null) continue;
      const distance = deltaE2000(labs[i], labs[j]);
      contrast[i] = Math.max(contrast[i], distance); contrast[j] = Math.max(contrast[j], distance);
    }
  }
  const cache = new Map(); let weightSum = 0;
  for (let i = 0; i < labs.length; i++) {
    if (labs[i] == null) continue;
    const key = labs[i].join(','); let nearest = cache.get(key);
    if (nearest === undefined) {
      nearest = 0; let best = Infinity;
      for (let c = 0; c < colors.length; c++) {
        const distance = deltaE2000(labs[i], colors[c].lab);
        if (distance < best) { nearest = c; best = distance; }
      }
      cache.set(key, nearest);
    }
    const r = Math.min(1, contrast[i] / 25);
    const s = Math.fround(saliencyMap == null ? r : Number(saliencyMap[i]));
    const f = Math.fround(defocusMap == null ? 0 : Number(defocusMap[i]));
    const weight = (1 + 2 * s + .5 * r) * (1 - .55 * f * (1 - s));
    if (!(weight > 0 && Number.isFinite(weight))) throw new Error('Invalid frequency weight');
    histogram[nearest].weight += weight; histogram[nearest].count++; weightSum += weight;
  }
  const ranked = histogram.filter(c => c.count > 0).sort((a, b) => b.weight - a.weight || byCode(a, b));
  const selectedCodes = ranked.slice(0, maximum).map(c => c.code), selectedSet = new Set(selectedCodes);
  // The production API requires a nonempty catalog even for an entirely empty
  // image. This sentinel never becomes a bead and is disclosed in the audit.
  const subset = selectedCodes.length ? palette.filter(c => selectedSet.has(String(c.code))) : [colors[0]];
  return { subset, audit: { selection: 'exact-DE00-nearest-full-catalogue-weighted-frequency',
    selectedCodes, sourceNearestColors: ranked.length, weightSum, weightedHistogram: ranked,
    emptySourceSentinel: !selectedCodes.length } };
}

function inputHash(prepared) {
  return sha(JSON.stringify({ labs: prepared.labs, saliency: Array.from(prepared.saliencyMap), defocus: Array.from(prepared.defocusMap) }));
}

function validatePattern(pattern, prepared, palette, frequencyAudit) {
  const available = new Set(palette.map(c => String(c.code))), used = new Set(pattern.cells.filter(c => c != null));
  if (used.size > options.maxColors || [...used].some(c => !available.has(c))) throw new Error('Hard catalogue budget violated');
  if (pattern.cells.some((c, i) => (c == null) !== (prepared.labs[i] == null))) throw new Error('Occupancy mask changed');
  if (pattern.diagnostics.version !== 'content-aware-v4.2') throw new Error('Unexpected optimizer version');
  if (pattern.diagnostics.paletteSelection.approximation !== 'none') throw new Error('This study requires the exact source-color matrix');
  if (frequencyAudit) {
    const trace = pattern.diagnostics.paletteSelection.trace;
    if (frequencyAudit.selectedCodes.length && (trace.length !== 1 || trace[0].stage !== 'nearest-complete')) {
      throw new Error('Restricted Top K unexpectedly underwent palette reselection');
    }
    if (pattern.diagnostics.inputColors !== frequencyAudit.selectedCodes.length) throw new Error('A Top K candidate lost its nearest source witness');
  }
  return used;
}

async function run() {
  const split = process.argv.find(arg => arg.startsWith('--split='))?.slice(8) ?? 'development';
  if (!['development', 'heldout'].includes(split)) throw new Error('Specify development or heldout');
  const protocolLock = await verifyLock();
  const sourceHashes = await sourceGraph(path.join(root, '../../public/pattern-pipeline.js'));
  const studyFiles = ['palette-study.mjs', 'SUPPLEMENTAL-PROTOCOL.md', 'PALETTE-STUDY.md'];
  const studyHashes = {};
  for (const name of studyFiles) studyHashes[name] = sha((await fs.readFile(path.join(root, name), 'utf8')).replace(/\r\n?/g, '\n'));
  const palette = JSON.parse(await fs.readFile(path.join(root, '../../public/palette.json'), 'utf8')).colors;
  const fixtures = JSON.parse(await fs.readFile(path.join(root, 'fixtures.json'), 'utf8')).filter(f => f.split === split);
  const main = JSON.parse(await fs.readFile(path.join(root, 'results', split + '-raw.json'), 'utf8'));
  for (const [file, hash] of Object.entries(sourceHashes)) {
    if (main.sourceHashes[file] !== hash) throw new Error('Main trial used different algorithm: ' + file);
  }
  if (main.paletteHash !== sha(JSON.stringify(palette))) throw new Error('Main trial used a different catalogue');
  const run = { protocol: 'palette-study-v1', mainProtocol: protocolLock.protocol, startedAt: new Date().toISOString(),
    node: process.version, split, sourceHashes, studyHashes,
    protocolLockHash: sha(await fs.readFile(path.join(root, 'protocol-lock.json'))),
    fixtureManifestHash: sha(await fs.readFile(path.join(root, 'fixtures.json'))),
    paletteHash: sha(JSON.stringify(palette)), palette,
    timingBoundary: 'Decoded RGBA through shared preprocessing + optional weighted Top K + optimizer; excludes I/O, decoding, checks, hashing and metrics.',
    timingDesign: 'One paired warmup, three paired measured repetitions; shared preprocessing is measured once per pair and attributed equally; alternating arm order.', rows: [] };
  for (const fixture of fixtures) {
    const raw = new Uint8ClampedArray(await fs.readFile(path.join(root, fixture.source))), sourceHash = sha(raw);
    if (sourceHash !== fixture.sourceSha256) throw new Error('Fixture source checksum mismatch: ' + fixture.id);
    const mainFull = main.rows.find(row => row.fixture === fixture.id && row.method === 'full' && row.maxColors === 18 && row.removeBackground === false);
    if (!mainFull) throw new Error('Missing completed main full/K18 positive control: ' + fixture.id);
    const measurements = Object.fromEntries(['full', 'frequencyPalette'].map(id => [id, { times: [], prep: [], selection: [], optimization: [], output: null, audit: null }]));
    let commonHash, latestPrepared;
    for (let repetition = -1; repetition < 3; repetition++) {
      const prepStart = performance.now(), prepared = prepare(raw, fixture), prepMs = performance.now() - prepStart;
      const preparedHash = inputHash(prepared); latestPrepared = prepared;
      if (commonHash != null && commonHash !== preparedHash) throw new Error('Shared inputs changed across repeats');
      commonHash = preparedHash;
      const methods = repetition % 2 === 0 ? ['frequencyPalette', 'full'] : ['full', 'frequencyPalette'];
      for (const method of methods) {
        let candidates = palette, audit = null, selectionMs = 0;
        if (method === 'frequencyPalette') {
          const start = performance.now(), selected = frequencyPalette(prepared.labs, fixture.width, fixture.height, palette, prepared.saliencyMap, prepared.defocusMap, options.maxColors);
          selectionMs = performance.now() - start; candidates = selected.subset; audit = selected.audit;
        }
        const start = performance.now();
        const pattern = optimizePatternColors(prepared.labs, fixture.width, fixture.height, candidates, {
          ...options, saliencyMap: prepared.saliencyMap, defocusMap: prepared.defocusMap,
        });
        const optimizationMs = performance.now() - start;
        validatePattern(pattern, prepared, candidates, audit);
        const m = measurements[method];
        if (m.output) sameCells(pattern.cells, m.output.cells, 'Output changed across repeats: ' + method);
        m.output = pattern; m.audit = audit;
        if (method === 'full') sameCells(pattern.cells, mainFull.cells, 'Supplemental full differs from main full/K18: ' + fixture.id);
        if (repetition >= 0) {
          m.prep.push(prepMs); m.selection.push(selectionMs); m.optimization.push(optimizationMs); m.times.push(prepMs + selectionMs + optimizationMs);
        }
      }
      if (inputHash(prepared) !== preparedHash || sha(raw) !== sourceHash) throw new Error('An arm mutated common source inputs');
    }
    for (const method of ['full', 'frequencyPalette']) {
      const m = measurements[method], pattern = m.output;
      run.rows.push({ fixture: fixture.id, split: fixture.split, kind: fixture.kind, method, maxColors: 18, removeBackground: false,
        width: fixture.width, height: fixture.height, usedColors: Object.keys(pattern.counts).length,
        timesMs: m.times, medianMs: median(m.times), prepTimesMs: m.prep, paletteSelectionTimesMs: m.selection,
        optimizationTimesMs: m.optimization, stageMediansMs: { preprocessing: median(m.prep), topKSelection: median(m.selection), optimizer: median(m.optimization) },
        sourceImageHash: sourceHash, commonInputHash: commonHash, candidatePaletteAudit: m.audit,
        positiveControlMatchesMain: method === 'full' ? true : null, occupancyMismatchVsFull: 0,
        cells: pattern.cells, diagnostics: pattern.diagnostics,
        backgroundDiagnostics: latestPrepared.backgroundDiagnostics, abstractionDiagnostics: latestPrepared.abstractionDiagnostics });
    }
    console.log('Measured supplemental palette pair: ' + fixture.id);
  }
  await verifyLock();
  if (JSON.stringify(sourceHashes) !== JSON.stringify(await sourceGraph(path.join(root, '../../public/pattern-pipeline.js')))) throw new Error('Frozen numerical code changed during study');
  for (const name of studyFiles) if (studyHashes[name] !== sha((await fs.readFile(path.join(root, name), 'utf8')).replace(/\r\n?/g, '\n'))) throw new Error('Study definition changed during run');
  run.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'results', 'palette-study-' + split + '-raw.json'), JSON.stringify(run, null, 2) + '\n');
  console.log('Saved ' + run.rows.length + ' supplemental rows.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
