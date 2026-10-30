import assert from 'node:assert/strict';
import { DEFAULTS, CONSTANTS as C, BEAM_DIRECTIONS, derive, compile, fieldAt,
  radiation, opticalAcceleration, acceleration, simulate, sampleInitialStates } from './physics.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const close = (a,b,tol=1e-10) => assert.ok(Math.abs(a-b)<=tol, `${a} vs ${b}, tolerance ${tol}`);
const off = { powersMW:[0,0,0,0,0,0],gravity:false,recoil:false };
const rmsDifference = (a,b) => Math.sqrt(a.reduce((s,v,i)=>s+(v-b[i])**2,0)/a.length);

check('User geometry: all unit directions, opposed pairs, 120 degree vertical angle',()=>{
  BEAM_DIRECTIONS.forEach(v=>close(Math.hypot(...v),1,1e-15));
  for(let j=0;j<6;j+=2) for(let a=0;a<3;a++) close(BEAM_DIRECTIONS[j][a]+BEAM_DIRECTIONS[j+1][a],0,0);
  close(BEAM_DIRECTIONS[0].reduce((s,v,a)=>s+v*BEAM_DIRECTIONS[2][a],0),-.5,1e-15);
});
check('No-light acceleration is exactly zero; gravity acts along -Z',()=>{
  assert.deepEqual(acceleration([.002,-.004,.009],[17,-2,3],off),[0,0,0]);
  assert.deepEqual(acceleration([.002,-.004,.009],[17,-2,3],{...off,gravity:true}),[0,0,-9.80665]);
});
check('Independent analytic ballistic/gravity trajectory',()=>{
  const initial=[.001,-.002,.003,1,2,3], t=.005;
  for(const gravity of [false,true]){
    const r=simulate({...off,n:1,durationMS:5,gravity},{initialStates:initial});
    for(let a=0;a<3;a++){
      const g=gravity&&a===2?-9.80665:0;
      close(r.finalPositions[a],initial[a]+initial[a+3]*t+.5*g*t*t,1e-10);
      close(r.finalVelocities[a],initial[a+3]+g*t,1e-9);
    }
  }
});
check('Balanced beams have zero optical acceleration at origin',()=>{
  opticalAcceleration([0,0,0],[0,0,0]).forEach(v=>close(v,0,1e-9));
});
const restoring = p => [0,1,2].every(a=>{
  const r=[0,0,0];r[a]=.0001;
  return opticalAcceleration(r,[0,0,0],p)[a]<0;
});
check('Default Y-axis quadrupole restores all three coordinates and respects inversion',()=>{
  assert.ok(restoring({}));
  for(let a=0;a<3;a++){
    const r=[0,0,0];r[a]=.0001;
    const plus=opticalAcceleration(r,[0,0,0]);
    const minus=opticalAcceleration(r.map(v=>-v),[0,0,0]);
    plus.forEach((v,i)=>close(v,-minus[i],1e-8));
  }
});
check('Negative control: reversed current fails the same restoring checker',()=>{
  assert.equal(restoring({mainCurrentA:-3}),false);
  for(let a=0;a<3;a++){
    const r=[0,0,0];r[a]=.0001;
    assert.ok(opticalAcceleration(r,[0,0,0],{mainCurrentA:-3})[a]>0);
  }
});
check('Z quadrupole with unchanged optics exposes instability, not automatic helicity repair',()=>{
  assert.equal(restoring({mainAxis:'z'}),false);
  assert.ok(opticalAcceleration([0,0,.0001],[0,0,0],{mainAxis:'z'})[2]>0);
  assert.ok(opticalAcceleration([0,.0001,0],[0,0,0],{mainAxis:'z'})[1]>0);
});
check('Red detuning damps; blue detuning anti-damps on every axis',()=>{
  for(let a=0;a<3;a++){
    const v=[0,0,0];v[a]=.1;
    assert.ok(opticalAcceleration([0,0,0],v)[a]<0);
    assert.ok(opticalAcceleration([0,0,0],v,{detuningMHz:25})[a]>0);
  }
});
check('Independent bias-field zero algebra for Y and Z axes',()=>{
  const p={biasCurrentA:[.3,-.6,.9]};
  const y=derive(p),z=derive({...p,mainAxis:'z'});
  [.2,.2,.6].forEach((v,a)=>close(y.zeroMM[a],v,1e-14));
  [.2,-.4,-.3].forEach((v,a)=>close(z.zeroMM[a],v,1e-14));
  fieldAt(y.zeroMM.map(v=>v*.001),p).forEach(v=>close(v,0,1e-18));
  assert.equal(derive({mainCurrentA:0}).zeroUnique,false);
  assert.equal(derive({mainCurrentA:0,biasCurrentA:[1,0,0]}).zeroMM,null);
});
check('Independent scalar single-beam scattering and Gaussian transverse falloff',()=>{
  const p={powersMW:[7,0,0,0,0,0],mainCurrentA:0,gravity:false,waistMM:6};
  const isat=Math.PI*6.62607015e-34*299792458*(2*Math.PI*29.13e6)/(3*(399e-9)**3);
  const s=2*.007/(Math.PI*.006**2*isat),ratio=2*(-25e6)/29.13e6;
  const expected=Math.PI*29.13e6*s/(1+s+ratio**2);
  const r=radiation([0,0,0],[0,0,0],p);
  close(r.totalRate/expected,1,1e-12);
  const sEdge=s*Math.exp(-2),edgeExpected=Math.PI*29.13e6*sEdge/(1+sEdge+ratio**2);
  close(radiation([0,.006,0],[0,0,0],p).totalRate/edgeExpected,1,1e-12);
  assert.ok(r.acceleration[0]>0&&r.acceleration[2]>0);
});
check('Fixed +Y quantum axis: H+ drives m=+1, H- drives m=-1 at positive By',()=>{
  const p={powersMW:[0,0,0,0,15,15],mainCurrentA:0,biasCurrentA:[0,1,0],gravity:false};
  const gamma=2*Math.PI*29.13e6,delta=-2*Math.PI*25e6;
  const isat=Math.PI*6.62607015e-34*299792458*gamma/(3*(399e-9)**3);
  const s=2*.015/(Math.PI*.006**2*isat);
  const z=9.2740100657e-24*1e-4/(6.62607015e-34/(2*Math.PI));
  const expected=[1,-1].map(m=>.5*gamma*s/(1+2*s+4*((delta-m*z)/gamma)**2));
  const r=radiation([0,0,0],[0,0,0],p);
  expected.forEach((v,j)=>close(r.rates[4+j]/v,1,1e-12));
  assert.ok(r.rates[5]>r.rates[4]&&r.acceleration[1]<0);
  // Swapping the m assignments predicts the opposite force and must be rejected.
  assert.ok(Math.sign(expected[1]-expected[0])!==Math.sign(r.acceleration[1]));
});
check('Small-field restoring matrix agrees with independent analytic tensor [-3,2,-1]',()=>{
  const gamma=2*Math.PI*29.13e6,delta=-2*Math.PI*25e6,k=2*Math.PI/399e-9;
  const hbar=6.62607015e-34/(2*Math.PI),mass=173.93886755*1.66053906892e-27;
  const isat=Math.PI*6.62607015e-34*299792458*gamma/(3*(399e-9)**3);
  const s=2*.015/(Math.PI*.006**2*isat),A=1+6*s+4*(delta/gamma)**2;
  const factor=4*(hbar*k/mass)*s*delta*9.2740100657e-24/(hbar*gamma*A*A);
  const expected=[1.5,2,.5].map(t=>factor*.3*t),eps=2e-7;
  for(let a=0;a<3;a++){
    const pos=[0,0,0];pos[a]=eps;
    const f=opticalAcceleration(pos,[0,0,0]);
    close(f[a]/eps/expected[a],1,1e-5);
    f.forEach((v,j)=>{if(j!==a)close(v,0,1e-8);});
  }
});
check('40 / 14.7 source is a forward truncated Gaussian with consistent measured moments',()=>{
  const n=16384,states=sampleInitialStates({n,seed:20261030});
  let sum=0,sum2=0;
  for(let i=0;i<n;i++){const v=states[6*i+3];assert.ok(v>=0);sum+=v;sum2+=v*v;}
  const mean=sum/n,sd=Math.sqrt(sum2/n-mean*mean);
  // Independent analytic truncated-normal moments (Python math.erf; no sampling engine).
  const alpha=-40/14.7,phi=Math.exp(-alpha*alpha/2)/Math.sqrt(2*Math.PI);
  const probability=0.9967466324064385;
  const lambda=phi/probability,expectedMean=40+14.7*lambda;
  const expectedSD=14.7*Math.sqrt(1+alpha*lambda-lambda*lambda);
  close(mean,expectedMean,.5);close(sd,expectedSD,.4);
  assert.ok(Math.abs(mean-20)>10); // Previous example is rejected by the same scale.
});
check('Initial longitudinal statistics use source direction and distinguish retained initial speed',()=>{
  const r=simulate({...off,n:2,durationMS:.001,sourceYawDeg:90},
    {initialStates:[0,0,0,0,.2,0, 0,0,0,0,.6,0]});
  close(r.summary.initialLongitudinal.meanMS,.4,1e-12);
  close(r.summary.initialLongitudinal.stdMS,.2,1e-12);
  close(r.summary.retainedInitialLongitudinal.meanMS,.4,1e-12);
  assert.equal(r.summary.initialLongitudinal.n,2);
});
check('Compiled and raw parameter APIs agree, including optical force without gravity',()=>{
  const p={biasCurrentA:[.1,.2,-.2]},r=[.0002,.0004,.001],v=[1,2,-3];
  assert.deepEqual(acceleration(r,v,p),acceleration(r,v,compile(p)));
  close(acceleration(r,v,p)[2]-opticalAcceleration(r,v,p)[2],-C.gravity,1e-9);
});
check('No-light recoil is inert; same seed replays bit for bit; seed changes sample',()=>{
  const p={n:4,durationMS:5};
  const a=simulate(p),b=simulate(p);
  assert.deepEqual(a.frames,b.frames);assert.deepEqual(a.finalVelocities,b.finalVelocities);
  assert.notDeepEqual(a.frames,simulate({...p,seed:123}).frames);
  assert.deepEqual(simulate({...p,...off,recoil:true}).frames,simulate({...p,...off}).frames);
});
check('Retention is a sustained window, not an endpoint label',()=>{
  const stationary=simulate({...off,n:1,durationMS:10},{initialStates:[0,0,0,0,0,0]});
  assert.equal(stationary.summary.retained,1);
  assert.equal(stationary.summary.meanSpeed,0);
  // Ends at the origin, but was outside the 3mm ball during the last 5ms.
  const crossing=simulate({...off,n:1,durationMS:5},{initialStates:[-.004,0,0,.8,0,0]});
  assert.ok(Math.abs(crossing.finalPositions[0])<1e-10);
  assert.equal(crossing.summary.retained,0);assert.equal(crossing.summary.centroidMM,null);
});
check('Domain losses remain marked, with finite final state and hidden later frames',()=>{
  const r=simulate({...off,n:1,durationMS:20},{initialStates:[0,0,0,100,0,0]});
  assert.equal(r.alive[0],0);assert.equal(r.retained[0],0);assert.equal(r.frameAlive.at(-1),0);
  assert.ok(r.finalPositions.every(Number.isFinite));assert.equal(r.summary.allMeanSpeed,null);
});
check('Input corruption is rejected rather than clamped into an apparent result',()=>{
  assert.throws(()=>compile({powersMW:[-1,0,0,0,0,0]}),RangeError);
  assert.throws(()=>compile({detuningMHz:NaN}),RangeError);
  assert.throws(()=>compile({mainAxis:'x'}),RangeError);
  assert.throws(()=>simulate({n:1},{initialStates:[0,0]}),TypeError);
});

console.log('Controls passed; starting the frozen small-N timing pilot.');
const pilot=simulate({n:8});
console.log('PILOT',JSON.stringify(pilot.summary));
check('5 to 2.5 microsecond deterministic step refinement',()=>{
  // Use the 2ms capture transient as well as frame positions, before damping erases differences.
  const p={n:16,recoil:false,durationMS:2};
  const a=simulate(p),b=simulate({...p,dtUS:2.5});
  const dr=rmsDifference(a.finalPositions,b.finalPositions)*1e3;
  const dv=rmsDifference(a.finalVelocities,b.finalVelocities);
  const frameDr=rmsDifference(a.frames,b.frames)*1e3;
  console.log('DT_DETERMINISTIC',JSON.stringify({positionRMSMM:dr,velocityRMSMS:dv,framePositionRMSMM:frameDr}));
  assert.ok(dr<.02);assert.ok(dv<.02);assert.ok(frameDr<.02);
});
check('Recoil variance matches the independently linearized low-speed molasses answer',()=>{
  const n=512,p={n,durationMS:8,mainCurrentA:0,gravity:false};
  const r=simulate(p,{initialStates:new Float64Array(n*6)});
  const gamma=2*Math.PI*29.13e6,delta=-2*Math.PI*25e6,k=2*Math.PI/399e-9;
  const mass=173.93886755*1.66053906892e-27,vr=(6.62607015e-34/(2*Math.PI))*k/mass;
  const isat=Math.PI*6.62607015e-34*299792458*gamma/(3*(399e-9)**3);
  const s=2*.015/(Math.PI*.006**2*isat),A=1+6*s+4*(delta/gamma)**2;
  const rate=.5*gamma*s/A, beta0=-4*vr*s*delta*k/(gamma*A*A);
  const expected=[5,4,3].map((factor,a)=>vr*vr*rate*factor/(2*beta0*[3,2,1][a]));
  const measured=[0,1,2].map(a=>{
    let mean=0,m2=0;
    for(let i=0;i<n;i++){const v=r.finalVelocities[3*i+a],d=v-mean;mean+=d/(i+1);m2+=d*(v-mean);}
    return m2/n;
  });
  const relative=measured.map((v,a)=>v/expected[a]-1);
  console.log('MOLASSES_VARIANCE',JSON.stringify({expected,measured,relative,elapsedMS:r.summary.elapsedMS}));
  relative.forEach(v=>assert.ok(Math.abs(v)<.22));
});
const full=simulate(DEFAULTS);
console.log('DEFAULT',JSON.stringify(full.summary));
check('Default sampling schema, finite states, and retained statistics',()=>{
  assert.equal(full.frames.length,120*192*3);assert.equal(full.frameAlive.length,120*192);
  assert.equal(full.times[0],0);close(full.times.at(-1),.020,1e-15);
  assert.ok(full.frames.every(Number.isFinite));assert.ok(full.finalVelocities.every(Number.isFinite));
  assert.equal(full.summary.retained,full.retained.reduce((a,b)=>a+b,0));
  if(full.summary.retained){assert.ok(full.summary.meanSpeed<1);assert.ok(full.summary.rmsMM.every(v=>v>=0));}
});
check('Stochastic step refinement agrees at the finite-N count scale',()=>{
  const half=simulate({...DEFAULTS,dtUS:2.5});
  const p=full.summary.retainedFraction,q=half.summary.retainedFraction;
  const tolerance=2*Math.sqrt((p*(1-p)+q*(1-q))/DEFAULTS.n)+.03;
  console.log('DT_STOCHASTIC',JSON.stringify({fraction5us:p,fraction2_5us:q,tolerance,
    speed5us:full.summary.meanSpeed,speed2_5us:half.summary.meanSpeed,elapsedMS:half.summary.elapsedMS}));
  assert.ok(Math.abs(p-q)<=tolerance);
});
console.log(`${passed} checks passed`);
