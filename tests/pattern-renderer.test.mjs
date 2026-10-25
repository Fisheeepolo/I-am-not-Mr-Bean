import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computePatternViewport, createPatternRenderer, drawBeadGrid, rulerLabelStep } from '../public/pattern-renderer.js';
import { makeDemo } from '../public/engine.js';

const palette = JSON.parse(await readFile(new URL('../public/palette.json', import.meta.url), 'utf8')).colors;
const baseArgs = { columns: 160, rows: 160, cellSize: 42, ruler: 23, viewportWidth: 800, viewportHeight: 600, dpr: 2 };

// Sample the renderer's actual rectangle paths with source-over compositing.
// Boundary pixels must remain visible on pale and dark beads; centers stay unpainted.
function gridRecording() {
  let path = [];
  return { fills: [], beginPath() { path = []; }, rect(...rect) { path.push(rect); },
    fill() { this.fills.push({ color: this.fillStyle, rects: path }); } };
}
function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function sampleGrid(recording, x, y, background) {
  let result = rgb(background);
  for (const fill of recording.fills) if (fill.rects.some(([left, top, width, height]) => x >= left && x < left + width && y >= top && y < top + height)) {
    const opacity = fill.color.length === 9 ? parseInt(fill.color.slice(7, 9), 16) / 255 : 1;
    result = rgb(fill.color).map((v, i) => v * opacity + result[i] * (1 - opacity));
  }
  return result;
}
function luminance(rgb) {
  const channels = rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrastRatio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
for (const scale of [1, 1.25, 2]) for (const size of [9.37, 24, 42]) {
  const recorded = gridRecording();
  const frame = { x: 8.3, y: 11.4, width: 520, height: 420, scale };
  drawBeadGrid(recorded, { columns: 25, rows: 25, cellSize: size, left: 23, top: 31 }, frame);
  for (const fill of recorded.fills) for (const [x, y, width, height] of fill.rects) {
    for (const value of [(x - frame.x) * scale, (y - frame.y) * scale, width * scale, height * scale]) {
      assert(Math.abs(value - Math.round(value)) < 1e-8, 'Grid edges align to physical pixels, including fractional zoom and scroll');
    }
  }
  const boundary = frame.x + Math.round((23 + 3 * size - frame.x) * scale) / scale;
  const sampleY = 31 + 3.5 * size;
  for (const background of ['#ffffff', '#000000', '#888888', '#4b2b1c', '#d5724a', '#f5e39c']) {
    const a = sampleGrid(recorded, boundary - .5 / scale, sampleY, background);
    const b = sampleGrid(recorded, boundary + .5 / scale, sampleY, background);
    assert(Math.max(contrastRatio(a, rgb(background)), contrastRatio(b, rgb(background))) >= 1.7, `A small-cell boundary remains visible on ${background}`);
    assert.deepEqual(sampleGrid(recorded, 23 + 3.5 * size, sampleY, background), rgb(background), 'Grid does not obscure the bead center or its code');
  }
}
console.log('PASS small-grid contrast across light/dark beads; pixel-aligned fractional zoom; bead centers remain clear');

assert.equal(rulerLabelStep(1.3), 20);
assert.equal(rulerLabelStep(.9), 30);
assert.equal(rulerLabelStep(3), 10);
assert.equal(rulerLabelStep(24), 1);
for (const size of [.5, .9, 1, 1.3, 2, 2.6, 3, 10, 23]) {
  const step = rulerLabelStep(size);
  const labels = Array.from({ length: 160 }, (_, index) => index).filter(index => index === 0 || (index + 1) % step === 0);
  assert.equal(labels[0], 0, 'The first coordinate remains visible');
  for (let i = 2; i < labels.length; i++) assert((labels[i] - labels[i - 1]) * size >= 26 - 1e-9, 'Regular axis labels remain at least 26 CSS pixels apart');
  if (labels.length > 1) assert((labels[1] - labels[0]) * size >= 23, 'The short first coordinate has sufficient separation');
}
console.log('PASS adaptive ruler spacing: mobile fit is sparse; zoomed views retain every coordinate');

const first = computePatternViewport(baseArgs);
assert.equal(first.paperWidth, 6766);
assert.equal(first.paperHeight, 6766);
assert(first.width <= 880 && first.height <= 680);
assert(first.pixelWidth * first.pixelHeight < 2_500_000);
assert.equal(first.stickyTop, false); assert.equal(first.stickyLeft, false);
const middle = computePatternViewport({ ...baseArgs, viewportX: 3000, viewportY: 3000 });
assert(middle.startColumn > 60 && middle.endColumn < 100);
assert(middle.startRow > 60 && middle.endRow < 100);
assert.equal(middle.stickyTop, true); assert.equal(middle.stickyLeft, true);
const last = computePatternViewport({ ...baseArgs, viewportX: 6500, viewportY: 6500 });
assert.equal(last.x + last.width, last.paperWidth);
assert.equal(last.y + last.height, last.paperHeight);
assert.equal(last.endColumn, 159); assert.equal(last.endRow, 159);
const centered = computePatternViewport({ ...baseArgs, columns: 32, rows: 32, cellSize: 10, viewportX: -200, viewportY: -100 });
assert.equal(centered.x, 0); assert.equal(centered.y, 0); assert.equal(centered.width, 366); assert.equal(centered.height, 366);
assert.equal(centered.scale, 2);
assert.equal(computePatternViewport({ ...baseArgs, viewportWidth: 0 }), null);
assert.equal(computePatternViewport({ ...baseArgs, viewportX: 7000 }), null);
const huge = computePatternViewport({ ...baseArgs, viewportWidth: 12000, viewportHeight: 12000, dpr: 4 });
assert(huge.pixelWidth <= 4096 && huge.pixelHeight <= 4096);
assert(huge.pixelWidth * huge.pixelHeight <= 8 * 1024 * 1024);
console.log('PASS viewport geometry: fit, centered, scrolled, edge, hidden and extreme dimensions');

// Counting contexts execute the real renderer without allocating raster memory.
// These are draw-call/buffer-dimension checks, not real browser frame-rate measurements.
const callbacks = new Map(); let nextFrame = 1;
const canvases = [];
function context() {
  const calls = Object.create(null);
  const events = [];
  const ctx = new Proxy({ calls, events }, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => { calls[name] = (calls[name] || 0) + 1; events.push({ name, args, fill: target.fillStyle, stroke: target.strokeStyle, alpha: target.globalAlpha }); };
  } });
  return ctx;
}
let area;
const document = { defaultView: {
  devicePixelRatio: 2,
  requestAnimationFrame(callback) { const id = nextFrame++; callbacks.set(id, callback); return id; },
  cancelAnimationFrame(id) { callbacks.delete(id); },
  ResizeObserver: class { observe() {} disconnect() {} }
}, createElement(tag) {
  if (tag === 'canvas') {
    const ctx = context(); let width = 300, height = 150;
    const canvas = { ownerDocument: document, style: {}, dataset: {}, dimensionWrites: 0, getContext: () => ctx,
      get width() { return width; }, get height() { return height; },
      set width(value) { this.dimensionWrites++; width = value; }, set height(value) { this.dimensionWrites++; height = value; }
    };
    canvases.push(canvas); return canvas;
  }
  return { style: {}, appendChild(child) { child.parentNode = this; }, getBoundingClientRect() {
    return { left: 24 - area.scrollLeft, top: 24 - area.scrollTop, width: parseFloat(this.style.width), height: parseFloat(this.style.height) };
  } };
} };
area = { clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
  events: {}, addEventListener(name, callback) { this.events[name] = callback; }, removeEventListener(name) { delete this.events[name]; },
  getBoundingClientRect: () => ({ left: 0, top: 0 })
};
const canvas = document.createElement('canvas');
const stage = { insertBefore(paper) { this.paper = paper; } };
const renderer = createPatternRenderer(canvas, area, stage);
const pattern = makeDemo(160, 160, palette);
const state = { pattern, palette, cellSize: 42, ruler: 23, view: 'grid', showCodes: true, showGrid: true, done: new Set(), highlighted: null, hovered: -1, selected: -1 };
function flush() { for (const [id, callback] of callbacks) { callbacks.delete(id); callback(); } }
renderer.render(state); flush();
assert.equal(stage.paper.style.width, '6766px');
assert.equal(stage.paper.style.height, '6766px');
assert(canvas.width < 1800 && canvas.height < 1400);
const initialDimensions = canvases.map(c => c.dimensionWrites);
const baseContext = canvases[1].getContext('2d');
const originalBaseText = baseContext.calls.fillText || 0, originalBaseRects = baseContext.calls.fillRect || 0;
const originalBaseFills = baseContext.calls.fill || 0;
for (let i = 0; i < 8; i++) renderer.render({ ...state, hovered: i });
assert.equal(callbacks.size, 1, 'Rapid hover updates are coalesced into one animation frame');
flush();
assert.deepEqual(canvases.map(c => c.dimensionWrites), initialDimensions, 'Hover must not resize either bitmap');
assert.equal(baseContext.calls.fillText || 0, originalBaseText, 'Hover reuses the cached base text');
assert.equal(baseContext.calls.fillRect || 0, originalBaseRects, 'Hover reuses the cached base beads');
assert.equal(baseContext.calls.fill || 0, originalBaseFills, 'Hover reuses the cached grid paths');
assert.equal(canvas.getContext('2d').calls.drawImage, 2, 'One visible base copy per presented frame');
console.log('PASS hover rendering: one scheduled frame, no dimension resets and no bead/code redraw');

area.scrollLeft = 2500; area.scrollTop = 2700; area.events.scroll(); flush();
const afterScrollRects = baseContext.calls.fillRect || 0, afterScrollText = baseContext.calls.fillText || 0;
assert(afterScrollRects > originalBaseRects);
assert(afterScrollRects - originalBaseRects < 500, 'Only visible bead rows/columns are drawn after scrolling');
const beforeDone = afterScrollRects;
const visibleIndex = 68 * 160 + 65;
state.done.add(visibleIndex); renderer.render(state); flush();
assert((baseContext.calls.fillRect || 0) > beforeDone, 'In-place progress changes invalidate the base cache');
const center = renderer.cellCenter(visibleIndex);
assert.deepEqual(center, { x: 24 + 23 + 65.5 * 42, y: 24 + 23 + 68.5 * 42 });
assert.equal(renderer.hitTest({ clientX: center.x - area.scrollLeft, clientY: center.y - area.scrollTop }), visibleIndex);
assert.equal(renderer.hitTest({ clientX: 200, clientY: 10 }), -1, 'Sticky top ruler must not select the covered bead');
assert.equal(renderer.hitTest({ clientX: 10, clientY: 200 }), -1, 'Sticky left ruler must not select the covered bead');
assert.equal(renderer.cellCenter(-1), null);
console.log('PASS scroll culling, progress-cache invalidation, coordinate mapping and ruler hit exclusion');

renderer.render({ ...state, highlighted: pattern.cells[visibleIndex] }); flush();
const afterHighlight = baseContext.calls.fillRect || 0;
assert(afterHighlight > beforeDone);
renderer.render({ ...state, palette: [...palette] }); flush();
assert((baseContext.calls.fillRect || 0) > afterHighlight, 'Changed palette invalidates colors');
const largeVisibleBitmap = { width: canvas.width, height: canvas.height, rgbaMiBPerCanvas: +(canvas.width * canvas.height * 4 / 1048576).toFixed(2) };

area.scrollLeft = 0; area.scrollTop = 0;
const whiteState = { ...state, pattern: { width: 2, height: 2, cells: [null, 'W', 'K', 'W'] },
  palette: [{ code: 'W', hex: '#ffffff' }, { code: 'K', hex: '#111111' }], cellSize: 24,
  showGrid: false, showCodes: false, done: new Set(), highlighted: null };
let eventStart = baseContext.events.length;
renderer.render(whiteState); flush();
let events = baseContext.events.slice(eventStart);
assert(events.some(event => event.name === 'fillRect' && event.fill === '#eef0f3' && event.args[0] === 23 && event.args[1] === 23), 'Null is a tinted square even when codes and grid are off');
assert(events.some(event => event.name === 'fillRect' && event.fill === '#ffffff' && event.args[0] === 47 && event.args[1] === 23), 'White bead keeps its actual white fill');
assert(!events.some(event => event.name === 'fillText' && event.args[0] === 'W'), 'Codes remain optional');
eventStart = baseContext.events.length;
renderer.render({ ...whiteState, showCodes: true, highlighted: 'K' }); flush();
events = baseContext.events.slice(eventStart);
assert.equal(events.filter(event => event.name === 'fillText' && event.args[0] === 'W' && event.fill === '#302b33').length, 2, 'Every real white bead has a dark readable code');
assert(events.some(event => event.name === 'fillRect' && event.fill === '#eef0f3' && event.alpha === 1), 'Highlighting never fades the empty-cell tint');
eventStart = baseContext.events.length;
renderer.render({ ...whiteState, view: 'bead' }); flush();
events = baseContext.events.slice(eventStart);
assert.equal(events.filter(event => event.name === 'stroke' && event.stroke === '#aeb5bf').length, 2, 'White bead circles have visible edges in the finished preview');
assert(canvas.width <= 188 && canvas.height <= 188, 'White/empty differentiation still uses only the bounded visible bitmap');
console.log('PASS empty-cell tint vs true white bead; dark white-bead codes; pale-bead preview outlines; bounded bitmap');
renderer.destroy(); assert.equal(area.events.scroll, undefined);
console.log(JSON.stringify({ fixture: '160×160 makeDemo with actual MARD 291 palette', measurement: 'Counting contexts, not browser FPS',
  visibleBitmap: largeVisibleBitmap,
  scrolledBaseCalls: { fillRect: afterScrollRects - originalBaseRects, fillText: afterScrollText - originalBaseText },
  fullOldBitmapMiB: 698.53 }, null, 2));
console.log('All pattern renderer tests passed.');
