import { compileSequence } from './sequence.js';
import { experimentControls, readControl } from './sequence-controls.js';
import { IMAGING_DEFAULTS } from './sequence-imaging.js';
import { sequenceObservation } from './sequence-observation.js';
import { opticalObjectives } from './sequence-optical-objectives.js';
import { cloudObjectives } from './sequence-cloud-objectives.js';

const sum = values => values.reduce((a, b) => a + b, 0);
const percent = (a, b) => b > 0 ? 100 * (a / b) : null;
const axes = ['X', 'Y', 'Z'];

function objectiveList(experiment, program) {
  const list = [], blueOnly = program.config.mode === 'blue-only';
  const calibrated = Math.min(20, program.stages[0].endMS);
  let group = '原子云';
  function add(id, label, unit, read, options = {}) {
    list.push({id, label, unit, group, read, ...options});
  }
  add('psd', '峰值 PSD', '', c => c.psd);
  add('atoms', '阱内原子数', '原子', c => c.atoms);
  add('temperatureUK', '动能温度', 'µK', c => c.cloud.temperatureUK);
  add('rmsRadiusMM', '云团 RMS 半径', 'mm', c => c.cloud.rmsRadiusMM);
  add('count', '阱内模拟轨迹数', '条', c => c.cloud.count);
  for (const [i, axis] of axes.entries())
    add('centroid' + axis, '云团质心 ' + axis, 'mm', c => c.cloud.centroidMM?.[i] ?? null);
  list.push(...cloudObjectives());

  group = '时序通道';
  add('elapsedMS', '当前阶段已运行时间', 'ms', c => c.channels.elapsedMS);
  for (const stage of program.stages)
    add('stage.' + stage.id, '处于' + stage.label + '阶段', '0 / 1', c => Number(c.channels.stageId === stage.id));
  add('sourceOn', '入射原子束开启', '0 / 1', c => Number(c.channels.stageId === 'load'));
  for (const [key, nm] of blueOnly ? [['blue',399]] : [['blue',399],['green',556]]) {
    add(key + 'On', nm + ' nm 光闸开启', '0 / 1', c => Number(c.channels[key + 'On']));
    add(key + 'TotalMW', nm + ' nm 六束总功率', 'mW', c => sum(c.channels[key + 'PowersMW']));
    add(key + 'ObliqueAtMW', nm + ' nm 斜光每束功率', 'mW', c => c.channels[key + 'PowersMW'][0]);
    add(key + 'HorizontalAtMW', nm + ' nm 水平光每束功率', 'mW', c => c.channels[key + 'PowersMW'][4]);
    add(key + 'AtMHz', nm + ' nm 瞬时失谐', 'MHz', c => c.channels[key + 'DetuningMHz']);
  }
  group = '磁场';
  add('gradientGCM', '主轴瞬时梯度', 'G/cm', c => c.channels.gradientGCM);
  for (const [i, axis] of axes.entries()) {
    add('bias' + axis, axis + ' 偏置磁场', 'G', c => c.geometry.biasG[i]);
    add('gradient' + axis, axis + ' 方向梯度', 'G/cm', c => c.geometry.mainTensor[i] * c.channels.gradientGCM);
    add('fieldZero' + axis, '磁场零点 ' + axis, 'mm', c => c.center?.[i] ?? null);
    add('cloudField' + axis, '云团质心磁场 ' + axis, 'G', c => c.cloudField?.[i] ?? null);
  }
  add('cloudFieldNorm', '云团质心磁场大小', 'G', c => c.cloudField ? Math.hypot(...c.cloudField) : null);
  list.push(...opticalObjectives(program.config));

  group = '装载与损失';
  add('sourceFlux', '当前入射原子通量', '原子/s', c => c.channels.stageId === 'load' ? experiment.loading.flux : 0);
  add('loadingRate', '装载率 Φp', '原子/s', c => c.population.loadingRate, {availableFromMS:calibrated});
  add('steadyState', '装载稳态原子数', '原子', c => c.population.steadyState, {availableFromMS:calibrated});
  add('loadingTauMS', '装载时间常数 τ（稳态的 63.2%）', 'ms', c => c.population.timeConstants().loading.timeMS,
    {availableFromMS:calibrated});
  add('lossTauMS', '损失时间常数 τ（已降至关源时的 1/e）', 'ms', c => {
    const loss = c.population.timeConstants().loss;
    return loss.status === 'reached' && c.timeMS >= program.stages[0].endMS + loss.timeMS ? loss.timeMS : null;
  }, {availableFromMS:program.stages[0].endMS});
  add('alpha', '当前阶段有效单体损失系数 α', 's⁻¹', c => c.loss.alpha);
  add('backgroundLossRate', '分支以外的单体损失系数', 's⁻¹', c => c.loss.background);
  add('branchLossRate', '光学分支损失系数', 's⁻¹', c => c.loss.branchLossRate);
  add('darkBranches.blueP0', '399 nm 累计进入 ³P₀ 的轨迹数', '条', c => c.cloud.darkBranches.blueP0);
  add('darkBranches.blueP2', '399 nm 累计进入 ³P₂ 的轨迹数', '条', c => c.cloud.darkBranches.blueP2);
  if (!blueOnly) add('darkBranches.greenP0', '556 nm 累计进入 ³P₀ 的轨迹数', '条', c => c.cloud.darkBranches.greenP0);
  add('beta', '当前阶段有效双体损失系数 β', '(原子·s)⁻¹', c => c.loss.beta);
  add('oneBodyLoss', '单体损失速率 αN', '原子/s', c => c.loss.alpha * c.atoms);
  add('twoBodyLoss', '双体损失速率 βN²', '原子/s', c => c.loss.beta * c.atoms ** 2);

  group = '阶段检查点';
  const labels = ['装载结束 N₀', blueOnly ? '保持中点 N₁' : '纯绿接收结束 N₁', blueOnly ? '保持结束 N₂' : '压缩结束 N₂'];
  for (const [i, label] of labels.entries()) {
    const key = 'N' + i, when = {availableFromMS:program.checkpointTimesMS[i]};
    add(key + '.atoms', label + ' · 原子数', '原子', c => c.population.estimatedAtoms[key], when);
    add(key + '.count', label + ' · 留存轨迹数', '条', c => c.result.summary[key], when);
    add(key + '.efficiency', label + (i ? ' · 相对上一检查点原子数' : ' · 入射轨迹捕获效率'), '%', c =>
      i ? percent(c.population.estimatedAtoms[key], c.population.estimatedAtoms['N' + (i-1)])
        : percent(c.result.summary.N0, c.result.n), when);
    const diagnostics = c => c.result.samplingDiagnostics.stages[key];
    for (const [id, text] of [['fromPrevious','相对进入本段轨迹'], ['fromSource','相对入射轨迹']]) {
      add(key + '.' + id + '.fraction', label + ' · ' + text + '的留存率', '%', c => {
        const value = diagnostics(c)[id].fraction;
        return value === null ? null : 100 * value;
      }, when);
      add(key + '.' + id + '.mcse', label + ' · ' + text + '的抽样标准误', '百分点', c => {
        const value = diagnostics(c)[id].mcse;
        return value === null ? null : 100 * value;
      }, when);
    }
  }
  add('transfer', '关源后总留存效率 N₂ / N₀', '%', c => percent(c.population.estimatedAtoms.N2, c.population.estimatedAtoms.N0),
    {availableFromMS:program.durationMS});

  group = '相机曝光';
  const mode = experiment.imaging?.mode ?? IMAGING_DEFAULTS.mode;
  add('cameraOn', '相机开启', '0 / 1', () => Number(mode !== 'off'));
  add('exposedUS', '已覆盖的曝光窗口', 'µs', c => mode === 'off' ? null : Math.min(experiment.imaging.exposureUS, 1000 * c.timeMS));
  add('exposureStartMS', '曝光窗口起点', 'ms', c => mode === 'off' ? null : Math.max(0, c.timeMS - experiment.imaging.exposureUS / 1000));
  add('camera.weightedAtoms', '视场内原子数（荧光按曝光平均）', '原子', c => c.image.weightedAtoms, {sampling:'camera'});
  add('camera.pixelSize', '物方像素尺寸', 'µm', c => c.image.pixelSizeUM, {sampling:'camera'});
  for (const requiredImagingMode of ['fluorescence','absorption']) {
    const fluorescence = requiredImagingMode === 'fluorescence';
    group = fluorescence ? '荧光相机' : '吸收相机';
    const image = {sampling:'camera', requiredImagingMode};
    const peaks = fluorescence ? [['emission','物方发射峰值','光子/像素'],['signal','相机荧光峰值','光电子/像素']]
      : [['atoms','有原子帧峰值','光电子/像素'],['reference','参考帧峰值','光电子/像素'],
        ['dark','暗场帧峰值','光电子/像素'],['od','峰值光学厚度','OD']];
    for (const [key, label, unit] of peaks)
      add('camera.' + key, label, unit, c => c.image.peaks[key], image);
    add('camera.' + requiredImagingMode + '.total', fluorescence ? '全视场荧光信号' : '全视场探针衰减', '光电子', c => c.image.totalSignal, image);
    if (!fluorescence) {
      add('camera.odLimit', '可分辨光学厚度上限', 'OD', c => c.image.odLimit, image);
      add('camera.clipped', '达到探测上限的像素数', '像素', c => c.image.clippedPixels, image);
      add('camera.referenceSignal', '扣除暗场的探针参考信号', '光电子/像素', c => c.image.referenceSignal, image);
    }
  }

  for (const control of experimentControls(experiment)) {
    group = '输入 · ' + control.group;
    const id = 'input.' + control.id;
    if (control.kind === 'choice' && control.choices.some(choice => typeof choice.value === 'string')) {
      for (const {value, label} of control.choices)
        add(id + '=' + value, control.label + '为' + label, '0 / 1', () => Number(readControl(experiment, control.id) === value));
    } else {
      const binary = control.choices?.every(choice => typeof choice.value === 'boolean');
      add(id, control.label, binary ? '0 / 1' : control.unit, () => Number(readControl(experiment, control.id)));
    }
  }
  return list;
}

export function sequenceObjectives(experiment) {
  return objectiveList(experiment, compileSequence(experiment.config)).map(({read, sampling, ...metadata}) => metadata);
}

export function findSequenceObjective(experiment, program, id) {
  return objectiveList(experiment, program).find(item => item.id === id);
}

function availableAt(objective, imaging, timeMS) {
  if (timeMS < (objective.availableFromMS ?? 0)) return false;
  return objective.sampling !== 'camera' || (imaging.mode !== 'off' &&
    (!objective.requiredImagingMode || objective.requiredImagingMode === imaging.mode));
}

export function objectiveSampling(objective, imaging, timeMS) {
  const options = {metricsOnly:true, observeAtMS:timeMS};
  if (!availableAt(objective, imaging, timeMS)) return options;
  switch (objective.sampling) {
    case undefined: return options;
    case 'phaseSpace': return {...options, observeVelocity:true, recordFromMS:timeMS};
    case 'camera': return {...options, recordFromMS:imaging.mode === 'fluorescence'
      ? Math.max(0, timeMS - imaging.exposureUS / 1000) : timeMS};
    default: throw new RangeError('未知的目标采样方式。');
  }
}

export function scoreSequenceObjective(objective, experiment, program, result, timeMS) {
  const context = sequenceObservation(experiment, program, result, timeMS);
  const value = availableAt(objective, experiment.imaging, timeMS) ? objective.read(context) : null;
  return {value:Number.isFinite(value) ? value : null, sampledAtMS:context.sampledAtMS};
}
