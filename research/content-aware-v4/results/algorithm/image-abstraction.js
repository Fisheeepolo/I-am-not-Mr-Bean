/** Local structure descriptors and a bounded anisotropic Kuwahara approximation. */
const LIMIT = 1_638_400;
const clamp01 = value => Math.max(0, Math.min(1, value));
const PRESETS = Object.freeze({ detail: { radius: 1.5, strength: .2 }, balanced: { radius: 2, strength: .45 }, easy: { radius: 2.5, strength: .65 } });

function inputPixels(imageData, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > LIMIT) throw new Error('结构分析图片尺寸无效或过大。');
  const data = imageData?.data ?? imageData;
  if (!data || data.length !== width * height * 4) throw new Error('结构分析像素与尺寸不一致。');
  return data;
}

/** Separable binomial [1,2,1]/4, clamped boundary; sigma ≈ sqrt(passes/2). */
function blur(source, width, height, channels = 1, passes = 1) {
  let current = source;
  for (let pass = 0; pass < passes; pass++) {
    const horizontal = new Float32Array(source.length), result = new Float32Array(source.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels, left = (y * width + Math.max(0, x - 1)) * channels, right = (y * width + Math.min(width - 1, x + 1)) * channels;
      for (let c = 0; c < channels; c++) horizontal[i + c] = (current[left + c] + 2 * current[i + c] + current[right + c]) * .25;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels, above = (Math.max(0, y - 1) * width + x) * channels, below = (Math.min(height - 1, y + 1) * width + x) * channels;
      for (let c = 0; c < channels; c++) result[i + c] = (horizontal[above + c] + 2 * horizontal[i + c] + horizontal[below + c]) * .25;
    }
    current = result;
  }
  return current;
}

function percentile95(values, alpha) {
  // Fixed histogram makes normalization deterministic without sorting all pixels.
  const bins = new Uint32Array(512); let count = 0;
  for (let i = 0; i < values.length; i++) if (alpha[i * 4 + 3]) { bins[Math.min(511, Math.floor(clamp01(values[i]) * 511))]++; count++; }
  const target = Math.ceil(count * .95); let cumulative = 0;
  for (let i = 0; i < bins.length; i++) { cumulative += bins[i]; if (cumulative >= target) return i / 511; }
  return 0;
}

export function analyzeImageStructure(imageData, width, height, options = {}) {
  const source = inputPixels(imageData, width, height), n = width * height;
  const premultiplied = new Float32Array(n * 4);
  let firstColor = -1, uniform = true;
  for (let i = 0; i < n; i++) {
    const p = i * 4, alpha = source[p + 3] / 255;
    for (let c = 0; c < 3; c++) premultiplied[p + c] = source[p + c] / 255 * alpha;
    premultiplied[p + 3] = alpha;
    if (alpha) {
      const key = source[p] * 65536 + source[p + 1] * 256 + source[p + 2];
      if (firstColor < 0) firstColor = key;
      else if (key !== firstColor) uniform = false;
    }
  }
  if (uniform) return { width, height, saliency: new Float32Array(n), gradient: new Float32Array(n), defocus: new Float32Array(n), defocusConfidence: new Float32Array(n), orientation: new Float32Array(n), anisotropy: new Float32Array(n), diagnostics: { model: 'multiscale-local-structure-v4', semanticSaliency: false, opticalDefocus: false, uniform: true } };
  const fine = blur(premultiplied, width, height, 4, 1);
  const middle = blur(fine, width, height, 4, 2);
  const coarse = blur(middle, width, height, 4, 3);
  const saliency = new Float32Array(n), gradient = new Float32Array(n), high = new Float32Array(n), medium = new Float32Array(n);
  const tensor = new Float32Array(n * 3);
  const color = (map, pixel, channel, fallback) => map[pixel * 4 + 3] > 1e-7 ? map[pixel * 4 + channel] / map[pixel * 4 + 3] : fallback;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, p = i * 4;
    if (!source[p + 3]) continue;
    const left = y * width + Math.max(0, x - 1), right = y * width + Math.min(width - 1, x + 1);
    const above = Math.max(0, y - 1) * width + x, below = Math.min(height - 1, y + 1) * width + x;
    let highSq = 0, mediumSq = 0, coarseSq = 0, xx = 0, xy = 0, yy = 0;
    for (let c = 0; c < 3; c++) {
      const original = source[p + c] / 255, f = color(fine, i, c, original), m = color(middle, i, c, original), s = color(coarse, i, c, original);
      highSq += (original - f) ** 2; mediumSq += (original - s) ** 2; coarseSq += (m - s) ** 2;
      const dx = (color(fine, right, c, f) - color(fine, left, c, f)) * .5;
      const dy = (color(fine, below, c, f) - color(fine, above, c, f)) * .5;
      xx += dx * dx / 3; xy += dx * dy / 3; yy += dy * dy / 3;
    }
    high[i] = Math.sqrt(highSq / 3); medium[i] = Math.sqrt(mediumSq / 3);
    saliency[i] = .65 * medium[i] + .35 * Math.sqrt(coarseSq / 3);
    gradient[i] = Math.sqrt(xx + yy);
    tensor[i * 3] = xx; tensor[i * 3 + 1] = xy; tensor[i * 3 + 2] = yy;
  }
  const smoothTensor = blur(tensor, width, height, 3, 2), smoothHigh = blur(high, width, height, 1, 2), smoothMedium = blur(medium, width, height, 1, 2);
  const orientation = new Float32Array(n), anisotropy = new Float32Array(n), defocus = new Float32Array(n), defocusConfidence = new Float32Array(n);
  let peakSaliency = 0, peakGradient = 0;
  for (let i = 0; i < n; i++) { peakSaliency = Math.max(peakSaliency, saliency[i]); peakGradient = Math.max(peakGradient, gradient[i]); }
  // A sparse eye can occupy much less than 5% of the image. Include its peak
  // so percentile normalization does not saturate both eye and surroundings.
  const saliencyScale = Math.max(.08, percentile95(saliency, source), .9 * peakSaliency), gradientScale = Math.max(.06, percentile95(gradient, source), .9 * peakGradient);
  for (let i = 0; i < n; i++) {
    if (!source[i * 4 + 3]) continue;
    saliency[i] = clamp01(saliency[i] / saliencyScale); gradient[i] = clamp01(gradient[i] / gradientScale);
    const xx = smoothTensor[i * 3], xy = smoothTensor[i * 3 + 1], yy = smoothTensor[i * 3 + 2], trace = xx + yy;
    anisotropy[i] = clamp01(Math.hypot(xx - yy, 2 * xy) / (trace + 1e-8));
    orientation[i] = trace > 1e-8 ? .5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2 : 0;
    // High/medium frequency ratio is only a blur-like structure proxy. A
    // textureless region has no evidence and explicitly receives confidence=0.
    defocusConfidence[i] = clamp01((smoothMedium[i] - .008) / .05);
    defocus[i] = defocusConfidence[i] * clamp01(1 - smoothHigh[i] / (.65 * smoothMedium[i] + 1e-6));
  }
  return { width, height, saliency, gradient, defocus, defocusConfidence, orientation, anisotropy,
    diagnostics: { model: 'multiscale-local-structure-v4', semanticSaliency: false, opticalDefocus: false, saliencyScale, gradientScale } };
}

const TAPS = [
  [0, 0, 1], [1, 0, .5], [-1, 0, .5], [0, 1, .5], [0, -1, .5],
  [.707, .707, .5], [.707, -.707, .5], [-.707, .707, .5], [-.707, -.707, .5],
  [.5, 0, .8], [-.5, 0, .8], [0, .5, .8], [0, -.5, .8]
];

export function abstractImageForPattern(imageData, width, height, options = {}) {
  const source = inputPixels(imageData, width, height), data = new Uint8ClampedArray(source), mode = options.optimizationMode ?? 'balanced';
  if (!Object.hasOwn(PRESETS, mode)) throw new Error('不支持的图纸优化模式。');
  const analysis = options.analysis ?? analyzeImageStructure(source, width, height, options);
  const analysisFields = ['saliency', 'gradient', 'defocus', 'defocusConfidence', 'orientation', 'anisotropy'];
  if (analysis.width !== width || analysis.height !== height || analysisFields.some(key => analysis[key]?.length !== width * height)) throw new Error('结构分析尺寸不一致。');
  if (analysisFields.some(key => !analysis[key].every(Number.isFinite))) throw new Error('结构分析包含无效数值。');
  const native = (options.targetWidth ?? width) === width && (options.targetHeight ?? height) === height;
  const diagnostics = { method: 'four-sector-sparse-anisotropic-kuwahara', approximate: true, changedPixels: 0, alphaUnchanged: true, status: 'preserved', reason: native ? 'native-resolution' : 'disabled' };
  if (native || options.abstraction === false || analysis.diagnostics?.uniform) {
    if (analysis.diagnostics?.uniform && !native && options.abstraction !== false) diagnostics.reason = 'uniform-image';
    return { data, width, height, analysis, diagnostics };
  }
  const { radius, strength } = PRESETS[mode], accum = new Float64Array(28);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, p = i * 4;
    if (!source[p + 3]) continue;
    const theta = analysis.orientation[i], cos = Math.cos(theta), sin = Math.sin(theta);
    const defocusAmount = options.defocusAware === false ? 0 : analysis.defocus[i];
    const localRadius = radius * (1 + .35 * defocusAmount);
    const elongation = 1 + .8 * analysis.anisotropy[i], major = localRadius * elongation, minor = localRadius / elongation;
    accum.fill(0);
    for (const [u, v, radial] of TAPS) {
      const sx = Math.max(0, Math.min(width - 1, Math.round(x + cos * u * major - sin * v * minor)));
      const sy = Math.max(0, Math.min(height - 1, Math.round(y + sin * u * major + cos * v * minor)));
      const q = (sy * width + sx) * 4, weight = radial * source[q + 3] / 255;
      if (!weight) continue;
      for (let sector = 0; sector < 4; sector++) {
        const signU = sector & 1 ? 1 : -1, signV = sector & 2 ? 1 : -1;
        if (u * signU < 0 || v * signV < 0) continue;
        const at = sector * 7; accum[at] += weight;
        for (let c = 0; c < 3; c++) { const value = source[q + c]; accum[at + 1 + c] += value * weight; accum[at + 4 + c] += value * value * weight; }
      }
    }
    let total = 0, red = 0, green = 0, blue = 0;
    for (let sector = 0; sector < 4; sector++) {
      const at = sector * 7, mass = accum[at];
      if (!mass) continue;
      const r = accum[at + 1] / mass, g = accum[at + 2] / mass, b = accum[at + 3] / mass;
      const variance = Math.max(0, (accum[at + 4] + accum[at + 5] + accum[at + 6]) / mass - r * r - g * g - b * b) / 3;
      const weight = 1 / (1 + (variance / 64) ** 2);
      total += weight; red += r * weight; green += g * weight; blue += b * weight;
    }
    if (!total) continue;
    const localStrength = strength + (1 - strength) * .3 * defocusAmount;
    const amount = localStrength * (1 - .65 * analysis.saliency[i]) * (1 - .5 * analysis.gradient[i]);
    const filtered = [red / total, green / total, blue / total];
    for (let c = 0; c < 3; c++) data[p + c] = source[p + c] + amount * (filtered[c] - source[p + c]);
    if (data[p] !== source[p] || data[p + 1] !== source[p + 1] || data[p + 2] !== source[p + 2]) diagnostics.changedPixels++;
  }
  Object.assign(diagnostics, { status: 'abstracted', reason: 'structure-guided', radius, strength, defocusAware: options.defocusAware !== false });
  return { data, width, height, analysis, diagnostics };
}
