import { CONSTANTS } from './physics.js';

const SIZE = 128;
const CROSS_SECTION = 3 * CONSTANTS.wavelength ** 2 / (2 * Math.PI);
const PHOTON_ENERGY = CONSTANTS.h * CONSTANTS.c / CONSTANTS.wavelength;
const SATURATION_INTENSITY = PHOTON_ENERGY * CONSTANTS.gamma / (2 * CROSS_SECTION);
const projections = { x: [1, 2], y: [0, 2], z: [0, 1] };

export const IMAGING_DEFAULTS = Object.freeze({
  mode: 'fluorescence', axis: 'y', band: 'both', fovMM: 3, exposureUS: 20,
  psfSigmaUM: 30, sampleSigmaUM: 60, detectionEfficiency: .01, probeSaturation: .01,
  probeEfficiency: .5, darkElectrons: 12, minDetectableElectrons: 1,
});

export function validateImagingSettings(input = {}) {
  const settings = { ...IMAGING_DEFAULTS, ...input };
  if (!Object.hasOwn(projections, settings.axis) ||
      !['fluorescence', 'absorption'].includes(settings.mode) ||
      !['399', '556', 'both'].includes(settings.band))
    throw new RangeError('成像模式、观察轴或荧光波段无效。');
  const ranges = { fovMM:[1,50], exposureUS:[1,1000], psfSigmaUM:[0,100], sampleSigmaUM:[0,200],
    detectionEfficiency:[0,1], probeSaturation:[.001,.05], probeEfficiency:[0,1],
    darkElectrons:[0,1e6], minDetectableElectrons:[.001,1e6] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max)
      throw new RangeError('成像参数超出范围 · ' + key);
  }
  return settings;
}

function gaussian(sigma) {
  if (sigma === 0) return Float64Array.of(1);
  const radius = Math.ceil(4 * sigma);
  const kernel = Float64Array.from({ length: 2 * radius + 1 },
    (_, i) => Math.exp(-.5 * ((i - radius) / sigma) ** 2));
  const total = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  return kernel;
}

// 投影时保留核半径大小的边界。两次一维卷积逐次截取有效区域，计入视野边缘的入光和漏光。
function gaussianCrop(source, width, kernel) {
  if (kernel.length === 1) return source;
  const outWidth = width - kernel.length + 1;
  const horizontal = new Float64Array(width * outWidth);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const value = source[y * width + x];
      if (value === 0) continue;
      const left = Math.max(0, x - kernel.length + 1), right = Math.min(x, outWidth - 1);
      for (let c = left; c <= right; c++) horizontal[y * outWidth + c] += value * kernel[x - c];
    }
  }
  const output = new Float64Array(outWidth * outWidth);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < outWidth; x++) {
      const value = horizontal[y * outWidth + x];
      if (value === 0) continue;
      const top = Math.max(0, y - kernel.length + 1), bottom = Math.min(y, outWidth - 1);
      for (let r = top; r <= bottom; r++) output[r * outWidth + x] += value * kernel[y - r];
    }
  }
  return output;
}

function centerCrop(source, width) {
  if (width === SIZE) return source;
  const output = new Float64Array(SIZE * SIZE), margin = (width - SIZE) / 2;
  for (let row = 0; row < SIZE; row++) {
    const offset = (row + margin) * width + margin;
    output.set(source.subarray(offset, offset + SIZE), row * SIZE);
  }
  return output;
}

function deposit(grid, width, u, v, value) {
  const firstCol = Math.floor(u), firstRow = Math.floor(v);
  for (let row = Math.max(0, firstRow); row <= Math.min(firstRow + 1, width - 1); row++) {
    for (let col = Math.max(0, firstCol); col <= Math.min(firstCol + 1, width - 1); col++) {
      grid[row * width + col] += value * (1 - Math.abs(col - u)) * (1 - Math.abs(row - v));
    }
  }
}

export function simulateImagingFrame(sample, input = {}) {
  const s = validateImagingSettings(input);
  const { positionsM, alive, blueRates, greenRates, weight = 1, weights, centerMM = [0,0,0] } = sample;
  const n = alive.length;
  if (positionsM.length !== 3 * n || blueRates.length !== n || greenRates.length !== n ||
      (weights != null && weights.length !== n) || centerMM.length !== 3 ||
      !centerMM.every(Number.isFinite) || !Number.isFinite(weight) || weight < 0)
    throw new RangeError('成像样本的数组长度、权重或视野中心无效。');
  const pixelSizeUM = 1000 * s.fovMM / SIZE, exposureS = s.exposureUS * 1e-6;
  const kde = gaussian(s.sampleSigmaUM / pixelSizeUM), psf = gaussian(s.psfSigmaUM / pixelSizeUM);
  const opticalWidth = SIZE + psf.length - 1, width = opticalWidth + kde.length - 1;
  const grid = new Float64Array(width * width);
  const [h, v] = projections[s.axis];
  const fluorescence = s.mode === 'fluorescence';
  let sampleCount = 0, weightedAtoms = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const w = weights == null ? weight : weights[i];
    if (!Number.isFinite(w) || w < 0) throw new RangeError('成像样本权重无效。');
    if (w === 0) continue;
    const u = (positionsM[3*i+h] * 1000 - centerMM[h]) * SIZE / s.fovMM + (width - 1) / 2;
    const row = (centerMM[v] - positionsM[3*i+v] * 1000) * SIZE / s.fovMM + (width - 1) / 2;
    if (!Number.isFinite(u) || !Number.isFinite(row)) throw new RangeError('成像位置无效。');
    const offset = (width - SIZE) / 2 - .5;
    if (u >= offset && u < offset + SIZE && row >= offset && row < offset + SIZE) {
      sampleCount++;
      weightedAtoms += w;
    }
    if (u <= -1 || u >= width || row <= -1 || row >= width) continue;
    let amount = w;
    if (fluorescence) {
      const blue = s.band === '556' ? 0 : blueRates[i], green = s.band === '399' ? 0 : greenRates[i];
      if (!Number.isFinite(blue) || !Number.isFinite(green) || blue < 0 || green < 0)
        throw new RangeError('荧光散射率无效。');
      amount *= (blue + green) * exposureS;
    }
    deposit(grid, width, u, row, amount);
  }

  const object = gaussianCrop(grid, width, kde);
  let images, totalSignal = 0, clippedPixels = 0, odLimit = null, referenceSignal = null;
  if (fluorescence) {
    const emission = centerCrop(object, opticalWidth);
    const signal = Float64Array.from(gaussianCrop(object, opticalWidth, psf), x => x * s.detectionEfficiency);
    totalSignal = signal.reduce((a,b) => a+b, 0);
    images = { emission, signal };
  } else {
    const pixelArea = (pixelSizeUM * 1e-6) ** 2;
    referenceSignal = s.probeEfficiency * s.probeSaturation * SATURATION_INTENSITY * pixelArea * exposureS / PHOTON_ENERGY;
    if (referenceSignal >= s.minDetectableElectrons) odLimit = Math.log(referenceSignal / s.minDetectableElectrons);
    // 平场归一时，对光强损失 1−T 卷积与对 T 卷积等价，且无原子时精确返回空白图像。
    for (let i = 0; i < object.length; i++) object[i] = -Math.expm1(-CROSS_SECTION * object[i] / pixelArea);
    const loss = gaussianCrop(object, opticalWidth, psf), dark = new Float64Array(loss.length).fill(s.darkElectrons);
    const reference = new Float64Array(loss.length).fill(referenceSignal + s.darkElectrons);
    const atoms = new Float64Array(loss.length), od = new Float64Array(loss.length);
    for (let i = 0; i < loss.length; i++) {
      const transmission = Math.max(0, 1 - loss[i]);
      atoms[i] = dark[i] + referenceSignal * transmission;
      const transmitted = atoms[i] - dark[i];
      if (transmitted < s.minDetectableElectrons) clippedPixels++;
      if (odLimit !== null) od[i] = Math.log((reference[i] - dark[i]) / Math.max(s.minDetectableElectrons, transmitted));
      totalSignal += reference[i] - atoms[i];
    }
    images = { atoms, reference, dark, od };
  }
  const peaks = {};
  for (const [name, pixels] of Object.entries(images)) peaks[name] = pixels.reduce((a,b) => Math.max(a,b), 0);
  if (!fluorescence && odLimit === null) peaks.od = null;
  return { size:SIZE, fovMM:s.fovMM, pixelSizeUM, horizontalAxis:'XYZ'[h], verticalAxis:'XYZ'[v],
    images, peaks, weightedAtoms, sampleCount, totalSignal, odLimit, clippedPixels, referenceSignal };
}
