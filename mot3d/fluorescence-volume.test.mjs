import assert from 'node:assert/strict';
import { createFluorescenceVolume, recentWindow, screenFade, TRAIL_WINDOW_S } from './fluorescence-volume.js';
import { CONSTANTS, radiation, simulate } from './physics.js';
import { createFluorescence } from './fluorescence.js';

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} / ${expected}`);
}
const balanced = { detuningMHz: 0, mainCurrentA: 0, gravity: false, recoil: false };
const positions = [[0, 0, 0], [.002, 0, 0], [0, .002, 0], [0, 0, .002], [.004, 0, 0]];
const initialStates = positions.flatMap(p => [...p, 0, 0, 0]);
const params = { ...balanced, n: positions.length, durationMS: 5 };
const result = simulate(params, { initialStates, frameCount: 201 });
assert.deepEqual(Array.from(result.retained), [1, 1, 1, 1, 0]);
const volume = createFluorescenceVolume(result);
for (const frame of [0, 37, 200, 5, 200]) {
  volume.at(frame, true);
  assert.equal(volume.cloud.count, frame > 0 ? 4 : 0);
  if (frame === 0) { assert.equal(volume.transient.count, 0); continue; }
  assert.ok(volume.transient.count > 0);
  for (let i = 0; i < 4; i++) {
    for (let axis = 0; axis < 3; axis++) close(volume.cloud.positions[3*i + axis], 1000 * positions[i][axis]);
    close(volume.cloud.rates[i], radiation(positions[i], [0, 0, 0], params).totalRate, 2e-5);
  }
  const { h, c, gamma, wavelength } = CONSTANTS;
  const isat = Math.PI * h * c * gamma / (3 * wavelength ** 3);
  const saturation = 6 * (2 * .015 / (Math.PI * .006**2)) / isat;
  close(volume.cloud.rates[0], .5 * gamma * saturation / (1 + saturation), 2e-5);
  volume.at(frame, false);
  assert.equal(volume.cloud.count, 4); assert.equal(volume.transient.count, 0);
}
const dark = simulate({ ...params, powersMW: Array(6).fill(0) }, { initialStates, frameCount: 201 });
const noLight = createFluorescenceVolume(dark);
noLight.at(200); assert.equal(noLight.cloud.count + noLight.transient.count, 0);

// 水平对射光轴上的真实匀速飞越。对粗、细两种保存帧距分别核对取样时间、位置及散射率。
for (const frameCount of [11, 801]) {
  const flight = simulate({ ...balanced, durationMS: 8, n: 1, powersMW: [0, 0, 0, 0, 15, 15] }, {
    initialStates: [0, -.04, 0, 0, 10, 0], frameCount,
  });
  assert.equal(flight.retained[0], 0);
  const v = createFluorescenceVolume(flight);
  for (const f of [frameCount - 1, 1, Math.floor(frameCount / 2), 0, frameCount - 1]) {
    v.at(f);
    const window = recentWindow(flight, f), sampleDt = flight.times[1] - flight.times[0];
    assert.equal(v.cloud.count, 0); assert.equal(v.transient.count, window.segments);
    assert.ok(window.segments <= 6);
    for (let j = 0; j < v.transient.count; j++) {
      const t = sampleDt * (window.first + (j + .5) * window.step);
      assert.ok(t >= flight.times[f] - TRAIL_WINDOW_S);
      close(v.transient.positions[3*j + 1], 1000 * (-.04 + 10*t));
      close(v.transient.rates[j], radiation([0, 0, 0], [0, 10, 0], flight.params).totalRate, 3e-4);
      if (j > 0) assert.ok(v.transient.weights[j] > v.transient.weights[j - 1]);
    }
    v.at(f, false); assert.equal(v.cloud.count + v.transient.count, 0);
  }
  assert.ok(createFluorescence(flight).at(frameCount - 1).emittedRate > 0);
}
const escaped = simulate({ ...balanced, durationMS: .8, dtUS: 1, n: 1, powersMW: [0, 0, 0, 0, 15, 15] }, {
  initialStates: [0, .149, 0, 0, 100, 0], frameCount: 81,
});
assert.equal(escaped.alive[0], 0);
const escapeDisplay = createFluorescenceVolume(escaped);
escapeDisplay.at(2); assert.ok(escapeDisplay.transient.count > 0);
escapeDisplay.at(80); assert.equal(escapeDisplay.cloud.count + escapeDisplay.transient.count, 0);
assert.deepEqual([0, 500, 1000, 2000].map(screenFade), [1, .5, 0, 0]);
console.log('通过实际留存、三维位置、绝对散射率、飞越窗口、暂停淡出、黑暗、逃逸及反向拖动检查。');

if (process.argv.includes('--benchmark')) {
  for (const n of [192, 768]) {
    const batch = simulate({ n }, { frameCount: 801 });
    const start = performance.now();
    const v = createFluorescenceVolume(batch);
    v.at(800, false);
    const initialMS = performance.now() - start;
    const times = [];
    for (let run = 0; run < 3; run++) for (let f = 0; f < batch.frameCount; f++) {
      const t = performance.now(); v.at(f); times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ n, retained: v.cloud.count, initialMS, frameP95MS: times[Math.floor(.95 * times.length)] }));
  }
}
