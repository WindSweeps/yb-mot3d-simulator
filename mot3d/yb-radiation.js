import { BEAM_DIRECTIONS, CONSTANTS as C, HELICITIES } from './physics.js';
import { MU_B_PER_HBAR } from './yb-atom.js';
import { configureDipoleTrap, dipoleProfile, dot, localMagneticField, potentialWorkspace } from './yb-potential.js';

const twoPiMHz = 2*Math.PI*1e6;
export function createYbField(model, atom, {directions = BEAM_DIRECTIONS, helicities = HELICITIES} = {}) {
  const {waistMM, greenWaistMM = waistMM} = model.params;
  function line(transition, waist) {
    if (!(Number.isFinite(waist) && waist >= .1 && waist <= 100))
      throw new RangeError('光束腰斑半径须在 0.1–100 mm 之间。');
    const wavelength = 2*Math.PI/transition.k;
    const isat = Math.PI*C.h*C.c*transition.gamma/(3*wavelength**3);
    const inverseWaist2 = 1/(waist*.001)**2;
    return {transition,isat,inverseWaist2, powerToS:.002*inverseWaist2/(Math.PI*isat),peak:new Float64Array(6)};
  }
  return {blue:line(atom.blue,waistMM), green:line(atom.green,greenWaistMM),
    atom, directions, helicities, bias:model.bias, gravityZ:model.gravityZ,
    tensor:model.derived.mainTensor, slope:new Float64Array(3), trap:null, repump:null};
}

export function configureYbField(field, channels, absoluteFrequency = false) {
  for (let i=0; i<3; i++) field.slope[i] = .01*channels.gradientGCM*field.tensor[i];
  for (const color of ['blue','green']) {
    const line = field[color];
    const power = channels[color+'PowersMW'], enabled = channels[color+'On'];
    line.detuning = twoPiMHz*(channels[color+'DetuningMHz'] -
      (absoluteFrequency ? line.transition.referenceMHz : 0));
    line.enabled = false;
    for (let j=0; j<6; j++) {
      line.peak[j] = enabled ? line.powerToS*power[j] : 0;
      line.enabled ||= line.peak[j] > 0;
    }
  }
  if (field.trapPulse !== channels.trap) {
    field.trapPulse = channels.trap;
    field.trap = configureDipoleTrap(channels.trap);
  }
  field.repump = channels.repump;
}

function lineWorkspace(line, groundStates, spectrum) {
  const links = line.levels.map(level => level.links.map(link => ({
    ...link, rates:new Float64Array(6), slopes:new Float64Array(6), total:0,
  })));
  return {line, links, exposure:new Float64Array(6), sensitivities:new Float64Array(6),
    levelWeights:new Float64Array(line.levels.length), drive:new Float64Array(line.levels.length),
    groundUpperBound:new Float64Array(groundStates), ratios:new Float64Array(line.levels.length),
    doppler:new Float64Array(6), detuningNorm:new Float64Array(6),
    spectrum:spectrum ? {saturation:new Float64Array(6), doppler:new Float64Array(6),
      detuning:new Float64Array(18), polarization:new Float64Array(18), fieldTesla:0, zeeman:0, gamma:line.gamma} : null};
}

export function ybRadiationWorkspace(atom, observeSpectrum = false) {
  const {groundStates:g} = atom;
  const blueWork = lineWorkspace(atom.blue,g,observeSpectrum), greenWork = lineWorkspace(atom.green,g,observeSpectrum);
  return {...potentialWorkspace(), blueWork, greenWork,
    spectrum:observeSpectrum ? {blue:blueWork.spectrum, green:greenWork.spectrum} : undefined,
    ground:new Float64Array(g), matrix:new Float64Array(g*(g+1)),
    polar:new Float64Array(18), projection:new Float64Array(6), speed:new Float64Array(6),
    blue:new Float64Array(9), green:new Float64Array(9), acceleration:new Float64Array(3),
    blueRate:0, greenRate:0, groundFraction:1, mass:atom.mass};
}

function geometry(p,v,field,s) {
  const norm = localMagneticField(p,field,s.b), {directions,helicities} = field;
  s.fieldNorm = norm;
  for (let j=0; j<6; j++) {
    const k = directions[j];
    const cosine = norm ? Math.max(-1,Math.min(1,dot(k,s.b)/norm)) : k[1];
    const hc = helicities[j]*cosine;
    s.polar[3*j] = .25*(1-hc)**2;
    s.polar[3*j+1] = .5*(1-cosine*cosine);
    s.polar[3*j+2] = .25*(1+hc)**2;
    s.projection[j] = dot(k,p);
    s.speed[j] = dot(k,v);
  }
  if (field.trap) dipoleProfile(p,s.b,field,s.profile);
  return dot(p,p);
}

function levelShift(level, color, field, s) {
  if (!field.trap) return 0;
  const [scalar,tensor] = field.trap.coefficients[color];
  const alpha = scalar - field.trap.coefficients.ground[0] + tensor*level.tensor*s.profile.angle;
  return -s.profile.scale*alpha/C.hbar;
}

function fillDrives(field, color, r2, s, linearize) {
  const {transition,peak,inverseWaist2,enabled,detuning} = field[color];
  const work = s[color+'Work'], {links,drive,ratios,exposure,spectrum,doppler,detuningNorm} = work;
  if (!enabled && !spectrum) return;
  const {k,gamma,levels,centralF} = transition, normFactor = 2/gamma;
  if (spectrum) {
    spectrum.fieldTesla = s.fieldNorm;
    spectrum.zeeman = transition.lande*MU_B_PER_HBAR*s.fieldNorm;
    spectrum.isat = field[color].isat;
    spectrum.detuning.fill(0);
  }
  for (let j=0; j<6; j++) {
    const projection = s.projection[j], power = peak[j]*Math.exp(-2*inverseWaist2*Math.max(0,r2-projection*projection));
    exposure[j] = .5*power*gamma;
    doppler[j] = k*s.speed[j];
    detuningNorm[j] = normFactor*(detuning-doppler[j]);
    if (spectrum) { spectrum.saturation[j] = power; spectrum.doppler[j] = doppler[j]; }
  }
  for (let e=0; e<levels.length; e++) {
    const level = levels[e], lightShift = levelShift(level,color,field,s);
    let total = 0;
    for (const link of links[e]) {
      const shift = normFactor*(level.offset+lightShift+link.moment*MU_B_PER_HBAR*s.fieldNorm);
      let sum = 0;
      for (let j=0; j<6; j++) {
        const index = 3*j+link.q, x = detuningNorm[j]-shift;
        const lorentzian = 1/(1+x*x);
        const rate = exposure[j]*s.polar[index]*link.strength*lorentzian;
        link.rates[j] = rate;
        if (linearize) link.slopes[j] = 2*normFactor*k*x*lorentzian*rate;
        sum += rate;
        if (spectrum && level.f === centralF)
          spectrum.detuning[index] += x*link.strength/(normFactor*(2*centralF+1)/3);
      }
      link.total = sum;
      total += sum;
    }
    drive[e] = total;
    ratios[e] = 1/(gamma+total);
  }
  if (spectrum) spectrum.polarization.set(s.polar);
}

function transfers(field, s, color) {
  if (!field[color].enabled) return;
  const {links,ratios,line} = s[color+'Work'], g = field.atom.groundStates;
  for (let e=0; e<links.length; e++) {
    for (const from of links[e]) {
      const input = from.total*ratios[e], i = from.ground;
      for (const to of links[e]) {
        const j = to.ground;
        if (i === j) continue;
        const rate = input*(to.total+line.gamma*to.strength);
        s.matrix[(g+1)*j+i] += rate;
        s.matrix[(g+1)*i+i] -= rate;
      }
    }
  }
}

// 消去激发态后，只对最多六个基态求稳态零空间。
function solveGround(field,s) {
  const {ground,matrix} = s, g = ground.length, width = g+1;
  if (g === 1) { ground[0] = 1; return; }
  matrix.fill(0);
  transfers(field,s,'blue');
  transfers(field,s,'green');
  let scale = 0;
  for (let i=0; i<matrix.length; i++) scale = Math.max(scale,Math.abs(matrix[i]));
  if (!scale) { ground.fill(1/g); return; }
  for (let i=0; i<width*(g-1); i++) matrix[i] /= scale;
  matrix.fill(1,width*(g-1));
  for (let col=0; col<g; col++) {
    let pivot = col;
    for (let row=col+1; row<g; row++)
      if (Math.abs(matrix[row*width+col]) > Math.abs(matrix[pivot*width+col])) pivot = row;
    if (pivot !== col) {
      for (let i=col; i<width; i++) {
        const value = matrix[pivot*width+i];
        matrix[pivot*width+i] = matrix[col*width+i];
        matrix[col*width+i] = value;
      }
    }
    const diagonal = matrix[col*width+col];
    if (!diagonal) throw new Error('光抽运速率方程的基态稳态无法归一化。');
    for (let row=col+1; row<g; row++) {
      const factor = matrix[row*width+col]/diagonal;
      for (let i=col+1; i<width; i++) matrix[row*width+i] -= factor*matrix[col*width+i];
    }
  }
  for (let row=g-1; row>=0; row--) {
    let value = matrix[row*width+g];
    for (let col=row+1; col<g; col++) value -= matrix[row*width+col]*ground[col];
    ground[row] = value/matrix[row*width+row];
    if (ground[row] < -1e-9) throw new Error('光抽运速率方程产生负布居。');
  }
  let total = 0;
  for (let i=0; i<g; i++) total += ground[i] = Math.max(0,ground[i]);
  for (let i=0; i<g; i++) ground[i] /= total;
}

function excite(field,s,color) {
  const {links,ratios,levelWeights,drive} = s[color+'Work'];
  if (!field[color].enabled) { levelWeights.fill(0); return 0; }
  let total = 0;
  for (let e=0; e<links.length; e++) {
    let fromGround = drive[e];
    if (s.ground.length !== 1) {
      fromGround = 0;
      for (const link of links[e]) fromGround += link.total*s.ground[link.ground];
    }
    total += levelWeights[e] = ratios[e]*fromGround;
  }
  return total;
}

function lineForce(field,s,color,linearize) {
  const out = s[color], line = field[color], {recoil} = line.transition;
  const {links,levelWeights,sensitivities} = s[color+'Work'], {ground,groundFraction} = s;
  out.fill(0);
  if (linearize) sensitivities.fill(0);
  if (!line.enabled) return;
  for (let e=0; e<links.length; e++) {
    const excited = levelWeights[e] *= groundFraction;
    for (const link of links[e]) {
      const imbalance = ground[link.ground]-excited;
      for (let j=0; j<6; j++) {
        out[3+j] += link.rates[j]*imbalance;
        if (linearize) sensitivities[j] += link.slopes[j]*imbalance;
      }
    }
  }
  for (let j=0; j<6; j++) {
    const d = field.directions[j], kick = recoil*out[3+j];
    out[0] += kick*d[0]; out[1] += kick*d[1]; out[2] += kick*d[2];
  }
}

export function ybRadiation(p,v,field,s,linearize = false) {
  const r2 = geometry(p,v,field,s);
  fillDrives(field,'blue',r2,s,linearize);
  fillDrives(field,'green',r2,s,linearize);
  solveGround(field,s);
  const blue = excite(field,s,'blue'), green = excite(field,s,'green');
  const pg = s.groundFraction = 1/(1+blue+green);
  for (let i=0; i<s.ground.length; i++) s.ground[i] *= pg;
  lineForce(field,s,'blue',linearize);
  lineForce(field,s,'green',linearize);
  s.blueRate = field.atom.blue.gamma*pg*blue;
  s.greenRate = field.atom.green.gamma*pg*green;
  for (let i=0; i<3; i++) s.acceleration[i] = s.blue[i]+s.green[i];
  s.acceleration[2] += field.gravityZ;
  return s;
}

// 点到运动线段的最短垂距给出高斯光强上界。失谐上界覆盖整个线段，包括磁场的零点。
export function greenRateBound(p,v,seconds,field,s) {
  const {green,directions,atom} = field, {links,line,groundUpperBound,exposure,doppler} = s.greenWork;
  if (!green.enabled) return 0;
  const b = localMagneticField(p,field,s.b), normal = dot(p,p), speed2 = dot(v,v), pv = dot(p,v);
  const variation = seconds*Math.hypot(field.slope[0]*v[0],field.slope[1]*v[1],field.slope[2]*v[2]);
  for (let j=0; j<6; j++) {
    const k = directions[j], r = dot(k,p), vp = dot(k,v);
    const a = Math.max(0,speed2-vp*vp), cross = pv - r*vp;
    const time = a ? Math.min(seconds,Math.max(0,-cross/a)) : 0;
    const nearest = Math.max(0,normal-r*r + 2*cross*time + a*time*time);
    exposure[j] = .5*line.gamma*green.peak[j]*Math.exp(-2*green.inverseWaist2*nearest);
    doppler[j] = line.k*vp;
  }
  groundUpperBound.fill(0);
  let ratio = 0;
  for (let e=0; e<links.length; e++) {
    const level = line.levels[e];
    const trap = field.trap;
    const stark = trap ? trap.u0/C.hbar*(Math.abs(trap.coefficients.green[0]-trap.coefficients.ground[0])+
      Math.abs(trap.coefficients.green[1]*level.tensor)) : 0;
    let total = 0;
    for (const link of links[e]) {
      const moment = MU_B_PER_HBAR*link.moment, atStart = green.detuning-level.offset-moment*b;
      const range = Math.abs(moment)*variation+stark;
      let sum = 0;
      for (let j=0; j<6; j++) {
        const x = 2*Math.max(0,Math.abs(atStart-doppler[j])-range)/line.gamma;
        sum += exposure[j]/(1+x*x);
      }
      const bound = link.strength*sum;
      groundUpperBound[link.ground] += bound;
      total += bound;
    }
    ratio += total/(line.gamma+total);
  }
  // 单基态的净束流为正。含超精细结构时，正净速率之和受总吸收率约束。
  const bound = atom.groundStates === 1 ? line.gamma*ratio/(1+ratio) : Math.max(...groundUpperBound);
  return bound*(1+32*Number.EPSILON);
}
