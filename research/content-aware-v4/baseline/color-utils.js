// Shared deterministic sRGB / D65 CIELAB conversion for local image processing.
export function hexToRgb(hex) {
  const value = String(hex).replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) throw new Error('无效的颜色值');
  const full = value.length === 3 ? [...value].map(c => c + c).join('') : value;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
}
export function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(c => {
    const v = Math.max(0, Math.min(255, c)) / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  const f = v => v > .008856451679 ? Math.cbrt(v) : 7.787037037 * v + 16 / 116;
  const x = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047);
  const y = f(.2126729 * r + .7151522 * g + .072175 * b);
  const z = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export const labDistanceSq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
