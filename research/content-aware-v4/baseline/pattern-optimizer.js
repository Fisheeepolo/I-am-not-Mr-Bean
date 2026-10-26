import { hexToRgb, rgbToLab, labDistanceSq } from './color-utils.js';

/**
 * A deterministic, catalogue-constrained colour optimiser. No dithering: each
 * output square is a single available bead. The two stages minimise different
 * costs: weighted colour error for palette choice, then edge-aware Potts energy
 * for assembly-friendly regions. These are image proxies, not a human study.
 */
export const OPTIMIZATION_MODES = ['detail', 'balanced', 'easy'];
const MODES = {
  detail: { lambda: 0, sigma: 9, iterations: 0 },
  balanced: { lambda: 35, sigma: 9, iterations: 3 },
  easy: { lambda: 95, sigma: 14, iterations: 5 },
};

function neighbours(index, width, height, callback) {
  const x = index % width, y = Math.floor(index / width);
  if (x > 0) callback(index - 1);
  if (x + 1 < width) callback(index + 1);
  if (y > 0) callback(index - width);
  if (y + 1 < height) callback(index + width);
}

function nearestIndex(lab, colors, candidates) {
  let best = -1, error = Infinity;
  for (const index of candidates) {
    const distance = labDistanceSq(lab, colors[index].lab);
    if (distance < error) { best = index; error = distance; }
  }
  return best;
}

/** Greedy weighted facility-location, followed by discrete Lloyd refinement. */
function selectPalette(groups, colors, maximum) {
  const m = groups.length, p = colors.length;
  const distances = new Float64Array(m * p);
  let first = 0, firstCost = Infinity;
  for (let c = 0; c < p; c++) {
    let sum = 0;
    for (let g = 0; g < m; g++) {
      const distance = labDistanceSq(groups[g].lab, colors[c].lab);
      distances[g * p + c] = distance;
      sum += groups[g].weight * distance;
    }
    if (sum < firstCost) { firstCost = sum; first = c; }
  }
  const selected = [first], chosen = new Set(selected);
  const bestDistances = Float64Array.from(groups, (_, g) => distances[g * p + first]);
  while (selected.length < maximum) {
    let winner = -1, improvement = 1e-9;
    for (let c = 0; c < p; c++) {
      if (chosen.has(c)) continue;
      let gain = 0;
      for (let g = 0; g < m; g++) {
        const reduction = bestDistances[g] - distances[g * p + c];
        if (reduction > 0) gain += groups[g].weight * reduction;
      }
      if (gain > improvement) { winner = c; improvement = gain; }
    }
    if (winner < 0) break;
    selected.push(winner); chosen.add(winner);
    for (let g = 0; g < m; g++) bestDistances[g] = Math.min(bestDistances[g], distances[g * p + winner]);
  }
  // For squared Lab error, a group's weighted centroid is sufficient to choose
  // its best catalogue entry. Two bounded refinements remove redundant seeds.
  for (let pass = 0; pass < 2; pass++) {
    const clusters = selected.map(() => ({ sum: [0, 0, 0], weight: 0 }));
    for (let g = 0; g < m; g++) {
      let best = 0, error = Infinity;
      for (let k = 0; k < selected.length; k++) {
        const d = distances[g * p + selected[k]];
        if (d < error) { best = k; error = d; }
      }
      const cluster = clusters[best], group = groups[g];
      cluster.weight += group.weight;
      for (let j = 0; j < 3; j++) cluster.sum[j] += group.lab[j] * group.weight;
    }
    let changed = false;
    for (let k = 0; k < selected.length; k++) {
      const cluster = clusters[k];
      if (!cluster.weight) continue;
      const center = cluster.sum.map(v => v / cluster.weight);
      let best = selected[k], error = labDistanceSq(center, colors[best].lab);
      for (let c = 0; c < p; c++) {
        if (c !== selected[k] && chosen.has(c)) continue;
        const d = labDistanceSq(center, colors[c].lab);
        if (d < error - 1e-9) { best = c; error = d; }
      }
      if (best !== selected[k]) {
        chosen.delete(selected[k]); chosen.add(best); selected[k] = best; changed = true;
      }
    }
    if (!changed) break;
  }
  return selected.sort((a, b) => a - b);
}

function smoothLabels(labels, labs, width, height, colors, weights, config) {
  if (!config.iterations) return 0;
  const n = labels.length, right = new Float32Array(n), down = new Float32Array(n);
  const denominator = 2 * config.sigma ** 2;
  for (let i = 0; i < n; i++) {
    if (!labs[i]) continue;
    if (i % width + 1 < width && labs[i + 1]) right[i] = config.lambda * Math.exp(-labDistanceSq(labs[i], labs[i + 1]) / denominator);
    if (i + width < n && labs[i + width]) down[i] = config.lambda * Math.exp(-labDistanceSq(labs[i], labs[i + width]) / denominator);
  }
  let totalChanges = 0;
  const adjacent = new Int32Array(4), penalties = new Float64Array(4), candidates = new Int32Array(5);
  for (let iteration = 0; iteration < config.iterations; iteration++) {
    let changes = 0;
    // Checkerboard updates avoid consistently pulling regions toward one corner.
    for (let parity = 0; parity < 2; parity++) for (let i = 0; i < n; i++) {
      const x = i % width, y = Math.floor(i / width);
      if (labels[i] < 0 || ((x + y) & 1) !== parity) continue;
      let neighboursCount = 0, candidatesCount = 1;
      candidates[0] = labels[i];
      const add = (index, penalty) => {
        if (labels[index] < 0) return;
        adjacent[neighboursCount] = labels[index]; penalties[neighboursCount++] = penalty;
        let exists = false;
        for (let c = 0; c < candidatesCount; c++) if (candidates[c] === labels[index]) { exists = true; break; }
        if (!exists) candidates[candidatesCount++] = labels[index];
      };
      if (x > 0) add(i - 1, right[i - 1]);
      if (x + 1 < width) add(i + 1, right[i]);
      if (y > 0) add(i - width, down[i - width]);
      if (y + 1 < height) add(i + width, down[i]);
      let best = labels[i], bestEnergy = Infinity;
      for (let c = 0; c < candidatesCount; c++) {
        const candidate = candidates[c];
        let energy = weights[i] * labDistanceSq(labs[i], colors[candidate].lab);
        for (let j = 0; j < neighboursCount; j++) if (candidate !== adjacent[j]) energy += penalties[j];
        if (energy < bestEnergy - 1e-9) { best = candidate; bestEnergy = energy; }
      }
      if (best !== labels[i]) { labels[i] = best; changes++; }
    }
    totalChanges += changes;
    if (!changes) break;
  }
  return totalChanges;
}

export function optimizePatternColors(labs, width, height, palette, options = {}) {
  const n = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || n > 1_000_000 || labs?.length !== n) throw new Error('图纸尺寸与像素不匹配');
  if (!Array.isArray(palette) || !palette.length) throw new Error('至少需要一种可用颜色');
  const mode = options.optimizationMode ?? 'balanced';
  if (!OPTIMIZATION_MODES.includes(mode)) throw new Error('未知的图纸优化模式');
  for (const lab of labs) if (lab != null && (lab.length !== 3 || typeof lab.every !== 'function' || !lab.every(Number.isFinite))) throw new Error('颜色像素数据无效');
  const codes = new Set();
  const colors = palette.map(color => {
    const code = String(color.code ?? '');
    if (!code || codes.has(code)) throw new Error('色号不可为空或重复');
    codes.add(code);
    return { code, lab: rgbToLab(hexToRgb(color.hex)) };
  }).sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const maximum = Math.max(1, Math.min(colors.length, Math.floor(Number(options.maxColors) || 24)));
  const all = colors.map((_, index) => index), initial = new Int32Array(n).fill(-1), weights = new Float32Array(n);
  const groupsByColor = new Map(), cache = new Map();
  for (let i = 0; i < n; i++) {
    const lab = labs[i];
    if (lab == null) continue;
    let contrast = 0;
    neighbours(i, width, height, at => { if (labs[at]) contrast = Math.max(contrast, labDistanceSq(lab, labs[at])); });
    // Strong local detail receives at most 3× weight. It is never classified as
    // an eye or text: preserving high contrast also intentionally preserves noise.
    const weight = 1 + Math.min(2, Math.sqrt(contrast) / 18);
    weights[i] = weight;
    const key = `${lab[0]},${lab[1]},${lab[2]}`;
    if (!cache.has(key)) cache.set(key, nearestIndex(lab, colors, all));
    const index = cache.get(key); initial[i] = index;
    if (!groupsByColor.has(index)) groupsByColor.set(index, { weight: 0, sum: [0, 0, 0] });
    const group = groupsByColor.get(index);
    group.weight += weight;
    for (let j = 0; j < 3; j++) group.sum[j] += lab[j] * weight;
  }
  const groups = [...groupsByColor.entries()].sort(([a], [b]) => a - b).map(([index, group]) => ({ index, weight: group.weight, lab: group.sum.map(v => v / group.weight) }));
  const selected = groups.length <= maximum ? groups.map(g => g.index) : selectPalette(groups, colors, maximum);
  const labels = initial.slice();
  if (groups.length > maximum) {
    cache.clear();
    for (let i = 0; i < n; i++) {
      if (!labs[i]) continue;
      const lab = labs[i], key = `${lab[0]},${lab[1]},${lab[2]}`;
      if (!cache.has(key)) cache.set(key, nearestIndex(lab, colors, selected));
      labels[i] = cache.get(key);
    }
  }
  const beforeSmoothing = labels.slice();
  smoothLabels(labels, labs, width, height, colors, weights, MODES[mode]);
  const cells = Array.from(labels, index => index < 0 ? null : colors[index].code), countMap = new Map();
  let changed = 0, visible = 0, error = 0, weightedError = 0, totalWeight = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] < 0) continue;
    const code = cells[i]; countMap.set(code, (countMap.get(code) || 0) + 1);
    const distance = labDistanceSq(labs[i], colors[labels[i]].lab);
    error += Math.sqrt(distance); weightedError += distance * weights[i]; totalWeight += weights[i]; visible++;
    if (labels[i] !== beforeSmoothing[i]) changed++;
  }
  const counts = Object.fromEntries(countMap);
  return { cells, counts, diagnostics: { version: 'catalogue-potts-1', mode, inputColors: groups.length, outputColors: Object.keys(counts).length, smoothedCells: changed, meanDeltaE76: visible ? error / visible : 0, weightedRmse: totalWeight ? Math.sqrt(weightedError / totalWeight) : 0 } };
}
