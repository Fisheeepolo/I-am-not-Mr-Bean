import { convertSourceToPattern } from './pattern-pipeline.js';

/** No DOM, network, storage or API credentials enter this worker. */
export function handlePatternJob(message) {
  const { data, sourceWidth, sourceHeight, width, height, palette, options } = message;
  return convertSourceToPattern({ data }, sourceWidth, sourceHeight, width, height, palette, options);
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = event => {
    try { globalThis.postMessage({ result: handlePatternJob(event.data) }); }
    catch (error) { globalThis.postMessage({ error: error?.message || '图纸计算失败，请重试。' }); }
  };
}
