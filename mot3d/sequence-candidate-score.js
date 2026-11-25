import { sampleInitialStates } from './physics.js';
import { compileSequence } from './sequence.js';
import { sequenceFrameAt } from './sequence-exposure.js';
import { sequencePopulation } from './sequence-population.js';
import { simulateSequence } from './sequence-physics.js';
import { createSequenceGpu, SequenceDeviceUnavailable } from './sequence-gpu.js';

// 原子数在指定时间计算，云团矩取目标帧。装载等待期复用已积分的捕获云。
export function candidateObservation(program, result, loading, timeMS) {
  const frame = sequenceFrameAt(result.timesMS, timeMS);
  const {count, psdPerAtom, temperatureUK, rmsRadiusMM} = result.metrics[frame];
  const atoms = sequencePopulation(program, result, loading).at(timeMS, count);
  const observed = result.timesMS[frame];
  const sampledAtMS = observed <= program.stages[0].endMS ? Math.min(observed, result.loadWindowMS) : observed;
  return {atoms, psd:psdPerAtom === null ? null : atoms * psdPerAtom, temperatureUK, rmsRadiusMM, sampledAtMS};
}

export async function createCandidateScorer({params, loading, shader, timeMS, metric}) {
  if (!Number.isFinite(timeMS) || timeMS < 0) throw new RangeError('目标时间须为有限的非负数。');
  if (!['atoms', 'psd', 'temperatureUK', 'rmsRadiusMM'].includes(metric)) throw new RangeError('未知的优化目标。');
  const options = {initialStates:sampleInitialStates(params), metricsOnly:true, observeAtMS:timeMS};
  let gpu;
  if (shader) {
    try { gpu = await createSequenceGpu(shader); }
    catch (error) { if (!(error instanceof SequenceDeviceUnavailable)) throw error; }
  }
  // 整轮沿用相同的求解后端、初态和反冲种子。
  const backend = gpu ? 'WebGPU' : 'CPU';
  return {
    async evaluate(config) {
      const program = compileSequence(config);
      if (program.durationMS < timeMS) return {value:null, sampledAtMS:null, backend};
      const result = gpu ? await gpu.run(params, config, options) : simulateSequence(params, config, options);
      const observed = candidateObservation(program, result, loading, timeMS);
      return {value:observed[metric], sampledAtMS:observed.sampledAtMS, backend};
    },
    destroy() { gpu?.destroy(); },
  };
}
