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

/** CIEDE2000, kL=kC=kH=1. Sharma/Wu/Dalal (2005), including hue wrap cases. */
export function deltaE2000(first, second) {
  const [l1, a1, b1] = first, [l2, a2, b2] = second, radians = Math.PI / 180;
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), meanC = (c1 + c2) / 2;
  const meanC7 = meanC ** 7, g = .5 * (1 - Math.sqrt(meanC7 / (meanC7 + 6103515625)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hue = (a, b) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / radians; return h < 0 ? h + 360 : h; };
  const hp1 = hue(ap1, b1), hp2 = hue(ap2, b2);
  const dl = l2 - l1, dc = cp2 - cp1;
  let dh = hp2 - hp1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * radians / 2);
  const meanL = (l1 + l2) / 2, meanCp = (cp1 + cp2) / 2;
  let meanH;
  if (cp1 * cp2 === 0) meanH = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) meanH = (hp1 + hp2) / 2;
  else meanH = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  const t = 1 - .17 * Math.cos((meanH - 30) * radians) + .24 * Math.cos(2 * meanH * radians)
    + .32 * Math.cos((3 * meanH + 6) * radians) - .2 * Math.cos((4 * meanH - 63) * radians);
  const l50 = (meanL - 50) ** 2;
  const sl = 1 + .015 * l50 / Math.sqrt(20 + l50), sc = 1 + .045 * meanCp, sh = 1 + .015 * meanCp * t;
  const cp7 = meanCp ** 7, rc = 2 * Math.sqrt(cp7 / (cp7 + 6103515625));
  const theta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2)), rt = -Math.sin(2 * theta * radians) * rc;
  const ll = dl / sl, cc = dc / sc, hh = dH / sh;
  return Math.sqrt(Math.max(0, ll * ll + cc * cc + hh * hh + rt * cc * hh));
}
export const ciede2000 = deltaE2000;
