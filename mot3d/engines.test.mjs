import assert from 'node:assert/strict';
import test from 'node:test';
import {availableEngines, defaultEngine} from './engines.js';
import {BLUE_TRANSITION, compile, radiation} from './physics.js';
import {GREEN_TRANSITION, saturationIntensity, sequenceRadiation} from './sequence-physics.js';

const origin = [0, 0, 0], waistMM = 6;
const resolved = {engine:'rate-equations', waistMM, mainCurrentA:0, detuningMHz:0, gravity:false};
function powerMW(transition, saturation) {
  return 1000 * Math.PI * (waistMM / 1000)**2 * saturationIntensity(transition) * saturation / 2;
}
function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 2e-14 * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`);
}

test('旧参数使用轻量引擎，无效的引擎或模拟类型会报错', () => {
  assert.equal(compile({}).params.engine, defaultEngine);
  assert.deepEqual(availableEngines('blue').map(e => e.id), [defaultEngine, 'rate-equations']);
  assert.notDeepEqual(availableEngines('two-color'), availableEngines('blue'));
  assert.throws(() => compile({engine:'absent'}), RangeError);
  assert.throws(() => availableEngines('absent'), RangeError);
});

test('沿量子化轴的单束圆偏振光满足两能级解析散射率', () => {
  const s = 2, detuningInLinewidths = -.75;
  const detuningMHz = detuningInLinewidths * BLUE_TRANSITION.gamma / (2*Math.PI*1e6);
  const expected = BLUE_TRANSITION.gamma * s / (2*(1+s+4*detuningInLinewidths**2));
  for (const {id} of availableEngines('blue')) {
    const powersMW = [0,0,0,0,powerMW(BLUE_TRANSITION,s),0];
    const output = radiation(origin, origin, {...resolved, engine:id, detuningMHz, powersMW});
    close(output.totalRate, expected);
    close(output.acceleration[1], BLUE_TRANSITION.recoil * expected);
  }
});

test('零磁场中六束等功率共振光均匀激发三个磁子能级', () => {
  const s = 4, powersMW = Array(6).fill(powerMW(BLUE_TRANSITION,s));
  const rate = radiation(origin, origin, {...resolved, powersMW});
  const expected = BLUE_TRANSITION.gamma * 3*s / (1+4*s);
  close(rate.totalRate, expected);
  rate.rates.forEach(value => close(value, expected/6));
  rate.acceleration.forEach(value => close(value, 0));
  const lightweight = radiation(origin, origin, {...resolved, engine:defaultEngine, powersMW});
  close(lightweight.totalRate, BLUE_TRANSITION.gamma * 3*s / (1+6*s));
});

test('同时驱动两组磁子能级时，散射率满足七能级粒子数守恒', () => {
  const blueS = .8, greenS = 4;
  const channels = {blueOn:true, greenOn:true, blueDetuningMHz:0, greenDetuningMHz:0, gradientGCM:0,
    bluePowersMW:Array(6).fill(powerMW(BLUE_TRANSITION,blueS)),
    greenPowersMW:Array(6).fill(powerMW(GREEN_TRANSITION,greenS))};
  const ratioBlue = blueS / (1+blueS), ratioGreen = greenS / (1+greenS);
  const ground = 1 / (1+3*ratioBlue+3*ratioGreen);
  const result = sequenceRadiation(origin, origin, resolved, channels);
  close(result.blueRate, 3 * BLUE_TRANSITION.gamma * ground * ratioBlue);
  close(result.greenRate, 3 * GREEN_TRANSITION.gamma * ground * ratioGreen);
  close(ground + result.blueRate/BLUE_TRANSITION.gamma + result.greenRate/GREEN_TRANSITION.gamma, 1);
  const greenOnly = sequenceRadiation(origin, origin, resolved, {...channels, blueOn:false});
  close(greenOnly.blueRate, 0);
  close(greenOnly.greenRate, 3 * GREEN_TRANSITION.gamma * greenS / (1+4*greenS));
});
