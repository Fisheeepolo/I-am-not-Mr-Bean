import test from 'node:test';
import assert from 'node:assert/strict';
import { runPatternJob } from '../public/pattern-job.js';
import { handlePatternJob } from '../public/pattern-worker.js';
import { convertSourceToPattern } from '../public/pattern-pipeline.js';

const image = { data: new Uint8ClampedArray([255,255,255,255,0,0,0,0,0,0,0,255,255,255,255,255]) };
const palette = [{code:'W',hex:'#FFFFFF'},{code:'K',hex:'#000000'}];

test('worker protocol returns the actual pure pipeline result without altering caller buffers', async () => {
  let ended = 0;
  class TestWorker {
    constructor(url, options) { assert.equal(url.pathname.endsWith('/pattern-worker.js'),true);assert.equal(options.type,'module'); }
    postMessage(message, transfers) {
      assert.notEqual(message.data, image.data);assert.equal(transfers[0],message.data.buffer);
      queueMicrotask(() => this.onmessage({data:{result:handlePatternJob(message)}}));
    }
    terminate(){ended++;}
  }
  const before = image.data.slice();
  const result = await runPatternJob(image,2,2,2,2,palette,{maxColors:2},{WorkerClass:TestWorker});
  assert.deepEqual(result,convertSourceToPattern(image,2,2,2,2,palette,{maxColors:2}));
  assert.deepEqual(image.data,before);assert.equal(ended,1);
  assert.equal(result.cells[1],null);assert.equal(result.algorithm,'content-aware-v4');
});

test('worker errors and timeouts terminate the job and reject rather than save invalid output',async()=>{
  for (const kind of ['error','invalid','exception','timeout']) {
    let ended=0;
    class TestWorker {
      postMessage(){queueMicrotask(()=>{
        if(kind==='error')this.onmessage({data:{error:'bad input'}});
        if(kind==='invalid')this.onmessage({data:{result:{}}});
        if(kind==='exception')this.onerror();
      });}
      terminate(){ended++;}
    }
    await assert.rejects(runPatternJob(image,2,2,2,2,palette,{}, {WorkerClass:TestWorker,timeoutMs:10}));
    assert.equal(ended,1);
  }
});
