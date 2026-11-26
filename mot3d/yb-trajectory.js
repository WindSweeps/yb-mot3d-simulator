import { CONSTANTS as C } from './physics.js';
import { CASCADE_RATES, CASCADE_ROUTES, MU_B_PER_HBAR, P2_FINE_DECAY, REPUMP_BRANCHES,
  repumpEmission, YB_CASCADE_RECOIL_NM, YB_REPUMPS } from './yb-atom.js';
import { randomChannel } from './yb-random.js';
import { conservativeAcceleration, dot, potentialWorkspace } from './yb-potential.js';
import { greenRateBound, ybRadiation, ybRadiationWorkspace } from './yb-radiation.js';

const {blueRecoil,greenJump,cascade,repump,spin} = randomChannel;
const clockState = Object.freeze({kind:'p0'});
const shift = (p,v,h) => { for (let i=0; i<3; i++) p[i] += h*v[i]; };
const phi = x => x === 0 ? 1 : Math.expm1(x)/x;

function choose(weights, random, total) {
  if (total === undefined) total = weights.reduce((sum,w) => sum+w,0);
  let remaining = random*total, last = -1;
  for (let i=0; i<weights.length; i++) {
    if (weights[i] <= 0) continue;
    last = i;
    remaining -= weights[i];
    if (remaining < 0) return i;
  }
  if (last === -1) throw new Error('事件通道没有正速率。');
  return last;
}

function emission(v, recoil, rng, channel) {
  const z = 2*rng.uniform(channel)-1, theta = 2*Math.PI*rng.uniform(channel);
  const transverse = recoil*Math.sqrt(1-z*z);
  v[0] += transverse*Math.cos(theta);
  v[1] += transverse*Math.sin(theta);
  v[2] += recoil*z;
}

export function advanceGreenDrift(p,v,seconds,field,rng,work) {
  if (!field.green.enabled) { shift(p,v,seconds); return; }
  const {directionRates,greenEvent} = work;
  let remaining = seconds, ceiling = 0;
  while (remaining > 0) {
    if (!ceiling) ceiling = greenRateBound(p,v,remaining,field,greenEvent);
    if (!ceiling) { shift(p,v,remaining); return; }
    const wait = rng.exponential(greenJump)/ceiling;
    if (wait >= remaining) { shift(p,v,remaining); return; }
    shift(p,v,wait);
    remaining -= wait;
    const rates = ybRadiation(p,v,field,greenEvent).green;
    let positive = 0, negative = 0;
    for (let j=0; j<6; j++) {
      positive += Math.max(0,rates[3+j]);
      negative -= Math.min(0,rates[3+j]);
    }
    if (positive > ceiling*(1+1e-12)) throw new Error('556 nm 散射率超过空碰撞上界。');
    if (rng.uniform(greenJump)*ceiling >= positive) continue;
    for (let j=0; j<6; j++) directionRates[j] = Math.max(0,rates[3+j]);
    const selected = choose(directionRates,rng.uniform(greenJump),positive);
    const recoil = field.atom.green.recoil;
    shift(v,field.directions[selected],recoil);
    if (negative && rng.uniform(greenJump)*positive < negative) {
      for (let j=0; j<6; j++) directionRates[j] = -Math.min(0,rates[3+j]);
      shift(v,field.directions[choose(directionRates,rng.uniform(greenJump),negative)],-recoil);
    } else {
      emission(v,recoil,rng,greenJump);
    }
    work.greenEvents++;
    ceiling = 0;
  }
}

function addCoefficients(field,s,color,friction,variance) {
  const rate = s[color+'Rate'], {recoil} = field[color].transition, recoil2 = recoil*recoil;
  if (!rate) return;
  const rates = s[color], slopes = s[color+'Work'].sensitivities;
  const isotropic = recoil2*rate/3;
  for (let i=0; i<3; i++) variance[i] += isotropic;
  for (let j=0; j<6; j++) {
    const [x,y,z] = field.directions[j], drag = -recoil*slopes[j];
    const power = recoil2*Math.abs(rates[3+j]);
    friction[0] += drag*x*x; friction[1] += drag*y*y; friction[2] += drag*z*z; friction[3] += drag*x*z;
    variance[0] += power*x*x; variance[1] += power*y*y; variance[2] += power*z*z; variance[3] += power*x*z;
  }
}

// 三对光轴中，两对位于 XZ 平面，一对沿 Y。解析推进局部阻尼，并在其主轴上积分协方差。
export function applyOpticalOU(v,h,field,s,work,rng,continuousGreen) {
  if (!(s.blueRate || ((continuousGreen || field.trap) && s.greenRate))) return;
  const {friction,variance,noise} = work;
  friction.fill(0); variance.fill(0);
  addCoefficients(field,s,'blue',friction,variance);
  if (continuousGreen) addCoefficients(field,s,'green',friction,variance);
  let ax = s.blue[0], ay = s.blue[1], az = s.blue[2];
  if (continuousGreen) { ax += s.green[0]; ay += s.green[1]; az += s.green[2]; }
  if (field.trap) {
    // 在光学漂移中加入已占据激发态相对于基态的偶极力。
    let scalar = 0, tensor = 0;
    for (const color of ['blue','green']) {
      const [alpha,t] = field.trap.coefficients[color], {levelWeights,line} = s[color+'Work'];
      for (let e=0; e<levelWeights.length; e++) {
        scalar += levelWeights[e]*(alpha-field.trap.coefficients.ground[0]);
        tensor += levelWeights[e]*t*line.levels[e].tensor;
      }
    }
    const {profile,mass} = s, effective = scalar+tensor*profile.angle, angular = tensor*profile.scale;
    ax += (effective*profile.scaleX+angular*profile.angleGradient[0])/mass;
    ay += (effective*profile.scaleY+angular*profile.angleGradient[1])/mass;
    az += (effective*profile.scaleZ+angular*profile.angleGradient[2])/mass;
  }
  const angle = friction[3] ? .5*Math.atan2(2*friction[3],friction[0]-friction[2]) : 0;
  const c = Math.cos(angle), sin = Math.sin(angle), cs = c*sin, c2 = c*c, s2 = sin*sin;
  const gx = h*(c2*friction[0]+s2*friction[2]+2*cs*friction[3]), gy = h*friction[1];
  const gz = h*(s2*friction[0]+c2*friction[2]-2*cs*friction[3]);
  let dx = (c*ax+sin*az)*h*phi(-gx), dy = ay*h*phi(-gy), dz = (c*az-sin*ax)*h*phi(-gz);
  if (rng) {
    rng.normals(blueRecoil,noise);
    const qx = (c2*variance[0]+s2*variance[2]+2*cs*variance[3])*h*phi(-2*gx);
    const qz = (s2*variance[0]+c2*variance[2]-2*cs*variance[3])*h*phi(-2*gz);
    const qxz = (cs*(variance[2]-variance[0])+(c2-s2)*variance[3])*h*phi(-gx-gz);
    const width = Math.sqrt(Math.max(0,qx)), shared = width ? qxz/width : 0;
    dx += width*noise[0];
    dy += Math.sqrt(variance[1]*h*phi(-2*gy))*noise[1];
    dz += shared*noise[0]+Math.sqrt(Math.max(0,qz-shared*shared))*noise[2];
  }
  v[0] += c*dx-sin*dz;
  v[1] += dy;
  v[2] += sin*dx+c*dz;
}

export function ybTrajectoryWorkspace(atom) {
  return {radiation:ybRadiationWorkspace(atom),greenEvent:ybRadiationWorkspace(atom),potential:potentialWorkspace(),
    acceleration:new Float64Array(3),directionRates:new Float64Array(6),friction:new Float64Array(4),
    variance:new Float64Array(4),noise:new Float64Array(3),leaks:new Float64Array(4),pump:new Float64Array(4),
    greenEvents:0};
}

function setP2(atom, p2, index) {
  atom.state = {kind:'p2',level:p2[index]};
}

function shelveP2(atom,field,work,bridge) {
  const {blueWork} = work.radiation, species = field.atom;
  const levelIndex = choose(blueWork.levelWeights,atom.rng.uniform(cascade));
  const links = blueWork.line.levels[levelIndex].links;
  let point = atom.rng.uniform(cascade);
  let link = links.at(-1);
  for (const candidate of links) {
    point -= candidate.strength;
    if (point <= 0) { link = candidate; break; }
  }
  const distribution = species.cascade[bridge][link.ground][link.q];
  setP2(atom,species.p2,choose(distribution,atom.rng.uniform(cascade)));
}

function kicks(atom, wavelengths, channel, mass) {
  for (const wavelength of wavelengths) emission(atom.v,C.h/(mass*wavelength*1e-9),atom.rng,channel);
}

function cascadeRoute(atom,terminal) {
  const routes = CASCADE_ROUTES[terminal];
  if (routes.length === 1) return routes[0];
  const first = routes[0].rate, second = routes[1].rate;
  return atom.rng.uniform(cascade)*(first+second) < first ? routes[0] : routes[1];
}

function cycleRepump(atom,field,work) {
  const channel = YB_REPUMPS[choose(work.pump,atom.rng.uniform(repump))];
  const outcome = choose(REPUMP_BRANCHES[channel.upper],atom.rng.uniform(repump));
  const old = atom.state.level, species = field.atom;
  if (work.recoil) {
    atom.v[0] += C.h/(species.mass*channel.wavelengthNm*1e-9);
    emission(atom.v,C.h/(species.mass*repumpEmission(channel.upper,outcome)*1e-9),atom.rng,repump);
  }
  if (outcome === 0) atom.state = clockState;
  if (outcome === 1) {
    atom.state = null;
    work.recovered += atom.weight;
    if (work.recoil) emission(atom.v,species.green.recoil,atom.rng,repump);
  }
  if (outcome === 2) {
    const draw = atom.rng.uniform(repump);
    const index = old ? choose(species.repumped[old.index],draw) : Math.floor(draw*species.p2.length);
    setP2(atom,species.p2,index);
  }
}

function durationBeforeEvent(atom, h, rate, channel) {
  if (rate === 0) return h;
  atom.budget ??= atom.rng.exponential(channel);
  const wait = atom.budget/rate;
  if (wait >= h) { atom.budget -= rate*h; return h; }
  atom.budget = null;
  return wait;
}

function pumpRates(atom,field,work) {
  if (!field.repump) return 0;
  const {waistM,rates} = field.repump, [,y,z] = atom.p;
  const beam = Math.exp(-2*(y*y+z*z)/waistM**2);
  let sum = 0;
  for (let i=0; i<rates.length; i++) {
    const local = YB_REPUMPS[i].lower === atom.state.kind ? beam*rates[i] : 0;
    sum += work.pump[i] = local;
  }
  return sum;
}

function naturalReturn(atom,field,work,fineStructure) {
  if (work.recoil) {
    const photon = atom.state.kind === 'p0' ? YB_CASCADE_RECOIL_NM.p0Ground :
      fineStructure ? YB_CASCADE_RECOIL_NM.p2P1 : YB_CASCADE_RECOIL_NM.p2Ground;
    kicks(atom,[photon],repump,field.atom.mass);
    if (fineStructure) emission(atom.v,field.atom.green.recoil,atom.rng,repump);
  }
  atom.state = null;
  work.naturalRecovered += atom.weight;
}

export function ybLeakRates(radiation,field,settings,out) {
  const blue = radiation.blueRate/field.atom.blue.gamma, green = radiation.greenRate/field.atom.green.gamma;
  out[0] = blue*settings.leakP0;
  out[1] = blue*settings.leakP1;
  out[2] = blue*settings.leakP2;
  out[3] = green*CASCADE_RATES.greenP0;
  return out[0]+out[2]+out[3];
}

function markDark(atom,channel,field,work) {
  atom.lastDark = channel;
  atom.lastOutside = work.timeMS;
  work.shelved[channel] += atom.weight;
  if (work.tier === 1) {
    atom.lost = 'radiative';
  } else if (channel === 2) {
    const route = cascadeRoute(atom,2);
    shelveP2(atom,field,work,route.bridge);
    if (work.recoil) kicks(atom,route.wavelengths,cascade,field.atom.mass);
  } else {
    atom.state = clockState;
    if (work.recoil) kicks(atom,channel === 0 ? cascadeRoute(atom,0).wavelengths :
      [YB_CASCADE_RECOIL_NM.greenP0],cascade,field.atom.mass);
  }
}

function opticalSubstep(h,field,work) {
  let fastest = 0;
  for (const color of ['blue','green']) {
    if (color === 'green' && !work.continuousGreen) continue;
    if (!work.radiation[color+'Rate']) continue;
    const {k,recoil,gamma} = field[color].transition;
    let derivative = 0;
    // 正阻尼由 OU 指数稳定推进。反阻尼和显著的 Doppler 漂移需要重算局部系数。
    for (const rate of work.radiation[color+'Work'].sensitivities) derivative += Math.max(0,rate);
    const [ax,ay,az] = work.radiation[color];
    fastest = Math.max(fastest,recoil*derivative,2*k*Math.hypot(ax,ay,az)/gamma);
  }
  return fastest > 0 ? Math.min(h,.35/fastest) : h;
}

function opticalStep(atom,h,field,work,allowSplit) {
  const {radiation,leaks,settings} = work;
  while (h > 0 && !atom.lost) {
    if (atom.state) {
      const pump = pumpRates(atom,field,work);
      const natural = settings.darkDecay === 'on';
      const fine = natural && atom.state.kind === 'p2' ? P2_FINE_DECAY : 0;
      const direct = natural ? atom.state.level?.directDecay ?? field.atom.clockDecay : 0;
      const wait = durationBeforeEvent(atom,h,pump+fine+direct,repump);
      if (wait === h) return;
      h -= wait;
      const path = atom.rng.uniform(repump)*(pump+fine+direct);
      if (path < pump) cycleRepump(atom,field,work);
      else naturalReturn(atom,field,work,path < pump+fine);
      continue;
    }
    if (!field.blue.enabled && !field.green.enabled) return;
    ybRadiation(atom.p,atom.v,field,radiation,true);
    const dark = ybLeakRates(radiation,field,settings,leaks);
    const fastReturn = work.recoil ? leaks[1] : 0;
    const weighted = settings.atomLossMode === 'lifetime';
    const rate = fastReturn+(weighted ? 0 : dark);
    const interval = opticalSubstep(h,field,work);
    const wait = durationBeforeEvent(atom,interval,rate,cascade);
    applyOpticalOU(atom.v,wait,field,radiation,work,work.recoil ? atom.rng : null,work.continuousGreen);
    if (weighted && dark > 0) {
      const loss = atom.weight*-Math.expm1(-dark*wait);
      atom.weight -= loss;
      work.radiative += loss;
      work.shelved[0] += loss*leaks[0]/dark;
      work.shelved[2] += loss*leaks[2]/dark;
      work.shelved[3] += loss*leaks[3]/dark;
    }
    h -= wait;
    if (wait === interval) continue;
    const select = atom.rng.uniform(cascade)*rate;
    if (select < fastReturn) {
      kicks(atom,cascadeRoute(atom,1).wavelengths,cascade,field.atom.mass);
      continue;
    }
    if (allowSplit && !atom.split && leaks[2] > 0 && leaks[2] < dark) {
      const weightP2 = atom.weight*leaks[2]/dark;
      atom.split = true;
      atom.weight -= weightP2;
      const perBranch = weightP2/settings.p2Branches;
      for (let i=1; i<=settings.p2Branches; i++) {
        const daughter = work.spawn(atom,i,perBranch);
        markDark(daughter,2,field,work);
        work.daughters.push(daughter);
      }
      markDark(atom,atom.rng.uniform(cascade)*(leaks[0]+leaks[3]) < leaks[0] ? 0 : 3,field,work);
      // 所有子轨迹均从同一次暗态跃迁的位置继续。后续跃迁各自抽样。
      for (const daughter of work.daughters) opticalStep(daughter,h,field,work,false);
      allowSplit = false;
    } else {
      const mark = select-fastReturn;
      markDark(atom,mark < leaks[0] ? 0 : mark < leaks[0]+leaks[2] ? 2 : 3,field,work);
    }
  }
}

const factorial = [1];
for (let i=1; i<=10; i++) factorial.push(i*factorial[i-1]);

function rotationProbability(f,m,next,flip) {
  const root = Math.sqrt(factorial[f+m]*factorial[f-m]*factorial[f+next]*factorial[f-next]);
  const cos = Math.sqrt(1-flip), sin = Math.sqrt(flip);
  let amplitude = 0;
  for (let k=Math.max(0,m-next); k<=Math.min(f+m,f-next); k++) {
    const denominator = factorial[f+m-k]*factorial[k]*factorial[next-m+k]*factorial[f-next-k];
    const sign = (next-m+k)%2 ? -1 : 1;
    amplitude += sign*root*cos**(2*f+m-next-2*k)*sin**(next-m+2*k)/denominator;
  }
  return amplitude*amplitude;
}

function majoranaDrift(atom,h,field) {
  const current = atom.state.level, {p,v} = atom, a = field.slope, b = field.bias;
  const bx = a[0]*p[0]+b[0], by = a[1]*p[1]+b[1], bz = a[2]*p[2]+b[2];
  const dx = a[0]*v[0], dy = a[1]*v[1], dz = a[2]*v[2];
  const sweep2 = dx*dx+dy*dy+dz*dz;
  const t = -(bx*dx+by*dy+bz*dz)/sweep2;
  if (!(t > 0 && t <= h)) return;
  const distance2 = (bx+t*dx)**2+(by+t*dy)**2+(bz+t*dz)**2;
  const probability = Math.exp(-Math.PI*Math.abs(current.g)*MU_B_PER_HBAR*distance2/(2*Math.sqrt(sweep2)));
  if (probability <= 1e-12) return;
  const {p2} = field.atom, start = current.index-(current.m+current.f);
  const weights = [];
  for (let m=-current.f; m<=current.f; m++) weights.push(rotationProbability(current.f,current.m,m,probability));
  setP2(atom,p2,start+choose(weights,atom.rng.uniform(spin)));
}

function kickConservative(atom,h,field,work) {
  if (atom.state?.level?.moment || field.trap) {
    conservativeAcceleration(atom.p,field,field.atom,atom.state,work.acceleration,work.potential);
    shift(atom.v,work.acceleration,h);
  } else atom.v[2] += h*field.gravityZ;
}

function drift(atom,h,field,work) {
  if (atom.state?.level && work.tier === 3) majoranaDrift(atom,h,field);
  if (!atom.state && !work.continuousGreen) advanceGreenDrift(atom.p,atom.v,h,field,atom.rng,work);
  else shift(atom.p,atom.v,h);
}

export function advanceYbAtom(atom,h,field,work) {
  const half = .5*h;
  work.daughters.length = 0;
  kickConservative(atom,half,field,work);
  drift(atom,half,field,work);
  opticalStep(atom,h,field,work,work.split);
  if (!atom.lost) {
    drift(atom,half,field,work);
    kickConservative(atom,half,field,work);
  }
  for (const daughter of work.daughters) {
    drift(daughter,half,field,work);
    kickConservative(daughter,half,field,work);
  }
}
