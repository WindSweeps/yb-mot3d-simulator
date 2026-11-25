import assert from 'node:assert/strict';
import { derive } from './physics.js';
import { songSequence, compileSequence } from './sequence.js';
import { simulateSequence } from './sequence-physics.js';
import { sequencePopulation } from './sequence-population.js';
import { IMAGING_DEFAULTS } from './sequence-imaging.js';
import { cloudReadout, sequenceCameraImage, sequenceObservation } from './sequence-observation.js';
import { findSequenceObjective, objectiveSampling, scoreSequenceObjective } from './sequence-objectives.js';

const config = {...songSequence(), loadMS:22, handoffMS:.3, greenMS:.5, compressMS:1};
const params = {n:26, seed:192944, sourceDistanceMM:.15, sourceRadiusMM:.12, sourceSpeed:.1,
  sourceSpread:.03, sourceTempMK:.012};
const loading = {flux:1e9}, imaging = {...IMAGING_DEFAULTS, exposureUS:500};
const experiment = {config, params, loading, imaging};
const program = compileSequence(config), geometry = derive(params);
const end = 22.1375;
const result = simulateSequence(params, config, {observeAtMS:end});
const population = sequencePopulation(program, result, loading);
const target = id => findSequenceObjective(experiment, program, id);
const psd = target('psd');
const saved = {population, geometry};

for (const [time, sampled, stage] of [[0,0,'load'],[20,20,'load'],[21.3,20,'load'],[22,20,'handoff'],[end,end,'handoff']]) {
  const curve = cloudReadout(program, result, population, time);
  const cursor = sequenceObservation(experiment, program, result, time, saved);
  const candidate = scoreSequenceObjective(psd, experiment, program, result, time);
  assert.equal(cursor.population, population);
  assert.equal(cursor.geometry, geometry);
  assert.equal(cursor.sampledAtMS, sampled);
  assert.equal(cursor.channels.stageId, stage);
  assert.equal(curve.sampledAtMS, sampled);
  assert.equal(cursor.cameraFrame().sampledAtMS, sampled);
  assert.equal(cursor.cameraFrame().timeMS, time);
  assert.equal(curve.psd, cursor.psd);
  assert.equal(curve.atoms, population.at(time, result.metrics[curve.frame].count));
  assert.deepEqual(candidate, {value:curve.psd, sampledAtMS:sampled});
}
assert.ok(cloudReadout(program, result, population, 21.3).atoms < cloudReadout(program, result, population, 22).atoms);
assert.equal(sequenceObservation(experiment, program, null, 21.3, {population:null, geometry}).cameraFrame().sample.positionsM, null);

const optical = target('optical.blue.scattering');
const limited = simulateSequence(params, config, objectiveSampling(optical, imaging, end));
assert.equal(limited.velocitiesMS.length, 3 * params.n);
assert.ok(scoreSequenceObjective(optical, experiment, program, limited, end).value > 0);
assert.equal(simulateSequence(params, config, objectiveSampling(psd, imaging, end)).positionsM, undefined);
const fluorescence = target('camera.fluorescence.total');
const exposure = simulateSequence(params, config, objectiveSampling(fluorescence, imaging, end));
assert.ok(exposure.firstRecordedFrame > 0 && exposure.positionsM.length < result.positionsM.length);
assert.equal(exposure.velocitiesMS, undefined);
const image = sequenceCameraImage(sequenceObservation(experiment, program, result, end, saved).cameraFrame(), imaging);
assert.ok(image.totalSignal > 0);
assert.equal(scoreSequenceObjective(fluorescence, experiment, program, exposure, end).value, image.totalSignal);
const abs = {...imaging, mode:'absorption'};
const absorption = target('camera.od');
assert.equal(objectiveSampling(absorption, imaging, end).recordFromMS, undefined);
const frozen = simulateSequence(params, config, objectiveSampling(absorption, abs, 22));
assert.equal(frozen.positionsM.length, 3 * params.n);
assert.equal(scoreSequenceObjective(absorption, {...experiment, imaging:abs}, program, frozen, 22).value,
  sequenceCameraImage(sequenceObservation(experiment, program, result, 22, saved).cameraFrame(), abs).peaks.od);
console.log('冻结段、关源边界和额外观察帧的回放、曲线和评分一致；跨阶段荧光曝光与吸收快照使用实际保留的粒子记录。');
