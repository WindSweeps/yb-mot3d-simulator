import { compileSequence, sequenceFieldsFor } from './sequence.js';

// 等比波形要求功率严格为正；朝零移动时保留正值并让步长继续缩小。
const rampPowers = new Set(['greenObliqueMW', 'greenHorizontalMW', 'finalObliqueUW', 'finalHorizontalUW']);

export async function optimizeSequence({
  config, variables, direction, timeMS = 0, maxEvaluations = 60, evaluate, onProgress, signal, isFeasible = () => true,
}) {
  const program = compileSequence(config), initial = program.config;
  if (!Number.isFinite(timeMS) || timeMS < 0 || timeMS > program.durationMS)
    throw new RangeError('目标时刻必须位于起始时序内。');
  if (!['max', 'min'].includes(direction)) throw new RangeError('请选择最大化或最小化。');
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1) throw new RangeError('模拟次数必须为正整数。');
  if (!Array.isArray(variables) || !variables.length || new Set(variables).size !== variables.length)
    throw new RangeError('请选择至少一个互不重复的操作变量。');
  const fields = sequenceFieldsFor(initial);
  const axes = variables.map(key => {
    if (!Object.hasOwn(fields, key) || !Number.isFinite(initial[key]))
      throw new RangeError('时序中没有这个数值变量：' + key);
    const [, , min, max] = fields[key];
    return {key, min, max, positive:initial.mode !== 'blue-only' && initial.powerRamp === 'geometric' && rampPowers.has(key)};
  });
  const sign = direction === 'max' ? 1 : -1;
  const durationKeys = program.stages.map(stage => stage.id + 'MS');
  const durationAxes = axes.filter(axis => durationKeys.includes(axis.key));
  const totalTime = sequence => durationKeys.reduce((sum, key) => sum + sequence[key], 0);
  const state = {evaluations:0, iteration:0, baseline:null, bestValue:null, bestConfig:null, lastValue:null, lastConfig:null};
  const scores = new Map();
  const finished = () => signal?.aborted || state.evaluations >= maxEvaluations;
  const end = reason => ({...state, reason:signal?.aborted ? 'stopped' : reason});

  async function sample(candidate) {
    if (finished() || !isFeasible(candidate)) return null;
    const id = JSON.stringify(axes.map(axis => candidate[axis.key]));
    if (scores.has(id)) return scores.get(id);
    let value;
    try {
      value = await evaluate(candidate);
    } catch (error) {
      if (signal?.aborted && error.name === 'AbortError') return null;
      throw error;
    }
    if (value !== null && !Number.isFinite(value)) throw new RangeError('目标值必须是有限数值，缺少样本时请返回 null。');
    state.evaluations++;
    scores.set(id, value);
    state.lastConfig = candidate;
    state.lastValue = value;
    if (state.evaluations === 1) state.baseline = value;
    if (value !== null && (state.bestValue === null || sign * (value - state.bestValue) > 0)) {
      state.bestConfig = candidate;
      state.bestValue = value;
    }
    onProgress?.({...state});
    return value;
  }

  await sample(initial);
  if (state.bestValue === null) return end('unavailable');
  // 先检验工作点附近的多个尺度，离散计数在这些尺度恒定时再逐次扩大差分范围。
  const localRadii = [.25, 1, .0625, .015625];
  let stalled = 0;
  while (!finished()) {
    state.iteration++;
    const base = state.bestConfig, baseValue = state.bestValue;
    const radius = localRadii[stalled] ?? 2 ** (stalled - localRadii.length + 1);
    const scales = axes.map(({key, min, max}) => Math.min(max - min, Math.max(1, Math.abs(base[key]))));
    const weights = durationAxes.map(axis => scales[axes.indexOf(axis)] ** 2);
    // 在归一化坐标中投影到总时长 ≥ 目标时刻。多阶段同时缩短时，沿可行边界分配时长。
    function projectTime(candidate) {
      if (!durationAxes.length || totalTime(candidate) >= timeMS) return candidate;
      let low = 0, high = 0;
      const feasible = {...candidate};
      durationAxes.forEach(({key, max}, i) => {
        feasible[key] = max;
        high = Math.max(high, (max - candidate[key]) / weights[i]);
      });
      const trial = {...candidate};
      for (let j = 0; j < 64; j++) {
        const mid = (low + high) / 2;
        if (mid === low || mid === high) break;
        durationAxes.forEach(({key, max}, i) => { trial[key] = Math.min(max, candidate[key] + mid * weights[i]); });
        if (totalTime(trial) < timeMS) low = mid;
        else {
          high = mid;
          for (const {key} of durationAxes) feasible[key] = trial[key];
        }
      }
      // 单个阶段恰在目标边界时，避免把时序求和的舍入误差识别为新的试算点。
      const snapped = {...feasible};
      for (const {key} of durationAxes)
        if (Math.abs(feasible[key] - base[key]) <= 4 * Number.EPSILON * Math.max(1, timeMS)) snapped[key] = base[key];
      return totalTime(snapped) >= timeMS ? snapped : feasible;
    }
    function displaced(i, step) {
      const {key, min, max, positive} = axes[i];
      const delta = step * scales[i];
      // 等比斜坡的功率下界是开区间。大步减小时从半功率开始指数接近零，连接处斜率连续。
      if (positive && delta < -.5 * base[key]) {
        const fraction = Math.max(Number.EPSILON, .5 * Math.exp(1 + 2 * delta / base[key]));
        return Math.max(Number.MIN_VALUE, base[key] * fraction);
      }
      return Math.max(min, Math.min(max, base[key] + delta));
    }
    const gradient = [];
    for (let i = 0; i < axes.length && !finished(); i++) {
      const {key, min, max} = axes[i];
      const left = displaced(i, -radius/4), right = displaced(i, radius/4);
      const a = left === base[key] ? baseValue : await sample(projectTime({...base, [key]:left}));
      const b = right === base[key] ? baseValue : await sample(projectTime({...base, [key]:right}));
      const span = (b === null ? base[key] : right) - (a === null ? base[key] : left);
      // 缺少一侧有效读数时使用单侧导数，两侧均无数据时保留原值。
      let slope = span > 0 ? sign * ((b ?? baseValue) - (a ?? baseValue)) / (span / scales[i]) : 0;
      if ((base[key] === min && slope < 0) || (base[key] === max && slope > 0)) slope = 0;
      gradient.push(slope);
    }
    const norm = Math.hypot(...gradient);
    if (norm > 0 && !finished()) {
      for (let step = radius; step >= radius/64 && !finished(); step /= 2) {
        const candidate = {...base};
        axes.forEach(({key}, i) => { candidate[key] = displaced(i, step * gradient[i] / norm); });
        const value = await sample(projectTime(candidate));
        if (value !== null && sign * (value - baseValue) > 0) break;
      }
    }
    if (state.bestValue !== baseValue) stalled = 0;
    else {
      const coversBounds = axes.every(({key, min, max, positive}, i) =>
        radius * scales[i] / 4 >= Math.max(positive ? 20 * base[key] : base[key] - min, max - base[key]));
      if (stalled >= localRadii.length && coversBounds) break;
      stalled++;
    }
  }
  return end(state.evaluations >= maxEvaluations ? 'budget' : 'stationary');
}
