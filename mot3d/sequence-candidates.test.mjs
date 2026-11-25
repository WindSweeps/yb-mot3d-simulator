import assert from 'node:assert/strict';
import { createCandidateScorer } from './sequence-candidate-score.js';
import { sequenceFrameAt } from './sequence-exposure.js';
import { simulateSequence } from './sequence-physics.js';
import { sequencePopulation } from './sequence-population.js';
import { compileSequence, songSequence } from './sequence.js';

const params = {n:48, seed:399174, sourceDistanceMM:.3, sourceSpeed:.1, sourceSpread:.02,
  sourceRadiusMM:.1, sourceTempMK:.01, recoil:true};
const loading = {flux:1e9, compressAlpha:1.2, compressBeta:1e-9};
const config = {...songSequence(), handoffMS:.3, greenMS:.7, compressMS:1.8};
const program = compileSequence(config);
const run = simulateSequence(params, config);
const compact = simulateSequence(params, config, {metricsOnly:true});
assert.deepEqual(compact.metrics, run.metrics);
assert.deepEqual(compact.summary, run.summary);
assert.equal(compact.positionsM, undefined);

// 覆盖装载快照、物理阶段边界、两帧之间与末端。修改接收失谐后可在同一求解器重新评估。
for (const [timeMS,metric] of [[1777.5,'atoms'],[5000,'temperatureUK'],[5000.147,'rmsRadiusMM'],[program.durationMS,'psd']]) {
  const scorer = await createCandidateScorer({params, loading, timeMS, metric});
  const observed = simulateSequence(params, config, {observeAtMS:timeMS});
  const population = sequencePopulation(program, observed, loading);
  const f = sequenceFrameAt(observed.timesMS, timeMS), frame = observed.metrics[f];
  if (timeMS < config.loadMS) assert.equal(observed.timesMS[f], 20);
  else assert.equal(observed.timesMS[f], timeMS);
  const atoms = population.at(timeMS, frame.count);
  const expected = metric === 'atoms' ? atoms : metric === 'psd' ? atoms * frame.psdPerAtom : frame[metric];
  assert.ok(Number.isFinite(expected) && expected > 0);
  const score = await scorer.evaluate(config);
  assert.equal(score.value, expected);
  assert.equal(score.backend, 'CPU');
  assert.equal(score.sampledAtMS, timeMS <= config.loadMS ? 20 : timeMS);
  await scorer.evaluate({...config, receiveMHz:-3.2});
  assert.deepEqual(await scorer.evaluate(config), score);
  assert.deepEqual(await scorer.evaluate({...config, loadMS:1}), {value:null, sampledAtMS:null, backend:'CPU'});
  scorer.destroy();
}
const insufficient = await createCandidateScorer({params:{...params, n:5}, loading, timeMS:5000, metric:'psd'});
assert.equal((await insufficient.evaluate(config)).value, null);
insufficient.destroy();
assert.throws(() => simulateSequence(params, config, {observeAtMS:program.durationMS+1}), RangeError);
console.log('优化候选与普通回放在四个目标读数、装载冻结、阶段边界和固定种子下逐值一致。');
