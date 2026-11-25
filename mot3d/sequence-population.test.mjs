import assert from 'node:assert/strict';
import { loadPopulation, sequenceLossStages, sequencePopulation } from './sequence-population.js';
import { blueSequence, compileSequence, songSequence } from './sequence.js';
import { simulateSequence } from './sequence-physics.js';

function near(actual, expected, tolerance = 2e-13) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.abs(expected), `${actual} ≠ ${expected}`);
}

assert.equal(loadPopulation(0, 1e9, .2, .4, 8e-9), 0);
assert.equal(loadPopulation(1000, 0, .2, .4, 8e-9), 0);
assert.equal(loadPopulation(1000, 1e9, 0, .4, 8e-9), 0);
assert.equal(loadPopulation(5000, 1e9, .2, 0, 0), 1e9);

// 单体损失的指数装载与仅双体损失的 tanh 解分别可独立验证。
const flux = 1e9, p = .24, rate = flux * p, alpha = .34, beta = 1.1e-8;
for (const t of [1e-10, .001, .25, 5, 5000]) {
  near(loadPopulation(t * 1000, flux, p, alpha, 0), -Math.expm1(-alpha * t) * rate / alpha);
  near(loadPopulation(t * 1000, flux, p, 0, beta), Math.sqrt(rate / beta) * Math.tanh(t * Math.sqrt(rate * beta)));
}

// 两类损失同时存在时用原微分方程作独立数值积分。
const rhs = n => rate - alpha * n - beta * n * n;
const dt = .0001;
let numerical = 0;
for (let i = 1; i <= 50000; i++) {
  const k1 = rhs(numerical), k2 = rhs(numerical + dt * k1 / 2);
  const k3 = rhs(numerical + dt * k2 / 2), k4 = rhs(numerical + dt * k3);
  numerical += dt * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
  if ([1, 10, 1000, 8500, 50000].includes(i)) near(loadPopulation(i * dt * 1000, flux, p, alpha, beta), numerical);
}
const equilibrium = loadPopulation(1e9, flux, p, alpha, beta);
near(alpha * equilibrium + beta * equilibrium ** 2, rate);
near(loadPopulation(1e-17, flux, p, alpha, beta), rate * 1e-20);
near(loadPopulation(1, 1e308, 1, 1e-300, 0), 1e305);
near(loadPopulation(1e-322, 1e308, 1, 0, 0), 1e305 * 1e-322);
near(loadPopulation(100000, 1e308, 1, 1e308, 1e308), (Math.sqrt(5) - 1) / 2);
const song = songSequence(), program = compileSequence(song);
function coefficients(config) {
  return sequenceLossStages(compileSequence({...song, ...config})).map(s => [s.light, s.alpha, s.beta]);
}
const greenHold = ['green', .012, 0], dark = ['dark', .012, 0];
assert.deepEqual(coefficients({}), [['twoColor', .53, 1.7e-9], ['twoColor', .21, 1e-9], greenHold, greenHold]);
assert.deepEqual(coefficients({greenEnabled:false}), [['blue', 1.3, 27e-9], ['blue', .54, 44e-9], dark, dark]);
assert.deepEqual(coefficients({blueEnabled:false}), [greenHold, greenHold, greenHold, greenHold]);
assert.deepEqual(coefficients({blueEnabled:false, greenEnabled:false}), [dark, dark, dark, dark]);
assert.deepEqual(coefficients({blueObliqueMW:0, blueHorizontalMW:0, greenObliqueMW:0, greenHorizontalMW:0}),
  [dark, dark, dark, greenHold]);

// 原点上无重力和反冲的原子在对称光场中静止，可逐阶段直接对照论文式 (2)、(3)。
const params = {n:2, dtUS:20, gravity:false, recoil:false};
const held = simulateSequence(params, song, {initialStates: [0,0,0,0,0,0, 0,0,0,0,0,0]});
assert.deepEqual(held.summary, {N0:2, N1:2, N2:2});
const loaded = loadPopulation(5000, 8.4e7, 1, .53, 1.7e-9);
// 用表 II 的装载率代入双色损失模型，与论文给出的稳态原子数比较。
near(loadPopulation(60000, 8.4e7, 1, .53, 1.7e-9), 1.15e8, .01);
near(loaded, 1.14165484e8, 1e-8);
function equation3(initial, seconds, a, b) {
  if (a === 0) return initial / (1 + initial * b * seconds);
  return a * initial / (a * Math.exp(a * seconds) + b * initial * Math.expm1(a * seconds));
}
const transferred = equation3(loaded, .001, .21, 1e-9);
const received = transferred * Math.exp(-.012 * .010);
const compressed = received * Math.exp(-.012 * .100);
const population = sequencePopulation(program, held, {flux:8.4e7});
near(population.loaded, loaded);
near(population.at(5000.53, 2), equation3(loaded, .00053, .21, 1e-9));
near(population.at(5001, 2), transferred);
near(population.estimatedAtoms.N1, received);
near(population.estimatedAtoms.N2, compressed);
near(population.weightAt(5111, 2) * 2, compressed);
const onlyOne = sequencePopulation(program, held, {flux:8.4e7, handoffBeta:0});
near(onlyOne.at(5001, 2), loaded * Math.exp(-.21 * .001));
const onlyTwo = sequencePopulation(program, held, {flux:8.4e7, compressAlpha:0, compressBeta:2e-8});
near(onlyTwo.estimatedAtoms.N2, equation3(received, .100, 0, 2e-8));
assert.throws(() => sequencePopulation(program, held, {flux:8.4e7, greenAlpha:-1}), RangeError);

// 按真实入射冷束检查轨迹逃逸只在阱内计数处扣除；双体衰减可由 1/w 的时间积分独立检验。
const run = simulateSequence({n:48, seed:399174}, song);
assert.ok(run.N0 > run.N2 && run.N2 > 0);
const lossless = {flux:1e9, alpha:0, beta:0, handoffAlpha:0, handoffBeta:0, greenAlpha:0, greenBeta:0,
  compressAlpha:0, compressBeta:0};
const withoutLoss = sequencePopulation(program, run, lossless);
const initialWeight = 1e9 * 5 / run.n;
near(withoutLoss.estimatedAtoms.N0, run.N0 * initialWeight);
near(withoutLoss.estimatedAtoms.N1, run.N1 * initialWeight);
near(withoutLoss.estimatedAtoms.N2, run.N2 * initialWeight);
const b = 7e-9;
const withPairs = sequencePopulation(program, run, {...lossless, handoffBeta:b, greenBeta:b, compressBeta:b});
let countSeconds = 0;
for (let f = run.timesMS.indexOf(song.loadMS); f + 1 < run.timesMS.length; f++)
  countSeconds += run.metrics[f].count * (run.timesMS[f + 1] - run.timesMS[f]) / 1000;
near(withPairs.estimatedAtoms.N2, run.N2 / (1 / initialWeight + b * countSeconds));
assert.deepEqual(sequencePopulation(program, run, {flux:0}).estimatedAtoms, {N0:0, N1:0, N2:0});
const empty = simulateSequence({n:1, gravity:false, recoil:false}, song, {initialStates:[.04,0,0,0,0,0]});
assert.equal(empty.summary.N0, 0);
assert.deepEqual(sequencePopulation(program, empty, {flux:1e9}).estimatedAtoms, {N0:0, N1:0, N2:0});
for (const [index, value] of [[0, -1], [1, Infinity], [2, -1], [2, 1.1], [3, NaN], [4, -.1]]) {
  const args = [100, flux, p, alpha, beta]; args[index] = value;
  assert.throws(() => loadPopulation(...args), RangeError);
}

const inactive = {status:'empty', timeMS:null};
assert.deepEqual(sequencePopulation(program, empty, {flux}).timeConstants(), {loading:inactive, loss:inactive});
assert.deepEqual(sequencePopulation(program, held, {flux:0}).timeConstants(), {loading:inactive, loss:inactive});
const constants = overrides => sequencePopulation(program, held, {...lossless,...overrides}).timeConstants();
assert.deepEqual(constants({}), {loading:{status:'no-steady-state', timeMS:null}, loss:{status:'lower-bound', timeMS:111}});
assert.deepEqual(constants({alpha:1e-310}).loading, {status:'out-of-range', timeMS:null});
near(constants({alpha}).loading.timeMS, 1000/alpha);
near(constants({beta}).loading.timeMS, 1000 * Math.atanh(1 - 1/Math.E) / Math.sqrt(flux*beta));
const mixedLoading = constants({alpha, beta}).loading;
assert.equal(mixedLoading.status, 'reached');
const steady = 2*flux / (alpha + Math.sqrt(alpha**2 + 4*beta*flux));
near(loadPopulation(mixedLoading.timeMS, flux, 1, alpha, beta), steady*(1 - 1/Math.E));

// 10 ms 接收和前段压缩共同提供积分损失，阈值位于两个回放帧之间。
const switched = constants({greenAlpha:10, compressAlpha:27}).loss;
assert.equal(switched.status, 'reached');
near(switched.timeMS, 11 + 900/27);
const betaHold = 1e-8, n0 = flux*5;
const pairOnly = constants({handoffBeta:betaHold, greenBeta:betaHold, compressBeta:betaHold}).loss;
assert.equal(pairOnly.status, 'reached');
near(pairOnly.timeMS, 1000 * Math.expm1(1) / (betaHold * n0));
const aHold = 9;
const mixedLoss = constants({handoffAlpha:aHold, handoffBeta:betaHold, greenAlpha:aHold, greenBeta:betaHold,
  compressAlpha:aHold, compressBeta:betaHold}).loss;
assert.equal(mixedLoss.status, 'reached');
near(mixedLoss.timeMS, 1000/aHold * Math.log((Math.E*aHold + betaHold*n0) / (aHold + betaHold*n0)));
assert.equal(constants({compressAlpha:10}).loss.status, 'reached');
near(constants({compressAlpha:10}).loss.timeMS, 111);

// 无光、无重力时两条等速轨迹越过 3 mm 边界，数量从三条变为一条，首次低于 N₀/e。
const driftConfig = {...blueSequence(), loadMS:.1, holdMS:100, blueEnabled:false};
for (const [speed, dropMS] of [[.05,60],[.03002,100]]) {
  const drift = simulateSequence({...params,n:3}, driftConfig,
    {initialStates:[0,0,0,0,0,0, 0,0,0,speed,0,0, 0,0,0,speed,0,0]});
  const pop = sequencePopulation(compileSequence(driftConfig), drift, {...lossless,holdAlpha:0,holdBeta:0});
  assert.deepEqual(pop.timeConstants().loss, {status:'reached', timeMS:dropMS});
}
console.log('已验证宋博组表 II 系数、式 (2) 与 (3)、真实轨迹的阱内计数及双体衰减。');
