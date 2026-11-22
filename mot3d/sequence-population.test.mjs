import assert from 'node:assert/strict';
import { loadPopulation, sequencePopulation } from './sequence-population.js';

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
const lossless = {flux: 1e9, alpha: 0, beta: 0};
const population = sequencePopulation(5000, 4000, 1000, lossless);
assert.equal(population.at(1000, 70), 2.5e8);
assert.equal(population.at(5000, 1000), 1.25e9);
assert.equal(population.at(5111, 800), 1e9);
assert.equal(population.weightAt(5111, 800) * 800, 1e9);
assert.equal(sequencePopulation(5000, 8000, 2000, lossless).at(5111, 1600), 1e9);
assert.equal(sequencePopulation(5000, 4000, 0, lossless).at(5111, 0), 0);
assert.equal(sequencePopulation(5000, 4000, 1000, {...lossless, flux:0}).at(5111, 800), 0);
for (const [index, value] of [[0, -1], [1, Infinity], [2, -1], [2, 1.1], [3, NaN], [4, -.1]]) {
  const args = [100, flux, p, alpha, beta]; args[index] = value;
  assert.throws(() => loadPopulation(...args), RangeError);
}
console.log('已验证装载方程、零损失与单类损失极限、5 s 数值积分及浮点稳定性。');
