import { nearestColors } from './engine.js';

// Original, deterministic pixel illustrations. All art colors are matched to the
// supplied real catalogue; the illustrations never invent brand color numbers.
function painter(width, height, palette) {
  const cells = Array(width * height).fill(null), matches = new Map();
  const color = hex => {
    if (!matches.has(hex)) matches.set(hex, nearestColors(hex, palette, 1)[0].code);
    return matches.get(hex);
  };
  const dot = (x, y, hex) => {
    if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = hex == null ? null : color(hex);
  };
  const rect = (x, y, w, h, hex) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) dot(xx, yy, hex); };
  const ellipse = (cx, cy, rx, ry, hex) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) dot(x, y, hex);
    }
  };
  const polygon = (points, hex) => {
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y + .5) !== (yj > y + .5) && x + .5 < (xj - xi) * (y + .5 - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) dot(x, y, hex);
    }
  };
  return { width, height, cells, dot, rect, ellipse, polygon };
}

function littleFlower(palette) {
  const a = painter(24, 24, palette);
  const outline = '#526146', leaf = '#83A45F', lightLeaf = '#B4C971';
  a.rect(11, 10, 2, 13, outline);
  a.polygon([[11, 20], [5, 20], [3, 16], [8, 16], [11, 18]], outline);
  a.polygon([[11, 19], [6, 19], [5, 17], [8, 17]], leaf);
  a.polygon([[13, 18], [18, 18], [21, 14], [16, 14], [13, 16]], outline);
  a.polygon([[13, 17], [17, 17], [19, 15], [16, 15]], lightLeaf);
  for (const [x, y] of [[8, 6], [12, 3], [16, 6], [16, 10], [12, 13], [8, 10]]) a.ellipse(x, y, 4, 4, '#BE883E');
  for (const [x, y] of [[8, 6], [12, 3], [16, 6], [16, 10], [12, 13], [8, 10]]) a.ellipse(x, y, 3, 3, '#FFF0BE');
  a.ellipse(12, 8, 4, 4, '#C47A2C');
  a.ellipse(12, 8, 3, 3, '#F6BE4C');
  a.rect(10, 6, 3, 1, '#FFE298');
  return a;
}

function mushroomCottage(palette) {
  const a = painter(48, 48, palette), ink = '#51393C';
  a.ellipse(24, 43, 22, 3, '#476554');
  a.rect(6, 42, 36, 3, '#7B9B63');
  a.rect(14, 21, 22, 22, ink);
  a.rect(16, 23, 18, 19, '#EBDDB5');
  a.rect(30, 23, 4, 19, '#D1B582');
  a.rect(20, 32, 10, 11, ink);
  a.rect(22, 33, 6, 9, '#AE7049');
  a.rect(22, 33, 1, 9, '#D09357');
  a.dot(26, 38, '#FFE6AB');
  for (const x of [17, 29]) {
    a.rect(x, 26, 5, 6, ink);
    a.rect(x + 1, 27, 3, 3, '#8AB8C0');
    a.rect(x + 1, 27, 1, 1, '#D2ECE0');
    a.rect(x, 31, 6, 1, '#A16F4D');
  }
  a.polygon([[4, 23], [6, 17], [10, 11], [17, 6], [26, 4], [34, 7], [41, 13], [45, 23], [42, 26], [7, 26]], ink);
  a.polygon([[6, 22], [8, 17], [12, 12], [18, 8], [26, 6], [33, 9], [39, 14], [43, 23], [8, 24]], '#C75C54');
  a.polygon([[9, 21], [13, 13], [19, 9], [26, 7], [31, 10], [35, 18], [36, 23], [9, 24]], '#E98063');
  a.rect(9, 23, 33, 1, '#A94B4E');
  for (const [x, y, rx, ry] of [[16, 15, 3, 3], [28, 11, 3, 2], [35, 19, 3, 2], [24, 21, 2, 1], [10, 21, 1, 1]]) {
    a.ellipse(x, y, rx, ry, '#FFF0CE');
  }
  for (const [x, y] of [[7, 39], [39, 38], [42, 42], [11, 43]]) {
    a.rect(x, y, 1, 4, '#476554');
    a.rect(x - 1, y - 1, 3, 1, '#E5B857');
    a.dot(x, y - 2, '#F4DEA1');
  }
  a.rect(22, 43, 7, 2, '#C8B29E');
  return a;
}

function harborAtNight(palette) {
  const a = painter(96, 96, palette), ink = '#24213D';
  a.rect(3, 3, 90, 90, ink);
  a.rect(5, 5, 86, 57, '#333153');
  a.rect(5, 37, 86, 25, '#4B456A');
  a.rect(5, 53, 86, 12, '#6A5273');
  a.ellipse(73, 20, 10, 10, '#F4D5A0');
  a.ellipse(77, 17, 9, 9, '#333153');
  for (const [x, y] of [[12, 14], [29, 10], [45, 22], [55, 12], [83, 34], [18, 31], [61, 31]]) {
    a.dot(x, y, '#F5E7C8');
    if (x % 2) { a.dot(x - 1, y, '#A7A8B6'); a.dot(x + 1, y, '#A7A8B6'); a.dot(x, y - 1, '#A7A8B6'); a.dot(x, y + 1, '#A7A8B6'); }
  }
  // Low skyline provides depth behind the waterfront houses.
  for (const [x, y, w, h, color] of [[5, 44, 12, 21, '#383B58'], [18, 39, 9, 26, '#414661'], [29, 46, 11, 19, '#383B58'], [44, 41, 13, 24, '#414661'], [58, 47, 10, 18, '#383B58'], [70, 36, 9, 29, '#414661'], [81, 45, 10, 20, '#383B58']]) a.rect(x, y, w, h, color);
  const houses = [[8, 48, 16, 20, '#B1706B'], [26, 42, 18, 26, '#7A91A2'], [46, 51, 16, 17, '#C0936B'], [64, 44, 19, 24, '#748981']];
  for (const [x, y, w, h, color] of houses) {
    a.rect(x - 1, y - 2, w + 2, h + 3, ink);
    a.rect(x, y, w, h, color);
    a.rect(x + w - 3, y, 3, h, '#52516A');
    a.polygon([[x - 2, y], [x + Math.floor(w / 2), y - 8], [x + w + 2, y]], '#8C5864');
    a.rect(x + 2, y - 1, w - 4, 1, '#D0A188');
    for (let wy = y + 3; wy < y + h - 4; wy += 7) for (let wx = x + 2; wx < x + w - 4; wx += 6) {
      a.rect(wx, wy, 4, 5, ink);
      a.rect(wx + 1, wy + 1, 2, 3, (wx + wy) % 3 ? '#F5C774' : '#E6A76D');
    }
    a.rect(x + Math.floor(w / 2) - 1, y + h - 5, 4, 5, ink);
    a.rect(x + Math.floor(w / 2), y + h - 4, 2, 4, '#CA9364');
  }
  a.rect(5, 68, 86, 3, '#C6AC91');
  a.rect(5, 71, 86, 2, '#696379');
  a.rect(5, 73, 86, 18, '#344D68');
  a.rect(5, 84, 86, 7, '#2E3F5B');
  // Broken horizontal reflections are deliberate, organized detail, not noise.
  for (let y = 75; y < 90; y += 3) {
    for (const x of [15, 35, 55, 74]) {
      const offset = (y % 4) - 2;
      a.rect(x + offset, y, y < 82 ? 6 : 4, 1, y < 81 ? '#D0A188' : '#87929A');
      a.rect(x + 8 - offset, y + 1, 3, 1, '#587C91');
    }
  }
  a.rect(8, 63, 1, 7, ink); a.rect(7, 61, 3, 3, '#F5D491');
  a.rect(87, 62, 1, 8, ink); a.rect(86, 60, 3, 3, '#F5D491');
  // Small boat in the lower-right water.
  a.polygon([[62, 82], [79, 82], [75, 86], [66, 86]], '#22243B');
  a.rect(70, 74, 1, 9, '#D6BA96');
  a.polygon([[71, 75], [71, 81], [77, 81]], '#EBD9B9');
  return a;
}

export function createDifficultyExamples(palette) {
  const colors = Array.isArray(palette) ? palette : palette?.colors;
  if (!Array.isArray(colors) || !colors.length) throw new Error('请先载入有效色卡，再查看难度示例。');
  const definitions = [
    { id: 'sunny-flower', name: '向阳小花', description: '小尺寸与连续色块，适合第一次拼豆。', art: littleFlower },
    { id: 'mushroom-cottage', name: '蘑菇小屋', description: '多色屋顶、门窗和花草，练习局部细节。', art: mushroomCottage },
    { id: 'harbor-lights', name: '港湾灯火', description: '较大画幅与丰富灯影，适合分区慢慢完成。', art: harborAtNight }
  ];
  return definitions.map(({ id, name, description, art }) => {
    const { width, height, cells } = art(colors);
    return { id, name, description, project: {
      format: 'bead-studio', version: 1, width, height, cells,
      palette: { name: typeof palette?.name === 'string' ? palette.name : 'MARD · 291 色参考色卡', colors: colors.map(c => ({ ...c })) },
      paletteId: 'mard', customPalettes: {}, projectName: name, isDemo: false, aiEdited: false, done: [], exclusions: {},
      settings: { width, height, maxColors: Math.min(64, Math.max(2, new Set(cells.filter(Boolean)).size)), keepRatio: true, removeBackground: false, backgroundTolerance: 20 },
      savedAt: new Date(0).toISOString()
    } };
  });
}

/** Time buckets use the midpoint of the estimate, never an actual session time.
 * under60: < 60 min; 60to180: 60 <= min <= 180; over180: > 180 min.
 */
export function matchesLibraryFilters(summary, { levels = [], time = 'all' } = {}) {
  const effort = summary?.effort;
  if (levels.length && !levels.map(Number).includes(effort?.level)) return false;
  if (time === 'all') return true;
  const minimum = Number(effort?.minutesMin), maximum = Number(effort?.minutesMax);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) return false;
  const middle = (minimum + maximum) / 2;
  if (time === 'under60') return middle < 60;
  if (time === '60to180') return middle >= 60 && middle <= 180;
  if (time === 'over180') return middle > 180;
  return true;
}
