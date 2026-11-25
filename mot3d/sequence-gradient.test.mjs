import assert from 'node:assert/strict';
import test from 'node:test';
import { blueSequence, compileSequence, songSequence } from './sequence.js';
import { createCandidateScorer } from './sequence-candidate-score.js';
import { simulateSequence } from './sequence-physics.js';
import { sequencePopulation } from './sequence-population.js';
import { optimizeSequence } from './sequence-gradient.js';

const config = {...songSequence(), greenEnabled:false, loadMS:1, handoffMS:.25, greenMS:.25, compressMS:.5,
  blueObliqueMW:6, blueHorizontalMW:4};
const apparatus = {n:24, seed:399174, sourceDistanceMM:.3, sourceSpeed:.12, sourceSpread:.02,
  sourceRadiusMM:.1, sourceTempMK:.001, recoil:false, gravity:true};
const powers = ['blueObliqueMW', 'blueHorizontalMW'];

function temperatureAtLoad(sequence) {
  const run = simulateSequence(apparatus, sequence);
  return run.metrics[run.timesMS.indexOf(sequence.loadMS)].temperatureUK;
}

for (const direction of ['min', 'max']) {
  test('依据同一批真实轨迹' + (direction === 'min' ? '降低' : '提高') + '装载末端温度', async () => {
    const observed = [];
    const evaluated = new Set();
    const result = await optimizeSequence({config, variables:powers, direction, maxEvaluations:16,
      evaluate(candidate) {
        const id = JSON.stringify(candidate);
        assert.ok(!evaluated.has(id));
        evaluated.add(id);
        const temperature = temperatureAtLoad(candidate);
        assert.ok(temperature > 0);
        observed.push(temperature);
        return temperature;
      }});
    assert.equal(result.evaluations, observed.length);
    assert.ok(result.evaluations <= 16);
    assert.equal(result.baseline, observed[0]);
    assert.equal(result.bestValue, direction === 'min' ? Math.min(...observed) : Math.max(...observed));
    assert.notEqual(result.bestValue, result.baseline);
    assert.equal(temperatureAtLoad(result.bestConfig), result.bestValue);
    for (const key of Object.keys(config).filter(key => !powers.includes(key))) assert.equal(result.bestConfig[key], config[key]);
  });
}

test('按固定绝对时刻与仿真次数限制搜索，停止时保存已计算的最优探针', async () => {
  const timeMS = compileSequence(config).durationMS;
  const stop = new AbortController();
  const trials = [];
  const settings = {
    config, timeMS, variables:['loadMS'], direction:'max',
    isFeasible:sequence => compileSequence(sequence).durationMS >= timeMS,
    evaluate(sequence) {
      const program = compileSequence(sequence);
      assert.ok(program.durationMS >= timeMS);
      const run = simulateSequence(apparatus, sequence);
      const frame = run.timesMS.findLastIndex(t => t <= timeMS);
      const atoms = sequencePopulation(program, run, {flux:1e7}).at(timeMS, run.metrics[frame].count);
      trials.push(atoms);
      return atoms;
    },
  };
  const interrupted = await optimizeSequence({...settings, signal:stop.signal,
    onProgress:state => { if (state.evaluations === 2) stop.abort(); }});
  assert.equal(interrupted.reason, 'stopped');
  assert.equal(interrupted.evaluations, 2);
  assert.equal(interrupted.bestValue, Math.max(...trials));
  assert.ok(interrupted.bestValue > interrupted.baseline);
  assert.equal(interrupted.bestConfig.loadMS, interrupted.lastConfig.loadMS);
  const limited = await optimizeSequence({...settings, maxEvaluations:1});
  assert.equal(limited.reason, 'budget');
  assert.equal(limited.evaluations, 1);
  assert.deepEqual(limited.bestConfig, config);
});

test('物理变量边界、几何斜坡、零原子群及不可计算目标', async () => {
  const geometric = {...config, powerRamp:'geometric', finalHorizontalUW:.003, blueObliqueMW:100};
  const checked = await optimizeSequence({
    config:geometric, variables:['finalHorizontalUW', 'blueObliqueMW'], direction:'max', maxEvaluations:8,
    evaluate(sequence) {
      const run = simulateSequence(apparatus, sequence);
      assert.ok(sequence.finalHorizontalUW > 0 && sequence.blueObliqueMW <= 100);
      return run.metrics.at(-1).temperatureUK;
    },
  });
  assert.ok(checked.baseline > 0);
  const empty = await optimizeSequence({config, variables:powers, direction:'max',
    evaluate:sequence => simulateSequence({...apparatus,n:1}, sequence).metrics.at(-1).psdPerAtom});
  assert.equal(empty.reason, 'unavailable');
  assert.equal(empty.evaluations, 1);
  assert.equal(empty.bestConfig, null);
});

test('两个阶段沿固定终点的可行边界重新分配时长', async () => {
  const timeMS = compileSequence(config).durationMS;
  const scorer = await createCandidateScorer({params:apparatus, loading:{flux:1e7}, timeMS, metric:'atoms'});
  const result = await optimizeSequence({config, timeMS, variables:['loadMS','compressMS'], direction:'min',
    maxEvaluations:10, async evaluate(sequence) {
      assert.ok(compileSequence(sequence).durationMS >= timeMS);
      return (await scorer.evaluate(sequence)).value;
    }});
  scorer.destroy();
  assert.ok(result.bestValue < result.baseline);
  assert.ok(result.bestConfig.loadMS < config.loadMS);
  assert.ok(result.bestConfig.compressMS > config.compressMS);
});

test('扩大差分范围能够跨过真实捕获计数的零梯度区间', async () => {
  const sequence = {...config, loadMS:3, handoffMS:.1, greenMS:.1, compressMS:.1, blueObliqueMW:1, blueHorizontalMW:0};
  const params = {...apparatus, n:8, sourceDistanceMM:2, sourceSpeed:.9, sourceSpread:.05, sourceTempMK:.002};
  const scorer = await createCandidateScorer({params, loading:{flux:1e7}, timeMS:3, metric:'atoms'});
  const trials = [];
  const result = await optimizeSequence({config:sequence, timeMS:3, variables:['blueObliqueMW'], direction:'max',
    maxEvaluations:22, async evaluate(candidate) {
      const {value} = await scorer.evaluate(candidate);
      trials.push([candidate.blueObliqueMW, value]);
      return value;
    }});
  scorer.destroy();
  const nearStart = trials.filter(([power]) => Math.abs(power - 1) <= .25);
  assert.ok(nearStart.length >= 5 && nearStart.every(([,value]) => value === 0));
  assert.ok(result.bestValue > 0 && result.bestConfig.blueObliqueMW < .75);
});

test('仅允许优化当前时序模式的变量', async () => {
  const sequence = {...blueSequence(), compressMS:1};
  await assert.rejects(optimizeSequence({config:sequence, variables:['compressMS'], direction:'min',
    evaluate:temperatureAtLoad}), RangeError);
});

test('等比斜坡的功率搜索可越过半功率并始终严格为正', async () => {
  const sequence = {...config, powerRamp:'geometric', finalHorizontalUW:16};
  const scorer = await createCandidateScorer({params:apparatus, loading:{flux:1e7}, timeMS:config.loadMS, metric:'atoms'});
  const tried = [];
  const result = await optimizeSequence({config:sequence, timeMS:config.loadMS, variables:['finalHorizontalUW'],
    direction:'max', maxEvaluations:24, async evaluate(candidate) {
      tried.push(candidate.finalHorizontalUW);
      return (await scorer.evaluate(candidate)).value;
    }});
  scorer.destroy();
  assert.equal(tried.length, result.evaluations);
  assert.equal(result.bestValue, result.baseline);
  assert.ok(Math.min(...tried) < 4 && tried.every(value => value > 0));
});
