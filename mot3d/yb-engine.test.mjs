import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, CONSTANTS as C } from './physics.js';
import { blueSequence, compileSequence, sequenceAt, SEQUENCE_PRESETS } from './sequence.js';
import { createCandidateScorer } from './sequence-candidate-score.js';
import { simulateSequence, sequenceRadiation } from './sequence-physics.js';
import { sequencePopulation } from './sequence-population.js';
import { YB_ISOTOPES, YB_REPUMPS, ybAtom } from './yb-atom.js';
import { atomRandom, threefry2x32 } from './yb-random.js';
import { configureYbField, createYbField, ybRadiation, ybRadiationWorkspace } from './yb-radiation.js';
import { conservativeAcceleration, conservativeEnergy, potentialWorkspace } from './yb-potential.js';
import { advanceGreenDrift, advanceYbAtom, ybTrajectoryWorkspace } from './yb-trajectory.js';

const origin = [0,0,0], yb = ybAtom();
const noLoss = {flux:1e6,alpha:0,beta:0,holdAlpha:0,holdBeta:0};
const darkChannels = {blueOn:false,greenOn:false,blueDetuningMHz:0,greenDetuningMHz:0,
  bluePowersMW:Array(6).fill(0),greenPowersMW:Array(6).fill(0),gradientGCM:0};
const balancedAxes = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]];
function close(actual,expected,tolerance) {
  assert.ok(Math.abs(actual-expected) <= tolerance,`${actual} 与解析值 ${expected} 相差超过 ${tolerance}`);
}
function trajectory(seed,i,state = null,p = origin,v = origin) {
  return {p:Float64Array.from(p),v:Float64Array.from(v),state,rng:atomRandom(seed,i,0),weight:1,budget:null};
}
function motion(species,tier,{recoil = false,continuousGreen = true,settings = {}} = {}) {
  return Object.assign(ybTrajectoryWorkspace(species),{tier,recoil,continuousGreen,daughters:[],
    recovered:0,radiative:0,shelved:[0,0,0,0],timeMS:0,
    settings:{atomLossMode:'reservoir',leakP0:6.18,leakP1:5.25,leakP2:.37,...settings}});
}

test('Random123 三组参考向量及随机流分离', () => {
  for (const [input,expected] of [
    [[0,0,0,0],[0x6b200159,0x99ba4efe]],
    [[0xffffffff,0xffffffff,0xffffffff,0xffffffff],[0x1cb996fc,0xbb002be7]],
    [[0x243f6a88,0x85a308d3,0x13198a2e,0x03707344],[0xc4923a9c,0x483df7a0]],
  ]) assert.deepEqual(Array.from(threefry2x32(...input)),expected);
  const a = atomRandom(399174,13,0), b = atomRandom(399174,13,0), c = atomRandom(399174,13,1);
  for (const rng of [a,b,c]) rng.reset(1,65535);
  b.uniform(2); b.uniform(3); b.uniform(2);
  assert.equal(a.uniform(1),b.uniform(1));
  assert.notEqual(a.uniform(1),c.uniform(1));
});

test('光谱、玻色子强饱和与费米子抽运', () => {
  close(YB_REPUMPS[3].wavelengthNm,2092.6,.06);
  for (const isotope of YB_ISOTOPES) {
    const atom = ybAtom(isotope);
    for (const line of [atom.blue,atom.green]) {
      for (const level of line.levels) close(level.links.reduce((s,l)=>s+l.strength,0),1,1e-13);
    }
    for (const distribution of atom.cascade.flat(2).concat(atom.repumped))
      close(distribution.reduce((s,w)=>s+w,0),1,1e-13);
  }
  const params = {engine:'yb-l1',gravity:false,waistMM:6};
  const field = createYbField(compile(params),yb);
  const inputs = {...darkChannels,blueOn:true,bluePowersMW:Array(6).fill(1e5/field.blue.powerToS)};
  const saturated = sequenceRadiation(origin,origin,params,inputs);
  close(saturated.blueRate/yb.blue.gamma,.75,3e-6);
  const atom = ybAtom('171Yb'), spinField = createYbField(compile(params),atom), work = ybRadiationWorkspace(atom);
  close(atom.blue.levels[0].offset/(2*Math.PI*1e6),321.260,1e-10);
  close(atom.green.levels[0].offset/(2*Math.PI*1e6),-5936.659,1e-10);
  const powers = [0,0,0,0,2/spinField.blue.powerToS,0];
  configureYbField(spinField,{...darkChannels,blueOn:true,bluePowersMW:powers});
  ybRadiation(origin,origin,spinField,work);
  assert.ok(work.ground[1] > .66);
  close(work.blueRate/atom.blue.gamma,1/3,1e-12);
  const plus = work.blueRate;
  configureYbField(spinField,{...darkChannels,blueOn:true,bluePowersMW:powers,blueDetuningMHz:-321.260});
  assert.ok(ybRadiation(origin,origin,spinField,work).blueRate < plus/100);
  configureYbField(spinField,{...darkChannels,blueOn:true,bluePowersMW:powers,blueDetuningMHz:832.436},true);
  close(ybRadiation(origin,origin,spinField,work).blueRate,plus,plus*1e-12);
});

test('低强度三轴光学黏胶达到 Doppler 温度', () => {
  const field = createYbField(compile({waistMM:100,gravity:false}),yb,{directions:balancedAxes});
  const work = motion(yb,1,{recoil:true,settings:{leakP0:0,leakP1:0,leakP2:0}});
  configureYbField(field,{...darkChannels,blueOn:true,blueDetuningMHz:-yb.blue.gammaMHz/2,
    bluePowersMW:Array(6).fill(.02/6/field.blue.powerToS)});
  const n = 1024, h = 50e-6, steps = 420;
  const sums = [0,0,0], squares = [0,0,0];
  for (let i=0; i<n; i++) {
    const atom = trajectory(141421,i);
    for (let j=0; j<steps; j++) {
      atom.rng.reset(0,j);
      advanceYbAtom(atom,h,field,work);
    }
    for (let j=0; j<3; j++) { sums[j] += atom.v[j]; squares[j] += atom.v[j]**2; }
  }
  const theory = C.hbar*yb.blue.gamma/(2*C.kB)*1e6;
  const temperatures = squares.map((s,i)=>(s-sums[i]**2/n)/(n-1)*yb.mass/C.kB*1e6);
  for (const temp of temperatures) close(temp,theory,.12*theory);
  close(temperatures.reduce((a,b)=>a+b,0)/3,theory,.08*theory);
  console.log('Doppler 温度 µK', {theory,temperatures,n,steps});
});

// 用连续时间马尔可夫链的矩阵指数计算三种状态的布居。
function brightReference(f,rateP0,rateP2,time) {
  const b0 = 6.18*f, b2 = .37*f;
  const p0Bright = rateP0/3, p0P2 = rateP0*5/9, p2Bright = rateP2/3, p2P0 = rateP2/9;
  const m = Math.max(b0+b2,p0Bright+p0P2,p2Bright+p2P0);
  let poisson = Math.exp(-m*time), sum = poisson;
  let bright = 1, p0 = 0, p2 = 0;
  for (let j=1; j<=400; j++) {
    [bright,p0,p2] = [
      bright*(1-(b0+b2)/m)+(p0*p0Bright+p2*p2Bright)/m,
      p0*(1-(p0Bright+p0P2)/m)+(bright*b0+p2*p2P0)/m,
      p2*(1-(p2Bright+p2P0)/m)+(bright*b2+p0*p0P2)/m,
    ];
    poisson *= m*time/j;
    sum += poisson*bright;
  }
  return sum;
}

test('四种可见光重泵浦组合对应有限速率布居', () => {
  const field = createYbField(compile({gravity:false}),yb);
  const n = 14000, time = .21, data = [];
  for (const s of [.4,2.3]) for (const [p0,p2] of [[0,0],[0,850],[850,0],[850,850]]) {
    const work = motion(yb,2);
    configureYbField(field,{...darkChannels,blueOn:true,bluePowersMW:Array(6).fill(s/field.blue.powerToS),
      repump:{waistM:.02,rates:[p0,p2,0,0]}});
    let bright = 0;
    for (let i=0; i<n; i++) {
      const atom = trajectory(64353,i);
      atom.rng.reset(1,0);
      advanceYbAtom(atom,time,field,work);
      bright += Number(!atom.state);
    }
    const f = 3*s/(1+4*s), expected = brightReference(f,p0,p2,time);
    const error = Math.sqrt(expected*(1-expected)/n);
    close(bright/n,expected,5*error+.001);
    data.push({p0,p2,f,bright:bright/n,expected,observedSlope:-Math.log(bright/n)/(f*time),
      referenceSlope:-Math.log(expected)/(f*time)});
  }
  console.log('有限脉冲四模式',data);
});

test('磁阱机械能及重力轴梯度', () => {
  const field = createYbField(compile({gravity:true}),yb), work = motion(yb,2);
  const level = yb.p2.find(row=>row.m===2);
  configureYbField(field,{...darkChannels,gradientGCM:50});
  const potential = potentialWorkspace(), errors = [];
  for (const dt of [80e-6,40e-6,20e-6]) {
    const atom = trajectory(10,0,{kind:'p2',level},[.0009,.0003,.0017],[.022,.07,.025]);
    const initial = conservativeEnergy(atom.p,atom.v,field,yb,atom.state,potential);
    const steps = Math.round(.8/dt);
    let drift = 0;
    for (let i=0; i<steps; i++) {
      advanceYbAtom(atom,dt,field,work);
      drift = Math.max(drift,Math.abs(conservativeEnergy(atom.p,atom.v,field,yb,atom.state,potential)/initial-1));
    }
    assert.ok(drift < .01);
    errors.push(drift);
  }
  assert.ok(errors[2] < errors[1] && errors[1] < errors[0]);
  console.log('磁阱最大相对能量误差',errors);
});

test('暗态自然寿命的指数衰减', () => {
  const field = createYbField(compile({gravity:false}),yb), work = motion(yb,2,
    {settings:{darkDecay:'on'}});
  configureYbField(field,darkChannels);
  work.naturalRecovered = 0;
  const n = 8192, time = 4, state = {kind:'p2',level:yb.p2.find(row => row.m === 2)};
  for (let i=0; i<n; i++) {
    const atom = trajectory(490812,i,state);
    atom.rng.reset(0,0);
    advanceYbAtom(atom,time,field,work);
  }
  const expected = -Math.expm1(-time/15);
  close(work.naturalRecovered/n,expected,4.5*Math.sqrt(expected*(1-expected)/n));
});

test('空碰撞抽样通过快速扫过 556 nm 共振的独立积分', () => {
  const field = createYbField(compile({gravity:false}),yb), work = motion(yb,3);
  const saturation = .025, speed = 5, y0 = .001, center = .0034, duration = .00077, gradient = 50;
  const gradientHz = yb.green.lande*C.muB/C.h*gradient*.01;
  const offsetHz = gradientHz*center+yb.green.k*speed/(2*Math.PI);
  const powers = [0,0,0,0,saturation/field.green.powerToS,0];
  configureYbField(field,{...darkChannels,greenOn:true,greenPowersMW:powers,
    gradientGCM:gradient,greenDetuningMHz:offsetHz/1e6});
  const halfWidth = yb.green.gammaMHz*1e6*Math.sqrt(1+saturation)/(2*gradientHz*speed);
  const centerTime = (center-y0)/speed;
  const peak = .5*yb.green.gamma*saturation/(1+saturation);
  const expected = -Math.expm1(-peak*halfWidth*
    (Math.atan((duration-centerTime)/halfWidth)+Math.atan(centerTime/halfWidth)));
  const n = 9000;
  let hit = 0;
  for (let i=0; i<n; i++) {
    const atom = trajectory(589372,i,null,[0,y0,0],[0,speed,0]);
    atom.rng.reset(0,0);
    work.greenEvents = 0;
    advanceGreenDrift(atom.p,atom.v,duration,field,atom.rng,work);
    hit += Number(work.greenEvents > 0);
  }
  close(hit/n,expected,4.5*Math.sqrt(expected*(1-expected)/n));
  console.log('扫描共振至少一次散射的比例', {observed:hit/n,expected,n});
});

test('实装时序中的带权损失、暗态回流、关源收支和同种子复现', () => {
  const n = 128, initialStates = new Float64Array(n*6);
  const params = {engine:'yb-l2',n,gravity:false,recoil:false};
  const config = {...blueSequence(),loadMS:100,holdMS:90,loadGradient:0,blueDetuningMHz:0,
    blueObliqueMW:40,blueHorizontalMW:40,atomStepUS:100,p2Branches:3};
  const options = {initialStates,loading:noLoss,observeVelocity:true};
  const noPump = simulateSequence(params,config,options);
  const both = {...config,repump649:2200,repump770:2200,repumpLeadMS:61,repumpDurationMS:60};
  const run = simulateSequence(params,both,options);
  assert.equal(run.timesMS.indexOf(129) > -1,true);
  assert.equal(run.timesMS.indexOf(189) > -1,true);
  assert.ok(noPump.metrics.at(-1).ledger.p0 > 30);
  assert.ok(run.metrics.at(-1).ledger.trappedBright > noPump.metrics.at(-1).ledger.trappedBright+10);
  assert.ok(run.metrics.at(-1).ledger.recovered > 0);
  for (const frame of run.metrics) close(frame.ledger.residual,0,5e-10);
  assert.deepEqual(run.metrics,simulateSequence(params,both,{...options,metricsOnly:true}).metrics);
  const population = sequencePopulation(compileSequence(both),run,noLoss);
  close(population.at(190),run.sourceMassPerSample*run.metrics.at(-1).ledger.trappedBright,1e-9);
  const weightedConfig = {...config,atomLossMode:'lifetime'};
  const weighted = simulateSequence(params,weightedConfig,options);
  const f = sequenceRadiation(origin,origin,params,sequenceAt(compileSequence(config),0)).blueRate/yb.blue.gamma;
  close(weighted.metrics.at(-1).ledger.trappedBright/n,Math.exp(-6.55*f*.19),2e-12);
  assert.throws(() => compileSequence({...both,atomLossMode:'lifetime'}),RangeError);
});

test('光阱张量势的机械力及 399 nm 到 556 nm 时序', () => {
  const trap = {mode:'lattice',wavelengthM:759.35e-9,waistM:60e-6,powerW:.25,polarization:.37,
    coefficients:{ground:[150,0],blue:[200,30],green:[100,-74],p0:[150,0],p2:[201,86]}};
  const field = createYbField(compile({gravity:true,biasCurrentA:[.1,.3,.4]}),yb);
  const p = [1.039e-6,9e-6,17e-6], v = [0,0,0], work = potentialWorkspace();
  const state = {kind:'p2',level:yb.p2.find(row=>row.m===1)}, a = new Float64Array(3);
  configureYbField(field,{...darkChannels,trap,gradientGCM:50});
  conservativeAcceleration(p,field,yb,state,a,work);
  for (let axis=0; axis<3; axis++) {
    const xp = p.slice(), xm = p.slice(), eps = 1e-11;
    xp[axis] += eps; xm[axis] -= eps;
    const finite = (conservativeEnergy(xm,v,field,yb,state,work)-conservativeEnergy(xp,v,field,yb,state,work))/(2*eps*yb.mass);
    close(a[axis],finite,Math.abs(a[axis])*1e-5+1e-5);
  }
  const blue = {...darkChannels,blueOn:true,bluePowersMW:Array(6).fill(.5)};
  const atOrigin = sequenceRadiation(origin,origin,{engine:'yb-l3',gravity:false},{...blue,trap});
  const without = sequenceRadiation(origin,origin,{engine:'yb-l3',gravity:false},blue);
  assert.ok(atOrigin.blueRate < without.blueRate);
  const matched = {...trap,coefficients:{...trap.coefficients,blue:[150,0]}};
  close(sequenceRadiation(origin,origin,{engine:'yb-l3'}, {...blue,trap:matched}).blueRate,
    without.blueRate,1e-8);
  const input = {engine:'yb-l3',isotope:'171Yb',n:8,recoil:true,gravity:true};
  const preset = SEQUENCE_PRESETS.find(p => p.id === 'blue-to-green-yb');
  const config = {...preset.config,loadMS:3,handoffMS:.15,greenMS:1,compressMS:2,
    greenObliqueMW:.04,greenHorizontalMW:.04,finalObliqueUW:5,finalHorizontalUW:5,
    shieldingMHz:-.4,receiveMHz:-.32,compressMHz:-.18};
  const result = simulateSequence(input,config,{initialStates:new Float64Array(48),loading:noLoss});
  assert.equal(result.isotope,'171Yb');
  assert.ok(result.blueRates[0] > 0);
  assert.equal(result.greenRates[0],0);
  assert.equal(sequenceAt(compileSequence(config),3).greenOn,true);
  assert.ok(result.greenRates.at(-result.n) > 0);
  assert.equal(result.blueRates.at(-result.n),0);
  assert.ok(result.samplingDiagnostics.greenEvents > 0);
});

test('带权读数可通过优化求解器，绝对频率设置可使用同位素位移',async () => {
  const config = {...blueSequence(),loadMS:15,holdMS:8,blueDetuningMHz:832.436,
    detuningReference:'174Yb',repump649:950,repumpLeadMS:4,repumpDurationMS:3};
  const params = {engine:'yb-l2',isotope:'171Yb',n:12,sourceSpeed:.1,sourceSpread:0,sourceDistanceMM:.1,
    sourceRadiusMM:.1,sourceTempMK:0,recoil:false,gravity:false};
  const timeMS = 19.1, program = compileSequence(config);
  const result = simulateSequence(params,config,{metricsOnly:true,observeAtMS:timeMS,loading:noLoss});
  const frame = result.timesMS.indexOf(timeMS);
  for (const [metric,expected] of [['atoms',sequencePopulation(program,result,noLoss).at(timeMS)],
    ['dark.magnetic',result.metrics[frame].ledger.p2Magnetic*result.sourceMassPerSample],
    ['N0.fromSource.fraction',100*result.samplingDiagnostics.stages.N0.fractionOfInput]]) {
    const scorer = await createCandidateScorer({params,loading:noLoss,timeMS,metric});
    try {
      const score = await scorer.evaluate(config);
      assert.equal(score.backend,'CPU');
      assert.equal(score.sampledAtMS,timeMS);
      close(score.value,expected,1e-12);
    } finally { scorer.destroy(); }
  }
});
