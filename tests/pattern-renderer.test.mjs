import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computePatternViewport, createPatternRenderer, rulerLabelStep } from '../public/pattern-renderer.js';
import { makeDemo } from '../public/engine.js';

const palette = JSON.parse(await readFile(new URL('../public/palette.json', import.meta.url), 'utf8')).colors;
const baseArgs = { columns: 160, rows: 160, cellSize: 42, ruler: 23, viewportWidth: 800, viewportHeight: 600, dpr: 2 };

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
  const ctx = new Proxy({ calls }, { get(target, name) {
    if (name in target) return target[name];
    return (..._args) => { calls[name] = (calls[name] || 0) + 1; };
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
for (let i = 0; i < 8; i++) renderer.render({ ...state, hovered: i });
assert.equal(callbacks.size, 1, 'Rapid hover updates are coalesced into one animation frame');
flush();
assert.deepEqual(canvases.map(c => c.dimensionWrites), initialDimensions, 'Hover must not resize either bitmap');
assert.equal(baseContext.calls.fillText || 0, originalBaseText, 'Hover reuses the cached base text');
assert.equal(baseContext.calls.fillRect || 0, originalBaseRects, 'Hover reuses the cached base beads');
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
renderer.destroy(); assert.equal(area.events.scroll, undefined);
console.log(JSON.stringify({ fixture: '160×160 makeDemo with actual MARD 291 palette', measurement: 'Counting contexts, not browser FPS',
  visibleBitmap: { width: canvas.width, height: canvas.height, rgbaMiBPerCanvas: +(canvas.width * canvas.height * 4 / 1048576).toFixed(2) },
  scrolledBaseCalls: { fillRect: afterScrollRects - originalBaseRects, fillText: afterScrollText - originalBaseText },
  fullOldBitmapMiB: 698.53 }, null, 2));
console.log('All pattern renderer tests passed.');
