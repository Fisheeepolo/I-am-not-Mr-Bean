import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
async function filesIn(directory) {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) names.push(...await filesIn(filename));
    else names.push(filename);
  }
  return names;
}
const [source, manifest] = await Promise.all([
  readFile(join(dist, 'server/index.js'), 'utf8'),
  readFile(join(dist, '.openai/hosting.json'), 'utf8').then(JSON.parse)
]);
assert.equal(manifest.project_id, 'appgprj_6addcac4e2f08191aab401e40698b1f7');
assert.equal(Object.hasOwn(manifest, 'static'), false);
assert.equal(manifest.d1, null); assert.equal(manifest.r2, null);
assert.deepEqual((await filesIn(dist)).map(filename => relative(dist, filename).split(sep).join('/')).sort(), ['.openai/hosting.json', 'server/index.js']);
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
assert.equal(typeof worker?.fetch, 'function');
const publicRoot = join(root, 'public');
let checked = 0;
for (const filename of await filesIn(publicRoot)) {
  const pathname = '/' + relative(publicRoot, filename).split(sep).map(encodeURIComponent).join('/');
  const response = await worker.fetch(new Request('https://beads.example.com' + pathname));
  assert.equal(response.status, 200, pathname);
  assert.equal(response.headers.get('Cache-Control'), 'no-cache');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(filename), pathname);
  checked++;
}
const homepage = await worker.fetch(new Request('https://beads.example.com/'));
assert.equal(homepage.headers.get('Content-Type'), 'text/html; charset=utf-8');
assert.deepEqual(Buffer.from(await homepage.arrayBuffer()), await readFile(join(publicRoot, 'index.html')));
const head = await worker.fetch(new Request('https://beads.example.com/', { method: 'HEAD' }));
assert.equal(head.status, 200); assert.equal(await head.text(), '');
assert(Number(head.headers.get('Content-Length')) > 0);
assert.equal((await worker.fetch(new Request('https://beads.example.com/not-found'))).status, 404);
assert.equal((await worker.fetch(new Request('https://beads.example.com/', { method: 'POST' }))).status, 405);
assert.equal((await worker.fetch(new Request('https://beads.example.com/api/ai/edit'))).status, 405);
const blocked = await worker.fetch(new Request('https://beads.example.com/api/ai/edit', { method: 'POST' }));
assert.equal(blocked.status, 403); assert.equal((await blocked.json()).code, 'invalid_origin');
console.log(`Validated ESM Worker, ${checked} embedded assets, response headers, HEAD/404/405 handling and AI routing. No external API calls made.`);
