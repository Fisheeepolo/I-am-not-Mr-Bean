import { segmentBackground } from './background-segmentation.js';

const FULL = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const MODES = ['auto', 'box', 'whole'];
const MIN_SPAN = .002;
let nextEditor = 1;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = value => Math.round(value * 1e6) / 1e6;

function parseRegion(region) {
  if (typeof region === 'string') { try { region = JSON.parse(region); } catch { return null; } }
  return region && ['x', 'y', 'width', 'height'].every(key => region[key] !== null && region[key] !== '' && Number.isFinite(Number(region[key]))) ? region : null;
}
function normalize(region) {
  region = parseRegion(region);
  if (!region) return { ...FULL };
  const x = round(clamp(Number(region.x), 0, 1 - MIN_SPAN)), y = round(clamp(Number(region.y), 0, 1 - MIN_SPAN));
  return { x, y, width: round(clamp(Number(region.width), MIN_SPAN, 1 - x)), height: round(clamp(Number(region.height), MIN_SPAN, 1 - y)) };
}

function alphaBounds(data, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!data[(y * width + x) * 4 + 3]) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  // Guard against small thumbnail/segmentation discrepancies. This is a region
  // proposal; alpha and foreground detail are never erased in this module.
  const padX = Math.max(1, Math.ceil((right - left + 1) * .025));
  const padY = Math.max(1, Math.ceil((bottom - top + 1) * .025));
  left = Math.max(0, left - padX); top = Math.max(0, top - padY);
  right = Math.min(width - 1, right + padX); bottom = Math.min(height - 1, bottom + padY);
  return normalize({ x: left / width, y: top / height, width: (right - left + 1) / width, height: (bottom - top + 1) / height });
}

/** A transparent, correctable traditional foreground proposal, not semantics. */
export function createSubjectEditor({ container, onChange = () => {} }) {
  if (!container) throw new Error('主体范围容器不存在');
  const document = container.ownerDocument, id = `subject-editor-${nextEditor++}`;
  container.classList.add('subject-editor');
  container.innerHTML = `<div class="subject-heading"><strong>主体范围</strong><div class="subject-modes" role="group" aria-label="选择主体范围方式"><button type="button" data-subject-mode="auto">自动</button><button type="button" data-subject-mode="box">框选</button><button type="button" data-subject-mode="whole">整图</button></div></div><div class="subject-preview"><canvas tabindex="0" role="img" aria-label="原图主体范围，可拖动框选" aria-describedby="${id}-hint"></canvas></div><div class="subject-region-fields" aria-label="手动修正主体范围">${[['x', '左侧'], ['y', '顶部'], ['width', '宽度'], ['height', '高度']].map(([key, name]) => `<label><span>${name}</span><input type="number" data-region="${key}" min="${key === 'x' || key === 'y' ? 0 : .2}" max="100" step="0.1" aria-label="主体范围${name}百分比"><span>%</span></label>`).join('')}</div><p id="${id}-hint" class="subject-hint" aria-live="polite"></p>`;
  const canvas = container.querySelector('canvas'), context = canvas.getContext('2d');
  const original = document.createElement('canvas'), originalContext = original.getContext('2d', { willReadFrequently: true });
  const hint = container.querySelector('.subject-hint'), fields = [...container.querySelectorAll('[data-region]')];
  let imageKey = null, hasImage = false, subjectMode = 'whole', boxRegion = { ...FULL }, autoRegion = { ...FULL }, autoReason = 'uncertain';
  let drag = null, boxEntryState = null;

  const getRegion = () => ({ ...(subjectMode === 'whole' ? FULL : subjectMode === 'auto' ? autoRegion : boxRegion) });
  const getState = () => ({ subjectMode, subjectRegion: JSON.stringify(getRegion()) });
  const notify = previous => { if (JSON.stringify(previous) !== JSON.stringify(getState())) onChange(getState()); };

  function paint() {
    if (!hasImage || !context) return;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height); context.fillStyle = '#eef0f3'; context.fillRect(0, 0, width, height);
    context.drawImage(original, 0, 0);
    const region = getRegion(), x = region.x * width, y = region.y * height, w = region.width * width, h = region.height * height;
    context.fillStyle = '#30243b72';
    context.fillRect(0, 0, width, y); context.fillRect(0, y + h, width, height - y - h);
    context.fillRect(0, y, x, h); context.fillRect(x + w, y, width - x - w, h);
    context.setLineDash([]); context.strokeStyle = '#ffffff'; context.lineWidth = 3; context.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    context.strokeStyle = '#7652ab'; context.lineWidth = 1.5; context.setLineDash([6, 3]); context.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2)); context.setLineDash([]);
  }

  function refresh(editingField = null) {
    container.hidden = !hasImage;
    for (const button of container.querySelectorAll('[data-subject-mode]')) {
      const active = button.dataset.subjectMode === subjectMode;
      button.setAttribute('aria-pressed', String(active)); button.classList.toggle('active', active);
    }
    const region = getRegion();
    for (const field of fields) if (field !== editingField) field.value = String(Math.round(region[field.dataset.region] * 1000) / 10);
    hint.textContent = subjectMode === 'whole' ? '保留整张图片；也可以拖动框选主体。' : subjectMode === 'box' ? '拖动或输入百分比修正；Esc 取消本次框选。' : autoReason === 'alpha' ? '' : autoReason === 'segmented' ? '已找到候选范围，请检查后继续。' : '未能可靠区分主体，可框选范围。';
    hint.hidden = !hint.textContent;
    paint();
  }

  function cancelDrag() {
    if (!drag) return false;
    const { previous, pointerId } = drag;
    drag = null;
    try { if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId); } catch {}
    subjectMode = previous.subjectMode; boxRegion = normalize(previous.subjectRegion); refresh(); return true;
  }

  function setState(state = {}) {
    cancelDrag();
    subjectMode = MODES.includes(state.subjectMode) ? state.subjectMode : 'whole';
    boxRegion = normalize(state.subjectRegion);
    // A saved auto crop is part of the drawing, not a request to infer it again.
    // Restore it both before and after image decode. When no saved region is
    // supplied (new import), retain the proposal computed by setImage instead.
    if (subjectMode === 'auto' && parseRegion(state.subjectRegion)) autoRegion = normalize(state.subjectRegion);
    boxEntryState = null; refresh();
  }

  function setImage(image) {
    const key = image ? image.currentSrc || image.src || image : null;
    if (key === imageKey && hasImage === !!image) { refresh(); return; }
    cancelDrag(); imageKey = key; hasImage = false; autoRegion = { ...FULL }; autoReason = 'uncertain';
    const imageWidth = image?.naturalWidth || image?.width || 0, imageHeight = image?.naturalHeight || image?.height || 0;
    if (!imageWidth || !imageHeight || !context || !originalContext) { refresh(); return; }
    const scale = Math.min(1, 512 / Math.max(imageWidth, imageHeight));
    original.width = canvas.width = Math.max(1, Math.round(imageWidth * scale));
    original.height = canvas.height = Math.max(1, Math.round(imageHeight * scale));
    originalContext.clearRect(0, 0, original.width, original.height);
    originalContext.drawImage(image, 0, 0, original.width, original.height); hasImage = true;
    try {
      const pixels = originalContext.getImageData(0, 0, original.width, original.height);
      let hasAlpha = false;
      for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] < 255) { hasAlpha = true; break; }
      if (hasAlpha) {
        const bounds = alphaBounds(pixels.data, original.width, original.height);
        if (bounds) { autoRegion = bounds; autoReason = 'alpha'; }
      } else {
        const segmented = segmentBackground(pixels, original.width, original.height, { mode: 'edge', scale: 1 });
        if (segmented.diagnostics.status === 'segmented') {
          const bounds = alphaBounds(segmented.data, original.width, original.height);
          if (bounds) { autoRegion = bounds; autoReason = 'segmented'; }
        }
      }
    } catch { autoRegion = { ...FULL }; autoReason = 'uncertain'; }
    refresh();
  }

  for (const button of container.querySelectorAll('[data-subject-mode]')) button.addEventListener('click', () => {
    cancelDrag(); const previous = getState(), next = button.dataset.subjectMode;
    if (next === 'box' && subjectMode !== 'box') { boxEntryState = previous; boxRegion = getRegion(); }
    subjectMode = next; if (next === 'whole') boxRegion = { ...FULL };
    refresh(); notify(previous);
  });
  for (const input of fields) {
    const applyValue = finalize => {
      const previous = getState(), value = Number(input.value), dimension = input.dataset.region;
      const valid = input.value.trim() !== '' && Number.isFinite(value) && value >= 0
        && ((dimension !== 'width' && dimension !== 'height') || value > 0);
      // Empty strings and a leading zero are ordinary intermediate edits. Keep
      // the last valid crop until the user finishes typing instead of snapping
      // the input back mid-keystroke or briefly creating a zero-sized crop.
      if (!valid) { if (finalize) refresh(); return; }
      if (subjectMode !== 'box') boxEntryState = previous;
      boxRegion = normalize({ ...getRegion(), [dimension]: value / 100 }); subjectMode = 'box';
      refresh(finalize ? null : input); notify(previous);
    };
    input.addEventListener('input', () => applyValue(false));
    input.addEventListener('change', () => applyValue(true));
    input.addEventListener('blur', () => refresh());
  }
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1), y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1) };
  };
  canvas.addEventListener('pointerdown', event => {
    if (!hasImage || event.button !== 0 || drag) return;
    event.preventDefault(); canvas.focus();
    const previous = getState(); drag = { pointerId: event.pointerId, start: point(event), previous };
    try { canvas.setPointerCapture(event.pointerId); } catch {}
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = point(event), start = drag.start;
    boxRegion = normalize({ x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y) });
    subjectMode = 'box'; refresh();
  });
  canvas.addEventListener('pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = point(event), { start, previous, pointerId } = drag, rect = canvas.getBoundingClientRect();
    if (Math.abs(current.x - start.x) * rect.width < 2 || Math.abs(current.y - start.y) * rect.height < 2) { cancelDrag(); return; }
    boxRegion = normalize({ x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y) });
    subjectMode = 'box'; drag = null; boxEntryState = previous;
    try { if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId); } catch {}
    refresh(); notify(previous);
  });
  canvas.addEventListener('pointercancel', cancelDrag);
  canvas.addEventListener('lostpointercapture', () => { if (drag) cancelDrag(); });
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (cancelDrag()) return;
    if (subjectMode === 'box' && boxEntryState) { const previous = getState(), restored = boxEntryState; setState(restored); notify(previous); }
  });
  refresh();
  return { setImage, setState, getState, getRegion };
}
