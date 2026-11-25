import { DEFAULTS } from './physics.js';
import { DEFAULT_FLUX } from './fluorescence.js';
import { validateImagingSettings } from './sequence-imaging-view.js';
import { compileSequence } from './sequence.js';
import { sequencePopulation } from './sequence-population.js';
import { cloudReadout } from './sequence-observation.js';
import { simulateSequence } from './sequence-physics.js';
import { createSequenceGpu, SequenceDeviceUnavailable } from './sequence-gpu.js';
import { findSequenceObjective, objectiveSampling, scoreSequenceObjective } from './sequence-objectives.js';

// 原子数在指定时间计算，云团矩取目标帧。装载等待期复用已积分的捕获云。
export function candidateObservation(program, result, loading, timeMS) {
  const {atoms, psd, sampledAtMS, cloud} = cloudReadout(program, result, sequencePopulation(program, result, loading), timeMS);
  return {atoms, psd, sampledAtMS, temperatureUK:cloud.temperatureUK, rmsRadiusMM:cloud.rmsRadiusMM};
}

export async function createCandidateScorer({params, loading, imaging, shader, timeMS, metric}) {
  if (!Number.isFinite(timeMS) || timeMS < 0) throw new RangeError('目标时间须为有限的非负数。');
  if (typeof metric !== 'string' || !metric) throw new RangeError('未选择优化目标。');
  let gpu;
  if (shader) {
    try { gpu = await createSequenceGpu(shader); }
    catch (error) { if (!(error instanceof SequenceDeviceUnavailable)) throw error; }
  }
  // 候选改变冷束参数或种子时重新生成初态。相同的物理设置使用同一抽样。
  const backend = gpu ? 'WebGPU' : 'CPU';
  let knownObjective = false;
  return {
    async evaluate(candidate) {
      const config = candidate.config ?? candidate;
      const input = candidate.config ? candidate : {params, loading, imaging};
      const source = {...DEFAULTS, ...input.params};
      const experiment = {config, params:{...source, greenWaistMM:source.greenWaistMM ?? source.waistMM},
        loading:{flux:source.incidentFlux ?? DEFAULT_FLUX, ...input.loading}, imaging:validateImagingSettings(input.imaging)};
      const program = compileSequence(config);
      if (program.durationMS < timeMS) return {value:null, sampledAtMS:null, backend};
      const objective = findSequenceObjective(experiment, program, metric);
      if (!objective) {
        if (!knownObjective) throw new RangeError('当前时序和相机设置不支持所选目标。');
        return {value:null, sampledAtMS:null, backend};
      }
      knownObjective = true;
      const options = objectiveSampling(objective, experiment.imaging, timeMS);
      const result = gpu ? await gpu.run(experiment.params, config, options) : simulateSequence(experiment.params, config, options);
      return {...scoreSequenceObjective(objective, experiment, program, result, timeMS), backend};
    },
    destroy() { gpu?.destroy(); },
  };
}
