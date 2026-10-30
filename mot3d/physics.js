/** 174Yb J=0 -> J'=1, six travelling waves; SI internally. See METHOD.md. */
export const CONSTANTS = Object.freeze({
  h: 6.62607015e-34, hbar: 6.62607015e-34 / (2 * Math.PI),
  kB: 1.380649e-23, c: 299792458, muB: 9.2740100657e-24,
  mass: 173.93886755 * 1.66053906892e-27,
  wavelength: 399e-9, gamma: 2 * Math.PI * 29.13e6, gravity: 9.80665,
});
const C = CONSTANTS, K = 2 * Math.PI / C.wavelength;
const RECOIL = C.hbar * K / C.mass;
const ISAT = Math.PI * C.h * C.c * C.gamma / (3 * C.wavelength ** 3);
const SQ3 = Math.sqrt(3) / 2;
export const BEAM_DIRECTIONS = Object.freeze([
  [SQ3, 0, .5], [-SQ3, 0, -.5], [-SQ3, 0, .5], [SQ3, 0, -.5], [0, 1, 0], [0, -1, 0],
].map(Object.freeze));
export const BEAM_LABELS = Object.freeze(['+V1', '−V1', '+V2', '−V2', '+H', '−H']);
// Photon angular momentum along each beam's OWN propagation direction.
// Fixed optics: a current or quadrupole-axis change does not change polarization.
export const HELICITIES = Object.freeze([-1, -1, -1, -1, 1, 1]);
export const DEFAULTS = Object.freeze({
  detuningMHz: -25, powersMW: Object.freeze([15, 15, 15, 15, 15, 15]), waistMM: 6,
  mainCurrentA: 3, gradientPerAmp: 10, mainAxis: 'y',
  biasCurrentA: Object.freeze([0, 0, 0]), biasPerAmp: Object.freeze([1, 1, 1]),
  gravity: true, recoil: true, sourceSpeed: 40, sourceSpread: 14.7,
  sourceRadiusMM: 1, sourceTempMK: 4, sourceYawDeg: 0, sourcePitchDeg: 0,
  sourceOffsetYMM: 0, sourceOffsetZMM: 0, sourceDistanceMM: 30,
  n: 192, durationMS: 20, seed: 399174, dtUS: 5,
});

function normalize(input = {}) {
  const p = { ...DEFAULTS, ...input };
  for (const [key, len] of [['powersMW', 6], ['biasCurrentA', 3], ['biasPerAmp', 3]]) {
    if (!Array.isArray(p[key]) || p[key].length !== len || p[key].some(v => !Number.isFinite(v)))
      throw new TypeError(`${key} requires ${len} finite numbers`);
    p[key] = [...p[key]];
  }
  const ranges = { detuningMHz: [-500, 500], waistMM: [.1, 100], mainCurrentA: [-100, 100],
    gradientPerAmp: [0, 1000], sourceSpeed: [0, 500], sourceSpread: [0, 100],
    sourceRadiusMM: [0, 100], sourceTempMK: [0, 1000], sourceYawDeg: [-180, 180],
    sourcePitchDeg: [-90, 90], sourceOffsetYMM: [-100, 100], sourceOffsetZMM: [-100, 100],
    sourceDistanceMM: [0, 120], n: [1, 16384], durationMS: [.001, 200],
    seed: [0, 4294967295], dtUS: [.1, 100] };
  for (const [key, [lo, hi]] of Object.entries(ranges))
    if (!Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) throw new RangeError(`Invalid ${key}`);
  if (!Number.isInteger(p.n) || !Number.isInteger(p.seed)) throw new RangeError('n and seed must be integers');
  if (p.powersMW.some(v => v < 0 || v > 10000)) throw new RangeError('powersMW must be nonnegative');
  if (!['y', 'z'].includes(p.mainAxis)) throw new RangeError('mainAxis must be y or z');
  if (typeof p.gravity !== 'boolean' || typeof p.recoil !== 'boolean') throw new TypeError('gravity and recoil must be Boolean');
  return p;
}

export function derive(input = {}) {
  const p = normalize(input), gradientGPerCm = p.mainCurrentA * p.gradientPerAmp;
  const gradientTeslaPerM = gradientGPerCm * .01;
  const mainTensor = p.mainAxis === 'y' ? [-.5, 1, -.5] : [-.5, -.5, 1];
  const biasG = p.biasCurrentA.map((v, i) => v * p.biasPerAmp[i]);
  const biasTesla = biasG.map(v => v * 1e-4);
  const zeroUnique = gradientTeslaPerM !== 0;
  const zeroMM = zeroUnique ? biasTesla.map((v, i) => -1000 * v / (gradientTeslaPerM * mainTensor[i]))
    : biasTesla.every(v => v === 0) ? [0, 0, 0] : null;
  const peakS = p.powersMW.map(v => 2 * v * 1e-3 / (Math.PI * (p.waistMM * 1e-3) ** 2 * ISAT));
  return { gradientGPerCm, gradientTeslaPerM, biasG, biasTesla, zeroMM, zeroUnique,
    mainAxis: p.mainAxis, mainAxisUnit: p.mainAxis === 'y' ? [0, 1, 0] : [0, 0, 1], mainTensor,
    totalPowerMW: p.powersMW.reduce((a, b) => a + b, 0), peakS,
    saturationIntensityWPerM2: ISAT, recoilVelocityMS: RECOIL };
}

export function compile(input = {}) {
  if (input?._mot3dCompiled === true) return input;
  const params = normalize(input), d = derive(params);
  return { _mot3dCompiled: true, params, derived: d,
    fieldSlope: d.mainTensor.map(v => v * d.gradientTeslaPerM), bias: d.biasTesla,
    peakS: d.peakS, inverseWaistSquared: 1 / (params.waistMM * 1e-3) ** 2,
    detuning: 2 * Math.PI * params.detuningMHz * 1e6,
    gravityZ: params.gravity ? -C.gravity : 0 };
}

export function fieldAt(pos, paramsOrCompiled = {}) {
  const c = compile(paramsOrCompiled);
  return pos.map((v, i) => c.fieldSlope[i] * v + c.bias[i]);
}

// Internal scratch: [ax,ay,az,R(+V1),R(-V1),R(+V2),R(-V2),R(+H),R(-H)].
function evaluate(x, y, z, vx, vy, vz, c, out, s) {
  const r2 = x*x + y*y + z*z;
  let saturation = 1;
  for (let j = 0; j < 6; j++) {
    const d = BEAM_DIRECTIONS[j], parallel = d[0]*x + d[1]*y + d[2]*z;
    s[j] = c.peakS[j] * Math.exp(-2 * Math.max(0, r2 - parallel*parallel) * c.inverseWaistSquared);
    saturation += s[j];
  }
  const bx = c.fieldSlope[0]*x + c.bias[0], by = c.fieldSlope[1]*y + c.bias[1], bz = c.fieldSlope[2]*z + c.bias[2];
  const b = Math.hypot(bx, by, bz), zeeman = C.muB * b / C.hbar;
  let ax = 0, ay = 0, az = 0;
  for (let j = 0; j < 6; j++) {
    const d = BEAM_DIRECTIONS[j];
    const cosine = b > 0 ? Math.max(-1, Math.min(1, (d[0]*bx+d[1]*by+d[2]*bz) / b)) : 0;
    const hc = HELICITIES[j] * cosine;
    const dp = 2 * (c.detuning - K*(d[0]*vx+d[1]*vy+d[2]*vz) - zeeman) / C.gamma;
    const dz = dp + 2 * zeeman / C.gamma, dm = dz + 2 * zeeman / C.gamma;
    const rate = .5 * C.gamma * s[j] * (
      .25*(1+hc)**2 / (saturation+dp*dp) + .5*(1-cosine*cosine) / (saturation+dz*dz)
      + .25*(1-hc)**2 / (saturation+dm*dm));
    out[3+j] = rate;
    ax += RECOIL * rate * d[0]; ay += RECOIL * rate * d[1]; az += RECOIL * rate * d[2];
  }
  out[0] = ax; out[1] = ay; out[2] = az;
  return out;
}

export function radiation(pos, vel, paramsOrCompiled = {}) {
  const c = compile(paramsOrCompiled), out = new Float64Array(9);
  evaluate(...pos, ...vel, c, out, new Float64Array(6));
  return { acceleration: Array.from(out.subarray(0, 3)), rates: Array.from(out.subarray(3)),
    totalRate: out.subarray(3).reduce((a, b) => a + b, 0) };
}
export function opticalAcceleration(pos, vel, paramsOrCompiled = {}) {
  return radiation(pos, vel, paramsOrCompiled).acceleration;
}
export function acceleration(pos, vel, paramsOrCompiled = {}) {
  const c = compile(paramsOrCompiled), a = opticalAcceleration(pos, vel, c);
  a[2] += c.gravityZ;
  return a;
}

function random(seed) {
  let state = seed >>> 0, spare = null;
  const uniform = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  return { normal() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const r = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-15))), a = 2*Math.PI*uniform();
    spare = r*Math.sin(a); return r*Math.cos(a);
  } };
}

export function sampleInitialStates(input = {}) {
  const p = normalize(input);
  const rng = random(p.seed), states = new Float64Array(p.n * 6);
  const yaw = p.sourceYawDeg * Math.PI/180, pitch = p.sourcePitchDeg * Math.PI/180;
  const d = [Math.cos(yaw)*Math.cos(pitch), Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch)];
  const e1 = [-Math.sin(yaw), Math.cos(yaw), 0];
  const e2 = [-Math.cos(yaw)*Math.sin(pitch), -Math.sin(yaw)*Math.sin(pitch), Math.cos(pitch)];
  const thermal = Math.sqrt(C.kB * p.sourceTempMK * 1e-3 / C.mass);
  for (let i = 0; i < p.n; i++) {
    const o = i*6;
    states[o] = -p.sourceDistanceMM * 1e-3;
    states[o+1] = (p.sourceOffsetYMM + p.sourceRadiusMM*rng.normal()) * 1e-3;
    states[o+2] = (p.sourceOffsetZMM + p.sourceRadiusMM*rng.normal()) * 1e-3;
    // A directed source uses a normal longitudinal distribution conditioned on v_parallel >= 0.
    let longitudinal;
    do { longitudinal = p.sourceSpeed + p.sourceSpread*rng.normal(); } while (longitudinal < 0);
    const vt1 = thermal*rng.normal(), vt2 = thermal*rng.normal();
    for (let a=0;a<3;a++) states[o+3+a] = longitudinal*d[a] + vt1*e1[a] + vt2*e2[a];
  }
  return states;
}

/** options.initialStates: optional flat [x,y,z,vx,vy,vz] per atom, SI, for controlled tests. */
export function simulate(input = {}, options = {}) {
  const started = performance.now(), c = compile(input), p = c.params, n = p.n;
  const frameCount = options.frameCount ?? 120;
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 1000) throw new RangeError('Invalid frameCount');
  const initial = options.initialStates ? Float64Array.from(options.initialStates) : sampleInitialStates(p);
  if (initial.length !== n*6 || initial.some(v => !Number.isFinite(v))) throw new TypeError('initialStates must contain n*6 finite SI values');
  const duration = p.durationMS*1e-3, steps = Math.ceil(duration/(p.dtUS*1e-6)), dt = duration/steps;
  const hold = Math.min(.005, duration), holdStart = duration-hold, radius = .003, speedLimit = 1;
  const domainRadius = .15; // computational termination sphere, not a physical aperture
  const frames = new Float32Array(frameCount*n*3), frameAlive = new Uint8Array(frameCount*n);
  const times = Float64Array.from({ length: frameCount }, (_, i) => duration*i/(frameCount-1));
  const finalPositions = new Float64Array(n*3), finalVelocities = new Float64Array(n*3);
  const alive = new Uint8Array(n), retained = new Uint8Array(n);
  const yaw = p.sourceYawDeg*Math.PI/180, pitch = p.sourcePitchDeg*Math.PI/180;
  const sourceDirection = [Math.cos(yaw)*Math.cos(pitch), Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch)];
  const initialLongitudinalVelocities = Float64Array.from({length:n}, (_,i) =>
    sourceDirection.reduce((sum,d,a) => sum+d*initial[6*i+3+a],0));
  const out = new Float64Array(9), mid = new Float64Array(9), s = new Float64Array(6);
  for (let i=0;i<n;i++) {
    let [x,y,z,vx,vy,vz] = initial.subarray(i*6,i*6+6), nextFrame = 1, live = true, held = true;
    const rng = random((p.seed ^ Math.imul(i+1, 0x9E3779B1) ^ 0xA341316C) >>> 0);
    frames.set([x,y,z], i*3); frameAlive[i] = 1;
    if (holdStart === 0 && (Math.hypot(x,y,z)>=radius || Math.hypot(vx,vy,vz)>=speedLimit)) held = false;
    for (let step=0;step<steps;step++) {
      const time = (step+1)*dt, oldX=x,oldY=y,oldZ=z;
      if (live) {
        evaluate(x,y,z,vx,vy,vz,c,out,s);
        const hx=x+.5*dt*vx,hy=y+.5*dt*vy,hz=z+.5*dt*vz;
        const hvx=vx+.5*dt*out[0],hvy=vy+.5*dt*out[1],hvz=vz+.5*dt*(out[2]+c.gravityZ);
        evaluate(hx,hy,hz,hvx,hvy,hvz,c,mid,s);
        x += dt*hvx; y += dt*hvy; z += dt*hvz;
        vx += dt*mid[0]; vy += dt*mid[1]; vz += dt*(mid[2]+c.gravityZ);
        if (p.recoil) {
          // Independent absorption shot noise along each beam pair plus isotropic emission.
          let total = 0;
          for (let pair=0;pair<3;pair++) {
            const rate = mid[3+2*pair]+mid[4+2*pair]; total += rate;
            const kick = RECOIL*Math.sqrt(rate*dt)*rng.normal(), d=BEAM_DIRECTIONS[2*pair];
            vx += kick*d[0]; vy += kick*d[1]; vz += kick*d[2];
          }
          const emission = RECOIL*Math.sqrt(total*dt/3);
          vx += emission*rng.normal(); vy += emission*rng.normal(); vz += emission*rng.normal();
        }
        if (Math.hypot(x,y,z)>domainRadius || !Number.isFinite(vx+vy+vz+x+y+z)) live = false;
        if (time >= holdStart-1e-15 && (!live || Math.hypot(x,y,z)>=radius || Math.hypot(vx,vy,vz)>=speedLimit)) held = false;
      }
      while (nextFrame < frameCount && times[nextFrame] <= time+1e-14) {
        const f = Math.max(0, Math.min(1, (times[nextFrame]-(time-dt))/dt)), o=(nextFrame*n+i)*3;
        frames[o] = oldX+f*(x-oldX); frames[o+1] = oldY+f*(y-oldY); frames[o+2] = oldZ+f*(z-oldZ);
        frameAlive[nextFrame*n+i] = live ? 1 : 0; nextFrame++;
      }
    }
    finalPositions.set([x,y,z],i*3); finalVelocities.set([vx,vy,vz],i*3);
    alive[i] = live ? 1 : 0; retained[i] = live && held ? 1 : 0;
  }
  let count=0, validCount=0, allSpeed=0, capturedSpeed=0;
  const centroid=[0,0,0], moments=[0,0,0];
  for (let i=0;i<n;i++) {
    const speed = Math.hypot(...finalVelocities.subarray(i*3,i*3+3));
    if (alive[i]) { validCount++; allSpeed += speed; }
    if (!retained[i]) continue;
    count++; capturedSpeed += speed;
    for (let a=0;a<3;a++) {
      const value=finalPositions[i*3+a]*1000, delta=value-centroid[a];
      centroid[a] += delta/count; moments[a] += delta*(value-centroid[a]);
    }
  }
  const longitudinalStats = selected => {
    let count=0, mean=0, m2=0;
    initialLongitudinalVelocities.forEach((v,i) => {
      if (selected && !selected[i]) return;
      const delta=v-mean; mean+=delta/++count; m2+=delta*(v-mean);
    });
    return {n:count,meanMS:count?mean:null,stdMS:count?Math.sqrt(Math.max(0,m2/count)):null};
  };
  return { params:p,n,frameCount,frames,frameAlive,times,finalPositions,finalVelocities,alive,retained,
    initialLongitudinalVelocities,
    summary:{ retained:count,retainedFraction:count/n,centroidMM:count?centroid:null,
      rmsMM:count?moments.map(v=>Math.sqrt(Math.max(0,v/count))):null,
      meanSpeed:count?capturedSpeed/count:null,allMeanSpeed:validCount?allSpeed/validCount:null,validCount,
      initialLongitudinal:longitudinalStats(), retainedInitialLongitudinal:longitudinalStats(retained),
      zeroMM:c.derived.zeroMM,criterion:{radiusMM:3,speedMS:1,holdMS:hold*1000,center:'optical-origin'},
      elapsedMS:performance.now()-started } };
}
