import { CONSTANTS } from './physics.js';

export const DEFAULT_FLUX = 1e9;
export const FLUORESCENCE_VIEW = Object.freeze({
  width: 224, height: 112, pixelMM: .25,
  xMinMM: -28, xMaxMM: 28, zMinMM: -14, zMaxMM: 14,
});

const { width, height, pixelMM, xMinMM, zMaxMM } = FLUORESCENCE_VIEW;
const pixelsPerMetre = 1000 / pixelMM;
const photonEnergy = CONSTANTS.h * CONSTANTS.c / CONSTANTS.wavelength;

// 每个回放区间的发射量沿投影线段分配。每个像素得到线段在该像素内的时间比例。
function depositSegment(pixels, frames, previous, current, photons) {
  const x0 = frames[previous] * pixelsPerMetre - xMinMM / pixelMM;
  const z0 = zMaxMM / pixelMM - frames[previous + 2] * pixelsPerMetre;
  const x1 = frames[current] * pixelsPerMetre - xMinMM / pixelMM;
  const z1 = zMaxMM / pixelMM - frames[current + 2] * pixelsPerMetre;
  const firstX = Math.floor(x0), firstZ = Math.floor(z0);
  if (firstX === Math.floor(x1) && firstZ === Math.floor(z1)) {
    if (firstX >= 0 && firstX < width && firstZ >= 0 && firstZ < height) {
      pixels[firstZ * width + firstX] += photons;
    }
    return;
  }
  if (Math.max(x0, x1) < 0 || Math.min(x0, x1) >= width ||
      Math.max(z0, z1) < 0 || Math.min(z0, z1) >= height) return;

  const dx = x1 - x0, dz = z1 - z0;
  let enter = 0, exit = 1;
  if (dx !== 0) {
    const t0 = -x0 / dx, t1 = (width - x0) / dx;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
  }
  if (dz !== 0) {
    const t0 = -z0 / dz, t1 = (height - z0) / dz;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
  }
  if (enter >= exit) return;

  const x = x0 + enter * dx, z = z0 + enter * dz;
  let column = Math.min(width - 1, Math.max(0, dx < 0 ? Math.ceil(x) - 1 : Math.floor(x)));
  let row = Math.min(height - 1, Math.max(0, dz < 0 ? Math.ceil(z) - 1 : Math.floor(z)));
  const stepX = Math.sign(dx), stepZ = Math.sign(dz);
  let t = enter;
  while (column >= 0 && column < width && row >= 0 && row < height && t < exit) {
    const crossX = dx === 0 ? Infinity : (column + Number(dx > 0) - x0) / dx;
    const crossZ = dz === 0 ? Infinity : (row + Number(dz > 0) - z0) / dz;
    const next = Math.min(exit, crossX, crossZ);
    if (next > t) pixels[row * width + column] += photons * (next - t);
    if (next === exit) break;
    if (crossX <= crossZ) column += stepX;
    if (crossZ <= crossX) row += stepZ;
    t = Math.max(t, next);
  }
}

export function createFluorescence(result) {
  const { n, frameCount, framePhotons, frames, times, summary } = result;
  if (framePhotons?.length !== n * frameCount || frames.length !== 3 * n * frameCount) {
    throw new RangeError('荧光数据与轨迹的样本数或帧数不符。');
  }
  const meanPhotons = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    for (let i = f * n; i < (f + 1) * n; i++) sum += framePhotons[i];
    meanPhotons[f] = sum / n;
  }

  let cumulative, scaled, imageFrame = 0, imageFlux, roiRate = 0;
  function updateImage(target, flux) {
    if (!cumulative) {
      cumulative = new Float64Array(width * height);
      scaled = new Float64Array(width * height);
    }
    if (target === imageFrame && flux === imageFlux) return;
    if (target < imageFrame) {
      cumulative.fill(0);
      imageFrame = 0;
    }
    for (let f = imageFrame + 1; f <= target; f++) {
      for (let i = n * f; i < n * (f + 1); i++) {
        const photons = framePhotons[i] - framePhotons[i - n];
        if (photons > 0) depositSegment(cumulative, frames, 3 * (i - n), 3 * i, photons);
      }
    }
    imageFrame = target;
    imageFlux = flux;
    const weight = flux / n;
    roiRate = 0;
    for (let i = 0; i < cumulative.length; i++) {
      scaled[i] = weight * cumulative[i];
      roiRate += scaled[i];
    }
  }

  // 恒定通量从空阱开启。时刻 t 内所有年龄段的发射率为 Φ × 平均累计发射量 C(t)。
  return {
    at(frameIndex, flux = DEFAULT_FLUX, includeImage = false) {
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) {
        throw new RangeError('观测时刻超出模拟时间。');
      }
      if (!Number.isFinite(flux) || flux < 0) throw new RangeError('入射通量必须为非负有限数。');
      if (includeImage) updateImage(frameIndex, flux);
      const emittedRate = flux * meanPhotons[frameIndex];
      return {
        timeS: times[frameIndex], flux, loadingRate: flux * summary.retainedFraction,
        emittedRate, emittedPowerW: emittedRate * photonEnergy,
        roiRate: includeImage ? roiRate : null, image: includeImage ? scaled : null,
      };
    },
  };
}
