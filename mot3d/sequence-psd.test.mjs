import assert from 'node:assert/strict';
import { CONSTANTS } from './physics.js';
import { songSequence } from './sequence.js';
import { simulateSequence } from './sequence-physics.js';

const sequence = {...songSequence(), loadMS:1, handoffMS:.5, greenMS:1, compressMS:2,
  blueEnabled:false, greenEnabled:false};
const widths = [.00015, .00022, .0001, .016, .028, .021];
const mean = [.0001, -.0002, .00006, .025, -.008, .014];
const states = [];
// 对称初始条件给出已知六维协方差，自由飞行和重力保持其行列式。
for (let axis = 0; axis < 6; axis++) {
  for (const sign of [-1, 1]) {
    const state = mean.slice();
    state[axis] += sign * Math.sqrt(11/2) * widths[axis];
    state[1] += .001 * state[5];
    state[4] -= 30 * state[0];
    states.push(state);
  }
}
// 加入一条阱外轨迹，检查统计仅使用当前阱内群体。
states.push([.006,0,0, .01,.02,.03]);
const reference = (CONSTANTS.hbar / CONSTANTS.mass)**3 / widths.reduce((product, w) => product * w, 1);
const simulate = cloud => simulateSequence({n:cloud.length, gravity:true, recoil:false}, sequence,
  {initialStates:cloud.flat()});
for (const frame of simulate(states).metrics) {
  assert.equal(frame.count, 12);
  assert.ok(Math.abs(frame.psdPerAtom/reference - 1) < 1e-12);
}
for (const frame of simulate(states.slice(0, 6)).metrics) assert.equal(frame.psdPerAtom, null);
// 速度分量满足线性约束，各轴方差均可非零，但协方差秩仍不足六。
const rankDeficient = states.slice(0, 12).map(([x,y,z,vx,vy]) => [x,y,z,vx,vy,2*vx-vy]);
for (const frame of simulate(rankDeficient).metrics) assert.equal(frame.psdPerAtom, null);
console.log('六维 PSD 已通过自由飞行不变性、位置与速度关联、阱外筛选、少样本与降秩检验。');
