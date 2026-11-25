import { compile, radiation } from './physics.js';
import { EMISSION_BRANCHES } from './branching.js';

export const TRAIL_WINDOW_S = .00015;
export const TRAIL_FADE_MS = 1000;
const sampleLimit = 6;

export function screenFade(elapsedMS) {
  const u = Math.min(1, Math.max(0, elapsedMS / TRAIL_FADE_MS));
  return (1 - u) ** 2 * (1 + 2 * u);
}

// 模拟器均匀保存回放帧。坐标是可以插值的帧编号，以便短时间窗能截断粗采样的区间。
export function recentWindow(result, frame, limit = sampleLimit) {
  const duration = result.times[result.frameCount - 1];
  const span = Math.min(frame, TRAIL_WINDOW_S * (result.frameCount - 1) / duration);
  const segments = frame === 0 ? 0 : Math.min(limit, Math.max(1, Math.ceil(span - 1e-10)));
  return { first: frame - span, segments, step: segments ? span / segments : 0 };
}

function captureStarts(result) {
  const { n, frames, times, retained, frameCount, summary } = result;
  const { radiusMM, speedMS, holdMS } = summary.criterion;
  const radius2 = (radiusMM / 1000) ** 2;
  const earliest = new Uint32Array(n).fill(frameCount);
  const holdStart = times[frameCount - 1] - holdMS / 1000;
  const firstCertified = times.findIndex(t => t >= holdStart - 1e-14);
  for (let i = 0; i < n; i++) {
    if (!retained[i]) continue;
    let first = firstCertified;
    // 求解器已逐步验证末端留存窗。从这里向前延伸，直到保存位置或相邻帧速度首次超出阈值。
    while (first > 0) {
      const k = 3 * ((first - 1) * n + i), j = k + 3 * n;
      const x = frames[k], y = frames[k + 1], z = frames[k + 2];
      const dx = frames[j] - x, dy = frames[j + 1] - y, dz = frames[j + 2] - z;
      const maxTravel = speedMS * (times[first] - times[first - 1]);
      if (x*x + y*y + z*z >= radius2 || dx*dx + dy*dy + dz*dz >= maxTravel*maxTravel) break;
      first--;
    }
    earliest[i] = first;
  }
  return earliest;
}

function pointData(capacity) {
  return { positions: new Float32Array(3 * capacity), rates: new Float32Array(capacity),
    weights: new Float32Array(capacity), count: 0 };
}

export function createFluorescenceVolume(result) {
  const { n, frameCount, frames, frameAlive, framePhotons, times, finalPositions, finalVelocities } = result;
  if (framePhotons?.length !== n * frameCount || frames.length !== 3 * n * frameCount ||
      frameAlive.length !== n * frameCount || result.retained.length !== n || times.length !== frameCount)
    throw new RangeError('三维荧光的光子数、留存标记与轨迹尺寸不符。');
  const capturedFrom = captureStarts(result);
  const cloud = pointData(n), transient = pointData(sampleLimit * n);
  let finalRates;
  function endpointRates() {
    const c = compile(result.params);
    return Float64Array.from(capturedFrom, (first, i) => {
      if (first === frameCount) return 0;
      return EMISSION_BRANCHES.blue399 * radiation(finalPositions.subarray(3*i, 3*i + 3), finalVelocities.subarray(3*i, 3*i + 3), c).totalRate;
    });
  }
  function at(frame, includeTransient = true) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= frameCount)
      throw new RangeError('三维荧光帧超出观测时间。');
    cloud.count = transient.count = 0;
    if (!frame) return;
    const final = frame === frameCount - 1;
    if (final && !finalRates) finalRates = endpointRates();
    const dt = times[frame] - times[frame - 1];
    for (let i = 0; i < n; i++) {
      if (capturedFrom[i] > frame) continue;
      const k = frame * n + i;
      const rate = final ? finalRates[i] : (framePhotons[k] - framePhotons[k - n]) / dt;
      if (!(rate > 0)) continue;
      const source = final ? finalPositions : frames;
      const start = 3 * (final ? i : k), output = cloud.count++;
      for (let axis = 0; axis < 3; axis++) cloud.positions[3*output + axis] = source[start + axis] * 1000;
      cloud.rates[output] = rate;
      cloud.weights[output] = 1;
    }
    if (!includeTransient) return;
    const { first, segments, step } = recentWindow(result, frame);
    for (let s = 0; s < segments; s++) {
      const age = first + (s + .5) * step;
      const lo = Math.floor(age), hi = lo + 1, alpha = age - lo;
      const interval = times[hi] - times[lo];
      const ageS = times[lo] + alpha * interval;
      const weight = Math.exp(-3 * (times[frame] - ageS) / TRAIL_WINDOW_S) / segments;
      for (let i = 0; i < n; i++) {
        const a = lo*n + i, b = hi*n + i;
        if (capturedFrom[i] <= age || !frameAlive[a]) continue;
        const rate = (framePhotons[b] - framePhotons[a]) / interval;
        if (!(rate > 0)) continue;
        const output = transient.count++;
        for (let axis = 0; axis < 3; axis++) {
          const from = frames[3*a + axis], to = frames[3*b + axis];
          transient.positions[3*output + axis] = (from + alpha * (to - from)) * 1000;
        }
        transient.rates[output] = rate;
        transient.weights[output] = weight;
      }
    }
  }
  return { capturedFrom, cloud, transient, at };
}
