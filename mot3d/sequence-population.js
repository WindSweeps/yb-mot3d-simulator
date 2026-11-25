import { sequenceAt } from './sequence.js';

// Li 等表 II 的总原子数拟合；β 的单位为每原子每秒。
const lossRates = {
  blue:     { load: [1.3, 27e-9],   hold: [.54, 44e-9] },
  green:    { load: [.012, 0],      hold: [.012, 0] },
  twoColor: { load: [.53, 1.7e-9],  hold: [.21, 1e-9] },
  // 暗场只保留背景损失，以论文给出的上限估计。
  dark:     { load: [.012, 0],      hold: [.012, 0] },
};

export function sequenceLossStages(program, settings = {}) {
  return program.stages.map(({id, startMS, durationMS}) => {
    // 中点避开关断瞬间及压缩斜坡端点，区分实际有光与开关开启但功率为零。
    const channels = sequenceAt(program, startMS + durationMS / 2);
    const blue = channels.bluePowersMW.some(power => power > 0);
    const green = channels.greenPowersMW.some(power => power > 0);
    const light = blue ? (green ? 'twoColor' : 'blue') : (green ? 'green' : 'dark');
    const [defaultAlpha, defaultBeta] = lossRates[light][id === 'load' ? 'load' : 'hold'];
    const alpha = settings[id === 'load' ? 'alpha' : id + 'Alpha'] ?? defaultAlpha;
    const beta = settings[id === 'load' ? 'beta' : id + 'Beta'] ?? defaultBeta;
    if (![alpha, beta].every(value => Number.isFinite(value) && value >= 0))
      throw new RangeError('损失系数必须是有限的非负数。');
    return {id, light, alpha, beta};
  });
}

// 把 ms 换算成 s 时先缩小较大的因子，保留极短装载时间的有效数字。
function rateTimesMS(rate, timeMS) {
  return rate >= timeMS ? (rate / 1000) * timeMS : rate * (timeMS / 1000);
}

function loadingRates(rate, alpha, beta) {
  // λ = √(α² + 4βR)。用共同的速率单位计算，避免平方溢出。
  const pairRate = Math.sqrt(beta) * Math.sqrt(rate);
  const scale = Math.max(alpha, pairRate);
  const a = alpha / scale;
  return {scale, a, lambda:Math.hypot(a, 2 * (pairRate / scale))};
}

// dN/dt = R − αN − βN²，N(0)=0。返回连续模型的原子数期望值。
export function loadPopulation(timeMS, flux, captureProbability, alpha, beta) {
  for (const [name, value] of Object.entries({ timeMS, flux, captureProbability, alpha, beta })) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} 必须是有限的非负数。`);
  }
  if (captureProbability > 1) throw new RangeError('捕获概率必须在 0 至 1 之间。');
  const rate = flux * captureProbability;
  if (rate === 0 || timeMS === 0) return 0;
  if (alpha === 0 && beta === 0) return rateTimesMS(rate, timeMS);

  const {scale, a, lambda} = loadingRates(rate, alpha, beta);
  const x = rateTimesMS(scale, timeMS) * lambda;
  const growth = -Math.expm1(-x);
  const denominator = lambda + a + (lambda - a) * Math.exp(-x);
  if (x <= 1) {
    // 短时间从 Rt 展开；即使稳态原子数超出浮点范围，也能求出初始装载量。
    const fraction = x === 0 ? 1 : Math.min(1, (growth / x) * (2 * lambda / denominator));
    const injected = rateTimesMS(rate, timeMS);
    return Number.isFinite(injected) ? injected * fraction : rateTimesMS(rate * fraction, timeMS);
  }
  const fraction = 2 * growth / denominator;
  const scaledPopulation = rate / scale;
  return Number.isFinite(scaledPopulation) ? scaledPopulation * fraction : (rate * fraction) / scale;
}

// 断流保持的式 (3)。区间内有 C 条阱内轨迹，N=Cw，故 dw/dt=−αw−βCw²。
// 单条轨迹的权重跨帧连续，瞬时进出阱的原子数由实际轨迹计数另行反映。
export function holdWeight(weight, count, timeMS, alpha, beta) {
  if (weight === 0 || timeMS === 0) return weight;
  const seconds = timeMS / 1000;
  const x = alpha * seconds;
  const integral = x === 0 ? seconds : -Math.expm1(-x) / alpha;
  return (weight * Math.exp(-x)) / (1 + beta * count * integral * weight);
}

function loadingTimeConstant(rate, alpha, beta) {
  if (rate === 0) return {status:'empty', timeMS:null};
  if (alpha === 0 && beta === 0) return {status:'no-steady-state', timeMS:null};
  const {scale, a, lambda} = loadingRates(rate, alpha, beta);
  // 装载解满足 N/N∞=(1−exp(−λt))/(1+q exp(−λt))，取 N/N∞=1−1/e。
  const q = (lambda - a) / (lambda + a);
  const timeMS = (1000 / lambda) * (1 + Math.log1p(-Math.expm1(-1) * q)) / scale;
  return Number.isFinite(timeMS) ? {status:'reached', timeMS} : {status:'out-of-range', timeMS:null};
}

function lossTimeConstant(intervals, endMS, finalWeight, finalCount, loaded) {
  if (loaded === 0) return {status:'empty', timeMS:null};
  const target = loaded / Math.E, shutoff = intervals[0].start;
  // 解析权重逐帧递推。判定帧沿恰好达到阈值时，计入已经累积的浮点舍入误差。
  const reachesAtFrame = (atoms, index) => atoms <= target * (1 + 4 * (index+1) * Number.EPSILON);
  for (let i = 0; i < intervals.length; i++) {
    const {start, count, weight, alpha, beta} = intervals[i], next = intervals[i+1];
    const elapsed = start - shutoff;
    if (reachesAtFrame(weight * count, i)) return {status:'reached', timeMS:elapsed};
    // 帧内计数固定，N 单调衰减。帧沿使用新计数，因此跳变发生在观察帧时刻。
    if ((next?.weight ?? finalWeight) * count < target) {
      let lo = 0, hi = (next?.start ?? endMS) - start;
      while (true) {
        const mid = lo + (hi - lo) / 2;
        if (mid === lo || mid === hi) break;
        if (holdWeight(weight, count, mid, alpha, beta) * count <= target) hi = mid;
        else lo = mid;
      }
      return {status:'reached', timeMS:elapsed + hi};
    }
  }
  return {status:reachesAtFrame(finalWeight * finalCount, intervals.length) ? 'reached' : 'lower-bound', timeMS:endMS - shutoff};
}

export function sequencePopulation(program, result, settings) {
  const {n: incident, summary: {N0: captured, N1, N2}, timesMS, metrics} = result;
  const {flux} = settings;
  if (!Number.isInteger(incident) || incident < 1 || !Number.isInteger(captured) || captured < 0 || captured > incident)
    throw new RangeError('捕获轨迹数须在零和入射轨迹总数之间。');
  if (!timesMS.length || timesMS.length !== metrics.length || timesMS[0] !== 0)
    throw new RangeError('时序损失计算需要从零开始且与阱内轨迹计数对应的观察时刻。');
  for (let i = 0; i < timesMS.length; i++) {
    if (!Number.isFinite(timesMS[i]) || (i > 0 && timesMS[i] <= timesMS[i - 1]) ||
        !Number.isInteger(metrics[i].count) || metrics[i].count < 0 || metrics[i].count > incident)
      throw new RangeError('观察时刻必须严格递增，每帧阱内轨迹计数须在抽样范围内。');
  }
  const stages = sequenceLossStages(program, settings).map((rates, i) => ({...program.stages[i], ...rates}));
  const load = stages[0];
  const p = captured / incident;
  const loaded = loadPopulation(load.durationMS, flux, p, load.alpha, load.beta);
  // 在精确的物理阶段边界和观察帧上分段。帧内沿用左端阱内计数，与成像一致。
  const starts = new Set(stages.slice(1).map(stage => stage.startMS));
  for (const time of timesMS)
    if (time > load.endMS && time < program.durationMS) starts.add(time);
  const boundaries = [...starts, program.durationMS].sort((a, b) => a - b);
  const intervals = [];
  let weight = captured > 0 ? loaded / captured : 0;
  let frame = 0, stage = 1;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i];
    while (frame + 1 < timesMS.length && timesMS[frame + 1] <= start) frame++;
    while (stage + 1 < stages.length && stages[stage].endMS <= start) stage++;
    const count = timesMS[frame] < load.endMS ? captured : metrics[frame].count;
    const {alpha, beta} = stages[stage];
    intervals.push({start, count, weight, alpha, beta});
    weight = holdWeight(weight, count, boundaries[i + 1] - start, alpha, beta);
  }
  const finalWeight = weight;
  function weightAt(timeMS, trapped) {
    if (!Number.isFinite(timeMS) || timeMS < 0) throw new RangeError('时序时间必须为有限的非负数。');
    if (timeMS < load.endMS)
      return trapped > 0 ? loadPopulation(timeMS, flux, p, load.alpha, load.beta) / trapped : 0;
    if (timeMS >= program.durationMS) return finalWeight;
    const interval = intervals.findLast(row => row.start <= timeMS);
    return holdWeight(interval.weight, interval.count, timeMS - interval.start, interval.alpha, interval.beta);
  }
  function at(timeMS, trapped) {
    if (timeMS < load.endMS) return loadPopulation(timeMS, flux, p, load.alpha, load.beta);
    return weightAt(timeMS, trapped) * trapped;
  }
  function timeConstants() {
    return {
      loading:loadingTimeConstant(flux * p, load.alpha, load.beta),
      loss:lossTimeConstant(intervals, program.durationMS, finalWeight, metrics.at(-1).count, loaded),
    };
  }
  return {at, weightAt, loaded, timeConstants,
    estimatedAtoms: {N0:loaded, N1:at(program.checkpointTimesMS[1], N1), N2:finalWeight * N2}};
}
