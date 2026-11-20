import assert from 'node:assert/strict';
import { createFluorescenceVolume, VOXEL_SIZE_MM } from './fluorescence-volume.js';
import { simulate } from './physics.js';

const balanced = { detuningMHz: 0, mainCurrentA: 0, gravity: false, recoil: false };
const sum = values => values.reduce((a, b) => a + b, 0);
function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} / ${expected}`);
}
function checkConservation(volume, result, frame) {
  const count = volume.at(frame);
  close(sum(volume.photons.subarray(0, count)), sum(result.framePhotons.subarray(frame * result.n, (frame + 1) * result.n)));
  return count;
}

// 四组静止原子分布于四面体顶点，核对三维方向和逐体素发射量。
const positions = [[0, 0, 0], [.004, 0, 0], [0, .004, 0], [0, 0, .004]];
const initialStates = positions.flatMap(p => [...p, 0, 0, 0]);
const params = { ...balanced, n: 4, durationMS: .5 };
const result = simulate(params, { initialStates, frameCount: 12 });
const volume = createFluorescenceVolume(result);
for (const frame of [0, 9, 3, 11, 4, 1, 0, 11]) {
  assert.equal(checkConservation(volume, result, frame), frame === 0 ? 0 : 4);
  for (let atom = 0; atom < 4; atom++) {
    close(volume.photons[atom], result.framePhotons[frame * 4 + atom]);
    for (let k = 0; k < 3; k++) close(volume.positions[3 * atom + k], 1000 * positions[atom][k], .063);
  }
}
const dark = simulate({ ...params, powersMW: Array(6).fill(0) }, { initialStates, frameCount: 12 });
assert.equal(createFluorescenceVolume(dark).at(11), 0);

// 原子沿水平对射光的轴线匀速飞越，两个端点之间没有保存中间帧。
// 每个完整体素内驻留时间相同。正向及反向的分布均可独立从匀速运动求出。
const flight = { ...balanced, durationMS: 4, n: 1, powersMW: [0, 0, 0, 0, 15, 15] };
for (const sign of [1, -1]) {
  const speed = 10;
  const crossing = simulate(flight, { initialStates: [0, -sign * .020, 0, 0, sign * speed, 0], frameCount: 2 });
  const lineVolume = createFluorescenceVolume(crossing);
  const count = checkConservation(lineVolume, crossing, 1);
  const perMM = crossing.framePhotons[1] / 40;
  assert.ok(count >= 40 / VOXEL_SIZE_MM);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = lineVolume.positions.subarray(3 * i, 3 * i + 3);
    assert.equal(x, 0); assert.equal(z, 0);
    const length = Math.min(20, y + VOXEL_SIZE_MM / 2) - Math.max(-20, y - VOXEL_SIZE_MM / 2);
    close(lineVolume.photons[i], length * perMM, 1.5e-5);
  }
}

const escaped = simulate({ ...flight, durationMS: .1, dtUS: 1 }, {
  initialStates: [0, .149, 0, 0, 100, 0], frameCount: 11,
});
assert.equal(escaped.alive[0], 0);
const escapedVolume = createFluorescenceVolume(escaped);
const finalCount = checkConservation(escapedVolume, escaped, 10);
assert.ok(finalCount > 0);
const finalPhotons = escapedVolume.photons.slice();
checkConservation(escapedVolume, escaped, 5);
assert.deepEqual(escapedVolume.photons, finalPhotons);
console.log('通过三维位置、逐体素发射率、帧间飞越、全空间守恒、反向拖动和逃逸检查。');

if (process.argv.includes('--benchmark')) {
  for (const n of [192, 768]) {
    const batch = simulate({ n }, { frameCount: 801 });
    for (const width of [.4, .25, .2]) {
      const start = performance.now();
      const v = createFluorescenceVolume(batch, width);
      const buildMS = performance.now() - start;
      const times = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        for (let frame = 0; frame < batch.frameCount; frame++) {
          const t = performance.now();
          v.at(frame);
          times.push(performance.now() - t);
        }
      }
      times.sort((a, b) => a - b);
      const scrubStart = performance.now();
      for (let jump = 0; jump < 100; jump++) v.at(jump % 2 ? batch.frameCount - 1 : 0);
      console.log(JSON.stringify({ n, width, cells: v.photons.length, buildMS, frameP95MS: times[Math.floor(.95 * times.length)],
        fullScrubMS: (performance.now() - scrubStart) / 100 }));
    }
  }
}
