import assert from 'node:assert/strict';
import { songSequence, compileSequence, sequenceAt } from './sequence.js';

const original = songSequence();
const plan = compileSequence(original);
const [load, handoff, green, compress] = plan.stages;
const at = t => sequenceAt(plan, t);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} 与 ${b} 不符`);

assert.deepEqual(plan.stages.map(s => [s.startMS, s.endMS]), [[0,5000],[5000,5001],[5001,5011],[5011,5111]]);
assert.equal(at(load.startMS).stageId, 'load');
assert.deepEqual(at(0).bluePowersMW, [15.5,15.5,15.5,15.5,8,8]);
assert.equal(at(4999.99).greenDetuningMHz, 2);
assert.equal(at(handoff.startMS).greenDetuningMHz, -5.94);
close(at(handoff.startMS + .5).bluePowersMW[0], 7.75);
close(at(handoff.startMS + .5).gradientGCM, 15.4);
assert.equal(at(green.startMS).blueOn, false);
assert.equal(at(green.endMS - .001).greenDetuningMHz, -5.94);
assert.equal(at(compress.startMS).greenDetuningMHz, -1.44);
close(at(compress.startMS + 50).greenPowersMW[0], (30.5 + .035) / 2);
close(at(plan.durationMS).gradientGCM, 18.2);
close(at(plan.durationMS).greenPowersMW[0], .035);
close(at(plan.durationMS).greenPowersMW[4], .035 * 13 / 30.5);
assert.equal(at(-1).timeMS, 0);
assert.equal(at(100000).timeMS, plan.durationMS);
assert.throws(() => at(NaN), TypeError);
for (const powerRamp of ['geometric', 'smooth']) {
  const ramp = compileSequence({ ...original, powerRamp });
  const value = (ms, i) => sequenceAt(ramp, compress.startMS + ms).greenPowersMW[i];
  close(value(0, 0), 30.5);
  close(value(100, 0), .035);
  if (powerRamp === 'geometric') close(value(50, 0), Math.sqrt(30.5 * .035));
  if (powerRamp === 'smooth') close(value(25, 0), 30.5 + (.035 - 30.5) * .15625);
}
const dark = compileSequence({ ...original, blueEnabled:false, greenEnabled:false });
assert.ok(sequenceAt(dark, 30).bluePowersMW.every(p => p === 0));
assert.ok(sequenceAt(dark, plan.durationMS).greenPowersMW.every(p => p === 0));
assert.equal(sequenceAt(dark, 0).greenOn, false);
assert.equal(sequenceAt(dark, 0).blueOn, false);
for (const changes of [{ loadMS:0 }, { handoffMS:-1 }, { receiveGradient:NaN }, { blueEnabled:1 },
  { powerRamp:'unknown' }, { powerRamp:'geometric', finalHorizontalUW:0 }]) {
  assert.throws(() => compileSequence({ ...original, ...changes }));
}
const adjusted = compileSequence({ ...original, greenMS:1, handoffMS:.05, loadGradient:-29.4 });
close(adjusted.durationMS, 5101.05);
assert.equal(sequenceAt(adjusted, 5001.05).stageId, 'compress');
assert.equal(sequenceAt(adjusted, 100).gradientGCM, -29.4);
console.log('已验证时序边界、同时切换、三种功率斜坡、独立光闸和输入范围。');
