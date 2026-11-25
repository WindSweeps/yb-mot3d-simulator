import { compileSequence, SEQUENCE_FIELDS } from './sequence.js';

// 等比波形要求功率严格为正；朝零移动时保留正值并让步长继续缩小。
const rampPowers = new Set(['greenObliqueMW', 'greenHorizontalMW', 'finalObliqueUW', 'finalHorizontalUW']);

export async function optimizeSequence({
  config, variables, direction, maxEvaluations = 60, evaluate, onProgress, signal, isFeasible = () => true,
}) {
  const initial = compileSequence(config).config;
  if (!['max', 'min'].includes(direction)) throw new RangeError('请选择最大化或最小化。');
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1) throw new RangeError('模拟次数必须为正整数。');
  if (!Array.isArray(variables) || !variables.length || new Set(variables).size !== variables.length)
    throw new RangeError('请选择至少一个互不重复的操作变量。');
  const axes = variables.map(key => {
    if (!Object.hasOwn(SEQUENCE_FIELDS, key) || !Number.isFinite(initial[key]))
      throw new RangeError('时序中没有这个数值变量：' + key);
    const [, , min, max] = SEQUENCE_FIELDS[key];
    return {key, min, max, positive:initial.powerRamp === 'geometric' && rampPowers.has(key)};
  });
  const sign = direction === 'max' ? 1 : -1;
  const state = {evaluations:0, iteration:0, baseline:null, bestValue:null, bestConfig:null, lastValue:null, lastConfig:null};
  const scores = new Map();
  const finished = () => signal?.aborted || state.evaluations >= maxEvaluations;
  const end = reason => ({...state, reason:signal?.aborted ? 'stopped' : reason});

  async function sample(candidate) {
    if (finished() || !isFeasible(candidate)) return null;
    const id = JSON.stringify(axes.map(axis => candidate[axis.key]));
    if (scores.has(id)) return scores.get(id);
    state.evaluations++;
    let value;
    try {
      value = await evaluate(candidate);
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    }
    if (value !== null && !Number.isFinite(value)) throw new RangeError('目标值必须是有限数值，缺少样本时请返回 null。');
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
  // 离散捕获数可能在小范围内恒定。扩大一次差分范围，再细化近邻搜索。
  const radii = [.25, 1, .0625, .015625];
  let stalled = 0;
  while (!finished() && stalled < radii.length) {
    state.iteration++;
    const base = state.bestConfig, baseValue = state.bestValue;
    const radius = radii[stalled];
    const scales = axes.map(({key, min, max}) => Math.min(max - min, Math.max(1, Math.abs(base[key]))));
    function displaced(i, step) {
      const {key, min, max, positive} = axes[i];
      const value = Math.max(min, Math.min(max, base[key] + step * scales[i]));
      return positive && value === 0 ? base[key] / 2 : value;
    }
    const gradient = [];
    for (let i = 0; i < axes.length && !finished(); i++) {
      const {key, min, max} = axes[i];
      const left = displaced(i, -radius/4), right = displaced(i, radius/4);
      const a = left === base[key] ? baseValue : await sample({...base, [key]:left});
      const b = right === base[key] ? baseValue : await sample({...base, [key]:right});
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
        const value = await sample(candidate);
        if (value !== null && sign * (value - baseValue) > 0) break;
      }
    }
    stalled = state.bestValue === baseValue ? stalled + 1 : 0;
  }
  return end(state.evaluations >= maxEvaluations ? 'budget' : 'stationary');
}
