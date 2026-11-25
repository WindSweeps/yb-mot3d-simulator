import assert from 'node:assert/strict';
import { createCandidateScorer } from './sequence-candidate-score.js';
import { findSequenceObjective, scoreSequenceObjective, sequenceObjectives } from './sequence-objectives.js';
import { simulateSequence } from './sequence-physics.js';
import { blueSequence, compileSequence, sequenceAt, songSequence } from './sequence.js';
import { sequencePopulation } from './sequence-population.js';
import { cloudSamples, fluorescenceExposure, sequenceFrameAt } from './sequence-exposure.js';
import { IMAGING_DEFAULTS, simulateImagingFrame } from './sequence-imaging.js';
import { experimentControls } from './sequence-controls.js';
import { derive, magneticCenterMM } from './physics.js';

const params = {n:24, sourceDistanceMM:.15, sourceRadiusMM:.1, sourceSpeed:.1,
  sourceSpread:.04, sourceTempMK:.01, seed:153, biasCurrentA:[.01,-.05,.08]};
const config = {...songSequence(), loadMS:2.8, handoffMS:.2, greenMS:.5, compressMS:1};
const imaging = {...IMAGING_DEFAULTS, exposureUS:800};
const base = {config, params, loading:{flux:1e10, compressAlpha:1100}, imaging};
const program = compileSequence(config), time = 3.64923, capture = 2.8;
const full = simulateSequence(params, config, {observeAtMS:time});
const compact = simulateSequence(params, config, {observeAtMS:time, metricsOnly:true, recordFromMS:time-.8, observeVelocity:true});
const population = sequencePopulation(program, full, base.loading);
const frame = sequenceFrameAt(full.timesMS, time), cloud = full.metrics[frame];
const geometry = derive(params), channels = sequenceAt(program, time);
const center = magneticCenterMM(channels.gradientGCM, geometry.mainTensor, geometry.biasG);
const weightAt = (f, t) => population.weightAt(t, full.metrics[f].count);
const fluSample = fluorescenceExposure(full, time, 800, center, weightAt);
const absSample = {...cloudSamples(full, frame, frame, center), weight:weightAt(frame, time)};
assert.ok(compact.positionsM.length < full.positionsM.length);
assert.deepEqual(compact.metrics, full.metrics);
assert.deepEqual(fluorescenceExposure(compact, time, 800, center, weightAt), fluSample);
const fluImage = simulateImagingFrame(fluSample, imaging);
assert.ok(fluImage.totalSignal > 0);
const absorption = {...base, imaging:{...imaging, mode:'absorption'}};
const absImage = simulateImagingFrame(absSample, absorption.imaging);
assert.ok(absImage.peaks.od > 0);

async function reading(metric, experiment = base, timeMS = time) {
  const solver = await createCandidateScorer({...experiment, timeMS, metric});
  try { return (await solver.evaluate(experiment)).value; }
  finally { solver.destroy(); }
}
for (const [metric, expected] of [
  ['count',cloud.count], ['atoms',population.at(time, cloud.count)], ['centroidY',cloud.centroidMM[1]],
  ['blueOn',0], ['greenTotalMW',channels.greenPowersMW.reduce((a,b) => a+b, 0)], ['fieldZeroZ',center[2]],
  ['cloudFieldZ',geometry.biasG[2] + cloud.centroidMM[2] / 10 * geometry.mainTensor[2] * channels.gradientGCM],
  ['alpha',1100], ['oneBodyLoss',1100 * population.at(time, cloud.count)], ['loadingRate',population.loadingRate],
  ['steadyState',population.steadyState], ['loadingTauMS',population.timeConstants().loading.timeMS],
  ['N0.atoms',population.loaded], ['N1.count',full.summary.N1], ['N1.efficiency',100*(population.estimatedAtoms.N1/population.loaded)],
  ['N2.atoms',null], ['transfer',null], ['camera.signal',fluImage.peaks.signal], ['camera.fluorescence.total',fluImage.totalSignal],
  ['input.loading.compressAlpha',1100], ['input.imaging.axis=y',1], ['input.params.biasCurrentA.1',-.05],
]) assert.equal(await reading(metric), expected, metric);
for (const [metric, expected] of [['camera.od',absImage.peaks.od],['camera.clipped',absImage.clippedPixels],
  ['camera.absorption.total',absImage.totalSignal],['camera.reference',absImage.peaks.reference]])
  assert.equal(await reading(metric, absorption), expected, metric);

const experiments = [base, absorption, {...base, config:blueSequence(), imaging:{...imaging,mode:'off'}}];
for (const experiment of experiments) {
  const ids = sequenceObjectives(experiment).map(item=>item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const control of experimentControls(experiment))
    assert.ok(ids.some(id => id === 'input.' + control.id || id.startsWith('input.' + control.id + '=')),control.id);
  assert.equal(ids.includes('greenAtMHz'), experiment.config.mode !== 'blue-only');
  assert.equal(sequenceObjectives(experiment).find(item => item.id === 'camera.od').requiredImagingMode, 'absorption');
}
for (const experiment of [base, absorption]) {
  for (const {id} of sequenceObjectives(experiment)) {
    const objective = findSequenceObjective(experiment, program, id);
    const {value} = scoreSequenceObjective(objective, experiment, program, compact, time);
    assert.ok(value === null || Number.isFinite(value), id);
    if (id.startsWith('input.') || id.startsWith('optical.') || id.startsWith('covariance.'))
      assert.notEqual(value, null, id);
  }
}
const modeTrial = await createCandidateScorer({...base, timeMS:time, metric:'camera.od'});
assert.equal((await modeTrial.evaluate(base)).value, null);
assert.equal((await modeTrial.evaluate({...base, imaging:{...imaging, mode:'off'}})).value, null);
assert.equal((await modeTrial.evaluate(absorption)).value, absImage.peaks.od);
modeTrial.destroy();
assert.equal(await reading('camera.weightedAtoms', {...base, imaging:{...imaging,mode:'off'}}), null);
assert.equal(await reading('exposureStartMS', {...base, imaging:{...imaging,mode:'off'}}), null);
assert.equal(await reading('loadingTauMS', base, capture-.02), null);
assert.equal(await reading('N0.count', base, capture-.02), null);
assert.equal(await reading('lossTauMS', base, capture), null);
const slow = {...base, loading:{flux:1e10, compressAlpha:0, greenBeta:0, greenAlpha:0, handoffAlpha:0, handoffBeta:0, compressBeta:0}};
assert.equal(await reading('lossTauMS', slow, program.durationMS), null);
const fast = {...base, loading:{...base.loading, handoffAlpha:10000, handoffBeta:0}};
const crossing = await reading('lossTauMS', fast, program.durationMS);
assert.ok(crossing > 0 && crossing <= .2);
assert.equal(await reading('lossTauMS', fast, capture + crossing / 2), null);
const scorer = await createCandidateScorer({...base, timeMS:time, metric:'camera.fluorescence.total'});
const first = await scorer.evaluate(base);
const half = await scorer.evaluate({...base, imaging:{...imaging, detectionEfficiency:imaging.detectionEfficiency/2}});
assert.equal(half.value, first.value/2);
assert.equal((await scorer.evaluate(absorption)).value, null);
const wider = await scorer.evaluate({...base, params:{...params, sourceRadiusMM:.2, n:32}});
assert.notEqual(wider.value, first.value);
assert.deepEqual(await scorer.evaluate(base), first);
scorer.destroy();
console.log('完整轨迹、曝光窗口与相机积分逐值一致；不同阶段的检查点、1/e 穿越、磁场、损失和实验包输入通过。');
