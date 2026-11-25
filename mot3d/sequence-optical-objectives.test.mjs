import assert from 'node:assert/strict';
import test from 'node:test';
import { BEAM_DIRECTIONS, BLUE_TRANSITION, CONSTANTS } from './physics.js';
import { compileSequence, sequenceAt, songSequence } from './sequence.js';
import { GREEN_TRANSITION, simulateSequence, sequenceRadiation } from './sequence-physics.js';
import { opticalObjectives } from './sequence-optical-objectives.js';
import { createCandidateScorer } from './sequence-candidate-score.js';
import { cloudObjectives } from './sequence-cloud-objectives.js';

test('阱内光场目标满足动量守恒、偏振归一与多普勒符号，并可由实际轨迹重算', async () => {
  const timeMS = 1.27;
  const config = {...songSequence(), loadMS:2, handoffMS:.1, greenMS:.2, compressMS:.4,
    blueDetuningMHz:-20, loadGradient:0};
  const params = {n:48, seed:399174, sourceDistanceMM:.3, sourceSpeed:.15, sourceSpread:.02,
    sourceTempMK:.01, sourceRadiusMM:.1, recoil:false, biasCurrentA:[0,.4,0], biasPerAmp:[1,2,1]};
  const experiment = {params, config, loading:{flux:1e9}};
  const program = compileSequence(config);
  const run = simulateSequence(params, config, {observeAtMS:timeMS, metricsOnly:true, recordFromMS:timeMS, observeVelocity:true});
  const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-8*Math.max(1,Math.abs(b)), a+' vs '+b);
  const cloud = run.metrics[run.firstRecordedFrame];
  const channels = sequenceAt(program, timeMS);
  const observation = {experiment, channels, result:run, frame:run.firstRecordedFrame, cloud};
  const get = id => opticalObjectives(config).find(goal => goal.id === 'optical.'+id).read(observation);
  const cloudValue = id => cloudObjectives().find(item => item.id === id).read({cloud});
  close(Math.hypot(...['X','Y','Z'].map(axis => cloudValue('width.'+axis))), cloud.rmsRadiusMM);
  close(['X','Y','Z'].reduce((sum,axis)=>sum+cloudValue('temperature.'+axis),0)/3, cloud.temperatureUK);
  assert.ok(run.metrics[run.firstRecordedFrame].count > 0);
  close(get('fieldMagnitude'), .8);
  close(get('blue.zeeman'), CONSTANTS.muB * .8e-4 / CONSTANTS.h * 1e-6);
  const velocity = run.velocitiesMS;
  let total = 0, count = 0;
  for (let i=0; i<run.n; i++) if (run.trapped[i]) { total += velocity[3*i+1]; count++; }
  close(cloudValue('velocity.Y'), total/count);
  close(get('blue.4.doppler'), total / count / CONSTANTS.wavelength * 1e-6);
  close(get('blue.4.doppler'), -get('blue.5.doppler'));
  close(get('blue.4.detuning.1'), -20 - get('blue.4.doppler') - get('blue.zeeman'));
  for (const color of ['blue','green']) {
    close([0,1,-1].reduce((s,m)=>s+get(color+'.2.polarization.'+m),0), 1);
    close(BEAM_DIRECTIONS.reduce((s,_,i)=>s+get(color+'.'+i+'.scattering'),0), get(color+'.scattering'));
  }
  close(get('blue.excitedFraction') + get('green.excitedFraction') + get('groundFraction'), 1);
  const forceY = (BLUE_TRANSITION.k * (get('blue.4.scattering') - get('blue.5.scattering')) +
    2*Math.PI/555.8e-9 * (get('green.4.scattering') - get('green.5.scattering'))) * CONSTANTS.hbar * 1e21;
  close(get('force.Y'), forceY);
  let mechanicalPower = 0;
  for (let i=0; i<run.n; i++) {
    if (!run.trapped[i]) continue;
    const position = run.positionsM.subarray(3*i, 3*i+3), v = velocity.subarray(3*i, 3*i+3);
    const rates = sequenceRadiation(position, v, params, channels);
    for (const [j, beam] of BEAM_DIRECTIONS.entries()) {
      const parallelSpeed = beam.reduce((sum, component, axis) => sum + component * v[axis], 0);
      const photonMomentumRate = CONSTANTS.hbar * (BLUE_TRANSITION.k * rates.blue[3+j] + GREEN_TRANSITION.k * rates.green[3+j]);
      mechanicalPower += photonMomentumRate * parallelSpeed;
    }
  }
  close(get('mechanicalPower'), mechanicalPower / count * 1e24);
  close(get('mechanicalPower'), get('blue.mechanicalPower') + get('green.mechanicalPower'));
  const scorer = await createCandidateScorer({...experiment, timeMS, metric:'optical.force.Y'});
  try { close((await scorer.evaluate(experiment)).value, forceY); }
  finally { scorer.destroy(); }
});
