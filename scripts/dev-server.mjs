import http from 'node:http';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerPath = fileURLToPath(new URL('../dist/server/index.js', import.meta.url));
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
let loadedVersion = '', worker;
async function getWorker() {
  const info = await stat(workerPath);
  const version = `${info.mtimeMs}-${info.size}`;
  if (version !== loadedVersion) {
    const module = await import(pathToFileURL(workerPath).href + '?build=' + encodeURIComponent(version));
    if (typeof module.default?.fetch !== 'function') throw new Error('Build must export default.fetch.');
    worker = module.default;
    loadedVersion = version;
  }
  return worker;
}
await getWorker();
const server = http.createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  incoming.once('aborted', abort);
  outgoing.once('close', () => { if (!outgoing.writableEnded) abort(); });
  try {
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
    const method = incoming.method || 'GET';
    const init = { method, headers, signal: controller.signal };
    if (method !== 'GET' && method !== 'HEAD') { init.body = Readable.toWeb(incoming); init.duplex = 'half'; }
    const url = new URL(incoming.url || '/', 'http://' + (incoming.headers.host || '127.0.0.1:' + port));
    const request = new Request(url, init);
    const result = await (await getWorker()).fetch(request, {}, {});
    outgoing.statusCode = result.status;
    for (const [key, value] of result.headers) outgoing.setHeader(key, value);
    if (!result.body || method === 'HEAD') outgoing.end();
    else await pipeline(Readable.fromWeb(result.body), outgoing);
  } catch {
    // Request payloads, credentials and upstream errors are deliberately never logged.
    if (!outgoing.headersSent && !outgoing.destroyed) {
      outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end('本地预览暂时无法完成请求，请重新构建后重试。');
    } else if (!outgoing.destroyed) outgoing.end();
  } finally { incoming.removeListener('aborted', abort); }
});
server.listen(port, '127.0.0.1', () => console.log(`我不是豆神预览：http://127.0.0.1:${port} （重新构建后自动读取更新）`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
