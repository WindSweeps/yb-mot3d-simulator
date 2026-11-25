import assert from 'node:assert/strict';
import { blueSequence, songSequence, compileSequence, sequenceAt, matchingSequencePreset } from './sequence.js';
import { prepareSequenceRun, sequenceRadiation, simulateSequence } from './sequence-physics.js';
import { sequenceLossStages, sequencePopulation } from './sequence-population.js';

const config = blueSequence();
const plan = compileSequence(config);
assert.equal(matchingSequencePreset(config).id, 'blue-mot-399nm');
assert.deepEqual(plan.stages.map(s => [s.id, s.startMS, s.endMS]), [['load',0,5000],['hold',5000,5100]]);
assert.deepEqual(plan.checkpointTimesMS, [5000,5050,5100]);
assert.deepEqual(compileSequence({...config, holdMS:3000}).checkpointTimesMS, [5000,6500,8000]);
assert.equal(compileSequence({...config, holdMS:120000}).durationMS, 125000);
assert.deepEqual(compileSequence(songSequence()).checkpointTimesMS, [5000,5011,5111]);
assert.equal(matchingSequencePreset({...config, holdMS:101}), undefined);
for (const bad of [{greenEnabled:true}, {holdMS:0}, {holdMS:NaN}, {holdMS:Infinity}, {mode:'unknown'}])
  assert.throws(() => compileSequence({...config, ...bad}));

const probe = [.00015,0,0], rest = [0,0,0], params = {gravity:false, recoil:false};
for (const t of [0, 4999.99, 5000, 5050, 5099.99, 5100]) {
  const c = sequenceAt(plan, t);
  assert.ok(c.blueOn && !c.greenOn);
  assert.deepEqual(c.bluePowersMW, [15.5,15.5,15.5,15.5,8,8]);
  assert.ok(c.greenPowersMW.every(power => power === 0));
  assert.equal(c.gradientGCM, 24);
  assert.equal(c.blueDetuningMHz, -34.92);
  const radiation = sequenceRadiation(probe, rest, params, c);
  assert.ok(radiation.blueRate > 0 && radiation.acceleration[0] < 0);
  assert.equal(radiation.greenRate, 0);
}
assert.deepEqual(sequenceLossStages(plan).map(s => [s.light,s.alpha,s.beta]),
  [['blue',1.3,27e-9], ['blue',.54,44e-9]]);
const testFlux = 9.8e7;
const run = simulateSequence({...params, n:2}, config, {initialStates:[0,0,0,0,0,0, .00015,0,0,0,0,0]});
assert.deepEqual(run.summary, {N0:2,N1:2,N2:2});
assert.ok(run.greenRates.every(rate => rate === 0));
assert.ok(run.blueRates.every(rate => rate > 0));
const {N0, N1, N2} = sequencePopulation(plan, run, {flux:testFlux}).estimatedAtoms;
// 从装载结束开始按论文式 (3) 演化，分别核对保持中点与终点。
for (const [t, atoms] of [[.05,N1],[.1,N2]]) {
  const expected = .54*N0 / ((.54+44e-9*N0)*Math.exp(.54*t)-44e-9*N0);
  assert.ok(Math.abs(atoms/expected-1) < 1e-12);
}
const noHoldLoss = sequencePopulation(plan, run, {flux:testFlux,holdAlpha:0,holdBeta:0});
assert.deepEqual(noHoldLoss.estimatedAtoms, {N0,N1:N0,N2:N0});

// 无光无重力时位置随时间线性变化。较快的轨迹在保持中点之后穿出 3 mm 捕获半径。
const darkHold = {...config, loadMS:.1, holdMS:3000, blueEnabled:false};
const drift = simulateSequence({...params, n:2}, darkHold,
  {initialStates:[0,0,0,.0005,0,0, 0,0,0,.0014,0,0]});
assert.deepEqual(drift.summary, {N0:2,N1:2,N2:1});
assert.equal(drift.timesMS.at(-1), 3000.1);
assert.ok(Math.abs(drift.positionsM.at(-6) - .0005*3.0001) < 2e-10);
assert.ok(Math.abs(drift.positionsM.at(-3) - .0014*3.0001) < 3e-10);

// 时间跨度超过单帧 32 位步号的容量。装载时从未入阱的原子能直接计算整段空云的回放。
const veryLong = {...darkHold, holdMS:200_000_000};
const outside = {initialStates:[.004,0,0,0,0,0]};
const fineStep = {...params, n:1, dtUS:.1};
const prepared = prepareSequenceRun(fineStep, veryLong, outside);
assert.ok(prepared.grid.some(point => point.steps > 2**32));
const empty = simulateSequence(fineStep, veryLong, outside);
assert.deepEqual(empty.summary, {N0:0,N1:0,N2:0});
assert.equal(empty.frameCount, drift.frameCount);
assert.equal(empty.timesMS.at(-1), veryLong.holdMS + veryLong.loadMS);
assert.ok(empty.metrics.slice(1).every(frame => frame.count === 0));
assert.throws(() => prepareSequenceRun(fineStep, {...darkHold, holdMS:Number.MAX_VALUE}, outside), /浮点时间精度/);
