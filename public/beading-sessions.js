/** Independent craft records. Drawing snapshots remain intact when a design changes. */
const DATABASE = 'bead-studio-sessions-v1';
const JOURNAL_PREFIX = 'bead-studio-session-journal:';
const LEASE_MS = 15000;
const copy = value => structuredClone(value);
const iso = now => new Date(now).toISOString();
const stateKeys = ['id', 'status', 'elapsedMs', 'startedAt', 'completedAt', 'updatedAt', 'done', 'epoch', 'sequence', 'owner', 'leaseUntil'];
let databasePromise;

function error(message, code = 'SESSION_STORAGE') { return Object.assign(new Error(message), { code }); }
function safeStorage() { try { return globalThis.localStorage; } catch { return null; } }
function validId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw error('拼豆记录编号无效。'); return id; }
function newId() { return 'craft-' + globalThis.crypto.randomUUID(); }
function doneFor(project, indices) {
  if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= project.cells.length || project.cells[index] === null)) throw error('拼豆标记无效，请重新打开这份记录。');
  return [...new Set(indices)];
}
function patternKey(project) { return JSON.stringify([project.width, project.height, project.cells, project.palette.colors.map(c => [c.code, c.hex])]); }
export function projectFingerprint(project) {
  const value = patternKey(project); let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `${value.length}-${(hash >>> 0).toString(36)}`;
}
function join(snapshot, state) { return snapshot && state ? { ...snapshot, ...state, project: { ...snapshot.project, done: [...state.done] } } : null; }
function stateOf(record) { return Object.fromEntries(stateKeys.map(key => [key, record[key]])); }
function snapshotOf(record) { const value = { ...record, project: { ...record.project, done: [] } }; for (const key of stateKeys) if (key !== 'id') delete value[key]; return value; }

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(error('当前浏览器不支持保存拼豆记录。')); return; }
    const request = indexedDB.open(DATABASE, 1); let abandoned = false;
    request.onupgradeneeded = () => { for (const name of ['snapshots', 'activity']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' }); };
    request.onblocked = () => { abandoned = true; reject(error('请关闭其他旧页面后重新打开拼豆记录。')); };
    request.onerror = () => reject(error('无法打开拼豆记录，请检查浏览器存储权限。'));
    request.onsuccess = () => {
      const db = request.result; if (abandoned) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = null; };
      db.onclose = () => { databasePromise = null; }; resolve(db);
    };
  }).catch(cause => { databasePromise = null; throw cause; });
  return databasePromise;
}
export async function closeSessionDB() { if (databasePromise) (await databasePromise).close(); databasePromise = null; }

function indexedBackend() {
  async function transaction(mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      let result, caught, tx;
      try { tx = db.transaction(['snapshots', 'activity'], mode); action(tx, value => { result = value; }, cause => { caught = cause; tx.abort(); }); }
      catch (cause) { reject(cause); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(caught || error(tx.error?.name === 'QuotaExceededError' ? '本机空间不足，拼豆记录未能保存。' : '拼豆记录保存失败，请重试。'));
      tx.onerror = () => {};
    });
  }
  return {
    create: record => transaction('readwrite', (tx, finish) => { tx.objectStore('snapshots').add(snapshotOf(record)); tx.objectStore('activity').add(stateOf(record)); finish(record); }),
    get: id => transaction('readonly', (tx, finish) => { const a = tx.objectStore('snapshots').get(id); a.onsuccess = () => { const b = tx.objectStore('activity').get(id); b.onsuccess = () => finish(join(a.result, b.result)); }; }),
    list: () => transaction('readonly', (tx, finish) => { const a = tx.objectStore('snapshots').getAll(); a.onsuccess = () => { const b = tx.objectStore('activity').getAll(); b.onsuccess = () => { const states = new Map(b.result.map(value => [value.id, value])); finish(a.result.map(value => join(value, states.get(value.id))).filter(Boolean)); }; }; }),
    update: (id, mutate) => transaction('readwrite', (tx, finish, fail) => {
      const a = tx.objectStore('snapshots').get(id); a.onsuccess = () => { const b = tx.objectStore('activity').get(id); b.onsuccess = () => {
        try { const original = join(a.result, b.result); if (!original) throw error('这份拼豆记录不存在。'); const updated = mutate(original); tx.objectStore('activity').put(stateOf(updated)); finish(updated); } catch (cause) { fail(cause); }
      }; };
    })
  };
}

/** The backend only supplies atomic read/update; recovery and ownership rules are shared with tests. */
export function createBeadingSessionStore({ backend = indexedBackend(), storage = safeStorage(), now = () => Date.now(), id = newId } = {}) {
  const key = record => JOURNAL_PREFIX + record.id + ':' + record.epoch;
  function recover(record) {
    if (!record || record.status === 'completed') return record;
    try {
      const saved = JSON.parse(storage?.getItem(key(record)) || 'null');
      if (saved?.id !== record.id || saved.epoch !== record.epoch || !Number.isSafeInteger(saved.sequence) || saved.sequence <= record.sequence || !Number.isFinite(saved.elapsedMs) || saved.elapsedMs < record.elapsedMs || saved.elapsedMs > 365 * 86400000) return record;
      const done = doneFor(record.project, saved.done);
      return { ...record, elapsedMs: saved.elapsedMs, done, sequence: saved.sequence, updatedAt: saved.updatedAt, project: { ...record.project, done } };
    } catch { return record; }
  }
  function journal(record) {
    if (!storage || record.status === 'completed') return false;
    storage.setItem(key(record), JSON.stringify({ id: record.id, epoch: record.epoch, sequence: record.sequence, elapsedMs: record.elapsedMs, done: record.done, updatedAt: record.updatedAt }));
    return true;
  }
  function removeJournal(record) { try { storage?.removeItem(key(record)); } catch {} }
  function checkOwner(record, owner, epoch) { if (record.owner !== owner || record.epoch !== epoch) throw error('这份记录已在另一个页面继续计时，请重新打开。', 'SESSION_LOST'); }
  function applyPatch(record, patch) {
    if (patch.sequence > record.sequence) {
      const done = doneFor(record.project, patch.done);
      return { ...record, elapsedMs: Math.max(record.elapsedMs, patch.elapsedMs), sequence: patch.sequence, done, project: { ...record.project, done }, updatedAt: iso(now()) };
    }
    return record;
  }
  const api = {
    async create(input) {
      const project = copy(input.project);
      if (!Number.isInteger(project?.width) || !Number.isInteger(project?.height) || project.width < 8 || project.width > 160 || project.height < 8 || project.height > 160 || !Array.isArray(project.cells) || project.cells.length !== project.width * project.height || !Array.isArray(project.palette?.colors)) throw error('图纸数据不完整，无法开始计时。');
      const codes = new Set(project.palette.colors.map(color => color.code));
      if (project.cells.some(code => code !== null && (typeof code !== 'string' || !codes.has(code)))) throw error('图纸色号无效，无法开始计时。');
      const totalBeads = project.cells.filter(code => code !== null).length;
      if (!totalBeads) throw error('空白图纸无法开始拼豆。');
      const done = doneFor(project, project.done || []), date = iso(now()); project.done = done;
      return backend.create({ id: validId(id()), projectId: validId(input.projectId), name: String(input.name || project.projectName || '我的拼豆图纸').slice(0, 80), thumbnail: String(input.thumbnail || ''), width: project.width, height: project.height, totalBeads, colorCount: new Set(project.cells.filter(Boolean)).size, fingerprint: projectFingerprint(project), project,
        status: 'in_progress', elapsedMs: 0, startedAt: date, completedAt: null, updatedAt: date, done, epoch: 0, sequence: 0, owner: null, leaseUntil: 0 });
    },
    async get(id) { return recover(await backend.get(validId(id))); },
    async list() { return (await backend.list()).map(recover).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async findPending(projectId, project) { const fingerprint = projectFingerprint(project), signature = patternKey(project); return (await api.list()).find(record => record.projectId === projectId && record.status === 'in_progress' && record.fingerprint === fingerprint && patternKey(record.project) === signature) || null; },
    async claim(id, owner, exclusiveBrowserLock = false) {
      let old;
      const record = await backend.update(validId(id), original => {
        if (original.status === 'completed') return original;
        if (!exclusiveBrowserLock && original.owner && original.owner !== owner && original.leaseUntil > now()) throw error('这份记录已在另一个页面打开，请先返回仓库或稍后再试。', 'SESSION_BUSY');
        old = original; const recovered = recover(original);
        return { ...recovered, owner, leaseUntil: now() + LEASE_MS, epoch: original.owner === owner ? original.epoch : original.epoch + 1, sequence: original.owner === owner ? recovered.sequence : 0 };
      });
      if (old && old.epoch !== record.epoch) removeJournal(old);
      return record;
    },
    async checkpoint(id, owner, epoch, patch, release = false) {
      const result = await backend.update(validId(id), record => {
        if (record.status === 'completed') return record;
        checkOwner(record, owner, epoch); record = applyPatch(record, patch);
        return { ...record, owner: release ? null : owner, leaseUntil: release ? 0 : now() + LEASE_MS };
      });
      return result;
    },
    async complete(id, owner, epoch, patch) {
      const result = await backend.update(validId(id), record => {
        if (record.status === 'completed') return record;
        checkOwner(record, owner, epoch); record = applyPatch(recover(record), patch);
        return { ...record, status: 'completed', completedAt: iso(now()), updatedAt: iso(now()), owner: null, leaseUntil: 0 };
      });
      removeJournal(result); return result;
    },
    journal
  };
  return api;
}

const defaultStore = createBeadingSessionStore();
export const listBeadingSessions = () => defaultStore.list();
export const getBeadingSession = id => defaultStore.get(id);
export const createBeadingSession = input => defaultStore.create(input);
export const findPendingSession = (projectId, project) => defaultStore.findPending(projectId, project);

/** Count visible, explicitly running time only. Never extrapolate from saved wall-clock time. */
export function createSessionTimer(options = {}) {
  const store = options.store || defaultStore;
  const document = options.document ?? globalThis.document, window = options.window ?? globalThis.window;
  const locks = (Object.hasOwn(options, 'navigator') ? options.navigator : globalThis.navigator)?.locks;
  const now = options.now || (() => Date.now()), monotonicNow = options.monotonicNow || (() => performance.now());
  const interval = options.setInterval || globalThis.setInterval, cancelInterval = options.clearInterval || globalThis.clearInterval;
  const owner = options.owner || ('timer-' + globalThis.crypto.randomUUID());
  let record = null, running = false, held = false, lockedElsewhere = false, recoveryWarning = '', lastTick = 0, lastFlush = 0, intervalId = null, resumeWhenVisible = false, queue = Promise.resolve(), releaseLock = null;
  const notify = () => { try { options.onChange?.(current()); } catch {} };
  const report = cause => { try { options.onError?.(cause); } catch {} };
  const current = () => record ? { ...record, project: { ...record.project, done: [...record.done] }, done: [...record.done], running, paused: !running, lockedElsewhere, recoveryWarning } : null;
  const enqueue = operation => { const result = queue.catch(() => {}).then(operation); queue = result; return result; };
  function releaseBrowserLock() { releaseLock?.(); releaseLock = null; }
  function acquireBrowserLock() {
    if (!locks?.request) return Promise.resolve(false);
    if (releaseLock) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      locks.request('bead-studio-timer:' + record.id, { ifAvailable: true }, async lock => {
        if (!lock) { reject(error('这份记录已在另一个页面打开，请先返回仓库。', 'SESSION_BUSY')); return; }
        const gate = new Promise(release => { releaseLock = release; }); resolve(true); await gate;
      }).catch(reject);
    });
  }
  function journal() {
    if (!record || !held || record.status === 'completed') return;
    try { if (!store.journal(record)) recoveryWarning = '浏览器未允许快速恢复备份，正在直接保存。'; }
    catch { recoveryWarning = '快速备份暂不可用，正在直接保存。'; }
  }
  function account() {
    if (!record || !running) return;
    const stamp = monotonicNow(), delta = stamp - lastTick; lastTick = stamp;
    // Sleep, frozen tabs, and backwards clocks are not active craft time.
    if (Number.isFinite(delta) && delta > 0 && delta <= 2500) record.elapsedMs += delta;
    record.updatedAt = iso(now()); record.sequence++; journal();
  }
  function stop() { account(); running = false; }
  function merge(saved) {
    if (!record || saved.id !== record.id) return;
    if (saved.status === 'completed') { record = saved; running = false; held = false; resumeWhenVisible = false; releaseBrowserLock(); }
    else if (saved.epoch === record.epoch) record = record.sequence > saved.sequence ? { ...saved, elapsedMs: Math.max(saved.elapsedMs, record.elapsedMs), sequence: record.sequence, done: record.done, project: { ...saved.project, done: record.done }, updatedAt: record.updatedAt } : saved;
    else record = saved;
  }
  async function flushInternal(release = false) {
    if (!record || !held || record.status === 'completed') return current();
    const patch = { elapsedMs: record.elapsedMs, done: [...record.done], sequence: record.sequence };
    try { const saved = await store.checkpoint(record.id, owner, record.epoch, patch, release); merge(saved); if (release) { held = false; releaseBrowserLock(); } lastFlush = monotonicNow(); return current(); }
    catch (cause) { stop(); if (cause.code === 'SESSION_LOST') { held = false; lockedElsewhere = true; releaseBrowserLock(); } if (release) { held = false; releaseBrowserLock(); } notify(); throw cause; }
  }
  async function claim() {
    if (!record || record.status === 'completed') return false;
    try { const exclusive = await acquireBrowserLock(); const saved = await store.claim(record.id, owner, exclusive); merge(saved); held = record.status !== 'completed'; lockedElsewhere = false; if (held) { journal(); lastFlush = monotonicNow(); } else releaseBrowserLock(); return held; }
    catch (cause) { releaseBrowserLock(); if (cause.code === 'SESSION_BUSY' || cause.code === 'SESSION_LOST') lockedElsewhere = true; running = false; notify(); throw cause; }
  }
  function tick() {
    if (!record) return;
    account(); notify();
    if (held && (monotonicNow() - lastFlush >= 5000 || recoveryWarning)) { lastFlush = monotonicNow(); enqueue(() => flushInternal()).catch(report); }
  }
  const api = {
    current,
    async open(id, { autoStart = true } = {}) {
      await api.detach(); record = await store.get(id); if (!record) throw error('这份拼豆记录不存在。');
      lockedElsewhere = false; recoveryWarning = ''; lastTick = lastFlush = monotonicNow(); notify();
      if (record.status !== 'completed') { intervalId = interval(tick, 1000); if (autoStart) await api.resume(); }
      return current();
    },
    pause() { resumeWhenVisible = false; stop(); journal(); notify(); return enqueue(() => flushInternal()); },
    resume() { return enqueue(async () => { if (!record || record.status === 'completed') return current(); if (document?.hidden) { resumeWhenVisible = true; return current(); } if (await claim()) { running = true; lastTick = monotonicNow(); resumeWhenVisible = false; notify(); } return current(); }); },
    flush() { account(); journal(); return enqueue(() => flushInternal()); },
    setDone(indices) {
      if (!record || record.status === 'completed') return Promise.reject(error('已完成的记录只供查看。', 'SESSION_COMPLETED'));
      const done = doneFor(record.project, indices);
      return enqueue(async () => { if (!record || record.status === 'completed') throw error('已完成的记录只供查看。', 'SESSION_COMPLETED'); if (!held && !await claim()) return current(); record.done = done; record.project = { ...record.project, done }; record.sequence++; record.updatedAt = iso(now()); journal(); notify(); return flushInternal(); });
    },
    complete() {
      resumeWhenVisible = false; stop(); journal(); notify();
      return enqueue(async () => { if (!record || record.status === 'completed') return current(); if (!held && !await claim()) return current(); const saved = await store.complete(record.id, owner, record.epoch, { elapsedMs: record.elapsedMs, done: record.done, sequence: record.sequence }); merge(saved); if (intervalId !== null) cancelInterval(intervalId); intervalId = null; notify(); return current(); });
    },
    detach() {
      resumeWhenVisible = false; stop(); journal(); if (intervalId !== null) cancelInterval(intervalId); intervalId = null;
      return enqueue(async () => { await flushInternal(true); releaseBrowserLock(); record = null; held = false; lockedElsewhere = false; notify(); });
    },
    async dispose() { await api.detach(); document?.removeEventListener('visibilitychange', visibility); window?.removeEventListener('pagehide', pagehide); }
  };
  function visibility() {
    if (!record || record.status === 'completed') return;
    if (document.hidden) { resumeWhenVisible = running; stop(); journal(); notify(); enqueue(() => flushInternal(true)).catch(report); }
    else if (resumeWhenVisible) api.resume().catch(report);
  }
  function pagehide() { resumeWhenVisible = false; stop(); journal(); notify(); enqueue(() => flushInternal(true)).catch(report); }
  document?.addEventListener('visibilitychange', visibility); window?.addEventListener('pagehide', pagehide);
  return api;
}
