/** Local-only drawing library. Original images stay in this browser's IndexedDB. */
const DATABASE_NAME = 'bead-studio-library-v1';
const DATABASE_VERSION = 2;
const PROJECT_STORE = 'projects';
const SUMMARY_STORE = 'summaries';
const TOMBSTONE_STORE = 'deletedProjects';
let databasePromise = null;

function storageError(error, action = '保存') {
  if (error?.name === 'ProjectStateError') return error;
  if (error?.name === 'QuotaExceededError') return new Error('本机仓库空间不足，未能保存。请先导出图纸备份，再释放浏览器存储空间。');
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return new Error('浏览器禁止了本机存储，请允许此网站保存数据后重试。');
  if (error?.name === 'InvalidStateError' || error?.name === 'VersionError') return new Error('仓库连接已更新，请刷新页面后重试。');
  return new Error(`图纸仓库${action}失败，请重试；当前图纸仍可导出备份。`);
}

function projectStateError(message, code) {
  const error = new Error(message);
  error.name = 'ProjectStateError';
  error.code = code;
  return error;
}

export function normalizeProjectName(value) {
  if (typeof value !== 'string') throw new Error('请输入图纸名称。');
  const name = value.trim();
  if (!name) throw new Error('图纸名称不能为空。');
  if (name.length > 80) throw new Error('图纸名称不能超过 80 个字符。');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('图纸名称不能包含换行或控制字符。');
  return name;
}

function validId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('图纸编号无效。');
  return id;
}

export function newProjectId() {
  if (globalThis.crypto?.randomUUID) return 'drawing-' + globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return 'drawing-' + [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('当前浏览器无法创建图纸编号，请使用新版浏览器。');
}

/** Pure, exported for validation tests. This never embeds the original image Blob. */
export function createProjectSummary(record) {
  validId(record?.id);
  const project = record.project;
  if (!project || !Number.isInteger(project.width) || !Number.isInteger(project.height) || project.width < 8 || project.height < 8 || project.width > 160 || project.height > 160) throw new Error('图纸宽高须为 8–160 的整数。');
  if (!Array.isArray(project.cells) || project.cells.length !== project.width * project.height) throw new Error('图纸格子数量与尺寸不一致。');
  if (!project.palette || !Array.isArray(project.palette.colors)) throw new Error('图纸缺少色卡，无法保存。');
  const codes = new Set(project.palette.colors.map(color => color.code));
  const used = new Set();
  let totalBeads = 0;
  for (const code of project.cells) {
    if (code === null) continue;
    if (typeof code !== 'string' || !codes.has(code)) throw new Error('图纸包含未定义的色号，无法保存。');
    totalBeads++;
    used.add(code);
  }
  const completed = project.done ?? [];
  if (!Array.isArray(completed) || completed.some(index => !Number.isInteger(index) || index < 0 || index >= project.cells.length || project.cells[index] === null)) throw new Error('图纸的已拼进度无效。');
  const name = String(record.name || project.projectName || '未命名图纸').trim().slice(0, 80) || '未命名图纸';
  return {
    id: record.id,
    name,
    width: project.width,
    height: project.height,
    totalBeads,
    colorCount: used.size,
    doneCount: new Set(completed).size,
    thumbnail: typeof record.thumbnail === 'string' ? record.thumbnail : '',
    paletteName: String(project.palette.name || '自定义色卡'),
    isDemo: project.isDemo === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasSource: record.sourceBlob instanceof Blob
  };
}

export function openLibrary() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) return Promise.reject(new Error('当前浏览器不支持本机图纸仓库，请使用新版浏览器。'));
  databasePromise = new Promise((resolve, reject) => {
    let request;
    let abandoned = false;
    try { request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION); }
    catch (error) { reject(storageError(error, '打开')); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(SUMMARY_STORE)) database.createObjectStore(SUMMARY_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(TOMBSTONE_STORE)) database.createObjectStore(TOMBSTONE_STORE, { keyPath: 'id' });
    };
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('其他旧页面阻止了仓库更新，请关闭其他豆豆工坊页面后重试。'));
    };
    request.onerror = () => reject(storageError(request.error, '打开'));
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => { database.close(); databasePromise = null; };
      database.onclose = () => { databasePromise = null; };
      resolve(database);
    };
  });
  // Allow retries after a blocked, disabled or interrupted opening attempt.
  databasePromise = databasePromise.catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}

export async function listProjects() {
  const database = await openLibrary();
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = database.transaction(SUMMARY_STORE, 'readonly'); }
    catch (error) { reject(storageError(error, '读取')); return; }
    const request = transaction.objectStore(SUMMARY_STORE).getAll();
    let summaries = [];
    request.onsuccess = () => { summaries = request.result; };
    transaction.oncomplete = () => resolve(summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id)));
    transaction.onabort = () => reject(storageError(transaction.error || request.error, '读取'));
    transaction.onerror = () => {};
  });
}

export async function getProject(id) {
  validId(id);
  const database = await openLibrary();
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = database.transaction(PROJECT_STORE, 'readonly'); }
    catch (error) { reject(storageError(error, '读取')); return; }
    const request = transaction.objectStore(PROJECT_STORE).get(id);
    let result = null;
    request.onsuccess = () => {
      result = request.result || null;
      if (result && !Object.hasOwn(result, 'originalBlob')) {
        result.originalBlob = result.sourceBlob ?? null;
        result.originalName = result.sourceName || '';
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(storageError(transaction.error || request.error, '读取'));
    transaction.onerror = () => {};
  });
}

/** Resolves only after both the complete drawing and its lightweight card commit. */
export async function saveProject(input) {
  let record;
  try {
    validId(input?.id);
    if (input.sourceBlob != null && !(input.sourceBlob instanceof Blob)) throw new Error('原图数据无效，请重新选择图片。');
    if (input.originalBlob != null && !(input.originalBlob instanceof Blob)) throw new Error('原始照片数据无效，请重新选择图片。');
    // Capture an independent snapshot before waiting for the database to open.
    record = {
      id: input.id,
      name: input.name,
      createdAt: input.createdAt,
      updatedAt: new Date().toISOString(),
      project: JSON.parse(JSON.stringify(input.project)),
      sourceBlob: input.sourceBlob ?? null,
      sourceName: String(input.sourceName || '').slice(0, 300),
      originalBlob: Object.hasOwn(input, 'originalBlob') ? input.originalBlob ?? null : input.sourceBlob ?? null,
      originalName: String(Object.hasOwn(input, 'originalName') ? input.originalName || '' : input.sourceName || '').slice(0, 300),
      thumbnail: typeof input.thumbnail === 'string' ? input.thumbnail : ''
    };
    createProjectSummary(record);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Error('图纸数据无效，无法保存到仓库。');
    throw error;
  }
  const database = await openLibrary();
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = database.transaction([PROJECT_STORE, SUMMARY_STORE, TOMBSTONE_STORE], 'readwrite'); }
    catch (error) { reject(storageError(error)); return; }
    const projectStore = transaction.objectStore(PROJECT_STORE);
    const summaryStore = transaction.objectStore(SUMMARY_STORE);
    const deleted = transaction.objectStore(TOMBSTONE_STORE).get(record.id);
    let summary, caughtError;
    deleted.onsuccess = () => {
      if (deleted.result) {
        caughtError = projectStateError('这份图纸已被删除，不能继续保存。请返回仓库新建图纸。', 'PROJECT_DELETED');
        transaction.abort();
        return;
      }
      const prior = summaryStore.get(record.id);
      prior.onsuccess = () => {
        try {
          const proposedCreatedAt = typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toISOString() : record.updatedAt;
          record.createdAt = prior.result?.createdAt || proposedCreatedAt;
          summary = createProjectSummary(record);
          record.name = summary.name;
          projectStore.put(record);
          summaryStore.put(summary);
        } catch (error) { caughtError = error; transaction.abort(); }
      };
    };
    transaction.oncomplete = () => resolve(summary);
    transaction.onabort = () => reject(storageError(caughtError || transaction.error || deleted.error));
    transaction.onerror = () => {};
  });
}

/** Renames both the full drawing and its card in one transaction. */
export async function renameProject(id, value) {
  validId(id);
  const name = normalizeProjectName(value);
  const database = await openLibrary();
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = database.transaction([PROJECT_STORE, SUMMARY_STORE, TOMBSTONE_STORE], 'readwrite'); }
    catch (error) { reject(storageError(error, '重命名')); return; }
    const projects = transaction.objectStore(PROJECT_STORE);
    const summaries = transaction.objectStore(SUMMARY_STORE);
    const deleted = transaction.objectStore(TOMBSTONE_STORE).get(id);
    let summary, caughtError;
    deleted.onsuccess = () => {
      if (deleted.result) {
        caughtError = projectStateError('这份图纸已被删除，无法重命名。', 'PROJECT_DELETED');
        transaction.abort();
        return;
      }
      const request = projects.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          caughtError = projectStateError('这份图纸不存在，无法重命名。', 'PROJECT_NOT_FOUND');
          transaction.abort();
          return;
        }
        try {
          record.name = name;
          record.project.projectName = name;
          record.updatedAt = new Date().toISOString();
          summary = createProjectSummary(record);
          projects.put(record);
          summaries.put(summary);
        } catch (error) { caughtError = error; transaction.abort(); }
      };
    };
    transaction.oncomplete = () => resolve(summary);
    transaction.onabort = () => reject(storageError(caughtError || transaction.error || deleted.error, '重命名'));
    transaction.onerror = () => {};
  });
}

/** Call only after the UI has confirmed deletion. A tombstone rejects stale autosaves. */
export async function deleteProject(id) {
  validId(id);
  const database = await openLibrary();
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = database.transaction([PROJECT_STORE, SUMMARY_STORE, TOMBSTONE_STORE], 'readwrite'); }
    catch (error) { reject(storageError(error, '删除')); return; }
    const projects = transaction.objectStore(PROJECT_STORE);
    const summaries = transaction.objectStore(SUMMARY_STORE);
    const originalCount = projects.count(id);
    const summaryCount = summaries.count(id);
    let existed = false;
    originalCount.onsuccess = () => { existed ||= originalCount.result > 0; };
    summaryCount.onsuccess = () => { existed ||= summaryCount.result > 0; };
    transaction.objectStore(TOMBSTONE_STORE).put({ id, deletedAt: new Date().toISOString() });
    projects.delete(id);
    summaries.delete(id);
    transaction.oncomplete = () => resolve(existed);
    transaction.onabort = () => reject(storageError(transaction.error || originalCount.error || summaryCount.error, '删除'));
    transaction.onerror = () => {};
  });
}
