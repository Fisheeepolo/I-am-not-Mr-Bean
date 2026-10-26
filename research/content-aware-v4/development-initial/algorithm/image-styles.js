/** Local image treatments applied to the already resized bead-grid pixels. */
export const IMAGE_STYLES = Object.freeze(['original', 'clean', 'vivid']);

export function applyImageStyle(imageData, width, height, style = 'original') {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) {
    throw new Error('图片尺寸无效。');
  }
  const source = imageData?.data ?? imageData;
  if (!source || source.length !== width * height * 4) throw new Error('图片像素与尺寸不一致。');
  if (!IMAGE_STYLES.includes(style)) throw new Error('不支持的图片风格。');
  const data = new Uint8ClampedArray(source);
  if (style === 'original') return { data, width, height };

  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  if (style === 'vivid') {
    for (let i = 0; i < data.length; i += 4) {
      if (!source[i + 3]) continue;
      const luminance = source[i] * .2126 + source[i + 1] * .7152 + source[i + 2] * .0722;
      for (let channel = 0; channel < 3; channel++) {
        const saturated = luminance + (source[i + channel] - luminance) * 1.18;
        data[i + channel] = clamp((saturated - 128) * 1.08 + 128);
      }
    }
    return { data, width, height };
  }

  // Coarse channel levels reduce photographic micro-variations. Keep transparent
  // pixels untouched; alpha is never quantized or copied from a neighbour.
  const quantize = value => clamp(Math.round(value / 32) * 32);
  for (let i = 0; i < data.length; i += 4) {
    if (!source[i + 3]) continue;
    for (let channel = 0; channel < 3; channel++) data[i + channel] = quantize(source[i + channel]);
  }
  const quantized = data.slice();
  const same = (a, b) => quantized[a] === quantized[b] && quantized[a + 1] === quantized[b + 1] && quantized[a + 2] === quantized[b + 2];
  // Only smooth a fully surrounded, opaque single-pixel speck. Do not bleed
  // colours over a transparent edge or erase a strong contrasting eye/outline.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (y * width + x) * 4;
      if (source[at + 3] !== 255) continue;
      const neighbors = [at - 4, at + 4, at - width * 4, at + width * 4];
      if (neighbors.some(index => source[index + 3] !== 255)) continue;
      if (!neighbors.slice(1).every(index => same(index, neighbors[0]))) continue;
      const target = neighbors[0];
      const distance = Math.hypot(quantized[at] - quantized[target], quantized[at + 1] - quantized[target + 1], quantized[at + 2] - quantized[target + 2]);
      if (distance > 58) continue;
      data[at] = quantized[target]; data[at + 1] = quantized[target + 1]; data[at + 2] = quantized[target + 2];
    }
  }
  return { data, width, height };
}
