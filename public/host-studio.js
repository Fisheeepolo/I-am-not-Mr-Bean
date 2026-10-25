import { parsePalette } from './palette-import.js';

const STORAGE_KEY = 'bead-studio-host-colors-v1';
const copy = value => structuredClone(value);
const fallbackEscape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validName = value => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('名称请输入 1–60 个字符，不可包含换行。');
  return name;
};
const defaultId = () => 'shop-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
const normalizeColors = colors => {
  if (!Array.isArray(colors) || colors.length > 1000) throw new Error('每份色卡最多保存 1000 种颜色。');
  if (!colors.length) return [];
  const palette = parsePalette(JSON.stringify({ name: '店家色卡', colors }), 'colors.json');
  return palette.colors.map((color, index) => {
    if (colors[index].available !== undefined && typeof colors[index].available !== 'boolean') throw new Error('颜色可用状态必须为 true 或 false。');
    if ((color.name || '').length > 60) throw new Error('色名最多 60 个字符。');
    return { ...color, name: color.name || '', available: colors[index].available !== false };
  });
};
function normalizeShop(shop) {
  if (!shop || !/^shop-[A-Za-z0-9-]{1,90}$/.test(shop.id || '')) throw new Error('店家色卡编号无效。');
  return { id: shop.id, name: validName(shop.name), revision: Number.isInteger(shop.revision) && shop.revision > 0 ? shop.revision : 1,
    isDemo: shop.isDemo === true, colors: normalizeColors(shop.colors), updatedAt: typeof shop.updatedAt === 'string' ? shop.updatedAt : '' };
}
function initialShop() {
  return { id: 'shop-demo', name: '演示小店', revision: 1, isDemo: true, updatedAt: new Date().toISOString(), colors: [
    ['DEMO01', '#FFFFFF', '白'], ['DEMO02', '#24212B', '墨黑'], ['DEMO03', '#EB7750', '橘红'],
    ['DEMO04', '#FFC86A', '暖黄'], ['DEMO05', '#78543D', '棕'], ['DEMO06', '#F5D9B6', '奶油'],
    ['DEMO07', '#CF3655', '莓红'], ['DEMO08', '#91B77B', '草绿'], ['DEMO09', '#4E8D76', '深绿'],
    ['DEMO10', '#64B6D4', '湖蓝'], ['DEMO11', '#8B6EB7', '紫'], ['DEMO12', '#F2A2BC', '粉']
  ].map(([code, hex, name]) => ({ code, hex, name, available: true })) };
}

/** Local demo catalogue. Writes commit only after storage succeeds. */
export function createHostStore(options = {}) {
  let storage;
  try { storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage; } catch {}
  const now = options.now || (() => new Date().toISOString());
  const id = options.id || defaultId;
  let shops = [], error = '', readBlocked = false;
  const persist = next => {
    if (readBlocked) throw new Error(error);
    if (!storage?.setItem) throw new Error('当前浏览器无法保存店家色卡，输入内容已保留，请允许本机存储后重试。');
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, shops: next })); }
    catch { throw new Error('店家色卡保存失败，输入内容已保留。请检查浏览器存储空间后重试。'); }
    shops = next; error = '';
  };
  function reload() {
    let raw;
    try { raw = storage?.getItem(STORAGE_KEY); }
    catch { readBlocked = true; error = '店家色卡读取失败，请刷新后重试。已有色卡未被改动。'; return; }
    if (raw == null) {
      shops = [initialShop()]; readBlocked = false;
      try { persist(shops); } catch (failure) { error = failure.message; }
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.shops) || data.shops.length > 10) throw new Error();
      const next = data.shops.map(normalizeShop);
      if (new Set(next.map(shop => shop.id)).size !== next.length) throw new Error();
      shops = next; error = ''; readBlocked = false;
    } catch { readBlocked = true; error = '店家色卡读取失败，请刷新后重试。已有色卡未被改动。'; }
  }
  const find = shopId => {
    const shop = shops.find(value => value.id === shopId);
    if (!shop) throw new Error('找不到这份店家色卡，请重新选择。');
    return shop;
  };
  const revise = (shopId, change) => {
    const old = find(shopId), next = normalizeShop({ ...copy(old), ...change, revision: old.revision + 1, updatedAt: now() });
    persist(shops.map(shop => shop.id === shopId ? next : shop));
    return copy(next);
  };
  reload();
  return {
    reload, getError: () => error,
    listShops: () => copy(shops),
    getShop: shopId => { const shop = shops.find(value => value.id === shopId); return shop ? copy(shop) : null; },
    getAvailablePalette(shopId) {
      const shop = find(shopId), colors = shop.colors.filter(color => color.available);
      if (!colors.length) throw new Error(shop.colors.length ? '这份店家色卡暂时全部缺货，请先在东道主启用颜色。' : '这份店家色卡还没有颜色，请先在东道主补充颜色。');
      return { name: shop.name + (shop.isDemo ? ' · 演示色卡' : ' · 店家色卡'), colors: copy(colors).map(({ available, ...color }) => color) };
    },
    createShop(name, colors = [], isDemo = false) {
      if (shops.length >= 10) throw new Error('最多保存 10 份店家色卡，请先整理已有色卡。');
      const shop = normalizeShop({ id: id(), name, colors, isDemo, revision: 1, updatedAt: now() });
      if (shops.some(value => value.id === shop.id)) throw new Error('色卡编号重复，请重试。');
      persist([...shops, shop]); return copy(shop);
    },
    renameShop(shopId, name) { return revise(shopId, { name: validName(name) }); },
    deleteShop(shopId) { find(shopId); persist(shops.filter(shop => shop.id !== shopId)); },
    saveColor(shopId, value, originalCode = null) {
      const shop = find(shopId);
      if (originalCode != null && !shop.colors.some(color => color.code === originalCode)) throw new Error('待修改的颜色已不存在，请重新打开。');
      const color = normalizeColors([value])[0];
      if (shop.colors.some(existing => existing.code === color.code && existing.code !== originalCode)) throw new Error(`色号「${color.code}」已存在，请修改已有颜色或使用其他编号。`);
      const colors = originalCode == null ? [...shop.colors, color] : shop.colors.map(existing => existing.code === originalCode ? color : existing);
      return revise(shopId, { colors });
    },
    setAvailability(shopId, code, available) {
      if (typeof available !== 'boolean') throw new Error('颜色可用状态无效。');
      const shop = find(shopId);
      if (!shop.colors.some(color => color.code === code)) throw new Error('找不到这个色号。');
      return revise(shopId, { colors: shop.colors.map(color => color.code === code ? { ...color, available } : color) });
    },
    deleteColor(shopId, code) {
      const shop = find(shopId);
      if (!shop.colors.some(color => color.code === code)) throw new Error('找不到这个色号。');
      return revise(shopId, { colors: shop.colors.filter(color => color.code !== code) });
    },
    importShop(text, filename) {
      const imported = parsePalette(text, filename);
      // JSON exports preserve availability; CSV imports begin with every colour enabled.
      let rawColors;
      if (/\.json$/i.test(filename || '') || /^\s*[\[{]/.test(text)) {
        const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
        rawColors = Array.isArray(raw) ? raw : raw.colors;
      }
      const colors = imported.colors.map((color, index) => ({ ...color, available: rawColors?.[index]?.available ?? true }));
      return this.createShop(imported.name, colors);
    }
  };
}

/** App-owned dialogs keep forms open, including input values, when a save fails. */
export function createHostStudio({ container, modal, closeModal, toast, escapeHTML = fallbackEscape, downloadText, onChange = () => {}, storage } = {}) {
  if (!container) throw new Error('东道主界面缺少容器。');
  const store = createHostStore(storage === undefined ? {} : { storage });
  const doc = container.ownerDocument;
  const byId = id => doc.getElementById(id);
  let selectedId = store.listShops()[0]?.id || '', query = '', importing = false;
  const notify = () => { try { onChange(store.listShops()); } catch (failure) { console.error(failure); } };
  const safeError = failure => failure?.message || '操作没有完成，请重试。';
  const fieldError = failure => { const line = byId('hostFormError'); if (line) { line.hidden = false; line.textContent = safeError(failure); } else toast(safeError(failure)); };
  const finish = message => { render(); closeModal(); notify(); toast(message); };
  const commonError = '<p id="hostFormError" class="host-form-error" role="alert" hidden></p>';
  const buttons = submit => `<div class="modal-buttons"><button id="hostCancel" type="button" class="button quiet">取消</button><button type="submit" class="button primary">${submit}</button></div>`;
  function shopForm(shop = null) {
    modal(shop ? '修改店家色卡名称' : '新建店家色卡', `<form id="hostShopForm" class="host-form"><label>色卡名称<input id="hostShopName" maxlength="60" required value="${escapeHTML(shop?.name || '')}" placeholder="例如：桃子拼豆店"></label>${commonError}${buttons('保存色卡')}</form>`, '东道主');
    byId('hostCancel').onclick = closeModal;
    byId('hostShopName').focus();
    byId('hostShopForm').onsubmit = event => { event.preventDefault(); try { const saved = shop ? store.renameShop(shop.id, byId('hostShopName').value) : store.createShop(byId('hostShopName').value); selectedId = saved.id; finish('店家色卡已保存。'); } catch (failure) { fieldError(failure); } };
  }
  function colorForm(code = null) {
    const shop = store.getShop(selectedId); if (!shop) return;
    const color = shop.colors.find(value => value.code === code);
    modal(color ? '编辑颜色信息' : '补充一种颜色', `<form id="hostColorForm" class="host-form"><div class="host-form-columns"><label>色号<input id="hostColorCode" maxlength="20" required value="${escapeHTML(color?.code || '')}" placeholder="店家的真实编号"></label><label>色名<input id="hostColorName" maxlength="60" value="${escapeHTML(color?.name || '')}" placeholder="可选"></label></div><label>颜色<div class="host-hex-fields"><input id="hostColorPicker" type="color" value="${color?.hex || '#A881D0'}" aria-label="选择颜色"><input id="hostColorHex" type="text" maxlength="7" required pattern="#[0-9a-fA-F]{6}" value="${color?.hex || '#A881D0'}" aria-label="颜色 HEX" placeholder="#A881D0"></div></label><label class="host-check"><input id="hostColorAvailable" type="checkbox" ${color?.available === false ? '' : 'checked'}>买家可使用这个颜色</label>${commonError}${buttons('保存颜色')}</form>`, shop.name);
    byId('hostCancel').onclick = closeModal;
    byId('hostColorPicker').oninput = event => { byId('hostColorHex').value = event.target.value.toUpperCase(); };
    byId('hostColorHex').oninput = event => { if (/^#[0-9a-fA-F]{6}$/.test(event.target.value)) byId('hostColorPicker').value = event.target.value; };
    byId('hostColorCode').focus();
    byId('hostColorForm').onsubmit = event => { event.preventDefault(); try { store.saveColor(shop.id, { code: byId('hostColorCode').value, name: byId('hostColorName').value, hex: byId('hostColorHex').value, available: byId('hostColorAvailable').checked }, color?.code ?? null); finish('颜色已保存，买家可使用更新后的色卡。'); } catch (failure) { fieldError(failure); } };
  }
  function deleteForm(kind, code = null) {
    const shop = store.getShop(selectedId); if (!shop) return;
    const name = kind === 'shop' ? shop.name : code;
    modal(kind === 'shop' ? '删除这份店家色卡？' : '删除这个颜色？', `<form id="hostDeleteForm" class="host-form"><p>确认删除「${escapeHTML(name)}」？已有图纸和拼豆记录会保留原来的颜色。</p>${commonError}<div class="modal-buttons"><button id="hostCancel" type="button" class="button quiet">取消</button><button type="submit" class="button host-danger">确认删除</button></div></form>`, '东道主');
    byId('hostCancel').onclick = closeModal;
    byId('hostCancel').focus();
    byId('hostDeleteForm').onsubmit = event => { event.preventDefault(); try { if (kind === 'shop') { store.deleteShop(shop.id); selectedId = store.listShops()[0]?.id || ''; } else store.deleteColor(shop.id, code); finish(kind === 'shop' ? '店家色卡已删除。' : '颜色已删除。'); } catch (failure) { fieldError(failure); } };
  }
  async function importFile(file) {
    if (!file || importing) return;
    importing = true;
    try {
      if (!/\.(csv|json)$/i.test(file.name)) throw new Error('请选择 CSV 或 JSON 色卡文件。');
      if (file.size > 1024 * 1024) throw new Error('色卡文件请控制在 1 MB 以内。');
      const text = await file.text();
      // Parse before opening the review form, retaining valid file content for retries.
      const parsed = parsePalette(text, file.name);
      modal('保存上传的店家色卡', `<form id="hostImportForm" class="host-form"><label>色卡名称<input id="hostImportName" maxlength="60" required value="${escapeHTML(parsed.name)}"></label><p>${parsed.colors.length} 种颜色 · 保存为一份新的店家色卡</p>${commonError}${buttons('保存色卡')}</form>`, '东道主');
      byId('hostCancel').onclick = closeModal;
      byId('hostImportForm').onsubmit = event => { event.preventDefault(); try {
        const name = validName(byId('hostImportName').value);
        let originalRows;
        if (/\.json$/i.test(file.name)) { const raw = JSON.parse(text.replace(/^\uFEFF/, '')); originalRows = Array.isArray(raw) ? raw : raw.colors; }
        const colors = parsed.colors.map((color, index) => ({ ...color, available: originalRows?.[index]?.available ?? true }));
        const shop = store.createShop(name, colors); selectedId = shop.id; query = ''; finish('上传的色卡已保存。');
      } catch (failure) { fieldError(failure); } };
    } catch (failure) { toast(safeError(failure)); }
    finally { importing = false; }
  }
  function render() {
    const shops = store.listShops();
    if (!shops.some(shop => shop.id === selectedId)) selectedId = shops[0]?.id || '';
    const shop = store.getShop(selectedId), available = shop?.colors.filter(color => color.available).length || 0;
    const visibleColors = (shop?.colors || []).filter(color => (color.code + ' ' + color.name).toLowerCase().includes(query.toLowerCase()));
    const status = store.getError();
    container.innerHTML = `<div class="host-heading"><div><h1>东道主 <span class="host-demo-tag">演示</span></h1><p>店家维护颜色，买家制作图纸时选择这份色卡。</p></div><div class="host-top-actions"><button data-host-action="template" class="button quiet">色卡模板</button><button data-host-action="import" class="button quiet">上传色卡</button><button data-host-action="new" class="button primary">＋ 新建色卡</button></div></div><p class="host-demo-note">同一项目内演示，色卡保存在当前浏览器。DEMO 编号仅为演示，不是品牌色号。</p>${status ? `<p class="host-storage-error" role="alert">${escapeHTML(status)}</p>` : ''}<input id="hostPaletteFile" type="file" accept=".csv,.json" hidden>${shops.length ? `<div class="host-toolbar"><label class="host-shop-field"><span>店家色卡</span><select id="hostShopSelect" aria-label="选择店家色卡">${shops.map(value => `<option value="${escapeHTML(value.id)}" ${value.id === selectedId ? 'selected' : ''}>${escapeHTML(value.name)}${value.isDemo ? ' · 演示' : ''}</option>`).join('')}</select></label><span class="host-availability">${available} / ${shop.colors.length} 色可用</span><div class="host-shop-actions"><button data-host-action="rename" class="text-button">改名</button><button data-host-action="export" class="text-button" ${shop.colors.length ? '' : 'disabled'}>导出</button><button data-host-action="delete-shop" class="text-button host-danger-text">删除色卡</button></div></div><div class="host-color-toolbar"><label class="host-search"><span aria-hidden="true">⌕</span><input id="hostColorSearch" type="search" placeholder="搜索色号或色名" aria-label="搜索店家颜色" value="${escapeHTML(query)}"></label><button data-host-action="add-color" class="button primary">＋ 补充颜色</button></div>${!shop.colors.length ? '<p class="host-no-colors">这份色卡还没有颜色，先补充一种颜色。</p>' : !available ? '<p class="host-no-colors">当前全部颜色均为缺货。启用颜色后，买家才可使用这份色卡。</p>' : ''}<div class="host-color-grid">${visibleColors.map(color => `<article class="host-color-card ${color.available ? '' : 'is-unavailable'}"><button class="host-color-edit" data-host-edit="${escapeHTML(color.code)}" aria-label="编辑颜色 ${escapeHTML(color.code)}"><span class="host-color-swatch" style="background:${color.hex}"></span><span class="host-color-description"><strong>${escapeHTML(color.code)}</strong><span>${escapeHTML(color.name || color.hex)}</span><small>${color.hex}</small></span></button><div class="host-color-bottom"><label class="host-color-toggle"><input type="checkbox" data-host-toggle="${escapeHTML(color.code)}" ${color.available ? 'checked' : ''} aria-label="${escapeHTML(color.code)} 可用"><span>${color.available ? '可用' : '缺货'}</span></label><button class="host-color-delete" data-host-delete="${escapeHTML(color.code)}" title="删除颜色" aria-label="删除颜色 ${escapeHTML(color.code)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></button></div></article>`).join('') || (query ? '<p class="host-search-empty">没有找到这个色号或色名。</p>' : '')}</div>` : '<div class="host-empty"><p>还没有店家色卡</p><button data-host-action="new" class="button primary">新建色卡</button></div>'}`;
    byId('hostPaletteFile').onchange = event => { const file = event.target.files[0]; event.target.value = ''; importFile(file); };
    if (byId('hostShopSelect')) byId('hostShopSelect').onchange = event => { selectedId = event.target.value; query = ''; render(); };
    if (byId('hostColorSearch')) byId('hostColorSearch').oninput = event => {
      query = event.target.value; const selection = event.target.selectionStart; render(); const field = byId('hostColorSearch'); field.focus(); if (selection != null) try { field.setSelectionRange(selection, selection); } catch {}
    };
  }
  container.addEventListener('click', event => {
    const action = event.target.closest('[data-host-action]')?.dataset.hostAction;
    if (action === 'new') shopForm();
    if (action === 'rename') shopForm(store.getShop(selectedId));
    if (action === 'add-color') colorForm();
    if (action === 'delete-shop') deleteForm('shop');
    if (action === 'import') byId('hostPaletteFile').click();
    if (action === 'template') downloadText('店家色卡-模板.csv', 'code,hex,name\nSAMPLE01,#FFFFFF,白色\nSAMPLE02,#242424,黑色\nSAMPLE03,#FFAA55,橘色', 'text/csv;charset=utf-8', true);
    if (action === 'export') { const shop = store.getShop(selectedId); if (shop) downloadText(shop.name + '-色卡.json', JSON.stringify({ name: shop.name, colors: shop.colors }, null, 2), 'application/json'); }
    const edit = event.target.closest('[data-host-edit]'), remove = event.target.closest('[data-host-delete]');
    if (edit) colorForm(edit.dataset.hostEdit);
    if (remove) deleteForm('color', remove.dataset.hostDelete);
  });
  container.addEventListener('change', event => {
    const toggle = event.target.closest('[data-host-toggle]'); if (!toggle) return;
    try { store.setAvailability(selectedId, toggle.dataset.hostToggle, toggle.checked); render(); notify(); }
    catch (failure) { toggle.checked = !toggle.checked; toast(safeError(failure)); }
  });
  return { render, listShops: store.listShops, getShop: store.getShop, getAvailablePalette: store.getAvailablePalette,
    refresh() { store.reload(); render(); notify(); } };
}
