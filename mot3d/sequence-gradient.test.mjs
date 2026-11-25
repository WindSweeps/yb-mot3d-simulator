import assert from 'node:assert/strict';
import test from 'node:test';
import { blueSequence, compileSequence, songSequence } from './sequence.js';
import { createCandidateScorer } from './sequence-candidate-score.js';
import { simulateSequence } from './sequence-physics.js';
import { sequenceLossStages, sequencePopulation } from './sequence-population.js';
import { optimizeSequence } from './sequence-gradient.js';
import { experimentControls, readControl, setControl } from './sequence-controls.js';

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

test('纯蓝保持时间无上限时仍可在固定观察时刻联合优化装载与保持', async () => {
  const sequence = {...blueSequence(), loadMS:1, holdMS:1};
  const timeMS = 2;
  const scorer = await createCandidateScorer({params:apparatus, loading:{flux:1e7}, timeMS, metric:'atoms'});
  const outcome = await optimizeSequence({config:sequence, timeMS, variables:['loadMS','holdMS'],
    direction:'min', maxEvaluations:10, async evaluate(candidate) {
      assert.ok(Number.isFinite(candidate.holdMS) && compileSequence(candidate).durationMS >= timeMS);
      return (await scorer.evaluate(candidate)).value;
    }});
  scorer.destroy();
  assert.ok(outcome.bestValue < outcome.baseline);
  assert.ok(outcome.bestConfig.loadMS < 1 && outcome.bestConfig.holdMS > 1);
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

test('控制目录按时序模式区分通道和损失，并沿用光闸对应的物理系数', () => {
  const blue = {config:blueSequence()}, twoColor = {config:songSequence()};
  const ids = experimentControls(blue).map(control => control.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('loading.holdBeta') && ids.includes('params.biasPerAmp.2') && ids.includes('imaging.mode'));
  for (const id of ['loading.compressBeta','powerRamp','greenEnabled','params.greenWaistMM','params.seed','params.dtUS','params.n','imaging.displayGain'])
    assert.ok(!ids.includes(id), id);
  assert.ok(experimentControls(twoColor).some(control => control.id === 'loading.compressAlpha'));
  assert.equal(readControl(twoColor, 'loading.beta'), 1.7e-9);
  assert.equal(readControl(setControl(twoColor,'greenEnabled',false),'loading.beta'), 27e-9);
  assert.equal(readControl(setControl(blue,'blueEnabled',false),'loading.beta'), 0);
});

test('候选装置的三轴偏置分量可独立优化并直接在物理模拟中复现', async () => {
  const experiment = {config, params:{...apparatus, biasCurrentA:[0,.2,-.1], biasPerAmp:[2,1,1]}, loading:{flux:1e7}, imaging:{}};
  const initial = structuredClone(experiment);
  const timeMS = 1, scorer = await createCandidateScorer({...experiment, timeMS, metric:'biasX'});
  const observed = [];
  const result = await optimizeSequence({experiment, timeMS, variables:['params.biasCurrentA.0'], direction:'max',
    maxEvaluations:8, async evaluate(candidate) {
      const {value} = await scorer.evaluate(candidate);
      assert.equal(value, candidate.params.biasCurrentA[0] * 2);
      observed.push(value);
      return value;
    }});
  assert.equal(result.bestValue, Math.max(...observed));
  assert.ok(result.bestValue > 0 && result.bestExperiment.params.biasCurrentA[0] > 0);
  assert.deepEqual(result.bestExperiment.params.biasCurrentA.slice(1), initial.params.biasCurrentA.slice(1));
  assert.deepEqual(experiment, initial);
  assert.equal((await scorer.evaluate(result.bestExperiment)).value, result.bestValue);
  scorer.destroy();
});

test('初始损失时间常数无定义时，试算可取得可复现的首次 1/e 时间', async () => {
  const experiment = {config:{...blueSequence(), loadMS:1, holdMS:1}, params:apparatus,
    loading:{flux:1e7, holdAlpha:980, holdBeta:0}, imaging:{}};
  const timeMS = 2, scorer = await createCandidateScorer({...experiment, timeMS, metric:'lossTauMS'});
  const result = await optimizeSequence({experiment, timeMS, variables:['loading.holdAlpha'], direction:'min',
    maxEvaluations:8, evaluate:async candidate => (await scorer.evaluate(candidate)).value});
  assert.equal(result.baseline, null);
  assert.ok(result.bestValue > 0 && result.bestValue <= 1);
  assert.ok(result.bestExperiment.loading.holdAlpha > 1000);
  assert.equal((await scorer.evaluate(result.bestExperiment)).value, result.bestValue);
  scorer.destroy();
});

test('光闸和成像波段以有效离散值试算，保留最佳相机信号', async () => {
  const experiment = {config:{...config,blueEnabled:false}, params:apparatus, loading:{flux:1e7}, imaging:{band:'556'}};
  const timeMS = .8, scorer = await createCandidateScorer({...experiment, timeMS, metric:'camera.fluorescence.total'});
  const attempts = [];
  const result = await optimizeSequence({experiment, timeMS,
    variables:['blueEnabled','imaging.band'], direction:'max', maxEvaluations:10,
    async evaluate(candidate) {
      const {value} = await scorer.evaluate(candidate);
      attempts.push([candidate.config.blueEnabled, candidate.imaging.band, value]);
      return value;
    }});
  assert.equal(result.baseline, 0);
  assert.equal(result.bestExperiment.config.blueEnabled, true);
  assert.ok(result.bestValue > 0 && result.bestValue === Math.max(...attempts.map(([, , value]) => value)));
  assert.ok(attempts.some(([on,band,value]) => on && band === '556' && value === 0));
  scorer.destroy();
});

test('较小预算下的同时扰动实际改变全部选定装置参数', async () => {
  const experiment = {config, params:apparatus, loading:{flux:1e7}, imaging:{}};
  const variables = ['params.sourceSpeed','params.sourceSpread','params.sourceRadiusMM','params.sourceTempMK'];
  const timeMS = 1, scorer = await createCandidateScorer({...experiment, timeMS, metric:'temperatureUK'});
  const result = await optimizeSequence({experiment, variables, timeMS, direction:'min', maxEvaluations:2,
    evaluate:async candidate => (await scorer.evaluate(candidate)).value});
  assert.equal(result.evaluations, 2);
  for (const id of variables) assert.notEqual(readControl(experiment,id), readControl(result.lastExperiment,id), id);
  assert.ok(result.bestValue <= result.baseline && result.bestValue > 0);
  scorer.destroy();
});

test('双体损失在文献系数量级估计局部导数，未改动的空字段继续继承参考值', async () => {
  const experiment = {config, params:apparatus, loading:{flux:1e7}, imaging:{}};
  const timeMS = 1, scorer = await createCandidateScorer({...experiment, timeMS, metric:'atoms'});
  const beta = readControl(experiment,'loading.beta'), probes = [];
  assert.equal(beta, 27e-9);
  const result = await optimizeSequence({experiment, timeMS, variables:['loading.beta'], direction:'max', maxEvaluations:3,
    async evaluate(candidate) {
      probes.push(readControl(candidate,'loading.beta'));
      assert.equal(candidate.loading.alpha, undefined);
      return (await scorer.evaluate(candidate)).value;
    }});
  assert.ok(probes[1] < beta && probes[2] > beta && probes.every(value => value > .5 * beta && value < 2 * beta));
  assert.equal(experiment.loading.beta, undefined);
  assert.ok(result.bestValue > result.baseline);
  scorer.destroy();
});

test('光闸、各束功率和手动设置共同确定优化读数与原子数模型使用的损失系数', () => {
  const dark = [.012,0], blueLoad = [1.3,27e-9], blueHold = [.54,44e-9];
  const cases = [
    [songSequence(), [[.53,1.7e-9],[.21,1e-9],dark,dark]],
    [{...songSequence(),greenEnabled:false}, [blueLoad,blueHold,dark,dark]],
    [{...songSequence(),blueEnabled:false}, [dark,dark,dark,dark]],
    [{...songSequence(),blueEnabled:false,greenEnabled:false}, [dark,dark,dark,dark]],
    [{...songSequence(),blueObliqueMW:0,blueHorizontalMW:0}, [dark,dark,dark,dark]],
    [blueSequence(), [blueLoad,blueHold]],
    [{...blueSequence(),blueEnabled:false}, [dark,dark]],
  ];
  for (const [sequence,expected] of cases) {
    const program = compileSequence(sequence);
    for (const loading of [{}, {alpha:0, beta:5e-9, handoffBeta:0, holdAlpha:.4}]) {
      const stages = sequenceLossStages(program, loading);
      for (const [i,{id,alpha,beta}] of stages.entries()) {
        const ak = id === 'load' ? 'alpha' : id + 'Alpha', bk = id === 'load' ? 'beta' : id + 'Beta';
        assert.deepEqual([alpha,beta], [loading[ak] ?? expected[i][0], loading[bk] ?? expected[i][1]]);
        assert.equal(readControl({config:sequence, loading},'loading.' + ak), alpha);
        assert.equal(readControl({config:sequence, loading},'loading.' + bk), beta);
      }
    }
  }
});
