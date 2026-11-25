import { compileSequence } from './sequence.js';
import { random } from './physics.js';
import { experimentControls, readControl, setControl } from './sequence-controls.js';

// 等比波形要求功率严格为正；朝零移动时保留正值并让步长继续缩小。
const rampPowers = new Set(['greenObliqueMW', 'greenHorizontalMW', 'finalObliqueUW', 'finalHorizontalUW']);

export async function optimizeSequence({
  config, experiment, variables, direction, timeMS = 0, maxEvaluations = 60, evaluate, onProgress, signal, isFeasible = () => true,
}) {
  const program = compileSequence(experiment ? experiment.config : config);
  const initial = {config:program.config, params:experiment?.params ?? {}, loading:experiment?.loading ?? {}, imaging:experiment?.imaging ?? {}};
  if (!Number.isFinite(timeMS) || timeMS < 0 || timeMS > program.durationMS)
    throw new RangeError('目标时刻必须位于起始时序内。');
  if (!['max', 'min'].includes(direction)) throw new RangeError('请选择最大化或最小化。');
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1) throw new RangeError('模拟次数必须为正整数。');
  if (!Array.isArray(variables) || !variables.length || new Set(variables).size !== variables.length)
    throw new RangeError('请选择至少一个互不重复的操作变量。');
  const controls = new Map(experimentControls(initial).map(control => [control.id, control]));
  const selected = variables.map(key => {
    const control = controls.get(key);
    if (!control || (!experiment && key.includes('.'))) throw new RangeError('当前时序没有这个操作变量：' + key);
    const value = readControl(initial, key);
    if (control.kind === 'number' ? !Number.isFinite(value) || value < control.min || value > control.max
      : !control.choices.some(item => item.value === value)) throw new RangeError('操作变量的起始值超出有效范围：' + key);
    return {...control,key};
  });
  const axes = selected.filter(axis => axis.kind === 'number');
  const choices = selected.filter(axis => axis.kind === 'choice');
  const choiceTrials = choices.reduce((sum, axis) => sum + axis.choices.length - 1, 0);
  const perturbations = random(174399556);
  const sign = direction === 'max' ? 1 : -1;
  const durationKeys = program.stages.map(stage => stage.id + 'MS');
  const durationAxes = axes.filter(axis => durationKeys.includes(axis.key));
  const totalTime = sequence => durationKeys.reduce((sum, key) => sum + sequence[key], 0);
  const state = {evaluations:0, iteration:0, baseline:null, bestValue:null, bestConfig:null, lastValue:null, lastConfig:null,
    bestExperiment:null, lastExperiment:null};
  const scores = new Map();
  const finished = () => signal?.aborted || state.evaluations >= maxEvaluations;
  const end = reason => ({...state, reason:signal?.aborted ? 'stopped' : reason});

  async function sample(candidate) {
    if (finished()) return null;
    if (candidate.config.powerRamp === 'geometric' && candidate.config.mode !== 'blue-only' &&
        [...rampPowers].some(key => candidate.config[key] <= 0)) return null;
    const input = experiment ? candidate : candidate.config;
    if (!isFeasible(input)) return null;
    const id = JSON.stringify(selected.map(axis => readControl(candidate,axis.key)));
    if (scores.has(id)) return scores.get(id);
    let value;
    try {
      value = await evaluate(input);
    } catch (error) {
      if (signal?.aborted && error.name === 'AbortError') return null;
      throw error;
    }
    if (value !== null && !Number.isFinite(value)) throw new RangeError('目标值必须是有限数值，缺少样本时请返回 null。');
    state.evaluations++;
    scores.set(id, value);
    state.lastExperiment = candidate;
    state.lastConfig = candidate.config;
    state.lastValue = value;
    if (state.evaluations === 1) state.baseline = value;
    if (value !== null && (state.bestValue === null || sign * (value - state.bestValue) > 0)) {
      state.bestExperiment = candidate;
      state.bestConfig = candidate.config;
      state.bestValue = value;
    }
    onProgress?.({...state});
    return value;
  }

  await sample(initial);
  if (state.bestValue === null && !experiment) return end('unavailable');
  // 先检验工作点附近的多个尺度，离散计数在这些尺度恒定时再逐次扩大差分范围。
  const localRadii = [.25, 1, .0625, .015625];
  let stalled = 0;
  while (!finished()) {
    state.iteration++;
    const baseExperiment = state.bestExperiment ?? initial, baseValue = state.bestValue;
    const base = {...baseExperiment.config};
    for (const {key} of selected) base[key] = readControl(baseExperiment,key);
    const geometric = base.powerRamp === 'geometric' && base.mode !== 'blue-only';
    const radius = localRadii[stalled] ?? 2 ** (stalled - localRadii.length + 1);
    const scales = axes.map(({key, min, max, scale}) => Math.min(max - min, Math.max(scale, Math.abs(base[key]))));
    const weights = durationAxes.map(axis => scales[axes.indexOf(axis)] ** 2);
    // 在归一化坐标中投影到总时长 ≥ 目标时刻。多阶段同时缩短时，沿可行边界分配时长。
    function projectTime(candidate) {
      if (!durationAxes.length || totalTime(candidate) >= timeMS) return candidate;
      let low = 0, high = 0;
      const feasible = {...candidate};
      durationAxes.forEach(({key, max}, i) => {
        // 投影只需补足目标时刻；即使阶段没有时长上限，也有有限的二分端点。
        feasible[key] = Math.min(max, Math.max(candidate[key], timeMS));
        high = Math.max(high, (feasible[key] - candidate[key]) / weights[i]);
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
      const {key, min, max} = axes[i];
      const delta = step * scales[i];
      // 等比斜坡的功率下界是开区间。大步减小时从半功率开始指数接近零，连接处斜率连续。
      if (geometric && rampPowers.has(key) && delta < -.5 * base[key]) {
        const fraction = Math.max(Number.EPSILON, .5 * Math.exp(1 + 2 * delta / base[key]));
        return Math.max(Number.MIN_VALUE, base[key] * fraction);
      }
      return Math.max(min, Math.min(max, base[key] + delta));
    }
    function candidateExperiment(point) {
      let candidate = baseExperiment;
      for (const {key} of axes)
        if (point[key] !== base[key]) candidate = setControl(candidate, key, point[key]);
      return candidate;
    }
    async function tryChoices() {
      // 光闸、离散波形与装置的类别没有数值导数，逐个试算可选值。
      for (const {key,choices:options} of choices) {
        for (const {value} of options) {
          if (finished()) return;
          if (value !== base[key]) await sample(setControl(baseExperiment,key,value));
        }
      }
    }
    const simultaneous = experiment && selected.length >= 3 &&
      maxEvaluations - state.evaluations < 2 * axes.length + choiceTrials + 1;
    const gradient = [];
    if (simultaneous) {
      // 预算不足以逐坐标中心差分时，沿可复现的同时扰动方向试算，使全部选定轴参与这一轮。
      const plus = {...base}, minus = {...base};
      axes.forEach(({key,min,max}, i) => {
        const toward = base[key] === min ? 1 : base[key] === max ? -1 : perturbations.uniform() < .5 ? 1 : -1;
        plus[key] = displaced(i, toward * radius / 4);
        minus[key] = displaced(i, -toward * radius / 4);
      });
      const right = projectTime(plus), left = projectTime(minus);
      if (choices.length) {
        let combined = candidateExperiment(right);
        for (const {key,choices:options} of choices) {
          const alternatives = options.filter(option => option.value !== base[key]);
          const option = alternatives[Math.floor(perturbations.uniform() * alternatives.length)];
          combined = setControl(combined, key, option.value);
        }
        await sample(combined);
      }
      if (axes.length && !finished()) {
        const b = await sample(candidateExperiment(right)), a = await sample(candidateExperiment(left));
        axes.forEach(({key}, i) => {
          const span = (b === null ? base[key] : right[key]) - (a === null ? base[key] : left[key]);
          gradient.push(baseValue === null || span === 0 ? 0 : sign * ((b ?? baseValue) - (a ?? baseValue)) / (span / scales[i]));
        });
      }
    } else await tryChoices();
    for (let i = 0; !simultaneous && i < axes.length && !finished(); i++) {
      const {key, min, max} = axes[i];
      async function neighbor(step) {
        const request = displaced(i, step);
        const candidate = projectTime({...base, [key]:request});
        if (axes.every(axis => candidate[axis.key] === base[axis.key])) return [base[key], baseValue];
        const value = await sample(candidateExperiment(candidate));
        if (value === null) return [base[key], baseValue];
        // 单变量可行步用实际位移求导；多阶段共同移动时沿投影路径的原始方向求导。
        const coupled = durationAxes.some(axis => axis.key !== key && candidate[axis.key] !== base[axis.key]);
        return [coupled ? request : candidate[key], value];
      }
      const [left, a] = await neighbor(-radius/4), [right, b] = await neighbor(radius/4);
      const span = right - left;
      // 缺少一侧有效读数时使用单侧导数，两侧均无数据时保留原值。
      let slope = baseValue !== null && span > 0 ? sign * (b - a) / (span / scales[i]) : 0;
      if ((base[key] === min && slope < 0) || (base[key] === max && slope > 0)) slope = 0;
      gradient.push(slope);
    }
    const norm = Math.hypot(...gradient);
    if (norm > 0 && !finished()) {
      for (let step = radius; step >= radius/64 && !finished(); step /= 2) {
        const candidate = {...base};
        axes.forEach(({key}, i) => { candidate[key] = displaced(i, step * gradient[i] / norm); });
        const value = await sample(candidateExperiment(projectTime(candidate)));
        if (value !== null && sign * (value - baseValue) > 0) break;
      }
    }
    if (simultaneous && !finished()) await tryChoices();
    // 例如关闭蓝光且只探测绿光时，分别改变光闸或波段都得到零信号。
    // 单个坐标没有改善时再检查成对切换，全部读数沿用同一次搜索的预算和缓存。
    if (state.bestValue === baseValue && choices.length >= 2 && !finished()) {
      for (let i = 0; i < choices.length && state.bestValue === baseValue && !finished(); i++) {
        const a = choices[i];
        for (const x of a.choices) {
          if (x.value === base[a.key] || finished()) continue;
          const trial = setControl(baseExperiment, a.key, x.value);
          for (const b of choices.slice(i + 1)) {
            for (const y of b.choices) {
              if (y.value === base[b.key] || finished()) continue;
              await sample(setControl(trial, b.key, y.value));
            }
          }
        }
      }
    }
    if (state.bestValue !== baseValue) stalled = 0;
    else {
      // 单侧有界的变量在覆盖有限侧及当前尺度后结束无改善的扩展。
      const coversBounds = axes.every(({key, min, max}, i) =>
        radius * scales[i] / 4 >= Math.max(geometric && rampPowers.has(key) ? 20 * base[key] : base[key] - min,
          Number.isFinite(max) ? max - base[key] : scales[i]));
      if (!axes.length || (stalled >= localRadii.length && coversBounds)) break;
      stalled++;
    }
  }
  return end(state.bestValue === null ? 'unavailable' : state.evaluations >= maxEvaluations ? 'budget' : 'stationary');
}
