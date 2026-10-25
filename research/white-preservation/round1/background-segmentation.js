import { rgbToLab, labDistanceSq } from './color-utils.js';

const MAX_PIXELS = 4_194_304;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const median = values => {
  values.sort((a, b) => a - b);
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
};

/** Binary rectangular morphology, ignoring pixels outside the content ROI. */
function boxMorph(input, width, height, radius, dilate, bounds) {
  const horizontal = new Uint8Array(input.length), output = new Uint8Array(input.length);
  const { left, top, right, bottom } = bounds;
  for (let y = top; y <= bottom; y++) {
    let count = 0;
    for (let x = left; x <= Math.min(right, left + radius); x++) count += input[y * width + x];
    for (let x = left; x <= right; x++) {
      const span = Math.min(right, x + radius) - Math.max(left, x - radius) + 1;
      horizontal[y * width + x] = dilate ? +(count > 0) : +(count === span);
      if (x - radius >= left) count -= input[y * width + x - radius];
      if (x + radius + 1 <= right) count += input[y * width + x + radius + 1];
    }
  }
  for (let x = left; x <= right; x++) {
    let count = 0;
    for (let y = top; y <= Math.min(bottom, top + radius); y++) count += horizontal[y * width + x];
    for (let y = top; y <= bottom; y++) {
      const span = Math.min(bottom, y + radius) - Math.max(top, y - radius) + 1;
      output[y * width + x] = dilate ? +(count > 0) : +(count === span);
      if (y - radius >= top) count -= horizontal[(y - radius) * width + x];
      if (y + radius + 1 <= bottom) count += horizontal[(y + radius + 1) * width + x];
    }
  }
  return output;
}

/**
 * Conservative non-semantic background removal, applied BEFORE downsampling.
 *
 * preserve is an exact owned copy. edge only removes a strongly supported,
 * near-uniform exterior connected to the image boundary. It is deliberately
 * allowed to abstain: white foreground on identical white background cannot
 * be inferred from RGB alone. Existing source transparency always takes
 * precedence. contentBounds identifies contain-padding added by the caller;
 * without it, any transparent source pixel causes edge to preserve the image.
 *
 * Barrier closing followed by boundary propagation follows binary morphology
 * (dilation→erosion and masked reconstruction); this is not GrabCut or an
 * implementation of semantic object segmentation.
 */
export function segmentBackground(imageData, width, height, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('背景处理尺寸无效。');
  const source = imageData?.data ?? imageData;
  if (!source || source.length !== width * height * 4) throw new Error('背景处理像素与尺寸不一致。');
  const mode = options.mode ?? 'preserve';
  if (mode !== 'preserve' && mode !== 'edge') throw new Error('不支持的背景处理模式。');
  const tolerance = options.tolerance ?? 20;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new Error('背景容差无效。');
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('背景处理比例无效。');
  const n = width * height, data = new Uint8ClampedArray(source), mask = new Uint8Array(n);
  let foregroundPixels = 0;
  for (let i = 0; i < n; i++) foregroundPixels += +(source[i * 4 + 3] > 0);
  const diagnostics = { status: 'preserved', reason: 'preserve-mode', mode, removedPixels: 0, foregroundPixels };
  const finish = reason => { diagnostics.reason = reason; return { data, width, height, mask, diagnostics }; };
  if (mode === 'preserve') return finish('preserve-mode');
  if (!foregroundPixels) return finish('empty-image');

  const content = options.contentBounds ?? { x: 0, y: 0, width, height };
  if (![content.x, content.y, content.width, content.height].every(Number.isFinite) || content.width <= 0 || content.height <= 0) throw new Error('原图区域无效。');
  const bounds = {
    left: Math.max(0, Math.floor(content.x)), top: Math.max(0, Math.floor(content.y)),
    right: Math.min(width - 1, Math.ceil(content.x + content.width) - 1),
    bottom: Math.min(height - 1, Math.ceil(content.y + content.height) - 1)
  };
  const { left, top, right, bottom } = bounds;
  if (right - left < 3 || bottom - top < 3) return finish('content-too-small');
  // Fractional drawImage edges can have alpha from contain-padding. Only
  // wholly covered source pixels distinguish that from an existing cutout.
  const innerLeft = Math.max(0, Math.ceil(content.x)), innerTop = Math.max(0, Math.ceil(content.y));
  const innerRight = Math.min(width - 1, Math.floor(content.x + content.width) - 1);
  const innerBottom = Math.min(height - 1, Math.floor(content.y + content.height) - 1);
  for (let y = innerTop; y <= innerBottom; y++) for (let x = innerLeft; x <= innerRight; x++) {
    if (source[(y * width + x) * 4 + 3] < 255) return finish('existing-alpha');
  }

  const labs = new Float32Array(n * 3), distances = new Float32Array(n);
  const cache = new Map();
  const labAt = i => [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]];
  let active = 0;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const i = y * width + x, p = i * 4;
    if (!source[p + 3]) continue;
    active++;
    const key = source[p] * 65536 + source[p + 1] * 256 + source[p + 2];
    let lab = cache.get(key);
    if (!lab) {
      lab = rgbToLab([source[p], source[p + 1], source[p + 2]]);
      if (cache.size < 8192) cache.set(key, lab);
    }
    labs.set(lab, i * 3);
  }
  const sides = [[], [], [], []];
  const strideX = Math.max(1, Math.ceil((right - left + 1) / 1024));
  const strideY = Math.max(1, Math.ceil((bottom - top + 1) / 1024));
  for (let x = left; x <= right; x += strideX) { sides[0].push(top * width + x); sides[2].push(bottom * width + x); }
  for (let y = top; y <= bottom; y += strideY) { sides[1].push(y * width + right); sides[3].push(y * width + left); }
  const samples = sides.flat().filter(i => source[i * 4 + 3] > 0);
  if (samples.length < 8) return finish('uncertain-boundary');
  const bins = new Map();
  for (const i of samples) {
    const p = i * 4, key = (source[p] >> 3) * 1024 + (source[p + 1] >> 3) * 32 + (source[p + 2] >> 3);
    let bin = bins.get(key);
    if (!bin) { bin = { count: 0, indices: [] }; bins.set(key, bin); }
    bin.count++; bin.indices.push(i);
  }
  const fitTolerance = clamp(tolerance * .2, 1, 4), fitSq = fitTolerance * fitTolerance;
  const candidates = [...bins.values()].sort((a, b) => b.count - a.count).slice(0, 8).map(bin => {
    const rgb = [0, 1, 2].map(c => median(bin.indices.map(i => source[i * 4 + c])));
    const lab = rgbToLab(rgb);
    return { lab, support: samples.filter(i => labDistanceSq(labAt(i), lab) <= fitSq) };
  }).sort((a, b) => b.support.length - a.support.length);
  const best = candidates[0];
  if (!best || best.support.length / samples.length < .72) return finish('uncertain-boundary');
  // Use the same precision as the pixel store so tolerance=0 really accepts
  // identical source RGB rather than treating rounding noise as a boundary.
  const reference = [...new Float32Array(rgbToLab([0, 1, 2].map(c => median(best.support.map(i => source[i * 4 + c])))))];
  const supportedSides = sides.filter(side => {
    const visible = side.filter(i => source[i * 4 + 3] > 0);
    return visible.length >= 2 && visible.filter(i => labDistanceSq(labAt(i), reference) <= fitSq).length / visible.length >= .6;
  }).length;
  if (supportedSides < 3) return finish('uncertain-boundary');
  const errors = best.support.map(i => Math.sqrt(labDistanceSq(labAt(i), reference))).sort((a, b) => a - b);
  const boundaryNoise = errors[Math.floor((errors.length - 1) * .95)] || 0;
  // The slider is an upper bound, not permission to walk across pale clothes.
  // A clean border justifies a tight threshold; a noisy one widens it mildly.
  const effectiveTolerance = Math.min(tolerance, Math.max(1.5, boundaryNoise * 2.5 + tolerance * .08));
  const edgeThreshold = clamp(effectiveTolerance * .65, .9, 3);
  Object.assign(diagnostics, { backgroundLab: reference, boundarySupport: best.support.length / samples.length, supportedSides, effectiveTolerance, edgeThreshold });
  let farthest = 0, evidencePixels = 0;
  const evidenceThreshold = Math.max(3, effectiveTolerance * 1.5);
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const i = y * width + x;
    if (!source[i * 4 + 3]) continue;
    const distance = Math.sqrt(labDistanceSq(labAt(i), reference));
    distances[i] = distance; farthest = Math.max(farthest, distance);
    evidencePixels += +(distance > evidenceThreshold);
  }
  if (farthest < 3) return finish('uniform-image');
  if (evidencePixels < Math.max(4, active * .001)) return finish('insufficient-foreground');

  const barrier = new Uint8Array(n), edgeSq = edgeThreshold * edgeThreshold;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const i = y * width + x;
    if (distances[i] > effectiveTolerance) barrier[i] = 1;
    if (!source[i * 4 + 3]) continue;
    for (const j of [x < right ? i + 1 : -1, y < bottom ? i + width : -1]) {
      if (j >= 0 && source[j * 4 + 3] && labDistanceSq(labAt(i), labAt(j)) > edgeSq) { barrier[i] = 1; barrier[j] = 1; }
    }
  }
  // Close only a fraction-of-a-bead source gap (normally radius=1 at 4×).
  // It may retain ambiguous tiny openings; it never erases an interior island.
  const radius = clamp(Math.round(scale / 4), 1, 3);
  const closed = boxMorph(boxMorph(barrier, width, height, radius, true, bounds), width, height, radius, false, bounds);
  for (let i = 0; i < n; i++) closed[i] |= barrier[i];
  diagnostics.closureRadius = radius;
  const visited = new Uint8Array(n), queue = new Int32Array((right - left + 1) * (bottom - top + 1));
  let head = 0, tail = 0;
  const visit = i => { if (!visited[i] && !closed[i]) { visited[i] = 1; queue[tail++] = i; } };
  for (let x = left; x <= right; x++) { visit(top * width + x); visit(bottom * width + x); }
  for (let y = top; y <= bottom; y++) { visit(y * width + left); visit(y * width + right); }
  while (head < tail) {
    const i = queue[head++], x = i % width, y = Math.floor(i / width);
    if (x > left) visit(i - 1); if (x < right) visit(i + 1);
    if (y > top) visit(i - width); if (y < bottom) visit(i + width);
  }
  let removed = 0;
  for (let i = 0; i < n; i++) if (visited[i] && source[i * 4 + 3]) removed++;
  if (!removed) return finish('no-connected-background');
  // A nearly empty result is too weak evidence to reinterpret a white object
  // as background. Keep the original instead of guessing its intended mask.
  if (removed / active > .985 || active - removed < Math.max(9, active * .005)) return finish('excessive-removal');
  for (let i = 0; i < n; i++) if (visited[i] && source[i * 4 + 3]) { data[i * 4 + 3] = 0; mask[i] = 1; }
  Object.assign(diagnostics, { status: 'segmented', reason: 'edge-background', removedPixels: removed, foregroundPixels: foregroundPixels - removed });
  return { data, width, height, mask, diagnostics };
}
