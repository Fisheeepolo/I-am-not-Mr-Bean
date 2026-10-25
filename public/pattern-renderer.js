/** A virtual paper with a bounded viewport canvas. No full-size bitmap is allocated. */
const MAX_BACKING_SIDE = 4096;
const MAX_BACKING_PIXELS = 8 * 1024 * 1024;
const EMPTY_DONE = new Set();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Keep axis numbers readable when a large pattern is fitted into a narrow view. */
export function rulerLabelStep(cellSize) {
  return cellSize >= 24 ? 1 : Math.max(10, Math.ceil(26 / (cellSize * 10)) * 10);
}

/** Draw paired light/dark cell edges on physical pixels, including exported paper. */
export function drawBeadGrid(context, { columns, rows, cellSize, left = 0, top = 0 }, frame = {}) {
  const scale = frame.scale || 1, pixel = 1 / scale;
  const offsetX = frame.x || 0, offsetY = frame.y || 0;
  const right = left + columns * cellSize, bottom = top + rows * cellSize;
  const clipLeft = Math.max(left, frame.x ?? left), clipTop = Math.max(top, frame.y ?? top);
  const clipRight = Math.min(right, frame.width == null ? right : offsetX + frame.width);
  const clipBottom = Math.min(bottom, frame.height == null ? bottom : offsetY + frame.height);
  const firstCol = Math.max(0, Math.ceil((clipLeft - left) / cellSize));
  const lastCol = Math.min(columns, Math.floor((clipRight - left) / cellSize));
  const firstRow = Math.max(0, Math.ceil((clipTop - top) / cellSize));
  const lastRow = Math.min(rows, Math.floor((clipBottom - top) / cellSize));
  const snapX = x => offsetX + Math.round((x - offsetX) * scale) / scale;
  const snapY = y => offsetY + Math.round((y - offsetY) * scale) / scale;
  // At a tiny overview, a second edge would consume most of each bead. Readable
  // zoom levels get a light side on dark colors and a dark side on light colors.
  const paired = cellSize * scale >= 6;
  function lines(color, shift, width, major = false) {
    context.fillStyle = color; context.beginPath();
    for (let col = firstCol; col <= lastCol; col++) {
      if (major && (col === 0 || col === columns || col % 10)) continue;
      context.rect(snapX(left + col * cellSize) + shift, snapY(clipTop), width, snapY(clipBottom) - snapY(clipTop));
    }
    for (let row = firstRow; row <= lastRow; row++) {
      if (major && (row === 0 || row === rows || row % 10)) continue;
      context.rect(snapX(clipLeft), snapY(top + row * cellSize) + shift, snapX(clipRight) - snapX(clipLeft), width);
    }
    context.fill();
  }
  if (paired) lines('#ffffffb8', -pixel, pixel);
  lines(paired ? '#50425b9e' : '#65597070', 0, pixel);
  const majorPixels = Math.max(1, Math.round(1.25 * scale));
  const majorShift = -Math.floor(majorPixels / 2) * pixel;
  if (paired) lines('#ffffffb8', majorShift - pixel, (majorPixels + 2) * pixel, true);
  lines('#a85e87', majorShift, majorPixels * pixel, true);
}

/** Pure geometry, shared by the renderer and regression tests. End indices are inclusive. */
export function computePatternViewport({ columns, rows, cellSize, ruler = 23, viewportX = 0, viewportY = 0, viewportWidth, viewportHeight, dpr = 1, overscan = 40 }) {
  if (![columns, rows, cellSize, ruler, viewportWidth, viewportHeight].every(Number.isFinite)
    || columns < 1 || rows < 1 || cellSize <= 0 || ruler < 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;
  const paperWidth = columns * cellSize + 2 * ruler;
  const paperHeight = rows * cellSize + 2 * ruler;
  const visibleX = Math.max(0, viewportX), visibleY = Math.max(0, viewportY);
  const visibleRight = Math.min(paperWidth, viewportX + viewportWidth);
  const visibleBottom = Math.min(paperHeight, viewportY + viewportHeight);
  if (visibleRight <= visibleX || visibleBottom <= visibleY) return null;
  const x = Math.max(0, Math.floor(visibleX - overscan));
  const y = Math.max(0, Math.floor(visibleY - overscan));
  const right = Math.min(paperWidth, Math.ceil(visibleRight + overscan));
  const bottom = Math.min(paperHeight, Math.ceil(visibleBottom + overscan));
  const width = right - x, height = bottom - y;
  // The pixel budget is a final guard for unusually large windows. Typical views use full DPR.
  let scale = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 2, MAX_BACKING_SIDE / width, MAX_BACKING_SIDE / height, Math.sqrt(MAX_BACKING_PIXELS / (width * height)));
  let pixelWidth = Math.max(1, Math.ceil(width * scale));
  let pixelHeight = Math.max(1, Math.ceil(height * scale));
  if (pixelWidth * pixelHeight > MAX_BACKING_PIXELS) {
    scale *= Math.sqrt(MAX_BACKING_PIXELS / (pixelWidth * pixelHeight)) * .9999;
    pixelWidth = Math.max(1, Math.ceil(width * scale));
    pixelHeight = Math.max(1, Math.ceil(height * scale));
  }
  const visible = { x: visibleX, y: visibleY, width: visibleRight - visibleX, height: visibleBottom - visibleY };
  return {
    paperWidth, paperHeight, x, y, width, height, scale, pixelWidth, pixelHeight, visible,
    startColumn: clamp(Math.floor((x - ruler) / cellSize), 0, columns - 1),
    endColumn: clamp(Math.ceil((right - ruler) / cellSize) - 1, 0, columns - 1),
    startRow: clamp(Math.floor((y - ruler) / cellSize), 0, rows - 1),
    endRow: clamp(Math.ceil((bottom - ruler) / cellSize) - 1, 0, rows - 1),
    stickyTop: visibleY > 0 && visibleY < paperHeight - ruler,
    stickyLeft: visibleX > 0 && visibleX < paperWidth - ruler
  };
}

function contrast(hex) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? [...value].map(c => c + c).join('') : value;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  return r * .299 + g * .587 + b * .114 > 150 ? '#302b33' : '#ffffff';
}

function doneFingerprint(done) {
  let xor = 0, sum = 0;
  for (const index of done) {
    let mixed = (index + 1) | 0;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
    mixed = (mixed ^ (mixed >>> 16)) >>> 0;
    xor ^= mixed; sum = (sum + mixed) >>> 0;
  }
  return `${done.size}:${xor >>> 0}:${sum}`;
}

function sameKey(a, b) {
  return a && Object.keys(b).every(key => a[key] === b[key]);
}

export function createPatternRenderer(canvas, area, stage) {
  const document = canvas.ownerDocument;
  const window = document.defaultView || globalThis;
  const context = canvas.getContext('2d');
  const baseCanvas = document.createElement('canvas');
  const base = baseCanvas.getContext('2d');
  if (!context || !base) throw new Error('当前浏览器不支持图纸绘制，请使用新版浏览器。');
  const paper = document.createElement('div');
  paper.className = 'pattern-virtual-paper';
  Object.assign(paper.style, { position: 'relative', flexShrink: '0', background: '#fff', boxShadow: '0 5px 22px #4e3a6320' });
  stage.insertBefore(paper, canvas);
  paper.appendChild(canvas);
  Object.assign(canvas.style, { position: 'absolute', display: 'block', boxShadow: 'none', maxWidth: 'none', maxHeight: 'none' });
  let latest = null, scheduled = null, baseKey = null, stylePalette = null, styles = new Map();
  const requestFrame = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame.bind(window) : callback => setTimeout(callback, 0);
  const cancelFrame = typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame.bind(window) : clearTimeout;

  function measure(state = latest) {
    if (!state?.pattern) return null;
    const areaRect = area.getBoundingClientRect(), paperRect = paper.getBoundingClientRect();
    return computePatternViewport({ columns: state.pattern.width, rows: state.pattern.height, cellSize: state.cellSize, ruler: state.ruler,
      viewportX: areaRect.left + area.clientLeft - paperRect.left, viewportY: areaRect.top + area.clientTop - paperRect.top,
      viewportWidth: area.clientWidth, viewportHeight: area.clientHeight, dpr: window.devicePixelRatio || 1 });
  }

  function resizeBitmap(target, frame) {
    // Assigning an unchanged canvas dimension still clears/reallocates it; avoid that on hover.
    if (target.width !== frame.pixelWidth) target.width = frame.pixelWidth;
    if (target.height !== frame.pixelHeight) target.height = frame.pixelHeight;
  }

  function updateStyles(palette) {
    if (stylePalette === palette) return;
    stylePalette = palette;
    styles = new Map(palette.map(color => [color.code, { hex: color.hex, text: contrast(color.hex) }]));
  }

  function grid(context, state, frame) {
    const { pattern, cellSize, ruler, view } = state;
    if (!state.showGrid || view !== 'grid') return;
    drawBeadGrid(context, { columns: pattern.width, rows: pattern.height, cellSize, left: ruler, top: ruler }, frame);
  }

  function paintBase(state, frame) {
    const { pattern, cellSize: size, ruler, view, highlighted } = state;
    const labelStep = rulerLabelStep(size);
    const done = state.done || EMPTY_DONE, showCodes = state.showCodes && view === 'grid';
    base.setTransform(frame.scale, 0, 0, frame.scale, -frame.x * frame.scale, -frame.y * frame.scale);
    base.globalAlpha = 1; base.fillStyle = '#ffffff'; base.fillRect(frame.x, frame.y, frame.width, frame.height);
    base.textAlign = 'center'; base.textBaseline = 'middle';
    for (let row = frame.startRow; row <= frame.endRow; row++) for (let col = frame.startColumn; col <= frame.endColumn; col++) {
      const index = row * pattern.width + col, code = pattern.cells[index];
      if (code == null) continue;
      const color = styles.get(code) || { hex: '#ccc', text: '#302b33' }, x = ruler + col * size, y = ruler + row * size;
      base.globalAlpha = highlighted && code !== highlighted ? .12 : 1;
      base.fillStyle = color.hex;
      if (view === 'bead') {
        base.beginPath(); base.arc(x + size / 2, y + size / 2, size * .46, 0, Math.PI * 2); base.fill();
        base.fillStyle = '#ffffffaa'; base.beginPath(); base.arc(x + size / 2, y + size / 2, size * .14, 0, Math.PI * 2); base.fill();
      } else {
        base.fillRect(x, y, size + .2, size + .2);
        if (showCodes && size >= 12) { base.fillStyle = color.text; base.font = `500 ${Math.min(11, size * .31)}px 'Noto Sans SC',sans-serif`; base.fillText(code, x + size / 2, y + size / 2, size - 2); }
      }
      if (done.has(index)) {
        base.fillStyle = '#ffffffb0'; base.fillRect(x, y, size, size);
        if (size >= 8) { base.fillStyle = '#586c50'; base.font = `bold ${size * .65}px sans-serif`; base.fillText('✓', x + size / 2, y + size / 2); }
      }
    }
    base.globalAlpha = 1;
    grid(base, state, frame);
    base.lineWidth = .7; base.strokeStyle = '#c4b8ce'; base.strokeRect(ruler, ruler, pattern.width * size, pattern.height * size);
    base.font = '9px sans-serif'; base.fillStyle = '#a89bae';
    for (let col = frame.startColumn; col <= frame.endColumn; col++) if (col === 0 || (col + 1) % labelStep === 0) {
      const x = ruler + (col + .5) * size;
      base.fillText(col + 1, x, ruler / 2); base.fillText(col + 1, x, frame.paperHeight - ruler / 2);
    }
    for (let row = frame.startRow; row <= frame.endRow; row++) if (row === 0 || (row + 1) % labelStep === 0) {
      const y = ruler + (row + .5) * size;
      base.fillText(row + 1, ruler / 2, y); base.fillText(row + 1, frame.paperWidth - ruler / 2, y);
    }
  }

  function paintStickyRulers(state, frame) {
    const { cellSize: size, ruler } = state, visible = frame.visible, band = Math.max(0, ruler - 2);
    const labelStep = rulerLabelStep(size);
    context.globalAlpha = 1; context.fillStyle = '#ffffff';
    if (frame.stickyTop) context.fillRect(visible.x, visible.y, visible.width, band);
    if (frame.stickyLeft) context.fillRect(visible.x, visible.y, band, visible.height);
    context.font = '9px sans-serif'; context.fillStyle = '#a89bae'; context.textAlign = 'center'; context.textBaseline = 'middle';
    if (frame.stickyTop) for (let col = frame.startColumn; col <= frame.endColumn; col++) if (col === 0 || (col + 1) % labelStep === 0) {
      const x = ruler + (col + .5) * size;
      if (!frame.stickyLeft || x >= visible.x + band) context.fillText(col + 1, x, visible.y + band / 2);
    }
    if (frame.stickyLeft) for (let row = frame.startRow; row <= frame.endRow; row++) if (row === 0 || (row + 1) % labelStep === 0) {
      const y = ruler + (row + .5) * size;
      if (!frame.stickyTop || y >= visible.y + band) context.fillText(row + 1, visible.x + band / 2, y);
    }
  }

  function paintFocus(state, frame) {
    const focus = state.hovered >= 0 ? state.hovered : state.selected;
    if (!(focus >= 0 && focus < state.pattern.cells.length)) return;
    const { pattern, cellSize: size, ruler } = state, col = focus % pattern.width, row = Math.floor(focus / pattern.width);
    const x = ruler + col * size, y = ruler + row * size, visible = frame.visible, band = Math.max(0, ruler - 2);
    const clipLeft = Math.max(ruler, frame.stickyLeft ? visible.x + band : frame.x);
    const clipTop = Math.max(ruler, frame.stickyTop ? visible.y + band : frame.y);
    const clipRight = Math.min(ruler + pattern.width * size, frame.x + frame.width);
    const clipBottom = Math.min(ruler + pattern.height * size, frame.y + frame.height);
    context.save(); context.beginPath(); context.rect(clipLeft, clipTop, Math.max(0, clipRight - clipLeft), Math.max(0, clipBottom - clipTop)); context.clip();
    context.fillStyle = '#8e68b31c'; context.fillRect(ruler, y, pattern.width * size, size); context.fillRect(x, ruler, size, pattern.height * size);
    context.strokeStyle = '#8662ad'; context.lineWidth = 1.5; context.strokeRect(x + .5, y + .5, size - 1, size - 1); context.restore();
    context.fillStyle = '#80609f';
    const labelTop = frame.stickyTop ? visible.y : 0, labelLeft = frame.stickyLeft ? visible.x : 0;
    if (!frame.stickyLeft || x + size > visible.x + band) context.fillRect(Math.max(x, frame.stickyLeft ? visible.x + band : x), labelTop, Math.max(0, x + size - Math.max(x, frame.stickyLeft ? visible.x + band : x)), band);
    if (!frame.stickyTop || y + size > visible.y + band) context.fillRect(labelLeft, Math.max(y, frame.stickyTop ? visible.y + band : y), band, Math.max(0, y + size - Math.max(y, frame.stickyTop ? visible.y + band : y)));
    context.fillStyle = '#ffffff'; context.font = `${Math.min(10, size * .85)}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
    if (!frame.stickyLeft || x + size / 2 >= visible.x + band) context.fillText(col + 1, x + size / 2, labelTop + band / 2);
    if (!frame.stickyTop || y + size / 2 >= visible.y + band) context.fillText(row + 1, labelLeft + band / 2, y + size / 2);
  }

  function paint() {
    scheduled = null;
    if (!latest?.pattern) return;
    const frame = measure();
    if (!frame) { canvas.style.display = 'none'; return; }
    const state = latest;
    canvas.style.display = 'block'; canvas.style.left = `${frame.x}px`; canvas.style.top = `${frame.y}px`;
    canvas.style.width = `${frame.width}px`; canvas.style.height = `${frame.height}px`;
    resizeBitmap(canvas, frame); resizeBitmap(baseCanvas, frame); updateStyles(state.palette);
    const key = { cells: state.pattern.cells, palette: state.palette, columns: state.pattern.width, rows: state.pattern.height, size: state.cellSize, ruler: state.ruler,
      view: state.view, codes: state.showCodes, grid: state.showGrid, highlighted: state.highlighted, done: doneFingerprint(state.done || EMPTY_DONE),
      x: frame.x, y: frame.y, width: frame.width, height: frame.height, scale: frame.scale };
    if (!sameKey(baseKey, key)) { paintBase(state, frame); baseKey = key; }
    context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1; context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(baseCanvas, 0, 0);
    context.setTransform(frame.scale, 0, 0, frame.scale, -frame.x * frame.scale, -frame.y * frame.scale);
    paintStickyRulers(state, frame); paintFocus(state, frame);
  }

  function schedule() { if (scheduled === null) scheduled = requestFrame(paint); }
  area.addEventListener('scroll', schedule, { passive: true });
  const Observer = window.ResizeObserver || globalThis.ResizeObserver;
  const observer = typeof Observer === 'function' ? new Observer(schedule) : null;
  observer?.observe(area);

  return {
    render(state) {
      latest = state;
      if (!state?.pattern) return;
      paper.style.width = `${state.pattern.width * state.cellSize + 2 * state.ruler}px`;
      paper.style.height = `${state.pattern.height * state.cellSize + 2 * state.ruler}px`;
      schedule();
    },
    hitTest(event) {
      if (!latest?.pattern) return -1;
      const rect = paper.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const { pattern, cellSize, ruler } = latest, frame = measure(), band = Math.max(0, ruler - 2);
      if (frame && ((frame.stickyTop && y >= frame.visible.y && y < frame.visible.y + band)
        || (frame.stickyLeft && x >= frame.visible.x && x < frame.visible.x + band))) return -1;
      const col = Math.floor((x - ruler) / cellSize), row = Math.floor((y - ruler) / cellSize);
      return col >= 0 && col < pattern.width && row >= 0 && row < pattern.height ? row * pattern.width + col : -1;
    },
    cellCenter(index) {
      if (!latest?.pattern || !Number.isInteger(index) || index < 0 || index >= latest.pattern.cells.length) return null;
      const rect = paper.getBoundingClientRect(), areaRect = area.getBoundingClientRect();
      return { x: rect.left - areaRect.left - area.clientLeft + area.scrollLeft + latest.ruler + (index % latest.pattern.width + .5) * latest.cellSize,
        y: rect.top - areaRect.top - area.clientTop + area.scrollTop + latest.ruler + (Math.floor(index / latest.pattern.width) + .5) * latest.cellSize };
    },
    destroy() { if (scheduled !== null) cancelFrame(scheduled); scheduled = null; observer?.disconnect(); area.removeEventListener('scroll', schedule); }
  };
}
