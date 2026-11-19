import assert from 'node:assert/strict';
import { CONSTANTS, simulate } from './physics.js';
import { createFluorescence, DEFAULT_FLUX, FLUORESCENCE_VIEW } from './fluorescence.js';

const { h, c, gamma, wavelength } = CONSTANTS;
const { width, height, pixelMM, xMinMM, zMaxMM } = FLUORESCENCE_VIEW;
const aligned = { gravity: false, recoil: false, mainCurrentA: 0, detuningMHz: 0 };
const fixedAtoms = { ...aligned, n: 4, durationMS: 8, waistMM: 6, powersMW: Array(6).fill(15) };
const fixedInitial = { initialStates: new Float64Array(24), frameCount: 33 };

function relativeClose(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.abs(expected),
    `${label}: ${actual} (expected ${expected} with relative tolerance ${tolerance})`);
}

const stationary = simulate(fixedAtoms, fixedInitial);
const source = createFluorescence(stationary);
const saturationIntensity = Math.PI * h * c * gamma / (3 * wavelength ** 3);
const saturation = 6 * 2 * .015 / (Math.PI * .006 ** 2 * saturationIntensity);
const rate = .5 * gamma * saturation / (1 + saturation);
for (const f of [0, 1, 13, 32, 8, 32]) {
  const { emittedRate, emittedPowerW, image, roiRate, loadingRate } = source.at(f, DEFAULT_FLUX, true);
  relativeClose(emittedRate, DEFAULT_FLUX * rate * stationary.times[f], 1e-6, '恒定单原子散射率和连续源卷积');
  relativeClose(emittedPowerW, emittedRate * h * c / wavelength, 2e-15, '发射功率');
  relativeClose(roiRate, emittedRate, 2e-15, '区域积分光子率');
  const centre = Math.floor(zMaxMM / pixelMM) * width + Math.floor(-xMinMM / pixelMM);
  assert.equal(image[centre], roiRate);
  assert.equal(loadingRate, DEFAULT_FLUX);
}
const finalRate = source.at(32).emittedRate;
const doubleFlux = source.at(32, 2 * DEFAULT_FLUX, true);
assert.equal(doubleFlux.emittedRate, 2 * finalRate);
assert.equal(doubleFlux.roiRate, 2 * finalRate);
assert.equal(source.at(32, 0, true).image.every(value => value === 0), true);
assert.equal(source.at(32, 0).loadingRate, 0);
assert.throws(() => source.at(33), RangeError);
assert.throws(() => source.at(2, -1), RangeError);

const dark = simulate({ ...fixedAtoms, powersMW: Array(6).fill(0) }, fixedInitial);
assert.equal(createFluorescence(dark).at(32, DEFAULT_FLUX, true).emittedRate, 0);
assert.equal(dark.framePhotons.every(value => value === 0), true);

// 对射且共振的 V1 光束沿光轴产生恒定的散射率。轨迹斜穿上下边缘，首末点均在视野之外。
const across = { ...aligned, n: 1, powersMW: [15, 15, 0, 0, 0, 0], durationMS: 7, dtUS: 5 };
const startX = -.035, velocityX = 10, tangent = 1 / Math.sqrt(3);
for (const sign of [1, -1]) {
  const flight = simulate(across, {
    initialStates: [sign * startX, 0, sign * startX * tangent, sign * velocityX, 0, sign * velocityX * tangent],
    frameCount: 2,
  });
  const image = createFluorescence(flight).at(1, DEFAULT_FLUX, true);
  const fractionInView = zMaxMM / (Math.abs(startX) * tangent * 1000);
  relativeClose(image.roiRate / image.emittedRate, fractionInView, 2e-6, '斜穿视野的光子率');
  const perRow = image.roiRate / height;
  for (let row = 0; row < height; row++) {
    const total = image.image.subarray(row * width, (row + 1) * width).reduce((sum, value) => sum + value, 0);
    relativeClose(total, perRow, 1e-8, '均匀散射沿全轨迹的逐行投影');
  }
}

const escaped = simulate({ ...aligned, n: 1, powersMW: [0, 0, 0, 0, 15, 15], durationMS: .1, dtUS: 1 },
  { initialStates: [0, .149, 0, 0, 100, 0], frameCount: 11 });
assert.equal(escaped.alive[0], 0);
const emission = createFluorescence(escaped);
const late = emission.at(10, DEFAULT_FLUX, true);
assert.ok(late.emittedRate > 0);
assert.equal(late.emittedRate, emission.at(3).emittedRate);
assert.equal(late.emittedRate, late.roiRate);
assert.equal(late.loadingRate, 0);
console.log('通过恒定散射、零通量、关闭光束、通量缩放、反向回放、逐像素守恒及逃逸轨迹检查。');
