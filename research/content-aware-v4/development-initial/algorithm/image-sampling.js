import { analyzeImageStructure } from './image-abstraction.js';

/**
 * Deterministic, alpha-aware source-to-bead sampling.
 *
 * The reference is the exact overlap area of source and destination pixels.
 * RGB is averaged after multiplying by alpha; transparent RGB cannot create
 * light/dark fringes. A bounded local contrast term can restore small marks
 * diluted by that average. This is a heuristic, not semantic recognition:
 * marks smaller than a bead are not guaranteed to survive.
 */
const MODES = Object.freeze({ detail: 1.5, balanced: 1.2, easy: .35 });
export const SALIENCY_SAMPLING_PARAMETERS = Object.freeze({
  detail: Object.freeze({ betaSaliency: 1.35, betaGradient: .6 }),
  balanced: Object.freeze({ betaSaliency: 1.1, betaGradient: .45 }),
  easy: Object.freeze({ betaSaliency: .75, betaGradient: .3 })
});
const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function validSize(width, height, limit) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= limit;
}

export function sampleImageForPattern(imageData, sourceWidth, sourceHeight, width, height, options = {}) {
  if (!validSize(sourceWidth, sourceHeight, 16_777_216) || !validSize(width, height, 1_000_000)) throw new Error('图片取样尺寸无效。');
  const source = imageData?.data ?? imageData;
  if (!source || source.length !== sourceWidth * sourceHeight * 4) throw new Error('图片像素与取样尺寸不一致。');
  const mode = options.optimizationMode ?? 'balanced';
  if (!Object.hasOwn(MODES, mode)) throw new Error('不支持的图纸优化模式。');
  const analysis = options.analysis ?? analyzeImageStructure(source, sourceWidth, sourceHeight, options);
  const sourceCount = sourceWidth * sourceHeight;
  if (analysis.width !== sourceWidth || analysis.height !== sourceHeight || analysis.saliency?.length !== sourceCount || analysis.gradient?.length !== sourceCount) throw new Error('取样结构分析尺寸不一致。');
  if (['defocus', 'defocusConfidence'].some(key => analysis[key] && analysis[key].length !== sourceCount)) throw new Error('取样结构分析尺寸不一致。');
  const weighted = options.saliencySampling !== false;
  const betaSaliency = options.betaSaliency ?? SALIENCY_SAMPLING_PARAMETERS[mode].betaSaliency;
  const betaGradient = options.betaGradient ?? SALIENCY_SAMPLING_PARAMETERS[mode].betaGradient;
  if (![betaSaliency, betaGradient].every(value => Number.isFinite(value) && value >= 0 && value <= 4)) throw new Error('显著性取样权重无效。');
  // A true pixel-art source already at bead resolution must remain unchanged,
  // including its alpha and hidden RGB channels.
  if (sourceWidth === width && sourceHeight === height) return {
    data: new Uint8ClampedArray(source), width, height,
    saliency: new Float32Array(analysis.saliency), defocus: new Float32Array(analysis.defocus ?? sourceCount), defocusConfidence: new Float32Array(analysis.defocusConfidence ?? sourceCount)
  };

  const n = width * height, means = new Float32Array(n * 3);
  const minimum = new Uint8Array(n * 3), maximum = new Uint8Array(n * 3);
  const deviations = new Float32Array(n), alpha = new Float32Array(n), concentration = new Float32Array(n);
  const data = new Uint8ClampedArray(n * 4);
  const saliency = new Float32Array(n), defocus = new Float32Array(n), defocusConfidence = new Float32Array(n);
  const finish = () => ({ data, width, height, saliency, defocus, defocusConfidence });
  const scaleX = sourceWidth / width, scaleY = sourceHeight / height, area = scaleX * scaleY;

  for (let y = 0; y < height; y++) {
    const y0 = y * scaleY, y1 = (y + 1) * scaleY;
    for (let x = 0; x < width; x++) {
      const x0 = x * scaleX, x1 = (x + 1) * scaleX, i = y * width + x, at = i * 3;
      let coverage = 0, colorMass = 0, r = 0, g = 0, b = 0, second = 0, saliencySq = 0, defocusSum = 0, confidenceSum = 0;
      let rMin = 255, gMin = 255, bMin = 255, rMax = 0, gMax = 0, bMax = 0;
      const localColors = new Map();
      for (let sy = Math.floor(y0); sy < Math.min(sourceHeight, Math.ceil(y1)); sy++) {
        const overlapY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(sourceWidth, Math.ceil(x1)); sx++) {
          const p = (sy * sourceWidth + sx) * 4;
          if (!source[p + 3]) continue;
          const weight = overlapY * (Math.min(x1, sx + 1) - Math.max(x0, sx)) * source[p + 3] / 255;
          if (weight <= 0) continue;
          const sr = source[p], sg = source[p + 1], sb = source[p + 2];
          const sourceIndex = sy * sourceWidth + sx, s = unit(analysis.saliency[sourceIndex]), gFeature = unit(analysis.gradient[sourceIndex]);
          const colorWeight = weight * (weighted ? Math.exp(betaSaliency * s + betaGradient * gFeature) : 1);
          coverage += weight;
          colorMass += colorWeight;
          saliencySq += weight * s * s;
          defocusSum += weight * unit(analysis.defocus?.[sourceIndex]); confidenceSum += weight * unit(analysis.defocusConfidence?.[sourceIndex]);
          const colorBin = (sr >> 4) * 256 + (sg >> 4) * 16 + (sb >> 4);
          localColors.set(colorBin, (localColors.get(colorBin) ?? 0) + weight);
          r += sr * colorWeight; g += sg * colorWeight; b += sb * colorWeight;
          second += (sr * sr + sg * sg + sb * sb) * colorWeight;
          rMin = Math.min(rMin, sr); gMin = Math.min(gMin, sg); bMin = Math.min(bMin, sb);
          rMax = Math.max(rMax, sr); gMax = Math.max(gMax, sg); bMax = Math.max(bMax, sb);
        }
      }
      if (!coverage) continue;
      r /= colorMass; g /= colorMass; b /= colorMass;
      means[at] = r; means[at + 1] = g; means[at + 2] = b;
      minimum[at] = rMin; minimum[at + 1] = gMin; minimum[at + 2] = bMin;
      maximum[at] = rMax; maximum[at + 1] = gMax; maximum[at + 2] = bMax;
      deviations[i] = Math.sqrt(Math.max(0, (second / colorMass - r * r - g * g - b * b) / 3));
      saliency[i] = Math.sqrt(saliencySq / coverage); defocus[i] = defocusSum / coverage; defocusConfidence[i] = confidenceSum / coverage;
      let first = 0, secondBin = 0;
      for (const mass of localColors.values()) {
        if (mass > first) { secondBin = first; first = mass; }
        else if (mass > secondBin) secondBin = mass;
      }
      concentration[i] = (first + secondBin) / coverage;
      alpha[i] = coverage / area;
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = alpha[i] * 255;
    }
  }

  const gain = options.contrastRecovery === false ? 0 : MODES[mode] * (weighted ? .65 : 1);
  if (!gain) return finish();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, at = i * 3;
    // Do not sharpen transparent silhouettes or weak texture. Opaque sampling
    // alone defines the alpha footprint; this pass can never grow the shape.
    if (alpha[i] < .75 || deviations[i] < 12) continue;
    // Broad photographic colour distributions are not simple strokes. The
    // development set exposed fragmented photo results from unconditional
    // sharpening, so balanced/easy only restore predominantly two-colour
    // source cells. Detail permits a small residual recovery for texture.
    const flatStructure = Math.max(0, Math.min(1, (concentration[i] - .7) / .2));
    const structureGate = mode === 'detail' ? .2 + .8 * flatStructure : flatStructure;
    if (!structureGate) continue;
    const nearby = [[], [], []];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const j = (y + dy) * width + x + dx;
      if (alpha[j] < .75) continue;
      const p = j * 3;
      nearby[0].push(means[p]); nearby[1].push(means[p + 1]); nearby[2].push(means[p + 2]);
    }
    if (nearby[0].length < 3) continue;
    // A median reference lets a continuous thin stroke keep its contrast even
    // when the two neighbouring stroke pixels share its diluted colour.
    const reference = nearby.map(values => {
      values.sort((a, b) => a - b);
      return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
    });
    const dr = means[at] - reference[0], dg = means[at + 1] - reference[1], db = means[at + 2] - reference[2];
    const contrast = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
    if (contrast < 8) continue;
    // Random source noise usually cancels inside a bead: its within-cell
    // variation is large but its target-scale contrast is small. Require the
    // latter to be meaningful before restoring contrast.
    const structure = Math.max(0, Math.min(1, (contrast / deviations[i] - .2) / .3));
    const amount = gain * structure * structureGate;
    if (!amount) continue;
    const residuals = [dr, dg, db];
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.max(minimum[at + c], Math.min(maximum[at + c], means[at + c] + residuals[c] * amount));
    }
  }
  return finish();
}
