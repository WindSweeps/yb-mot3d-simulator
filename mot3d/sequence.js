// 四个阶段共享同一物理时钟。单位与时序编辑器一致：ms、MHz、mW、G/cm。
export const SEQUENCE_STAGES = Object.freeze([
  { id: 'load', label: '双色装载' },
  { id: 'handoff', label: '交接' },
  { id: 'green', label: '纯绿接收' },
  { id: 'compress', label: '绿光压缩' },
]);

export const SEQUENCE_FIELDS = Object.freeze({
  loadMS: ['双色装载时间', 'ms', .1, 60000],
  handoffMS: ['蓝光关断时间', 'ms', .01, 10],
  greenMS: ['纯绿接收时间', 'ms', .01, 100],
  compressMS: ['压缩时间', 'ms', .01, 300],
  blueObliqueMW: ['399 nm 斜光每束功率', 'mW', 0, 100],
  blueHorizontalMW: ['399 nm 水平光每束功率', 'mW', 0, 100],
  greenObliqueMW: ['556 nm 斜光每束功率', 'mW', 0, 100],
  greenHorizontalMW: ['556 nm 水平光每束功率', 'mW', 0, 100],
  finalObliqueUW: ['556 nm 斜光末端每束功率', 'µW', 0, 100000],
  finalHorizontalUW: ['556 nm 水平光末端每束功率', 'µW', 0, 100000],
  blueDetuningMHz: ['399 nm 失谐', 'MHz', -150, 150],
  shieldingMHz: ['双色装载绿光失谐', 'MHz', -30, 30],
  receiveMHz: ['纯绿接收失谐', 'MHz', -30, 30],
  compressMHz: ['压缩绿光失谐', 'MHz', -30, 30],
  loadGradient: ['装载主轴梯度', 'G/cm', -100, 100],
  receiveGradient: ['纯绿接收主轴梯度', 'G/cm', -100, 100],
  finalGradient: ['压缩末端主轴梯度', 'G/cm', -100, 100],
});

export function songSequence() {
  return {
    loadMS: 5000, handoffMS: 1, greenMS: 10, compressMS: 100,
    blueObliqueMW: 15.5, blueHorizontalMW: 8, greenObliqueMW: 30.5, greenHorizontalMW: 13,
    finalObliqueUW: 35, finalHorizontalUW: 35 * 13 / 30.5,
    blueDetuningMHz: -34.92, shieldingMHz: 2, receiveMHz: -5.94, compressMHz: -1.44,
    loadGradient: 29.4, receiveGradient: 1.4, finalGradient: 18.2,
    blueEnabled: true, greenEnabled: true, powerRamp: 'linear',
  };
}

export const SEQUENCE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'arxiv-2503.24383v2', name: 'arXiv:2503.24383v2',
    config: Object.freeze(songSequence()),
  }),
  Object.freeze({
    id: 'ai-20261123-gpt62astra', name: 'ai优化+2026-11-23+GPT6.2astra',
    config: Object.freeze({ ...songSequence(), greenMS: 7.2, compressMS: 102.8,
      receiveMHz: -3.15, compressMHz: -0.54, receiveGradient: 2.3, finalGradient: 13.2,
      finalObliqueUW: 18.1, finalHorizontalUW: 17.9, powerRamp: 'geometric' }),
  }),
]);

export function matchingSequencePreset(config) {
  return SEQUENCE_PRESETS.find(preset =>
    Object.entries(preset.config).every(([key, value]) => config[key] === value));
}

export function compileSequence(input) {
  const config = { ...input };
  for (const [key, [label, unit, min, max]] of Object.entries(SEQUENCE_FIELDS)) {
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max)
      throw new RangeError(`${label}须在 ${min} 至 ${max} ${unit} 之间。`);
  }
  for (const key of ['blueEnabled', 'greenEnabled'])
    if (typeof config[key] !== 'boolean') throw new TypeError('光路开关需要布尔值。');
  if (!['linear', 'smooth', 'geometric'].includes(config.powerRamp)) throw new RangeError('未知绿光功率曲线。');
  if (config.powerRamp === 'geometric' &&
      [config.greenObliqueMW, config.greenHorizontalMW, config.finalObliqueUW, config.finalHorizontalUW].some(p => p <= 0))
    throw new RangeError('使用等比功率斜坡时，起点和终点的各束绿光功率需要大于零。');
  let time = 0;
  const stages = SEQUENCE_STAGES.map(({ id, label }) => {
    const durationMS = config[id + 'MS'], startMS = time;
    time += durationMS;
    return { id, label, startMS, endMS: time, durationMS };
  });
  return { config, stages, durationMS: time };
}

function sixBeams(oblique, horizontal) {
  return [oblique, oblique, oblique, oblique, horizontal, horizontal];
}

function greenRamp(start, end, u, curve) {
  if (u <= 0) return start;
  if (u >= 1) return end;
  if (curve === 'geometric') return start * (end / start) ** u;
  if (curve === 'smooth') u = u * u * (3 - 2 * u);
  return start + (end - start) * u;
}

export function sequenceAt(program, timeMS) {
  if (!Number.isFinite(timeMS)) throw new TypeError('时序时间必须是有限数。');
  const t = Math.max(0, Math.min(timeMS, program.durationMS));
  const index = program.stages.findIndex(s => t < s.endMS);
  const stageIndex = index < 0 ? program.stages.length - 1 : index;
  const stage = program.stages[stageIndex], c = program.config;
  const elapsedMS = t - stage.startMS;
  const u = t === stage.endMS ? 1 : Math.min(1, Math.max(0, elapsedMS / stage.durationMS));
  const blueOn = c.blueEnabled && stageIndex <= 1;
  const greenOn = c.greenEnabled;
  const blueScale = blueOn ? (stageIndex === 1 ? 1 - u : 1) : 0;
  let oblique = c.greenObliqueMW, horizontal = c.greenHorizontalMW;
  let greenDetuningMHz = c.receiveMHz, gradientGCM = c.receiveGradient;
  if (stageIndex === 0) {
    greenDetuningMHz = c.shieldingMHz;
    gradientGCM = c.loadGradient;
  } else if (stageIndex === 1) {
    gradientGCM = c.loadGradient + (c.receiveGradient - c.loadGradient) * u;
  } else if (stageIndex === 3) {
    greenDetuningMHz = c.compressMHz;
    gradientGCM = c.receiveGradient + (c.finalGradient - c.receiveGradient) * u;
    oblique = greenRamp(oblique, c.finalObliqueUW / 1000, u, c.powerRamp);
    horizontal = greenRamp(horizontal, c.finalHorizontalUW / 1000, u, c.powerRamp);
  }
  return { stageIndex, stageId: stage.id, elapsedMS, timeMS: t, blueOn, greenOn,
    bluePowersMW: sixBeams(c.blueObliqueMW * blueScale, c.blueHorizontalMW * blueScale),
    greenPowersMW: sixBeams(greenOn ? oblique : 0, greenOn ? horizontal : 0),
    blueDetuningMHz: c.blueDetuningMHz, greenDetuningMHz, gradientGCM };
}
