/* Browser-local image conversion. Colours are compared in CIE L*a*b*. */
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

const labDistanceSq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export const deltaE = (a, b) => Math.sqrt(labDistanceSq(rgbToLab(a), rgbToLab(b)));

export function nearestColors(hex, palette, limit = 5) {
  const lab = rgbToLab(hexToRgb(hex));
  return palette.map(c => ({ ...c, distance: Math.sqrt(labDistanceSq(lab, rgbToLab(hexToRgb(c.hex)))) }))
    .sort((a, b) => a.distance - b.distance || String(a.code).localeCompare(String(b.code)))
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function countCells(cells) {
  const counts = new Map();
  for (const code of cells) if (code !== null && code !== undefined && code !== '') counts.set(code, (counts.get(code) || 0) + 1);
  return Object.fromEntries(counts);
}

export const replaceColor = (cells, from, to) => cells.map(code => code === from ? to : code);

export function generatePattern(imageData, width, height, palette, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) throw new Error('图纸尺寸无效');
  const data = imageData.data || imageData;
  if (!data || data.length !== width * height * 4) throw new Error('图片像素尺寸不匹配');
  if (!palette?.length) throw new Error('至少需要一种可用颜色');
  const colors = palette.map(c => ({ ...c, lab: rgbToLab(hexToRgb(c.hex)) }));
  const maxColors = Math.max(1, Math.min(colors.length, Math.floor(Number(options.maxColors) || 24)));
  const alphaThreshold = options.alphaThreshold ?? 100;
  const n = width * height;
  const skip = new Uint8Array(n);
  const labs = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (data[p + 3] < alphaThreshold) { skip[i] = 1; continue; }
    const alpha = data[p + 3] / 255;
    labs[i] = rgbToLab([data[p], data[p + 1], data[p + 2]].map(c => c * alpha + 255 * (1 - alpha)));
  }

  if (options.removeBackground) {
    const cornerIndices = [...new Set([0, width - 1, (height - 1) * width, n - 1])];
    const corners = cornerIndices.filter(i => labs[i]).map(i => labs[i]);
    if (corners.length >= 2) {
      // The best-supported corner colour is the background reference. Flood fill
      // never crosses foreground pixels and therefore preserves enclosed whites.
      const toleranceSq = Math.max(0, Number(options.backgroundTolerance ?? 28)) ** 2;
      const reference = corners.map(lab => ({ lab, votes: corners.filter(c => labDistanceSq(lab, c) <= toleranceSq).length }))
        .sort((a, b) => b.votes - a.votes)[0];
      const background = reference.lab;
      const visited = new Uint8Array(n);
      const queue = new Int32Array(n);
      let head = 0, tail = 0;
      const visit = i => {
        if (visited[i]) return;
        visited[i] = 1;
        if (!labs[i] || (reference.votes >= 2 && labDistanceSq(labs[i], background) <= toleranceSq)) { skip[i] = 1; queue[tail++] = i; }
      };
      for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
      for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
      while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i / width);
        if (x > 0) visit(i - 1); if (x + 1 < width) visit(i + 1);
        if (y > 0) visit(i - width); if (y + 1 < height) visit(i + width);
      }
    }
  }

  function nearest(lab, candidates) {
    let best = candidates[0], distance = Infinity;
    for (const candidate of candidates) {
      const d = labDistanceSq(lab, candidate.lab);
      if (d < distance) { best = candidate; distance = d; }
    }
    return best.code;
  }
  const cache = new Map();
  let cells = labs.map((lab, i) => {
    if (skip[i]) return null;
    const key = `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]},${data[i * 4 + 3]}`;
    if (!cache.has(key)) cache.set(key, nearest(lab, colors));
    return cache.get(key);
  });
  const firstCounts = countCells(cells);
  if (Object.keys(firstCounts).length > maxColors) {
    const selectedCodes = new Set(Object.entries(firstCounts).sort((a, b) => b[1] - a[1]).slice(0, maxColors).map(([code]) => code));
    const selected = colors.filter(c => selectedCodes.has(c.code));
    cache.clear();
    cells = cells.map((code, i) => {
      if (code === null || selectedCodes.has(code)) return code;
      const key = `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]},${data[i * 4 + 3]}`;
      if (!cache.has(key)) cache.set(key, nearest(labs[i], selected));
      return cache.get(key);
    });
  }
  return { width, height, cells, counts: countCells(cells) };
}

export function makeDemo(width = 52, height = 52, palette = []) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) throw new Error('图纸尺寸无效');
  if (!palette.length) throw new Error('示例需要色卡');
  const ink = new Array(32 * 32).fill(null);
  const shades = { outline: '#563A31', orange: '#E78850', shadow: '#C15F38', cream: '#FFF0D4', blush: '#F2B3A5', eyes: '#382D2B', light: '#F7AF68' };
  const codes = Object.fromEntries(Object.entries(shades).map(([key, hex]) => [key, nearestColors(hex, palette, 1)[0].code]));
  function polygon(points, color) {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y + .5) !== (yj > y + .5) && x + .5 < (xj - xi) * (y + .5 - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) ink[y * 32 + x] = codes[color];
    }
  }
  function rect(x, y, w, h, color) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) ink[j * 32 + i] = codes[color]; }
  // Original, deliberately small pixel illustration: a seated woodland fox.
  polygon([[21,22],[25,20],[29,17],[30,22],[28,28],[23,29],[19,27]], 'outline');
  polygon([[22,23],[26,21],[29,19],[29,23],[27,27],[23,28],[20,26]], 'orange');
  polygon([[26,21],[29,19],[29,23],[28,25],[26,24]], 'cream');
  polygon([[11,17],[22,17],[24,24],[23,29],[9,29],[8,25]], 'outline');
  polygon([[12,18],[21,18],[23,24],[22,28],[10,28],[9,25]], 'orange');
  polygon([[14,19],[19,19],[21,24],[20,27],[13,27],[12,24]], 'cream');
  rect(10,27,4,2,'outline'); rect(19,27,4,2,'outline');
  polygon([[5,3],[11,6],[16,5],[22,6],[27,3],[27,12],[25,17],[20,21],[12,21],[7,17],[5,12]], 'outline');
  polygon([[6,5],[11,7],[16,6],[22,7],[26,5],[26,12],[24,16],[20,20],[12,20],[8,16],[6,12]], 'orange');
  polygon([[7,6],[11,8],[8,10]], 'shadow'); polygon([[25,6],[21,8],[24,10]], 'shadow');
  polygon([[9,9],[13,8],[20,8],[23,10],[22,12],[19,11],[14,11],[10,12]], 'light');
  polygon([[7,13],[11,13],[16,16],[21,13],[25,13],[24,16],[20,20],[12,20],[8,16]], 'cream');
  rect(10,12,2,2,'eyes'); rect(21,12,2,2,'eyes');
  rect(8,14,2,1,'blush'); rect(23,14,2,1,'blush');
  rect(15,15,3,2,'eyes'); rect(16,17,1,1,'outline');
  const cells = Array.from({length: width * height}, (_, i) => {
    const x = Math.min(31, Math.floor((i % width) * 32 / width));
    const y = Math.min(31, Math.floor(Math.floor(i / width) * 32 / height));
    return ink[y * 32 + x];
  });
  return {width, height, cells, counts: countCells(cells)};
}
