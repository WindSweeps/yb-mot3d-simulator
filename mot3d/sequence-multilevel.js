import { DEFAULT_FLUX } from './fluorescence.js';
import { sequenceAt } from './sequence.js';
import { sequenceLossStages } from './sequence-population.js';
import { atomRandom, randomChannel } from './yb-random.js';
import { configureYbField, createYbField } from './yb-radiation.js';
import { advanceYbAtom, ybTrajectoryWorkspace } from './yb-trajectory.js';

export function multilevelGrid(program,tier,paths,observeAtMS) {
  const {durationMS,stages} = program;
  const points = new Map([[0,{time:0}]]);
  const budget = Math.min(580,Math.floor(4e6/paths));
  for (const [i, stage] of stages.entries()) {
    const span = stage.durationMS, cap = Math.max(1,Math.floor(budget/stages.length));
    const count = Math.max(1,Math.min(cap,Math.ceil(span/(i === 0 ? .25 : .5))));
    for (let j = 1; j <= count; j++) {
      const time = j === count ? stage.endMS : stage.startMS+span*j/count;
      points.set(time,{time});
    }
  }
  const pulses = [tier >= 2 && program.atom.repumpWindow, tier >= 3 && program.atom.trapWindow];
  for (const pulse of pulses.filter(Boolean)) {
    const count = Math.min(24,Math.ceil((pulse.endMS-pulse.startMS)/.2));
    for (let i=0; i<=count; i++) {
      const time = i === count ? pulse.endMS : pulse.startMS+(pulse.endMS-pulse.startMS)*i/count;
      points.set(time,{time});
    }
  }
  if (observeAtMS != null) points.set(observeAtMS,{time:observeAtMS});
  program.checkpointTimesMS.forEach((time,index) => {
    const left = index === 0 ? 0 : program.checkpointTimesMS[index-1];
    const windowStart = Math.max(left,time-5);
    points.set(time,{time,windowStart,checkpoint:'N'+index});
  });
  const grid = [...points.values()].sort((a,b) => a.time-b.time);
  if (grid.at(-1).time !== durationMS) throw new Error('镱引擎时序终点不完整。');
  return {grid,loadEnd:stages[0].endMS};
}

function initialSpecies(options, i, species) {
  if (!options.initialAtomStates) return null;
  const state = options.initialAtomStates[i];
  if (state === null) return null;
  if (state === 'p0') return {kind:'p0'};
  const level = species.p2.find(level => level.f === state?.f && level.m === state?.m);
  if (!level) throw new RangeError('初始暗态的 F 与 m_F 不存在。');
  return {kind:'p2',level};
}

function transportAtom(initial,i,seed,slot,launchWindowMS,state) {
  const rng = atomRandom(seed,i,0);
  rng.reset(15,0);
  const time = launchWindowMS > 0 ? launchWindowMS*(i+rng.uniform(randomChannel.source)) : 0;
  return {i,slot,time,p:initial.slice(6*i,6*i+3),v:initial.slice(6*i+3,6*i+6),state,
    rng,weight:1,split:false,budget:null,lastOutside:time,firstCapture:false};
}

function trapSubsteps(atom, field, h) {
  const {trap} = field;
  if (!trap) return 1;
  const [x,y,z] = atom.p, [vx,vy,vz] = atom.v;
  const axialMax = 1+(Math.abs(x)+Math.abs(vx)*h)**2*trap.rayleighInverse2;
  const rMin = Math.max(0,Math.hypot(y,z)-Math.hypot(vy,vz)*h);
  const envelope = Math.exp(-2*rMin*rMin*trap.inverseWaist2/axialMax);
  const well = trap.maxAlpha*trap.u0*envelope;
  if (well < 1e-32) return 1;
  const speed = Math.sqrt(2*well/field.atom.mass);
  const omega = Math.max(Math.sqrt(2*trap.inverseWaist2)*speed,
    trap.lattice ? trap.k*(Math.abs(vx)+speed) : 0);
  return Math.max(1,Math.ceil(omega*h/.12));
}

export function integrateMultilevel(run,options,inside,domain,recordFrame) {
  const {model,program,grid,initial,result,species,tier,tracksPerInput} = run;
  const {n,seed,recoil} = model.params;
  const settings = program.atom.values, loading = options.loading ?? {};
  const flux = loading.flux ?? model.params.incidentFlux ?? DEFAULT_FLUX;
  if (!(Number.isFinite(flux) && flux >= 0)) throw new RangeError('入射通量须为有限的非负数。');
  const loss = sequenceLossStages(program,loading);
  result.sourceMassPerSample = flux*(program.stages[0].durationMS/1000)/n;
  if (!Number.isFinite(result.sourceMassPerSample)) throw new RangeError('样本代表的原子数超出浮点范围。');
  if (options.initialAtomStates && (tier < 2 || options.initialAtomStates.length !== n))
    throw new RangeError('暗态初值须对应每条入射轨迹及可跟踪暗态的引擎。');
  const launchWindow = options.initialStates || options.initialAtomStates ? 0 : program.stages[0].durationMS/n;
  const source = Array.from({length:n},(_,i) =>
    transportAtom(initial,i,seed,i*tracksPerInput,launchWindow,initialSpecies(options,i,species)));
  const field = createYbField(model,species);
  const work = Object.assign(ybTrajectoryWorkspace(species),{
    settings,tier,recoil,split:tracksPerInput > 1,daughters:[],shelved:[0,0,0,0],
    recovered:0,naturalRecovered:0,radiative:0,
  });
  let head = 0, active = [], step = 0, region = -1, timeMS = 0;
  const counters = {background:0,collision:0,escapeBright:0,escapeDark:0,firstCapture:0};
  let stageIndex = 0, nextStep = 0, currentStep = 0, setAt = -1, trappedWeight = 0;
  let spawned = [];
  work.spawn = (parent,branch,weight) => {
    const rng = atomRandom(seed,parent.i,branch);
    rng.reset(stageIndex,currentStep);
    const child = {...parent,slot:parent.slot+branch,p:parent.p.slice(),v:parent.v.slice(),rng,weight};
    spawned.push(child);
    return child;
  };
  function inject(t) {
    while (head < n && source[head].time <= t) active.push(source[head++]);
  }
  function setField(t) {
    const channels = sequenceAt(program,t);
    if (tier < 3) channels.trap = null;
    if (tier < 2) channels.repump = null;
    configureYbField(field,channels,channels.absoluteFrequency);
    return channels.stageIndex;
  }
  function stepTrack(atom,h,background,binary,h0) {
    const {p,v} = atom;
    const wasInside = !atom.state && inside(p,v);
    if (!wasInside) atom.lastOutside = work.timeMS;
    const bg = h === h0 ? work.backgroundFactor : Math.exp(-h*background);
    const coll = !wasInside ? 1 : h === h0 ? work.collisionFactor : 1/(1+binary*integratedSurvival(h,background));
    const afterBackground = atom.weight*bg;
    counters.background += atom.weight-afterBackground;
    atom.weight = afterBackground*coll;
    counters.collision += afterBackground-atom.weight;
    atom.rng.reset(stageIndex,currentStep);
    spawned = [];
    const subdivisions = trapSubsteps(atom,field,h);
    const dt = h/subdivisions;
    for (let j=0; j<subdivisions; j++) {
      const children = spawned.length;
      if (!atom.lost) advanceYbAtom(atom,dt,field,work);
      for (let child=0; child<children; child++) advanceYbAtom(spawned[child],dt,field,work);
    }
    for (const child of spawned) active.push(child);
  }
  function checkTrack(atom,end) {
    if (atom.lost) { work.radiative += atom.weight; return false; }
    if (!Number.isFinite(atom.p[0]+atom.p[1]+atom.p[2]+atom.v[0]+atom.v[1]+atom.v[2]))
      throw new Error('镱引擎产生非有限相空间。');
    if (atom.p[0]**2+atom.p[1]**2+atom.p[2]**2 > domain**2) {
      counters[atom.state ? 'escapeDark' : 'escapeBright'] += atom.weight;
      atom.lost = 'escaped';
      return false;
    }
    if (atom.state || !inside(atom.p,atom.v)) atom.lastOutside = end;
    else {
      trappedWeight += atom.weight;
      if (!atom.firstCapture && end-atom.lastOutside >= 5 && end <= program.stages[0].endMS) {
        counters.firstCapture += atom.weight;
        atom.firstCapture = true;
      }
    }
    return true;
  }
  function observe(frame) {
    setField(timeMS);
    setAt = -1;
    const state = {pending:n-head,...counters,radiative:work.radiative,recovered:work.recovered,naturalRecovered:work.naturalRecovered,
      shelved:[...work.shelved],greenEvents:work.greenEvents};
    recordFrame(frame,active,field,state);
    trappedWeight = result.metrics[frame].ledger.trappedBright;
  }
  inject(0);
  observe(0);
  for (let frame=1; frame<grid.length; frame++) {
    const end = grid[frame].time, prior = result.metrics[frame-1], start = timeMS, span = end-start;
    const channels = sequenceAt(program,start+span/2);
    const fixedStage = channels.stageIndex;
    const {alpha,alphaMode,beta} = loss[fixedStage];
    const background = alphaMode === 'total' ? Math.max(0,alpha-prior.branchLossRate) : alpha;
    const continuousGreen = tier !== 3 || !recoil;
    const greenCooling = channels.greenOn && channels.greenPowersMW.some(Boolean);
    const maxStep = (greenCooling && continuousGreen ? Math.min(5,settings.atomStepUS) : settings.atomStepUS)/1000;
    const varying = (fixedStage === 1 && program.config.mode !== 'blue-only') || fixedStage === 3;
    const subdivisions = Math.max(1,Math.ceil(span/maxStep-1e-9));
    if (!Number.isSafeInteger(subdivisions) || subdivisions >= 2**32)
      throw new RangeError('观察间隔的积分步数超出计数器范围。');
    for (let j=1; j<=subdivisions; j++) {
      const finish = j === subdivisions ? end : start+span*j/subdivisions;
      if (!(finish > timeMS)) throw new Error('时序浮点精度不足以推进镱原子。');
      stageIndex = fixedStage;
      if (region !== stageIndex) { region = stageIndex; nextStep = 0; }
      currentStep = nextStep++;
      if (!active.length && (head === n || source[head].time > finish)) { timeMS = finish; continue; }
      const h0 = (finish-timeMS)/1000;
      const midpoint = timeMS+(finish-timeMS)/2;
      if (varying || setAt !== stageIndex) { setField(midpoint); setAt = stageIndex; }
      work.continuousGreen = continuousGreen;
      work.timeMS = midpoint;
      work.backgroundFactor = Math.exp(-h0*background);
      const binary = beta*trappedWeight*result.sourceMassPerSample;
      work.collisionFactor = 1/(1+binary*integratedSurvival(h0,background));
      inject(finish);
      const count = active.length;
      let alive = count;
      trappedWeight = 0;
      for (let i=0; i<count; i++) {
        const atom = active[i], h = (finish-Math.max(atom.time,timeMS))/1000;
        if (h > 0) stepTrack(atom,h,background,binary,h0);
        if (!checkTrack(atom,finish)) alive--;
      }
      for (let i=count; i<active.length; i++) if (checkTrack(active[i],finish)) alive++;
      if (alive !== active.length) active = active.filter(atom => !atom.lost);
      timeMS = finish;
      step++;
    }
    observe(frame);
    options.onProgress?.(frame/(grid.length-1));
  }
  result.integrationSteps = step;
}

function integratedSurvival(h,alpha) {
  return alpha ? -Math.expm1(-h*alpha)/alpha : h;
}
