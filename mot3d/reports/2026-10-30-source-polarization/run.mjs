// One-off reproducible source/polarity audit; reuses the canonical MOT engine.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DEFAULTS, simulate } from '../../physics.js';

const seeds=[399174,399175,399176,399177],n=1024;
const cases=[
  {id:'old-example',overrides:{sourceSpeed:20,sourceSpread:4}},
  {id:'aosense-reference',overrides:{}},
  {id:'aosense-half-step',overrides:{dtUS:2.5}},
  {id:'reversed-current',overrides:{mainCurrentA:-3},seeds:[399174]},
  {id:'no-light',overrides:{powersMW:[0,0,0,0,0,0]},seeds:[399174]},
];
const wilson=(k,n)=>{
  const z=1.959963984540054,p=k/n,d=1+z*z/n;
  const center=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [center-half,center+half];
};
assert.ok(wilson(0,100)[0]<1e-15&&wilson(100,100)[1]>1-1e-15);
const pilots=[64,128].map(size=>({n:size,elapsedMS:simulate({n:size},{frameCount:2}).summary.elapsedMS}));
const projectedMS=Math.max(...pilots.map(p=>p.elapsedMS/p.n))*(10*n+8*n);
console.log('TIMING',JSON.stringify({pilots,projectedMS,scaling:'linear per atom; double cost for half dt'}));
assert.ok(projectedMS<120000,'pilot exceeds planned lightweight batch time');
const results={date:'2026-10-30',defaultParams:DEFAULTS,controls:'GATE.md',pilots,projectedMS,cases:[]};
for(const c of cases){
  const rows=[],histogram=Array.from({length:12},(_,j)=>({lowerMS:j*10,upperMS:(j+1)*10,n:0,retained:0}));
  let retained=0,total=0,sumV=0,sumInitial=0,sumInitial2=0,sumKeptInitial=0;
  for(const seed of c.seeds||seeds){
    const r=simulate({...c.overrides,n,seed},{frameCount:2});
    rows.push({seed,...r.summary});
    total+=n;retained+=r.summary.retained;sumV+=r.summary.retained*(r.summary.meanSpeed||0);
    r.initialLongitudinalVelocities.forEach((v,i)=>{
      sumInitial+=v;sumInitial2+=v*v;if(r.retained[i])sumKeptInitial+=v;
      const bin=histogram[Math.min(11,Math.floor(v/10))];bin.n++;bin.retained+=r.retained[i];
    });
    console.log('RUN',c.id,seed,JSON.stringify(r.summary));
  }
  const fraction=retained/total,meanInitial=sumInitial/total;
  results.cases.push({id:c.id,params:{...DEFAULTS,...c.overrides,n},n:total,retained,fraction,
    wilson95: wilson(retained,total),seedFractionRange:[Math.min(...rows.map(r=>r.retainedFraction)),Math.max(...rows.map(r=>r.retainedFraction))],
    initialMeanMS:meanInitial,initialStdMS:Math.sqrt(sumInitial2/total-meanInitial**2),
    retainedInitialMeanMS:retained?sumKeptInitial/retained:null,retainedFinalMeanSpeedMS:retained?sumV/retained:null,
    histogram,rows});
  writeFileSync(new URL('./results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
}
const a=results.cases.find(c=>c.id==='aosense-reference'),b=results.cases.find(c=>c.id==='aosense-half-step');
const difference=Math.abs(a.fraction-b.fraction),tolerance=Math.max(.03,3*Math.sqrt(a.fraction*(1-a.fraction)/a.n+b.fraction*(1-b.fraction)/b.n));
results.stepCheck={difference,tolerance,passed:difference<=tolerance};
results.noLightCheck=results.cases.find(c=>c.id==='no-light').retained===0;
writeFileSync(new URL('./results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
assert.ok(results.stepCheck.passed,'step-refinement gate failed');assert.ok(results.noLightCheck,'no-light control failed');
console.log('AGGREGATE',JSON.stringify(results.cases.map(({rows,histogram,params,...rest})=>rest)));
console.log('CHECKS',JSON.stringify({step:results.stepCheck,noLight:results.noLightCheck}));
