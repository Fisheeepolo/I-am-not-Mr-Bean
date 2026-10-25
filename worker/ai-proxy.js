/** Request-scoped image editing proxy. Neither keys nor images are persisted or logged. */
const MiB = 1024 * 1024;
const MAX_INPUT_BYTES = 12 * MiB;
const MAX_OUTPUT_BYTES = 20 * MiB;
const MAX_REQUEST_BYTES = MAX_INPUT_BYTES + 128 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_OUTPUT_BYTES * 4 / 3) + MiB;

class ProxyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function fail(status, code, message) { throw new ProxyError(status, code, message); }
function errorResponse(error) {
  return new Response(JSON.stringify({ error: error.message, code: error.code }), {
    status: error.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function publicHTTPSURL(value, isEndpoint = false) {
  if (typeof value !== 'string' || value.length > 4096) fail(400, 'invalid_endpoint', '请填写有效的 HTTPS 图片编辑接口地址。');
  let url;
  try { url = new URL(value.trim()); } catch { fail(400, 'invalid_endpoint', '请填写有效的 HTTPS 图片编辑接口地址。'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // URL parsing also canonicalizes numeric/hexadecimal IPv4 forms before these checks.
  const labels = hostname.split('.');
  const forbiddenSuffixes = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'home.arpa'];
  const forbiddenHost = !hostname.includes('.') || hostname.includes(':') || hostname.startsWith('[') || /^[\d.]+$/.test(hostname)
    || forbiddenSuffixes.some(suffix => hostname === suffix || hostname.endsWith('.' + suffix))
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z][a-z0-9-]*$/i.test(labels.at(-1));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || forbiddenHost || (url.port && url.port !== '443')) {
    fail(400, 'invalid_endpoint', '服务地址必须使用公网 HTTPS 域名，不能包含账号、密码、私网地址或非标准端口。');
  }
  if (isEndpoint && (url.search || !/\/images\/edits\/?$/.test(url.pathname))) {
    fail(400, 'invalid_endpoint', '请填写以 /images/edits 结尾的完整图片编辑接口地址，不要包含查询参数。');
  }
  return url;
}

function imageType(bytes) {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 20 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  return null;
}

function base64Encode(bytes) {
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 32768) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
  return btoa(chunks.join(''));
}

function base64Decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_OUTPUT_BYTES * 4 / 3) + 4) fail(502, 'invalid_image', 'AI 返回的图片过大或格式无效，请降低输出尺寸后重试。');
  const text = value.replace(/\s/g, '');
  if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail(502, 'invalid_image', 'AI 接口没有返回有效的图片数据，请确认所选模型支持图片编辑。');
  let binary;
  try { binary = atob(text); } catch { fail(502, 'invalid_image', 'AI 接口返回的图片编码无法读取，请重试。'); }
  if (binary.length > MAX_OUTPUT_BYTES) fail(502, 'image_too_large', 'AI 返回的图片超过 20 MB，请降低输出尺寸后重试。');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readLimited(response, maxBytes, signal, race, status = 502) {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) fail(status, 'body_too_large', status === 413 ? '图片或请求过大，请将原图缩小到 12 MB 以内。' : 'AI 返回的数据过大，请降低输出尺寸后重试。');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) await race(Promise.reject(signal.reason));
      const { done, value } = await race(reader.read());
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { cancel(); fail(status, 'body_too_large', status === 413 ? '图片或请求过大，请将原图缩小到 12 MB 以内。' : 'AI 返回的数据过大，请降低输出尺寸后重试。'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function providerFailure(status) {
  if (status >= 300 && status < 400) fail(502, 'upstream_redirect', 'AI 服务返回了跳转地址。为保护密钥，请直接填写最终的图片编辑接口地址。');
  if (status === 401) fail(401, 'upstream_unauthorized', 'AI 服务拒绝了密钥，请检查 API Key 是否正确或已失效。');
  if (status === 403) fail(403, 'upstream_forbidden', '当前密钥没有图片编辑或所选模型的使用权限，请检查服务账号权限。');
  if (status === 404) fail(404, 'upstream_not_found', '没有找到图片编辑接口或模型，请检查服务地址和模型名称。');
  if (status === 429) fail(429, 'upstream_rate_limit', 'AI 服务额度不足或请求过于频繁，请检查余额或稍后重试。');
  if (status >= 500) fail(502, 'upstream_unavailable', 'AI 服务暂时不可用，请稍后重试。');
  fail(400, 'upstream_rejected', 'AI 服务未接受此次图片编辑。请确认模型支持图片编辑、图片格式正确，并尝试另一种请求格式。');
}

/** Pass an injected fetch only in tests; production callers use the native server fetch. */
export async function handleAI(request, { fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const controller = new AbortController();
  let timeout, cancelled = false, timedOut = false, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // The catch prevents an unhandled rejection if an abort occurs between bounded operations.
  aborted.catch(() => {});
  const stop = (reason, isTimeout = false) => {
    if (controller.signal.aborted) return;
    timedOut = isTimeout; cancelled = !isTimeout;
    controller.abort(reason); rejectAbort(reason);
  };
  const clientAbort = () => stop(new ProxyError(499, 'cancelled', '已取消本次 AI 图片处理。'));
  const race = promise => Promise.race([promise, aborted]);
  request.signal.addEventListener('abort', clientAbort, { once: true });
  timeout = setTimeout(() => stop(new ProxyError(504, 'timeout', 'AI 图片处理超时，请稍后重试；取消或超时不保证服务商停止计费。'), true), Math.max(1, Number(timeoutMs) || 180000));
  try {
    const requestURL = new URL(request.url);
    if (requestURL.pathname !== '/api/ai/edit') fail(404, 'not_found', '未找到此接口。');
    if (request.method !== 'POST') fail(405, 'method_not_allowed', '请使用图片编辑表单提交请求。');
    if (request.headers.get('X-Bead-AI') !== '1') fail(403, 'invalid_origin', '请从豆豆工坊的 AI 图片处理面板发起请求。');
    const origin = request.headers.get('Origin');
    if ((origin && origin !== requestURL.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'invalid_origin', '不允许从其他网站发起图片处理请求。');
    if (request.signal.aborted) clientAbort();
    if (controller.signal.aborted) await aborted;
    const contentType = request.headers.get('Content-Type') || '';
    if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) fail(415, 'invalid_request_type', '请通过图片上传表单提交 PNG、JPG 或 WEBP 图片。');
    const requestBytes = await readLimited(request, MAX_REQUEST_BYTES, controller.signal, race, 413);
    let form;
    try { form = await race(new Response(requestBytes, { headers: { 'Content-Type': contentType } }).formData()); }
    catch (error) { if (error instanceof ProxyError) throw error; fail(400, 'invalid_form', '无法读取图片表单，请重新选择图片后重试。'); }
    const endpoint = publicHTTPSURL(form.get('endpoint'), true);
    const model = form.get('model'), prompt = form.get('prompt'), apiKey = form.get('apiKey');
    const transport = form.get('transport') || 'multipart';
    if (typeof model !== 'string' || !model.trim() || model.trim().length > 160 || /[\x00-\x1f\x7f]/.test(model)) fail(400, 'invalid_model', '请填写图片编辑模型名称，长度不超过 160 个字符。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) fail(400, 'invalid_prompt', '请填写图片调整要求，长度不超过 8000 个字符。');
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.trim().length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey.trim())) fail(400, 'invalid_key', '请在 AI 配置中填写有效的 API Key，不要包含空格或换行。');
    if (!['multipart', 'json'].includes(transport)) fail(400, 'invalid_transport', '请选择文件表单或 JSON 图片编辑请求格式。');
    const image = form.get('image');
    if (!(image instanceof Blob) || form.getAll('image').length !== 1 || !image.size) fail(400, 'invalid_image', '请先选择一张 PNG、JPG 或 WEBP 原图。');
    if (image.size > MAX_INPUT_BYTES) fail(413, 'input_too_large', 'AI 原图不能超过 12 MB，请先缩小图片。');
    const imageBytes = new Uint8Array(await race(image.arrayBuffer()));
    const inputType = imageType(imageBytes);
    if (!inputType || (image.type && image.type !== 'application/octet-stream' && image.type.toLowerCase() !== inputType)) fail(415, 'invalid_image_type', '图片内容不是有效的 PNG、JPG 或 WEBP，请更换图片。');
    const headers = new Headers({ 'Authorization': 'Bearer ' + apiKey.trim(), 'Accept': 'application/json' });
    let body;
    if (transport === 'json') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify({ model: model.trim(), prompt: prompt.trim(), images: [{ image_url: `data:${inputType};base64,${base64Encode(imageBytes)}` }], n: 1 });
    } else {
      body = new FormData();
      body.set('model', model.trim()); body.set('prompt', prompt.trim()); body.set('n', '1');
      body.append('image[]', new Blob([imageBytes], { type: inputType }), 'source.' + (inputType === 'image/jpeg' ? 'jpg' : inputType.split('/')[1]));
    }
    const result = await race(fetchImpl(endpoint.href, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal }));
    if (!result.ok) providerFailure(result.status);
    const resultBytes = await readLimited(result, MAX_JSON_BYTES, controller.signal, race);
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(resultBytes)); }
    catch { fail(502, 'invalid_response', 'AI 接口未返回有效的图片编辑结果，请检查接口地址与请求格式。'); }
    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    let outputBytes;
    if (item && typeof item.b64_json === 'string' && item.b64_json) outputBytes = base64Decode(item.b64_json);
    else if (item && typeof item.url === 'string') {
      let imageURL;
      try { imageURL = publicHTTPSURL(item.url); }
      catch { fail(502, 'invalid_result_url', 'AI 返回的图片地址不安全或无法访问，请尝试返回 Base64 图片的服务。'); }
      if (imageURL.href.includes(apiKey.trim()) || imageURL.href.includes(encodeURIComponent(apiKey.trim()))) fail(502, 'invalid_result_url', 'AI 返回的图片地址包含敏感凭据，已停止读取。');
      // Never forward the provider key or request headers when fetching an output URL.
      const download = await race(fetchImpl(imageURL.href, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'Accept': 'image/png,image/jpeg,image/webp' } }));
      if (!download.ok || (download.status >= 300 && download.status < 400)) fail(502, 'result_download_failed', 'AI 已返回图片地址，但图片无法读取或要求跳转。请换用直接返回图片数据的接口。');
      outputBytes = await readLimited(download, MAX_OUTPUT_BYTES, controller.signal, race);
    } else fail(502, 'missing_image', 'AI 接口没有返回图片。请确认所选模型支持图片编辑，而不只是文字对话。');
    const outputType = imageType(outputBytes);
    if (!outputType) fail(502, 'invalid_image', 'AI 返回的数据不是有效的 PNG、JPG 或 WEBP 图片，请重试。');
    return new Response(outputBytes, { status: 200, headers: { 'Content-Type': outputType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="bead-ai-result.' + (outputType === 'image/jpeg' ? 'jpg' : outputType.split('/')[1]) + '"' } });
  } catch (error) {
    if (error instanceof ProxyError) return errorResponse(error);
    if (timedOut) return errorResponse(new ProxyError(504, 'timeout', 'AI 图片处理超时，请稍后重试。'));
    if (cancelled || request.signal.aborted) return errorResponse(new ProxyError(499, 'cancelled', '已取消本次 AI 图片处理。'));
    return errorResponse(new ProxyError(502, 'connection_failed', '无法连接 AI 服务，请检查服务地址、网络和接口设置后重试。'));
  } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', clientAbort); }
}
