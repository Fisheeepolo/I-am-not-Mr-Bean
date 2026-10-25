import { handleAI } from './ai-proxy.js';

// scripts/build.mjs embeds every public asset here for a self-contained Worker.
const assets = /* __BEAD_ASSETS__ */ {};

function staticResponse(body, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders
  } });
}

function decodeAsset(encoded) {
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai/edit') return handleAI(request);
    if (url.pathname.startsWith('/api/')) return staticResponse('未找到此接口。', 404);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return staticResponse('请使用 GET 或 HEAD 请求页面。', 405, undefined, { Allow: 'GET, HEAD' });
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return staticResponse('无效的页面地址。', 400); }
    if (pathname === '/') pathname = '/index.html';
    if (!Object.hasOwn(assets, pathname)) return staticResponse(request.method === 'HEAD' ? null : '未找到页面。', 404);
    const asset = assets[pathname];
    return staticResponse(request.method === 'HEAD' ? null : decodeAsset(asset.base64), 200, asset.type, { 'Content-Length': String(asset.bytes) });
  }
};
