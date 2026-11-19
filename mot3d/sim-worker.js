import { DEFAULTS, simulate } from './physics.js';
import { createGpuSimulation } from './gpu-simulation.js';

let engine;
let computing = false;
let pending = null;
let latestId = 0;
let source;

self.onmessage = ({ data }) => {
  if (data.shader !== undefined) source = data.shader;
  latestId = data.id;
  pending = data.cancel ? null : data;
  if (pending && !computing) void runPending();
};

async function runPending() {
  computing = true;
  while (pending) {
    const { id, params } = pending;
    pending = null;
    const isCurrent = () => id === latestId;
    try {
      if (engine === undefined) {
        engine = await createGpuSimulation(source);
        self.postMessage({ backend: engine ? 'WebGPU' : 'CPU' });
      }
      if (!isCurrent()) continue;
      // 细分年龄区间，避免快速飞越的原子在荧光投影中形成过长的轨迹段。
      const durationMS = params.durationMS ?? DEFAULTS.durationMS;
      const frameCount = Math.min(1000, Math.max(120, Math.ceil(durationMS / 0.025) + 1));
      const result = engine ? await engine.run(params, { frameCount, isCurrent }) : simulate(params, { frameCount });
      if (!isCurrent() || !result) continue;
      result.summary.backend = engine ? 'WebGPU' : 'CPU';
      const transfer = ['frames', 'frameAlive', 'framePhotons', 'times', 'finalPositions', 'finalVelocities',
        'alive', 'retained', 'initialLongitudinalVelocities'].map(key => result[key].buffer);
      self.postMessage({ id, result }, transfer);
    } catch (error) {
      if (isCurrent()) self.postMessage({ id, error: error.message || String(error) });
    }
  }
  computing = false;
}
