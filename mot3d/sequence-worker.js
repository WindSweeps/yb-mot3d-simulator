import { simulateSequence } from './sequence-physics.js';
import { createSequenceGpu, SequenceDeviceUnavailable } from './sequence-gpu.js';
import { atomTier } from './engines.js';

self.onmessage = async ({ data: {id, params, config, shader, observeAtMS, loading} }) => {
  let engine, result, reason = '', backend = 'WebGPU', lastProgress = -Infinity;
  function report(progress) {
    if (progress>0 && progress<1 && performance.now()-lastProgress<160) return;
    lastProgress = performance.now();
    self.postMessage({id,backend,progress,reason});
  }
  try {
    if (shader && !atomTier(params.engine)) {
      try {
        engine = await createSequenceGpu(shader);
        if (engine) {
          report(0);
          result = await engine.run(params,config,{onProgress:report, observeAtMS});
        }
      } catch (error) {
        if (!(error instanceof SequenceDeviceUnavailable)) throw error;
        reason = error.message;
      }
    }
    if (!result) {
      backend = 'CPU';
      reason ||= atomTier(params.engine) ? '镱多能级积分' :
        shader ? '当前浏览器没有可用的 WebGPU 设备。' : '此请求使用 CPU 积分。';
      report(0);
      result = simulateSequence(params,config,{onProgress:report,observeAtMS,loading});
      result.backend = backend;
    }
    const transfer = ['timesMS','positionsM','alive','trapped','blueRates','greenRates'].map(key => result[key].buffer);
    if (result.sampleWeights) transfer.push(result.sampleWeights.buffer,result.darkStates.buffer);
    for (const mask of Object.values(result.checkpointRetained)) transfer.push(mask.buffer);
    self.postMessage({id, result}, transfer);
  } catch (error) {
    self.postMessage({id, error: error.message});
  } finally {
    engine?.destroy();
  }
};
