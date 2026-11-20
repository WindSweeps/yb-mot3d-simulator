import assert from 'node:assert/strict';
import { CONSTANTS as C, radiation } from './physics.js';
import { compileSequence, sequenceAt, songSequence } from './sequence.js';
import { sequenceRadiation, simulateSequence } from './sequence-physics.js';

function close(x, y, tolerance) {
  assert.ok(Math.abs(x-y) <= tolerance, `${x} ≠ ${y} (±${tolerance})`);
}

const song = songSequence(), program = compileSequence(song), channels = sequenceAt(program, 0);
const origin = [0,0,0], position = [.001,-.002,.001], velocity = [.2,-.13,.4];
const params = { gravity:false, recoil:false };
const both = sequenceRadiation(position, velocity, params, channels);
const blueOnly = sequenceRadiation(position, velocity, params, {...channels, greenOn:false});
const greenOnly = sequenceRadiation(position, velocity, params, {...channels, blueOn:false});
const single = radiation(position, velocity, { ...params, powersMW:channels.bluePowersMW,
  detuningMHz:channels.blueDetuningMHz, mainCurrentA:1, gradientPerAmp:channels.gradientGCM });
close(blueOnly.blueRate, single.totalRate, 1e-7);
for (let a=0; a<3; a++) close(blueOnly.acceleration[a], single.acceleration[a], 1e-9);
assert.equal(blueOnly.greenRate,0);
assert.equal(greenOnly.blueRate,0);
const fg = greenOnly.greenRate/(2*Math.PI*180e3), fb = blueOnly.blueRate/C.gamma;
const ground = 1/(1 + fg/(1-fg) + fb/(1-fb));
close(both.blueRate, C.gamma*ground*fb/(1-fb), 1e-7);
close(both.greenRate, 2*Math.PI*180e3*ground*fg/(1-fg), 1e-8);

const oneGreen = {...channels,blueOn:false,greenPowersMW:[0,0,0,0,.1,0],greenDetuningMHz:0};
for (const waist of [3,6,12]) {
  const gamma = 2*Math.PI*180e3, lambda=555.8e-9;
  const isat=C.h*C.c*gamma*Math.PI/(3*lambda**3), s=.0002/(Math.PI*(waist*.001)**2*isat);
  const rate = .5*gamma*s/(1+s);
  const g=sequenceRadiation(origin,origin,{...params,greenWaistMM:waist},oneGreen);
  close(g.greenRate, rate, rate*1e-12);
  close(g.acceleration[1], C.hbar*2*Math.PI/lambda/C.mass*rate, 1e-9);
  close(g.acceleration[0],0,1e-12);
}

const dark = { ...song, blueEnabled:false, greenEnabled:false, loadMS:1, handoffMS:.2, greenMS:.8, compressMS:1 };
const launches = [0,0,0,0,0,.03, 0,0,0,0,0,-.03, .004,0,0,0,0,0];
const ballistic = simulateSequence({n:3,recoil:true,gravity:true},dark,{initialStates:launches});
assert.deepEqual(ballistic.summary,{N0:2,N1:2,N2:2});
const last = (ballistic.frameCount-1)*3, t = ballistic.timesMS.at(-1)/1000;
for (let i=0; i<2; i++) {
  close(ballistic.positionsM[3*(last+i)+2],launches[6*i+5]*t-.5*C.gravity*t*t,1e-10);
  assert.equal(ballistic.alive[last+i],1);
}
assert.equal(ballistic.alive[last+2],0);
assert.ok(ballistic.blueRates.every(r=>r===0) && ballistic.greenRates.every(r=>r===0));
close(ballistic.metrics.at(-1).temperatureUK,C.mass*(.03**2+.03**2)*1e6/(3*C.kB),1e-9);
const empty = simulateSequence({n:1},dark,{initialStates:[.004,0,0,0,0,0]});
assert.deepEqual(empty.summary,{N0:0,N1:0,N2:0});
assert.equal(empty.metrics.at(-1).temperatureUK,null);
assert.equal(empty.metrics.at(-1).centroidMM,null);

// 同一粒子沿实际时序连续演化，改变长装载等待时长只平移此代表样本的后续时刻。
const runParams = { n:3, seed:456, recoil:false, gravity:true };
const sample = [0,0,.0002,.02,0,0, .0004,.0001,-.0004,-.03,0,.11, -.0001,0,0,0,-.12,.08];
const short = { ...song, loadMS:20, greenMS:.8, compressMS:2 };
const long = { ...short, loadMS:1200 };
const reference = simulateSequence(runParams,short,{initialStates:sample});
const longRun = simulateSequence(runParams,long,{initialStates:sample});
assert.deepEqual(reference.summary,longRun.summary);
assert.equal(longRun.loadWindowMS,20);
const r0=longRun.timesMS.indexOf(20), r1=longRun.timesMS.indexOf(1200);
assert.equal(r1,r0+1);
assert.deepEqual(longRun.positionsM.slice(9*r0,9*r0+9),longRun.positionsM.slice(9*r1,9*r1+9));
for (let k=0;k<9;k++) close(longRun.positionsM.at(k-9),reference.positionsM.at(k-9),1e-9);
const refined = simulateSequence({...runParams,dtUS:2.5},short,{initialStates:sample});
assert.deepEqual(reference.summary,refined.summary);
for (let k=0;k<9;k++) close(reference.positionsM.at(k-9),refined.positionsM.at(k-9),1e-7);

const batch = simulateSequence({ n:32, seed:399174 },song);
assert.ok(batch.N0>0 && batch.N2>0 && batch.N0>=batch.N1 && batch.N1>=batch.N2);
const replay = simulateSequence({ n:32, seed:399174 },song);
assert.deepEqual(batch.positionsM,replay.positionsM);
assert.ok(batch.greenRates.some(r=>r>0));
for (let f=0; f<batch.frameCount; f++) {
  if (f) assert.ok(batch.timesMS[f]>batch.timesMS[f-1]);
  if (batch.timesMS[f]>=song.loadMS+song.handoffMS)
    assert.ok(batch.blueRates.subarray(f*batch.n,(f+1)*batch.n).every(r=>r===0));
}
console.log('通过单色散射、双色基态归一、绿光饱和与束腰、解析重力、队列交接、布居温度、暗场、空云、步长细化与种子复现检查。',batch.summary);
