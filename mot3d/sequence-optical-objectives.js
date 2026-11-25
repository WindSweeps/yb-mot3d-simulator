import { BEAM_LABELS, BLUE_TRANSITION, CONSTANTS } from './physics.js';
import { GREEN_TRANSITION, prepareSequenceRadiation, saturationIntensity } from './sequence-physics.js';

const lines = [['blue', '399 nm', BLUE_TRANSITION], ['green', '556 nm', GREEN_TRANSITION]];
const axes = ['X', 'Y', 'Z'];
const angularToMHz = 1e-6 / (2 * Math.PI);
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const workRateYW = (acceleration, velocity) => CONSTANTS.mass * dot(acceleration, velocity) * 1e24;

// 逐原子计算再对阱内样本取平均，保留速度、多普勒频移、光力分量的正负号。
function catalog(blueOnly) {
  const descriptors = [];
  function add(key, label, unit, group, read) {
    descriptors.push({id:'optical.' + key, label, unit, group, sampling:'phaseSpace',
      read:observation => meanTrapped(observation, read)});
  }
  const forceGroup = '阱内平均光力与布居';
  for (const [i, axis] of axes.entries()) {
    add('force.' + axis, '光力 ' + axis + ' 分量', 'zN', forceGroup,
      atom => (atom.radiation.blue[i] + atom.radiation.green[i]) * CONSTANTS.mass * 1e21);
    add('acceleration.' + axis, '含重力的加速度 ' + axis + ' 分量', 'm/s²', forceGroup,
      atom => atom.radiation.acceleration[i]);
  }
  add('forceMagnitude', '单原子光力大小的平均值', 'zN', forceGroup, ({radiation:r}) =>
    Math.hypot(r.blue[0]+r.green[0], r.blue[1]+r.green[1], r.blue[2]+r.green[2]) * CONSTANTS.mass * 1e21);
  add('groundFraction', '基态布居', '', forceGroup,
    ({radiation:r}) => 1 - r.blueRate / BLUE_TRANSITION.gamma - r.greenRate / GREEN_TRANSITION.gamma);
  add('fieldMagnitude', '原子位置处的平均磁场强度 |B|', 'G', forceGroup, atom => atom.spectrum.blue.fieldTesla * 1e4);
  add('mechanicalPower', '总光力做功功率 ⟨F·v⟩', 'yW', forceGroup, ({radiation, velocity}) =>
    workRateYW(radiation.blue, velocity) + workRateYW(radiation.green, velocity));

  for (const [color, name, line] of lines) {
    if (blueOnly && color === 'green') continue;
    const group = name + ' 阱内平均光场', shiftGroup = name + ' 阱内平均频移';
    add(color + '.excitedFraction', name + ' 激发态布居', '', forceGroup,
      atom => atom.radiation[color + 'Rate'] / line.gamma);
    add(color + '.scattering', name + ' 总散射率', 's⁻¹', group, atom => atom.radiation[color + 'Rate']);
    add(color + '.mechanicalPower', name + ' 光力做功功率 ⟨F·v⟩', 'yW', forceGroup,
      ({radiation, velocity}) => workRateYW(radiation[color], velocity));
    add(color + '.zeeman', name + ' 相邻磁子能级塞曼频移', 'MHz', shiftGroup, atom => atom.spectrum[color].zeeman * angularToMHz);
    const isat = saturationIntensity(line);
    for (const [j, beam] of BEAM_LABELS.entries()) {
      const prefix = color + '.' + j + '.', label = name + ' ' + beam + ' ';
      add(prefix + 'scattering', label + '散射率', 's⁻¹', group, atom => atom.radiation[color][3+j]);
      add(prefix + 'intensity', label + '光强', 'mW/cm²', group, atom => .1 * isat * atom.spectrum[color].saturation[j]);
      add(prefix + 'saturation', label + '饱和参数 I/Iₛₐₜ', '', group, atom => atom.spectrum[color].saturation[j]);
      add(prefix + 'doppler', label + '多普勒频移 k·v/2π', 'MHz', shiftGroup, atom => atom.spectrum[color].doppler[j] * angularToMHz);
      for (const [m, polarization] of [[-1,'σ⁻'],[0,'π'],[1,'σ⁺']]) {
        const index = 3*j + 1 + m;
        add(prefix + 'detuning.' + m, label + polarization + ' 有效失谐', 'MHz', shiftGroup,
          atom => atom.spectrum[color].detuning[index] * angularToMHz);
        add(prefix + 'polarization.' + m, label + polarization + ' 偏振权重', '', group,
          atom => atom.spectrum[color].polarization[index]);
      }
    }
  }
  return descriptors;
}

const twoColor = catalog(false), blue = catalog(true);
export const opticalObjectives = config => config.mode === 'blue-only' ? blue : twoColor;

function meanTrapped({experiment, result, channels, frame, cloud}, read) {
  if (!cloud.count) return null;
  const start = (frame - result.firstRecordedFrame) * result.n;
  if (!result.velocitiesMS || start < 0 || start + result.n > result.trapped.length)
    throw new RangeError('目标帧缺少光场计算所需的相空间样本。');
  const radiationAt = prepareSequenceRadiation(experiment.params, channels, {observeSpectrum:true});
  let sum = 0;
  for (let i = start; i < start + result.n; i++) {
    if (!result.trapped[i]) continue;
    const position = result.positionsM.subarray(3*i, 3*i+3);
    const velocity = result.velocitiesMS.subarray(3*i, 3*i+3);
    const radiation = radiationAt(position, velocity);
    sum += read({velocity, radiation, spectrum:radiation.spectrum});
  }
  return sum / cloud.count;
}
