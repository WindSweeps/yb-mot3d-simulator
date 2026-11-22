// 轨迹采用每一输出时刻保存的坐标和散射率，直到下一帧生效。
export function sequenceFrameAt(timesMS, timeMS) {
  let lo = 0, hi = timesMS.length;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timesMS[mid] <= timeMS) lo = mid;
    else hi = mid;
  }
  return lo;
}

function cloudSamples(result, first, last, centerMM) {
  const start = first * result.n, end = (last + 1) * result.n;
  return {
    centerMM,
    positionsM: result.positionsM.subarray(3 * start, 3 * end),
    alive: result.trapped.subarray(start, end),
    blueRates: result.blueRates.subarray(start, end),
    greenRates: result.greenRates.subarray(start, end),
  };
}

export function fluorescenceExposure(result, endMS, exposureUS, centerMM, weightAt) {
  if (!(Number.isFinite(exposureUS) && exposureUS > 0)) throw new RangeError('曝光时间必须为正数。');
  const durationMS = exposureUS / 1000, startMS = Math.max(0, endMS - durationMS);
  const times = result.timesMS;
  const first = sequenceFrameAt(times, startMS);
  let last = sequenceFrameAt(times, endMS);
  if (last > first && times[last] === endMS) last--;
  const sample = cloudSamples(result, first, last, centerMM);
  if (last !== first) sample.weights = new Float64Array(sample.alive.length);
  for (let f = first; f <= last; f++) {
    const begin = Math.max(times[f], startMS);
    const end = Math.min(times[f + 1] ?? endMS, endMS);
    // 视场固定在曝光结束时的磁场中心。按真实重叠时长和当时装载量加权。
    const w = weightAt(f, (begin + end) / 2) * Math.max(0, end - begin) / durationMS;
    if (first === last) sample.weight = w;
    else sample.weights.fill(w, (f - first) * result.n, (f - first + 1) * result.n);
  }
  return sample;
}
