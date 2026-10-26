import { convertSourceToPattern } from './pattern-pipeline.js';

/** Run the pure pipeline off the UI thread; terminate after every completed job. */
export async function runPatternJob(image, sourceWidth, sourceHeight, width, height, palette, options = {}, runtime = {}) {
  const WorkerClass = runtime.WorkerClass ?? globalThis.Worker;
  if (!WorkerClass) return convertSourceToPattern(image, sourceWidth, sourceHeight, width, height, palette, options);
  // Transfer an owned copy: caller buffers are never detached or modified.
  const data = new Uint8ClampedArray(image?.data ?? image);
  return new Promise((resolve, reject) => {
    let worker, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); worker?.terminate();
      if (error) reject(error); else resolve(result);
    };
    try {
      worker = new WorkerClass(new URL('./pattern-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: response }) => {
        if (response?.error) finish(new Error(response.error));
        else if (response?.result?.cells) finish(null, response.result);
        else finish(new Error('图纸计算返回了无效结果，请重试。'));
      };
      worker.onerror = () => finish(new Error('图纸计算未完成，请重试或减小尺寸。原图仍保留。'));
      worker.onmessageerror = () => finish(new Error('无法读取计算结果，请重试。'));
      timer = setTimeout(() => finish(new Error('计算时间过长，请减小图纸尺寸后重试。')), runtime.timeoutMs ?? 120_000);
      worker.postMessage({ data, sourceWidth, sourceHeight, width, height, palette, options }, [data.buffer]);
    } catch (error) { finish(error); }
  });
}
