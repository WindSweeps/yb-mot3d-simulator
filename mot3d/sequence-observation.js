import { derive, magneticCenterMM } from './physics.js';
import { sequenceAt } from './sequence.js';
import { sequenceLossStages, sequencePopulation } from './sequence-population.js';
import { cloudSamples, fluorescenceExposure, sequenceFrameAt } from './sequence-exposure.js';
import { simulateImagingFrame } from './sequence-imaging.js';

// 装载等待期间，原子数按请求时间演化，云团矩与坐标取捕获云快照。
// 在关源边界保留该快照的物理采样时间，通道则按边界上生效的新设置读取。
export function cloudReadout(program, result, population, timeMS, frame) {
  if (!Number.isFinite(timeMS) || timeMS < 0 || timeMS > program.durationMS)
    throw new RangeError('读数时刻超出当前时序范围。');
  if (!result) return {timeMS, sampledAtMS:null, frame:null, cloud:null, atoms:null, psd:null};
  frame ??= sequenceFrameAt(result.timesMS, timeMS);
  const observed = result.timesMS[frame], cloud = result.metrics[frame];
  const sampledAtMS = observed <= program.stages[0].endMS ? Math.min(observed, result.loadWindowMS) : observed;
  const atoms = population?.at(timeMS, cloud.count) ?? null;
  const psd = atoms !== null && cloud.psdPerAtom !== null ? atoms * cloud.psdPerAtom : null;
  return {timeMS, sampledAtMS, frame, cloud, atoms, psd};
}

export function sequenceCameraImage(frame, settings) {
  const sample = settings.mode === 'fluorescence' ? frame.fluorescenceSample(settings.exposureUS) : frame.sample;
  return simulateImagingFrame(sample, settings);
}

// 回放传入当前实验已求好的布居和几何。候选可直接由同一份积分结果构造。
export function sequenceObservation(experiment, program, result, timeMS, {
  population = result ? sequencePopulation(program, result, experiment.loading) : null,
  geometry = derive(experiment.params),
} = {}) {
  const point = cloudReadout(program, result, population, timeMS);
  const channels = sequenceAt(program, timeMS);
  const stage = program.stages[channels.stageIndex];
  const center = magneticCenterMM(channels.gradientGCM, geometry.mainTensor, geometry.biasG);
  function cameraFrame() {
    const centerMM = center ?? [0, 0, 0];
    const view = {timeMS, sampledAtMS:point.sampledAtMS, stageLabel:stage.label, sample:{positionsM:null, centerMM}};
    if (result && population) {
      const weightAt = (frame, t) => population.weightAt(t, result.metrics[frame].count);
      view.weight = weightAt(point.frame, timeMS);
      view.sample = {...cloudSamples(result, point.frame, point.frame, centerMM), weight:view.weight};
      view.fluorescenceSample = durationUS => fluorescenceExposure(result, timeMS, durationUS, centerMM, weightAt);
    }
    return view;
  }
  return {...point, experiment, program, result, population, channels, geometry, center, stage, cameraFrame,
    get loss() { return sequenceLossStages(program, experiment.loading)[channels.stageIndex]; },
    get cloudField() {
      return point.cloud?.centroidMM?.map((position, i) =>
        geometry.biasG[i] + position / 10 * channels.gradientGCM * geometry.mainTensor[i]) ?? null;
    },
    get image() { return sequenceCameraImage(cameraFrame(), experiment.imaging); },
  };
}
