import assert from 'node:assert/strict';
import { handleAI } from '../worker/ai-proxy.js';

const PNG64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6rUAAAAASUVORK5CYII=';
const png=new Uint8Array(Buffer.from(PNG64,'base64'));
const KEY='test-only-key-not-a-real-secret';
function request(overrides={},options={}){
 const form=new FormData();
 const data={endpoint:'https://api.example.com/v1/images/edits',model:'example-image-model',apiKey:KEY,prompt:'简化背景，保留主体。',transport:'multipart',...overrides};
 for(const [key,value] of Object.entries(data))if(value!==undefined)form.append(key,value);
 if(!Object.hasOwn(overrides,'image'))form.append('image',new Blob([png],{type:'image/png'}),'test.png');
 return new Request('https://beads.example.com/api/ai/edit',{method:'POST',headers:{'X-Bead-AI':'1',Origin:'https://beads.example.com',...options.headers},body:form,...options.extra});
}
const success=()=>new Response(JSON.stringify({data:[{b64_json:PNG64}]}),{headers:{'Content-Type':'application/json'}});
let tests=0;
async function test(name,fn){await fn();tests++;console.log('PASS '+name);}

await test('multipart editing forwards only the required fields and bearer key',async()=>{
 let calls=0;
 const result=await handleAI(request(),{fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.example.com/v1/images/edits');assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');assert.equal(options.headers.get('Authorization'),'Bearer '+KEY);assert.equal(options.headers.get('Content-Type'),null);assert.deepEqual([...options.body.keys()].sort(),['image[]','model','n','prompt'].sort());assert.equal(options.body.get('n'),'1');assert.equal(options.body.get('model'),'example-image-model');assert.deepEqual(new Uint8Array(await options.body.get('image[]').arrayBuffer()),png);return success();}});
 assert.equal(calls,1);assert.equal(result.status,200);assert.equal(result.headers.get('Content-Type'),'image/png');assert.equal(result.headers.get('Cache-Control'),'no-store');assert.equal(result.headers.get('Access-Control-Allow-Origin'),null);assert.deepEqual(new Uint8Array(await result.arrayBuffer()),png);
});
await test('JSON editing carries a data URL and no multipart-only options',async()=>{
 const result=await handleAI(request({transport:'json'}),{fetchImpl:async(_,options)=>{assert.equal(options.headers.get('Content-Type'),'application/json');const data=JSON.parse(options.body);assert.deepEqual(Object.keys(data).sort(),['images','model','n','prompt'].sort());assert.equal(data.images[0].image_url,'data:image/png;base64,'+PNG64);assert.equal(data.n,1);return success();}});assert.equal(result.status,200);
});
await test('URL results are fetched without the API key or authorization',async()=>{
 let calls=0;
 const result=await handleAI(request(),{fetchImpl:async(url,options)=>{if(!calls++){return new Response(JSON.stringify({data:[{url:'https://images.example.net/result.png?sig=abc123'}]}));}assert.equal(url,'https://images.example.net/result.png?sig=abc123');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(new Headers(options.headers).get('Authorization'),null);assert(!JSON.stringify(options.headers).includes(KEY));return new Response(png,{headers:{'Content-Type':'text/plain'}});}});assert.equal(result.status,200);assert.equal(result.headers.get('Content-Type'),'image/png');assert.equal(calls,2);
});
await test('private, local, numeric and credential-bearing endpoints never receive a request',async()=>{
 for(const endpoint of ['http://api.example.com/v1/images/edits','https://localhost/images/edits','https://foo.local/images/edits','https://foo.internal/images/edits','https://127.0.0.1/images/edits','https://2130706433/images/edits','https://0x7f000001/images/edits','https://[::1]/images/edits','https://10.1.1.1/images/edits','https://user:password@api.example.com/images/edits','https://api.example.com:8443/images/edits','https://api.example.com/images/edits?key=value','https://api.example.com/images/edits#fragment','https://api.example.com/chat/completions']){
  let called=false;const result=await handleAI(request({endpoint}),{fetchImpl:async()=>{called=true;return success();}});assert.equal(result.status,400,endpoint);assert.equal(called,false,endpoint);
 }
});
await test('upstream redirects are not followed and do not expose credentials',async()=>{
 let calls=0;const result=await handleAI(request(),{fetchImpl:async()=>{calls++;return new Response(KEY,{status:302,headers:{Location:'https://untrusted.example.net'}});}});assert.equal(result.status,502);assert.equal(calls,1);assert(!(await result.text()).includes(KEY));
});
await test('invalid configuration and image types are rejected before network access',async()=>{
 for(const [override,status]of [[{apiKey:''},400],[{apiKey:'key\nvalue'},400],[{model:''},400],[{model:'a'.repeat(161)},400],[{prompt:''},400],[{prompt:'a'.repeat(8001)},400],[{transport:'chat'},400],[{image:new Blob(['not an image'],{type:'image/png'})},415],[{image:undefined},400]]){
  let calls=0;const result=await handleAI(request(override),{fetchImpl:async()=>{calls++;return success();}});assert.equal(result.status,status);assert.equal(calls,0);
 }
});
await test('wrong origin, missing custom header and cross-site form requests are rejected',async()=>{
 for(const headers of [{'X-Bead-AI':''},{Origin:'https://evil.example.com'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}]){let calls=0;const result=await handleAI(request({}, {headers}),{fetchImpl:async()=>{calls++;return success();}});assert.equal(result.status,403);assert.equal(calls,0);}
});
await test('common provider errors are translated without echoing provider payloads',async()=>{
 for(const [status,expected]of [[401,401],[403,403],[404,404],[429,429],[500,502],[400,400]]){const result=await handleAI(request(),{fetchImpl:async()=>new Response(JSON.stringify({error:{message:KEY}}),{status})});assert.equal(result.status,expected);const body=await result.json();assert.equal(typeof body.error,'string');assert(!body.error.includes(KEY));assert.equal(result.headers.get('Cache-Control'),'no-store');}
});
await test('malformed, missing and non-image outputs cannot become a successful preview',async()=>{
 for(const data of ['<html>failure</html>',JSON.stringify({data:[]}),JSON.stringify({data:[{b64_json:'not@@@base64'}]}),JSON.stringify({data:[{b64_json:Buffer.from('not an image').toString('base64')}]}),JSON.stringify({data:[{url:'https://127.0.0.1/image.png'}]})]){const result=await handleAI(request(),{fetchImpl:async()=>new Response(data)});assert.equal(result.status,502);}
});
await test('output URL redirects are rejected without forwarding authorization',async()=>{
 let calls=0;const result=await handleAI(request(),{fetchImpl:async(_,options)=>{if(!calls++)return new Response(JSON.stringify({data:[{url:'https://cdn.example.net/picture'}]}));assert.equal(new Headers(options.headers).get('Authorization'),null);return new Response(null,{status:302,headers:{Location:'https://other.example.net/image'}});}});assert.equal(result.status,502);assert.equal(calls,2);
});
await test('output URLs containing the API key are never requested',async()=>{
 let calls=0;const result=await handleAI(request(),{fetchImpl:async()=>{calls++;return new Response(JSON.stringify({data:[{url:'https://cdn.example.net/picture?key='+KEY}]}));}});assert.equal(result.status,502);assert.equal(calls,1);assert(!(await result.text()).includes(KEY));
});
await test('input and upstream content length limits stop oversized work',async()=>{
 let calls=0;const tooBig=request();tooBig.headers.set('content-length',String(14*1024*1024));const a=await handleAI(tooBig,{fetchImpl:async()=>{calls++;return success();}});assert.equal(a.status,413);assert.equal(calls,0);
 const b=await handleAI(request(),{fetchImpl:async()=>new Response('{}',{headers:{'Content-Length':String(40*1024*1024)}})});assert.equal(b.status,502);
});
await test('a stalled fetch times out even if the adapter ignores AbortSignal',async()=>{
 const start=Date.now();const result=await handleAI(request(),{fetchImpl:()=>new Promise(()=>{}),timeoutMs:15});assert.equal(result.status,504);assert(Date.now()-start<1000);assert.equal((await result.json()).code,'timeout');
});
await test('client cancellation terminates the operation',async()=>{
 const controller=new AbortController();const req=request({}, {extra:{signal:controller.signal}});const resultPromise=handleAI(req,{fetchImpl:async()=>{controller.abort();return await new Promise(()=>{});}});const result=await resultPromise;assert.equal(result.status,499);assert.equal((await result.json()).code,'cancelled');
});
await test('unexpected network errors never disclose their raw messages',async()=>{
 const result=await handleAI(request(),{fetchImpl:async()=>{throw new Error('Network failure '+KEY);}});assert.equal(result.status,502);assert(!(await result.text()).includes(KEY));
});
console.log(`${tests} AI proxy tests passed. No real API calls were made.`);
