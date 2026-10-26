import { hexToRgb, rgbToLab, labDistanceSq, deltaE2000 } from './color-utils.js';
import { optimizePotts, pottsEnergy } from './graph-cuts.js';

export const OPTIMIZATION_MODES = ['detail', 'balanced', 'easy'];
// Freeze these before development evaluation; never tune against the holdout.
export const OPTIMIZER_PARAMETERS = Object.freeze({
  version: 'content-aware-v4.2', maximumMatrixEntries: 3_000_000, medoidPasses: 2, componentPasses: 2,
  microProtection: Object.freeze({ kappa: .5, minimumRing: 4, minimumGap: 1, maximumInnerRatio: .35,
    maximumRingRatio: .5, minimumSaliency: .2, minimumSaliencyGain: .05, maximumDefocus: .3 }),
  modes: Object.freeze({
    detail: Object.freeze({ lambda: 0, sigma: 7, island: 0, expansionPasses: 0 }),
    balanced: Object.freeze({ lambda: 18, sigma: 7, island: 18, expansionPasses: 2 }),
    easy: Object.freeze({ lambda: 42, sigma: 10, island: 50, expansionPasses: 2 }),
  }),
});
const square = n => n * n;

function mapValue(map, index, fallback) {
  const value = map == null ? fallback : Number(map[index]);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('显著性和虚化值须在 0–1 之间');
  return value;
}

/** All exact unique source colours if their matrix fits; otherwise deterministic
 * Lab bins represented by an actual source sample, never a fictitious centroid.
 * Only palette selection is approximated; final per-cell unary costs are exact.
 */
function representatives(unique, paletteSize) {
  const limit = Math.max(1, Math.floor(OPTIMIZER_PARAMETERS.maximumMatrixEntries / paletteSize));
  if (unique.length <= limit) return { rows: unique, exact: true, binWidth: 0 };
  let binWidth = 1, rows;
  do {
    const bins = new Map();
    for (const item of unique) {
      const coordinates = item.lab.map(value => Math.floor(value / binWidth)), key = coordinates.join(',');
      const distance = item.lab.reduce((sum, value, j) => sum + square(value - (coordinates[j] + .5) * binWidth), 0);
      let bin = bins.get(key);
      if (!bin) { bin = { lab: item.lab, weight: 0, representativeDistance: distance }; bins.set(key, bin); }
      bin.weight += item.weight;
      if (distance < bin.representativeDistance) { bin.lab = item.lab; bin.representativeDistance = distance; }
    }
    rows = [...bins.values()];
    if (rows.length <= limit) break;
    binWidth *= 1.5;
  } while (binWidth < 1000);
  return { rows, exact: false, binWidth };
}

function paletteCost(selected, rows, matrix, p) {
  let energy = 0;
  for (let r = 0; r < rows.length; r++) {
    let cost = Infinity;
    for (const c of selected) cost = Math.min(cost, matrix[r * p + c]);
    energy += rows[r].weight * cost;
  }
  return energy;
}

/** Facility-location greedy additions, then catalogue medoid refinement using
 * complete assigned sample costs. A non-Euclidean distance has no centroid
 * sufficient statistic, so no Lab-mean shortcut is used here.
 */
function choosePalette(rows, colors, maximum, metric) {
  const p = colors.length, m = rows.length, matrix = new Float32Array(m * p), used = new Set();
  const firstCosts = new Float64Array(p);
  for (let r = 0; r < m; r++) {
    let best = 0, bestCost = Infinity;
    for (let c = 0; c < p; c++) {
      const cost = square(metric(rows[r].lab, colors[c].lab)); matrix[r * p + c] = cost;
      firstCosts[c] += rows[r].weight * matrix[r * p + c];
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    used.add(best);
  }
  if (!m) return { selected: [], matrix, inputColors: 0, trace: [] };
  if (used.size <= maximum) return { selected: [...used].sort((a, b) => a - b), matrix, inputColors: used.size, trace: [{ stage: 'nearest-complete', energy: paletteCost([...used], rows, matrix, p) }] };
  let first = 0;
  for (let c = 1; c < p; c++) if (firstCosts[c] < firstCosts[first]) first = c;
  const selected = [first], chosen = new Set(selected), trace = [{ stage: 'facility-seed', energy: firstCosts[first] }];
  const best = Float32Array.from(rows, (_, r) => matrix[r * p + first]);
  while (selected.length < maximum) {
    let winner = -1, gain = 1e-8;
    for (let c = 0; c < p; c++) {
      if (chosen.has(c)) continue;
      let improvement = 0;
      for (let r = 0; r < m; r++) { const delta = best[r] - matrix[r * p + c]; if (delta > 0) improvement += rows[r].weight * delta; }
      if (improvement > gain) { winner = c; gain = improvement; }
    }
    if (winner < 0) break;
    chosen.add(winner); selected.push(winner);
    for (let r = 0; r < m; r++) best[r] = Math.min(best[r], matrix[r * p + winner]);
    trace.push({ stage: 'facility-add', colors: selected.length, energy: paletteCost(selected, rows, matrix, p) });
  }
  for (let pass = 0; pass < OPTIMIZER_PARAMETERS.medoidPasses; pass++) {
    const members = selected.map(() => []);
    for (let r = 0; r < m; r++) {
      let label = 0;
      for (let k = 1; k < selected.length; k++) if (matrix[r * p + selected[k]] < matrix[r * p + selected[label]]) label = k;
      members[label].push(r);
    }
    let changed = false;
    for (let k = 0; k < selected.length; k++) {
      if (!members[k].length) continue;
      let winner = selected[k], bestCost = 0;
      for (const r of members[k]) bestCost += rows[r].weight * matrix[r * p + winner];
      for (let c = 0; c < p; c++) {
        if (chosen.has(c)) continue;
        let cost = 0;
        for (const r of members[k]) cost += rows[r].weight * matrix[r * p + c];
        if (cost < bestCost - 1e-8) { winner = c; bestCost = cost; }
      }
      if (winner !== selected[k]) { chosen.delete(selected[k]); selected[k] = winner; chosen.add(winner); changed = true; }
    }
    trace.push({ stage: 'catalogue-medoid', pass, energy: paletteCost(selected, rows, matrix, p) });
    if (!changed) break;
  }
  return { selected: selected.sort((a, b) => a - b), matrix, inputColors: used.size, trace };
}

const componentPenalty = (component, eta) => component.size <= 2 && !component.protected
  ? eta * square(1 - component.saliency / component.size) * (1 + .5 * component.defocus / component.size) : 0;

function componentsOf(labels, neighbours, saliency, defocus, protectedCells, eta) {
  const n = labels.length, ids = new Int32Array(n).fill(-1), queue = new Int32Array(n), components = [];
  let energy = 0, protectedSmallCells = 0, unprotectedSmallCells = 0, protectedSmallComponents = 0, unprotectedSmallComponents = 0;
  for (let start = 0; start < n; start++) {
    if (ids[start] >= 0) continue;
    const id = components.length, component = { id, size: 0, label: labels[start], saliency: 0, defocus: 0, protected: false, members: [] };
    let head = 0, tail = 0; queue[tail++] = start; ids[start] = id;
    while (head < tail) {
      const i = queue[head++]; component.size++; component.saliency += saliency[i]; component.defocus += defocus[i]; component.protected ||= !!protectedCells[i];
      if (component.members.length < 3) component.members.push(i);
      for (let d = 0; d < 4; d++) { const j = neighbours[i * 4 + d]; if (j >= 0 && ids[j] < 0 && labels[j] === component.label) { ids[j] = id; queue[tail++] = j; } }
    }
    if (component.size <= 2) {
      for (const i of component.members) { if (protectedCells[i]) protectedSmallCells++; else unprotectedSmallCells++; }
      if (component.protected) protectedSmallComponents++; else unprotectedSmallComponents++;
    } else component.members.length = 0;
    energy += componentPenalty(component, eta); components.push(component);
  }
  return { ids, components, energy, protectedSmallCells, unprotectedSmallCells, protectedSmallComponents, unprotectedSmallComponents };
}

/** Coherent source extrema get a fixed boundary budget, initialized once before
 * any label optimization. This preserves a local data/edge margin; it is neither
 * a semantic detector nor a guarantee about full higher-order/global optima.
 */
function protectMicrostructure(points, nodeAt, width, height, labels, unary, k, edges, edgeIndex, edgeWeights, neighbours, saliency, defocus, protectedCells, metric) {
  const gates = OPTIMIZER_PARAMETERS.microProtection, groups = componentsOf(labels, neighbours, saliency, defocus, protectedCells, 0).components;
  const records = []; let candidates = 0, cappedEdges = 0;
  const meanLab = nodes => [0, 1, 2].map(channel => nodes.reduce((sum, node) => sum + points[node].lab[channel], 0) / nodes.length);
  for (const component of groups) {
    if (component.size > 2) continue;
    candidates++;
    const members = component.members, ring = new Set();
    for (const i of members) {
      const index = points[i].index, x = index % width, y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const j = nodeAt[(y + dy) * width + x + dx];
        if (j >= 0 && !members.includes(j)) ring.add(j);
      }
    }
    if (ring.size < gates.minimumRing) continue;
    const outside = [...ring], meanSaliency = component.saliency / component.size, meanDefocus = component.defocus / component.size;
    const ringSaliency = outside.reduce((sum, i) => sum + saliency[i], 0) / outside.length;
    if (meanSaliency < gates.minimumSaliency || meanSaliency - ringSaliency < gates.minimumSaliencyGain || meanDefocus > gates.maximumDefocus) continue;
    const center = meanLab(members), surround = meanLab(outside), gap = metric(center, surround);
    if (gap < gates.minimumGap) continue;
    const innerRms = Math.sqrt(members.reduce((sum, i) => sum + square(metric(points[i].lab, center)), 0) / members.length);
    const ringRms = Math.sqrt(outside.reduce((sum, i) => sum + square(metric(points[i].lab, surround)), 0) / outside.length);
    if (innerRms > gates.maximumInnerRatio * gap || ringRms > gates.maximumRingRatio * gap) continue;
    let margin = Infinity;
    for (let target = 0; target < k; target++) {
      if (target === component.label) continue;
      let delta = 0;
      for (const i of members) delta += unary[i * k + target] - unary[i * k + component.label];
      margin = Math.min(margin, delta);
    }
    if (!(margin > 1e-8 && Number.isFinite(margin))) continue;
    const boundary = new Set();
    for (const i of members) for (let d = 0; d < 4; d++) {
      const j = neighbours[i * 4 + d];
      if (j >= 0 && !members.includes(j)) boundary.add(edgeIndex[i * 4 + d]);
    }
    const boundaryBefore = [...boundary].reduce((sum, id) => sum + edges[id].weight, 0);
    const factor = boundaryBefore ? Math.min(1, gates.kappa * margin / boundaryBefore) : 1;
    for (const id of boundary) {
      const edge = edges[id];
      if (factor < 1) { edge.weight *= factor; cappedEdges++; }
      edgeWeights[edge.u * 4 + edge.direction] = edge.weight; edgeWeights[edge.v * 4 + (edge.direction ^ 1)] = edge.weight;
    }
    for (const i of members) protectedCells[i] = 1;
    records.push({ cells: members.map(i => points[i].index), size: component.size, sourceGap: gap, innerRms, ringRms,
      saliency: meanSaliency, ringSaliency, defocus: meanDefocus, margin, boundaryBefore, boundary: [...boundary] });
  }
  const protectedCount = records.reduce((sum, record) => sum + record.size, 0);
  return { enabled: true, candidateComponents: candidates, protectedComponents: records.length, protectedCells: protectedCount, cappedEdges,
    recordsTruncated: records.length > 256, records: records.slice(0, 256).map(({ boundary, ...record }) => ({ ...record,
      boundaryAfter: boundary.reduce((sum, id) => sum + edges[id].weight, 0), localDataPairwiseLowerBound: (1 - gates.kappa) * record.margin })) };
}

/** Whole-component proposals evaluate the exact change in unary + Potts +
 * size<=2 step energy. This higher-order stage is NOT a cut. Union/find keeps
 * adjacent target components; a full energy scan verifies each complete pass.
 */
function refineIslands(labels, unary, k, edges, neighbours, edgeWeights, saliency, defocus, protectedCells, eta) {
  const trace = []; let current = Int32Array.from(labels), accepted = 0;
  for (let pass = 0; pass < OPTIMIZER_PARAMETERS.componentPasses; pass++) {
    const segmentation = componentsOf(current, neighbours, saliency, defocus, protectedCells, eta), comps = segmentation.components;
    const parent = Int32Array.from(comps, (_, i) => i), ids = segmentation.ids;
    const find = start => { let root = start; while (parent[root] !== root) root = parent[root]; while (parent[start] !== start) { const next = parent[start]; parent[start] = root; start = next; } return root; };
    const before = pottsEnergy(current, unary, k, edges).total + segmentation.energy;
    let changes = 0;
    for (let id = 0; id < comps.length; id++) {
      if (find(id) !== id) continue;
      const component = comps[id];
      if (component.size > 2 || component.protected) continue;
      const candidates = new Set();
      for (const i of component.members) for (let d = 0; d < 4; d++) { const j = neighbours[i * 4 + d]; if (j >= 0 && current[j] !== component.label) candidates.add(current[j]); }
      let best = null, bestDelta = -1e-7;
      for (const target of [...candidates].sort((a, b) => a - b)) {
        let delta = 0;
        const roots = new Set();
        for (const i of component.members) {
          delta += unary[i * k + target] - unary[i * k + component.label];
          for (let d = 0; d < 4; d++) {
            const j = neighbours[i * 4 + d];
            if (j < 0 || component.members.includes(j)) continue;
            delta += edgeWeights[i * 4 + d] * ((target !== current[j] ? 1 : 0) - (component.label !== current[j] ? 1 : 0));
            if (current[j] === target) roots.add(find(ids[j]));
          }
        }
        if (!roots.size) continue;
        const merged = { size: component.size, saliency: component.saliency, defocus: component.defocus, protected: component.protected };
        delta -= componentPenalty(component, eta);
        for (const root of roots) { const c = comps[root]; merged.size += c.size; merged.saliency += c.saliency; merged.defocus += c.defocus; merged.protected ||= c.protected; delta -= componentPenalty(c, eta); }
        delta += componentPenalty(merged, eta);
        if (delta < bestDelta) { bestDelta = delta; best = { target, roots: [...roots], merged }; }
      }
      if (!best) continue;
      const root = best.roots[0], members = best.merged.size <= 2 ? [...component.members, ...best.roots.flatMap(index => comps[index].members)] : [];
      for (const i of component.members) current[i] = best.target;
      for (const other of best.roots) if (other !== root) parent[other] = root;
      parent[id] = root; Object.assign(comps[root], best.merged, { label: best.target, members }); changes++; accepted++;
    }
    const energy = pottsEnergy(current, unary, k, edges), islands = componentsOf(current, neighbours, saliency, defocus, protectedCells, eta).energy;
    if (energy.total + islands > before + 1e-6 * Math.max(1, before)) throw new Error('连通域提案未通过全能量检查');
    trace.push({ stage: 'component-merge', pass, accepted: changes, data: energy.data, pairwise: energy.pairwise, island: islands, total: energy.total + islands });
    if (!changes) break;
  }
  return { labels: current, trace, accepted };
}

export function optimizePatternColors(labs, width, height, palette, options = {}) {
  // Timing is opt-in so default result data and all energy traces are repeatable.
  const clock = options.collectTimings === true ? () => globalThis.performance?.now?.() ?? Date.now() : () => 0;
  const started = clock(), size = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || size > 1_000_000 || labs?.length !== size) throw new Error('图纸尺寸与像素不匹配');
  if (!Array.isArray(palette) || !palette.length || palette.length > 1000) throw new Error('需要 1–1000 种可用颜色');
  const mode = options.optimizationMode ?? 'balanced', colorMetric = options.colorMetric ?? 'de2000';
  if (!OPTIMIZATION_MODES.includes(mode)) throw new Error('未知的图纸优化模式');
  if (!['de2000', 'lab76'].includes(colorMetric)) throw new Error('未知的色差度量');
  for (const map of [options.saliencyMap, options.defocusMap]) if (map != null && map.length !== size) throw new Error('特征图尺寸与图纸不一致');
  for (const lab of labs) if (lab != null && (lab.length !== 3 || typeof lab.every !== 'function' || !lab.every(Number.isFinite))) throw new Error('颜色像素数据无效');
  const codes = new Set(), colors = palette.map(color => {
    const code = String(color.code ?? ''); if (!code || codes.has(code)) throw new Error('色号不可为空或重复'); codes.add(code);
    return { code, lab: rgbToLab(hexToRgb(color.hex)) };
  }).sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const maximum = Math.max(1, Math.min(colors.length, Math.floor(Number(options.maxColors) || 24)));
  const metric = colorMetric === 'de2000' ? deltaE2000 : (a, b) => Math.sqrt(labDistanceSq(a, b));
  const config = OPTIMIZER_PARAMETERS.modes[mode], lambda = options.spatialRegularization === false ? 0 : config.lambda;
  const eta = options.islandPenalty === false ? 0 : config.island;
  const nodeAt = new Int32Array(size).fill(-1), points = [];
  for (let i = 0; i < size; i++) if (labs[i] != null) { nodeAt[i] = points.length; points.push({ index: i, lab: labs[i], contrast: 0 }); }
  const n = points.length, neighbours = new Int32Array(n * 4).fill(-1), edgeWeights = new Float64Array(n * 4), rawEdges = [];
  for (let i = 0; i < n; i++) {
    const p = points[i], x = p.index % width;
    for (const [next, direction] of [[x + 1 < width ? p.index + 1 : -1, 0], [p.index + width < size ? p.index + width : -1, 2]]) {
      if (next < 0 || nodeAt[next] < 0) continue;
      const j = nodeAt[next], distance = metric(p.lab, points[j].lab);
      p.contrast = Math.max(p.contrast, distance); points[j].contrast = Math.max(points[j].contrast, distance);
      neighbours[i * 4 + direction] = j; neighbours[j * 4 + direction + 1] = i;
      rawEdges.push({ u: i, v: j, distance, direction });
    }
  }
  const saliency = new Float32Array(n), defocus = new Float32Array(n), protectedCells = new Uint8Array(n), unique = [], uniqueMap = new Map();
  let protectedCount = 0;
  for (let i = 0; i < n; i++) {
    const point = points[i], fallback = Math.min(1, point.contrast / 25);
    saliency[i] = mapValue(options.saliencyMap, point.index, fallback); defocus[i] = mapValue(options.defocusMap, point.index, 0);
    protectedCells[i] = +(saliency[i] >= .65 || (point.contrast >= 24 && defocus[i] < .5)); protectedCount += protectedCells[i];
    point.weight = (1 + 2 * saliency[i] + .5 * fallback) * (1 - .55 * defocus[i] * (1 - saliency[i]));
    const key = point.lab.join(',');
    if (!uniqueMap.has(key)) { uniqueMap.set(key, unique.length); unique.push({ lab: point.lab, weight: 0 }); }
    point.unique = uniqueMap.get(key); unique[point.unique].weight += point.weight;
  }
  const edgeIndex = new Int32Array(n * 4).fill(-1);
  const edges = rawEdges.map(({ u, v, distance, direction }, index) => {
    const meanSaliency = (saliency[u] + saliency[v]) / 2, meanDefocus = (defocus[u] + defocus[v]) / 2;
    const weight = lambda * Math.exp(-square(distance) / (2 * square(config.sigma))) * (1 - .55 * Math.max(saliency[u], saliency[v])) * (1 + .8 * meanDefocus * (1 - meanSaliency));
    edgeWeights[u * 4 + direction] = weight; edgeWeights[v * 4 + direction + 1] = weight;
    edgeIndex[u * 4 + direction] = index; edgeIndex[v * 4 + direction + 1] = index;
    return { u, v, weight, direction };
  });
  const paletteStarted = clock(), representation = representatives(unique, colors.length);
  const selection = choosePalette(representation.rows, colors, maximum, metric), k = selection.selected.length;
  const sampleCosts = new Float32Array(unique.length * k);
  for (let r = 0; r < unique.length; r++) for (let c = 0; c < k; c++) sampleCosts[r * k + c] = representation.exact
    ? selection.matrix[r * colors.length + selection.selected[c]] : square(metric(unique[r].lab, colors[selection.selected[c]].lab));
  const unary = new Float64Array(n * k); let labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (let c = 0; c < k; c++) { const cost = sampleCosts[points[i].unique * k + c] * points[i].weight; unary[i * k + c] = cost; if (cost < unary[i * k + best]) best = c; }
    labels[i] = best;
  }
  const paletteMs = clock() - paletteStarted, originalLabels = labels.slice();
  const microProtection = options.microProtection !== false && n && k > 1 && (lambda || eta)
    ? protectMicrostructure(points, nodeAt, width, height, labels, unary, k, edges, edgeIndex, edgeWeights, neighbours, saliency, defocus, protectedCells, metric)
    : { enabled: false, candidateComponents: 0, protectedComponents: 0, protectedCells: 0, cappedEdges: 0, recordsTruncated: false, records: [] };
  protectedCount = protectedCells.reduce((sum, flag) => sum + flag, 0);
  const initialIslands = componentsOf(labels, neighbours, saliency, defocus, protectedCells, eta);
  const initialEnergy = pottsEnergy(labels, unary, k, edges), energyTrace = [{ stage: 'initial', data: initialEnergy.data, pairwise: initialEnergy.pairwise, island: initialIslands.energy, total: initialEnergy.total + initialIslands.energy }];
  const spatialStarted = clock(); let cuts = { moves: 0, accepted: 0, passes: 0 };
  if (lambda && n && k > 1) {
    cuts = optimizePotts(labels, unary, k, edges, { maxPasses: config.expansionPasses,
      extraEnergy: eta ? candidate => componentsOf(candidate, neighbours, saliency, defocus, protectedCells, eta).energy : undefined });
    labels = cuts.labels; energyTrace.push(...cuts.trace);
  }
  const spatialMs = clock() - spatialStarted, islandStarted = clock(); let merges = 0;
  if (eta && n && k > 1) {
    const result = refineIslands(labels, unary, k, edges, neighbours, edgeWeights, saliency, defocus, protectedCells, eta);
    labels = result.labels; merges = result.accepted; energyTrace.push(...result.trace);
  }
  const islandMs = clock() - islandStarted, finalIslands = componentsOf(labels, neighbours, saliency, defocus, protectedCells, eta);
  const cells = new Array(size).fill(null), countMap = new Map(); let changed = 0, error76 = 0, error00 = 0, totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const color = colors[selection.selected[labels[i]]], point = points[i]; cells[point.index] = color.code;
    countMap.set(color.code, (countMap.get(color.code) || 0) + 1); changed += +(labels[i] !== originalLabels[i]);
    error76 += Math.sqrt(labDistanceSq(point.lab, color.lab)); error00 += deltaE2000(point.lab, color.lab); totalWeight += point.weight;
  }
  const finalEnergy = pottsEnergy(labels, unary, k, edges);
  const rates = result => ({ protected: protectedCount ? result.protectedSmallCells / protectedCount : 0,
    unprotected: n - protectedCount ? result.unprotectedSmallCells / (n - protectedCount) : 0,
    all: n ? (result.protectedSmallCells + result.unprotectedSmallCells) / n : 0,
    protectedComponents: result.protectedSmallComponents, unprotectedComponents: result.unprotectedSmallComponents });
  return { cells, counts: Object.fromEntries(countMap), diagnostics: {
    version: OPTIMIZER_PARAMETERS.version, mode, colorMetric, inputColors: selection.inputColors, outputColors: countMap.size, smoothedCells: changed,
    meanDeltaE76: n ? error76 / n : 0, meanDeltaE2000: n ? error00 / n : 0, weightedRmse: totalWeight ? Math.sqrt(finalEnergy.data / totalWeight) : 0,
    paletteSelection: { approximation: representation.exact ? 'none' : 'actual-source-Lab-bin-representatives', binWidth: representation.binWidth,
      sourceUniqueColors: unique.length, representativeCount: representation.rows.length, matrixEntries: selection.matrix.length, trace: selection.trace },
    energyTrace, dataEnergyTrace: energyTrace.map(e => e.data), pairwiseEnergyTrace: energyTrace.map(e => e.pairwise), islandEnergyTrace: energyTrace.map(e => e.island),
    initialIslandRates: rates(initialIslands), finalIslandRates: rates(finalIslands), protectedCellCount: protectedCount, microProtection,
    solver: { expansionMoves: cuts.moves, acceptedExpansionMoves: cuts.accepted, expansionPasses: cuts.passes, componentMerges: merges,
      higherOrder: eta ? 'full-energy-filtered-cuts-and-component-proposals' : 'disabled', globalOptimalityClaim: false },
    parameters: { lambda, sigma: config.sigma, island: eta }, timings: options.collectTimings === true ? { paletteMs, spatialMs, islandMs, totalMs: clock() - started } : null,
  } };
}

