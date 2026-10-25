const CONFIG_KEY = 'bead-studio-ai-config-v1';
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const OFFICIAL_ENDPOINT = 'https://api.openai.com/v1/images/edits';
const OFFICIAL_MODEL = 'gpt-image-2.5-sunburst';
const MODES = [
  { id: 'illustration', name: '转拼豆插画', description: '轮廓清楚，色块更好拼', prompt: '请将这张图片改绘为适合制作拼豆图纸的简洁插画。保留主体的身份、姿态、表情和主要配色，主体完整居中。用清晰的粗轮廓和连贯的大色块，平涂、少色，减少渐变、阴影、纹理和细碎装饰，去除杂乱背景及难以用少量像素表达的零散细节。让相邻区域容易辨认，保留关键特征。请只输出优化后的图片，不要生成拼豆网格、坐标、编号、文字、图例或边框。' },
  { id: 'background', name: '去除杂背景', description: '保留主体，简化周围干扰', prompt: '请保留这张图片中的主要主体及其姿态、表情、关键特征和主要颜色，去除背景、无关物品、投影和零散干扰，优先输出透明背景；如不能输出透明背景，使用纯白背景。适度简化边缘细节和渐变，使主体轮廓清晰、色块连贯，方便后续制作拼豆。不要改变主体的基本外观，不要生成网格、坐标、编号、文字或图例。' },
  { id: 'retouch', name: '细节微调', description: '按照你的描述修改画面', prompt: '请在保留图片主体、主要构图、配色和关键特征的前提下，进行适合拼豆制作的轻度调整：减少细碎纹理、孤立的小色点和复杂渐变，用清晰轮廓与平涂色块表达，保留容易辨认的主体特征。不要生成网格、坐标、编号、文字或图例。\n\n我的具体调整要求：' }
];

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请先填写 AI 服务地址。');
  let url;
  try { url = new URL(raw); } catch { throw new Error('服务地址格式不正确，请填写以 https:// 开头的完整地址。'); }
  if (url.protocol !== 'https:') throw new Error('AI 服务地址需要使用 HTTPS。');
  if (url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('服务地址不能包含账号密码、查询参数、片段或非标准端口。');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/images\/edits$/.test(path) ? path : /\/images$/.test(path) ? `${path}/edits` : `${path || '/v1'}/images/edits`;
  return url.href;
}

function readConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    return { endpoint: typeof saved.endpoint === 'string' ? saved.endpoint : '', model: typeof saved.model === 'string' ? saved.model : '', transport: saved.transport === 'json' ? 'json' : 'multipart' };
  } catch { return { endpoint: '', model: '', transport: 'multipart' }; }
}

function validateConfig(config) {
  const endpoint = normalizeEndpoint(config.endpoint);
  const model = String(config.model || '').trim();
  if (!model) throw new Error('请填写支持图片编辑的模型名称。');
  if (model.length > 160) throw new Error('模型名称过长，请检查后再保存。');
  return { endpoint, model, transport: config.transport === 'json' ? 'json' : 'multipart' };
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
}

async function decodeImage(blob, signal) {
  throwIfAborted(signal);
  if (typeof createImageBitmap === 'function') {
    try {
      const image = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (signal.aborted) { image.close(); throwIfAborted(signal); }
      return { image, close: () => image.close() };
    } catch (error) { if (error.name === 'AbortError') throw error; }
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    const dispose = () => { signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null; URL.revokeObjectURL(url); };
    const abort = () => { dispose(); image.src = ''; reject(new DOMException('已取消', 'AbortError')); };
    image.onload = () => { dispose(); resolve({ image, close: () => { image.src = ''; } }); };
    image.onerror = () => { dispose(); reject(new Error('无法读取这张图片，请换用 PNG、JPG 或 WEBP 图片。')); };
    signal.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}

async function prepareImage(blob, signal) {
  const decoded = await decodeImage(blob, signal);
  try {
    const width = decoded.image.width || decoded.image.naturalWidth;
    const height = decoded.image.height || decoded.image.naturalHeight;
    if (!width || !height) throw new Error('图片尺寸无效，请换一张图片重试。');
    if (Math.max(width, height) <= 2048 && blob.size <= MAX_UPLOAD_BYTES && /^image\/(png|jpeg|webp)$/.test(blob.type)) return { blob, resized: false };
    let scale = Math.min(1, 2048 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法准备图片，请更换浏览器后再试。');
    for (let attempt = 0; attempt < 7; attempt++) {
      throwIfAborted(signal);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
      const result = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      throwIfAborted(signal);
      if (!result) throw new Error('图片准备失败，请换一张图片重试。');
      if (result.size <= MAX_UPLOAD_BYTES) return { blob: result, resized: true, width: canvas.width, height: canvas.height };
      scale *= 0.82;
    }
    throw new Error('图片仍超过 12 MB，请先裁剪主体后再试。');
  } finally { decoded.close(); }
}

export function installAI({ getSource, adoptSource, modal, closeModal, toast, escapeHTML }) {
  const $ = id => document.getElementById(id);
  const escape = value => escapeHTML(String(value ?? ''));
  const dialog = $('modal');
  const body = $('modalBody');
  let config = readConfig();
  let apiKey = '';
  let apiKeyOrigin = '';
  let active = null;
  let sequence = 0;

  function isActive(session) { return active === session && dialog.open; }
  function clearSession(session = active) {
    if (!session) return;
    if (body.firstElementChild?.dataset.aiSession === session.id) {
      const keyField = $('aiApiKey');
      if (keyField) keyField.value = '';
    }
    session.requestId++;
    session.controller?.abort();
    session.controller = null;
    for (const url of session.urls) URL.revokeObjectURL(url);
    session.urls.clear();
    session.resultBlob = null;
    if (active === session) { active = null; dialog.classList.remove('ai-wide'); }
  }
  function begin(source = null) {
    clearSession();
    active = { id: `ai-${++sequence}`, source, sourceURL: '', resultURL: '', resultBlob: null, urls: new Set(), controller: null, requestId: 0, mode: MODES[0].id, prompt: MODES[0].prompt, prompts: Object.fromEntries(MODES.map(mode => [mode.id, mode.prompt])), stage: '' };
    return active;
  }
  function makeURL(session, blob) { const url = URL.createObjectURL(blob); session.urls.add(url); return url; }
  function releaseResult(session) {
    if (session.resultURL) { URL.revokeObjectURL(session.resultURL); session.urls.delete(session.resultURL); }
    session.resultURL = '';
    session.resultBlob = null;
  }
  function render(session, title, html, stage) {
    if (active !== session) return;
    session.stage = stage;
    modal(title, `<div data-ai-session="${session.id}">${html}</div>`, 'AI IMAGE STUDIO');
    dialog.classList.add('ai-wide');
  }
  function errorLine(message = '') { return `<div id="aiErrorLine" class="ai-error-line" role="alert">${escape(message)}</div>`; }
  function showError(message) { const line = $('aiErrorLine'); if (line) { line.textContent = message; line.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }
  function sourceURL(session) { if (!session.sourceURL) session.sourceURL = makeURL(session, session.source.blob); return session.sourceURL; }

  function renderConfig(session, returnToOptimize = false, message = '') {
    render(session, '连接你的 AI 服务', `<p class="ai-dialog-intro">填写服务地址、图片编辑模型和密钥。保存配置不会发起调用。</p>
      <form id="aiConfigForm" class="ai-config-form">
      <div class="ai-config-preset ai-span-full"><span>使用 OpenAI？可以快速填入地址和模型。</span><button type="button" id="aiOfficialPreset" class="button lavender">使用官方接口预设</button></div>
      <label class="ai-span-full">服务地址<input id="aiEndpoint" type="url" autocomplete="off" spellcheck="false" placeholder="https://你的服务地址/v1" value="${escape(config.endpoint)}" maxlength="2048"><span class="ai-field-help">支持 Base URL 或完整的 /images/edits 地址。</span></label>
      <div class="ai-target-line ai-span-full"><strong>实际发送至</strong><span id="aiSendTarget"></span></div>
      <label>图片编辑模型<input id="aiModel" type="text" autocomplete="off" spellcheck="false" placeholder="填写服务提供的图片编辑模型" value="${escape(config.model)}" maxlength="160"><span class="ai-field-help">需要支持以图片为输入进行编辑。官方预设为 ${escape(OFFICIAL_MODEL)}；其他服务请使用其提供的模型名称。</span></label>
      <label>API Key<input id="aiApiKey" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096" placeholder="${apiKey ? '本次已设置，留空继续使用' : '填写你的 API Key'}"><span id="aiKeyState" class="ai-field-help">${apiKey ? '本次已为此服务设置密钥。留空保留，填写新密钥可替换。' : '密钥仅用于当前页面，刷新后需要重新填写。'}</span></label>
      <div class="ai-key-actions ai-span-full"><span>更换服务域名时，需要重新填写该服务的密钥。</span><button type="button" id="aiClearKey" class="text-button">清除本次密钥</button></div>
      <details class="ai-advanced ai-span-full" ${config.transport === 'json' ? 'open' : ''}><summary>兼容选项 <span>大多数服务无需调整</span></summary><label>请求格式<select id="aiTransport"><option value="multipart" ${config.transport === 'multipart' ? 'selected' : ''}>标准图片编辑接口（multipart）</option><option value="json" ${config.transport === 'json' ? 'selected' : ''}>兼容接口（JSON / Base64 图片）</option></select><span class="ai-field-help">只有服务说明要求 JSON 时再切换，两种格式都使用 /images/edits。</span></label></details>
      <div class="ai-model-note ai-span-full">地址和模型保存在本机，密钥不会写入仓库或浏览器存储。开始优化时，图片与密钥经本站转发至你指定的服务；服务可能按用量收费。</div>
      ${errorLine(message)}
      <div class="modal-buttons ai-sticky-actions ai-span-full"><button type="button" id="aiConfigCancel" class="button quiet">${returnToOptimize ? '返回图片优化' : '取消'}</button><button type="submit" class="button primary">保存配置</button></div>
      </form>`, 'config');
    function showTarget() {
      try {
        const target = normalizeEndpoint($('aiEndpoint').value);
        $('aiSendTarget').textContent = target;
        const changedOrigin = !!apiKey && new URL(target).origin !== apiKeyOrigin;
        $('aiKeyState').textContent = changedOrigin ? '服务域名已改变，请填写新服务的密钥。旧密钥不会发送至这个地址。' : apiKey ? '本次已为此服务设置密钥。留空保留，填写新密钥可替换。' : '密钥仅用于当前页面，刷新后需要重新填写。';
        $('aiApiKey').placeholder = apiKey && !changedOrigin ? '本次已设置，留空继续使用' : '填写此服务的 API Key';
      }
      catch (error) { $('aiSendTarget').textContent = $('aiEndpoint').value.trim() ? error.message : '填写服务地址后显示'; }
    }
    $('aiEndpoint').addEventListener('input', showTarget);
    showTarget();
    $('aiOfficialPreset').onclick = () => { $('aiEndpoint').value = OFFICIAL_ENDPOINT; $('aiModel').value = OFFICIAL_MODEL; $('aiTransport').value = 'multipart'; showTarget(); };
    $('aiClearKey').onclick = () => { apiKey = ''; apiKeyOrigin = ''; $('aiApiKey').value = ''; $('aiApiKey').placeholder = '填写你的 API Key'; $('aiKeyState').textContent = '本次密钥已清除。发起处理前需要重新填写。'; toast('本次页面中的 API Key 已清除。'); };
    $('aiConfigCancel').onclick = () => returnToOptimize ? renderOptimize(session) : closeModal();
    $('aiConfigForm').onsubmit = event => {
      event.preventDefault();
      try {
        const next = validateConfig({ endpoint: $('aiEndpoint').value, model: $('aiModel').value, transport: $('aiTransport').value });
        const suppliedKey = $('aiApiKey').value.trim();
        if (suppliedKey && (suppliedKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(suppliedKey))) throw new Error('API Key 不能包含空格或换行，请检查后重新填写。');
        const nextOrigin = new URL(next.endpoint).origin;
        const changedOrigin = !!apiKey && nextOrigin !== apiKeyOrigin;
        if (suppliedKey) { apiKey = suppliedKey; apiKeyOrigin = nextOrigin; }
        else if (changedOrigin) { apiKey = ''; apiKeyOrigin = ''; }
        $('aiApiKey').value = '';
        config = next;
        let persisted = true;
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); } catch { persisted = false; }
        const note = changedOrigin && !suppliedKey ? '服务地址已更换。请重新填写新服务密钥后使用 AI。' : persisted ? 'AI 配置已保存，尚未验证连接。' : '配置已用于本次页面；浏览器未允许保存，尚未验证连接。';
        toast(note);
        if (returnToOptimize) renderOptimize(session, apiKey ? '' : '已保存服务配置。开始处理前，请在 AI 配置中填写 API Key。');
        else closeModal();
      } catch (error) { showError(error.message); }
    };
  }

  function renderOptimize(session, message = '') {
    if (active !== session) return;
    let endpoint = '';
    try { endpoint = validateConfig(config).endpoint; } catch { /* Configuration is optional until a request starts. */ }
    const target = endpoint ? new URL(endpoint).hostname : '你配置的 AI 服务';
    render(session, '把图片整理得更好拼', `<p>先选择一种优化方式，也可以补充自己的要求。预览满意后再生成图纸。</p>
      <div class="ai-mode-options" role="group" aria-label="图片优化方式">${MODES.map(mode => `<button type="button" data-ai-mode="${mode.id}" class="${session.mode === mode.id ? 'selected' : ''}" aria-pressed="${session.mode === mode.id}"><strong>${mode.name}</strong><small>${mode.description}</small></button>`).join('')}</div>
      <label class="ai-prompt" for="aiPrompt">告诉 AI 你想怎么调整<textarea id="aiPrompt" maxlength="8000" rows="5">${escape(session.prompt)}</textarea><span class="ai-field-help">主体、配色或表情想保留什么，可以直接写在这里。</span></label>
      <div class="ai-model-note"><strong>当前服务</strong><br>${endpoint ? `${escape(target)} · ${escape(config.model)}` : '尚未配置'}<br><button id="aiEditConfig" type="button" class="text-button">${endpoint ? '调整 AI 配置' : '填写 AI 配置'}</button>${!apiKey ? '<span class="ai-field-help">尚未填写本次页面的 API Key。</span>' : ''}</div>
      <div class="ai-send-notice">点击“开始 AI 优化”后，会将当前图片和调整要求发送至 <strong>${escape(target)}</strong>。该服务可能按用量收费。超过 2048 像素的图片会先缩小，发送文件不超过 12 MB；仓库里的原图会保留。</div>
      ${errorLine(message)}
      <div class="modal-buttons ai-sticky-actions"><button id="aiOptimizeCancel" class="button quiet">取消</button><button id="aiBeginButton" class="button primary">开始 AI 优化</button></div>`, 'optimize');
    $('aiPrompt').oninput = () => { session.prompt = $('aiPrompt').value; session.prompts[session.mode] = session.prompt; };
    body.querySelectorAll('[data-ai-mode]').forEach(button => { button.onclick = () => {
      const nextMode = button.dataset.aiMode;
      if (nextMode === session.mode) return;
      session.prompts[session.mode] = $('aiPrompt').value;
      session.mode = nextMode;
      session.prompt = session.prompts[nextMode];
      renderOptimize(session);
    }; });
    $('aiEditConfig').onclick = () => { session.prompt = $('aiPrompt').value; renderConfig(session, true); };
    $('aiOptimizeCancel').onclick = closeModal;
    $('aiBeginButton').onclick = () => runRequest(session);
  }

  function renderProgress(session, target) {
    render(session, 'AI 正在整理图片', `<div class="ai-progress" role="status" aria-live="polite"><span id="aiProgressText">正在准备图片…</span></div><p>图片将交给 ${escape(target)} 处理。较复杂的图片可能需要几分钟。</p><div class="ai-send-notice">可以取消等待。取消后会中止本站请求；上游服务已经开始的处理和费用，仍以服务方规则为准。</div>${errorLine()}<div class="modal-buttons"><button id="aiCancelRequest" class="button quiet">取消等待</button></div>`, 'busy');
    $('aiCancelRequest').onclick = () => { session.requestId++; session.controller?.abort(); session.controller = null; renderOptimize(session, '已取消等待，原图与图纸保持不变。'); };
  }

  async function runRequest(session) {
    if (!isActive(session) || session.stage !== 'optimize') return;
    session.prompt = $('aiPrompt').value.trim();
    if (!session.prompt) { showError('请填写调整要求后再开始。'); return; }
    if (session.prompt.length > 8000) { showError('调整要求超过 8000 字，请稍作精简。'); return; }
    let currentConfig;
    try { currentConfig = validateConfig(config); }
    catch (error) { renderConfig(session, true, error.message); return; }
    if (apiKey && apiKeyOrigin !== new URL(currentConfig.endpoint).origin) { apiKey = ''; apiKeyOrigin = ''; }
    if (!apiKey) { renderConfig(session, true, '请填写当前服务的 API Key，保存后再开始处理。'); return; }
    const controller = new AbortController();
    session.controller = controller;
    const requestId = ++session.requestId;
    const current = () => isActive(session) && session.requestId === requestId && !controller.signal.aborted;
    renderProgress(session, new URL(currentConfig.endpoint).hostname);
    try {
      const prepared = await prepareImage(session.source.blob, controller.signal);
      if (!current()) return;
      $('aiProgressText').textContent = prepared.resized ? `已准备 ${prepared.width} × ${prepared.height} 图片，正在等待 AI 返回…` : '图片已准备，正在等待 AI 返回…';
      const form = new FormData();
      form.append('endpoint', currentConfig.endpoint);
      form.append('model', currentConfig.model);
      form.append('transport', currentConfig.transport);
      form.append('apiKey', apiKey);
      form.append('prompt', session.prompt);
      const extension = prepared.blob.type === 'image/jpeg' ? 'jpg' : prepared.blob.type === 'image/webp' ? 'webp' : 'png';
      form.append('image', prepared.blob, `bead-source.${extension}`);
      const response = await fetch('/api/ai/edit', { method: 'POST', headers: { 'X-Bead-AI': '1' }, body: form, signal: controller.signal });
      if (!current()) return;
      if (!response.ok) {
        let message = `AI 处理未完成（${response.status}），请检查配置后重试。`;
        try { const data = await response.json(); if (typeof data.error === 'string') message = data.error; } catch { /* Do not expose HTML or raw upstream response bodies. */ }
        throw new Error(message);
      }
      if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('服务没有返回可用图片，请确认接口和模型支持图片编辑。');
      const resultBlob = await response.blob();
      if (!current()) return;
      if (!resultBlob.size || resultBlob.size > 30 * 1024 * 1024) throw new Error('返回图片为空或过大，请调整要求后重试。');
      const decoded = await decodeImage(resultBlob, controller.signal);
      decoded.close();
      if (!current()) return;
      releaseResult(session);
      session.resultBlob = resultBlob;
      session.resultURL = makeURL(session, resultBlob);
      session.controller = null;
      renderResult(session);
    } catch (error) {
      if (!isActive(session) || session.requestId !== requestId) return;
      session.controller = null;
      if (error.name === 'AbortError') { renderOptimize(session, '处理已取消，原图与图纸保持不变。'); return; }
      const message = error instanceof TypeError ? '无法连接 AI 图片处理服务，请检查网络及服务配置后重试。' : error.message || '图片处理失败，请稍后重试。';
      renderOptimize(session, message);
    } finally { if (session.controller === controller) session.controller = null; }
  }

  function renderResult(session) {
    render(session, '看看这次的优化效果', `<p>对照主体、颜色和细节。只有点击“采用并生成图纸”，优化图才会进入工作台。</p><div class="ai-compare"><figure><img src="${escape(sourceURL(session))}" alt="优化前的图片"><figcaption>优化前</figcaption></figure><figure><img src="${escape(session.resultURL)}" alt="AI 优化后的图片"><figcaption>AI 优化后</figcaption></figure></div><div class="ai-model-note">采用后会沿用当前图纸尺寸与配色设置生成图纸，原图仍会保留，可在工作台恢复。</div>${errorLine()}<div class="ai-result-actions"><button id="aiDiscardResult" class="button quiet">保留原图</button><button id="aiAdjustAgain" class="button quiet">重新调整</button><button id="aiAdoptResult" class="button primary">采用并生成图纸</button></div>`, 'result');
    $('aiDiscardResult').onclick = closeModal;
    $('aiAdjustAgain').onclick = () => { releaseResult(session); renderOptimize(session); };
    $('aiAdoptResult').onclick = async () => {
      const button = $('aiAdoptResult');
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = '正在生成图纸…';
      $('aiAdjustAgain').disabled = true;
      $('aiDiscardResult').disabled = true;
      try {
        const accepted = await adoptSource(session.resultBlob, session.source.name, session.source.token);
        if (!isActive(session)) return;
        if (accepted) { closeModal(); toast('已采用 AI 优化图并生成图纸，原图已保留。'); }
        else showError('暂时未能采用这张图片。可以重试，或回到工作台重新选择图片后再优化。');
      } catch (error) { if (isActive(session)) showError(error.message || '生成图纸失败，请重试。'); }
      finally { if (isActive(session) && session.stage === 'result') { button.disabled = false; button.textContent = '采用并生成图纸'; $('aiAdjustAgain').disabled = false; $('aiDiscardResult').disabled = false; } }
    };
  }

  function openConfig() { renderConfig(begin()); }
  async function openOptimize() {
    let source;
    try { source = await getSource(); } catch { toast('暂时无法读取原图，请重新选择图片。'); return; }
    if (!source || !(source.blob instanceof Blob) || !source.blob.size) { toast('请先上传一张图片，再使用 AI 优化。'); return; }
    const session = begin({ blob: source.blob, name: source.name || '我的拼豆图片', token: source.token });
    renderOptimize(session);
  }
  function onClose() { if (!dialog.open) clearSession(); }
  dialog.addEventListener('close', onClose);
  const observer = new MutationObserver(() => { if (active && body.firstElementChild?.dataset.aiSession !== active.id) clearSession(); });
  observer.observe(body, { childList: true });
  $('aiConfigBtn')?.addEventListener('click', openConfig);
  $('aiOptimizeBtn')?.addEventListener('click', openOptimize);

  return {
    openConfig,
    openOptimize,
    dispose() { clearSession(); apiKey = ''; apiKeyOrigin = ''; observer.disconnect(); dialog.removeEventListener('close', onClose); $('aiConfigBtn')?.removeEventListener('click', openConfig); $('aiOptimizeBtn')?.removeEventListener('click', openOptimize); }
  };
}
