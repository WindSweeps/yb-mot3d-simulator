import { BEAM_DIRECTIONS, BLUE_TRANSITION, CONSTANTS as C, compile, evaluate, random, sampleInitialStates } from './physics.js';
import { compileSequence, sequenceAt } from './sequence.js';
import { sequenceSamplingDiagnostics } from './sequence-diagnostics.js';

const greenK = 2 * Math.PI / 555.8e-9;
export const GREEN_TRANSITION = Object.freeze({ k: greenK, gamma: 2 * Math.PI * 180000, lande: 1.5, recoil: C.hbar * greenK / C.mass });
const radius = .003, domain = .15;

function line(model, transition, waistMM) {
  if (!Number.isFinite(waistMM) || waistMM < .1 || waistMM > 100) throw new RangeError('光束腰斑半径须在 0.1–100 mm 之间。');
  const wavelength = 2 * Math.PI / transition.k;
  const isat = Math.PI * C.h * C.c * transition.gamma / (3 * wavelength ** 3);
  const inverseWaistSquared = 1 / (waistMM * .001) ** 2;
  return {
    ...model, transition, peakS: new Float64Array(6), fieldSlope: new Float64Array(3),
    inverseWaistSquared, factor: .002 * inverseWaistSquared / (Math.PI * isat),
    enabled: false,
  };
}

function lightField(model) {
  const {waistMM,greenWaistMM = waistMM} = model.params;
  return { blue: line(model, BLUE_TRANSITION, waistMM), green: line(model, GREEN_TRANSITION, greenWaistMM) };
}

function configureLine(c, detuningMHz, powers, gradient, gate) {
  c.detuning = 2 * Math.PI * detuningMHz * 1e6;
  c.enabled = false;
  for (let j = 0; j < 6; j++) {
    c.peakS[j] = gate ? c.factor * powers[j] : 0;
    if (c.peakS[j] > 0) c.enabled = true;
  }
  for (let axis = 0; axis < 3; axis++) c.fieldSlope[axis] = c.derived.mainTensor[axis] * gradient * .01;
}

function configure(field, channels) {
  configureLine(field.blue, channels.blueDetuningMHz, channels.bluePowersMW, channels.gradientGCM, channels.blueOn);
  configureLine(field.green, channels.greenDetuningMHz, channels.greenPowersMW, channels.gradientGCM, channels.greenOn);
}

function scratch() {
  return { blue: new Float64Array(9), green: new Float64Array(9), saturation: new Float64Array(6),
    acceleration: new Float64Array(3), blueRate: 0, greenRate: 0 };
}

function evaluateLine(pos, vel, c, output, saturation) {
  if (!c.enabled) { output.fill(0); return 0; }
  evaluate(pos[0], pos[1], pos[2], vel[0], vel[1], vel[2], c, output, saturation, c.transition);
  return output[3] + output[4] + output[5] + output[6] + output[7] + output[8];
}

function scattering(pos, vel, field, s) {
  const rb = evaluateLine(pos, vel, field.blue, s.blue, s.saturation);
  const rg = evaluateLine(pos, vel, field.green, s.green, s.saturation);
  // 两个有效跃迁共享基态。分别保留单色平衡比 f/(1-f)，再用总布居为一归一化。
  const fb = rb / BLUE_TRANSITION.gamma, fg = rg / GREEN_TRANSITION.gamma, norm = 1 - fb * fg;
  const sb = (1 - fg) / norm, sg = (1 - fb) / norm;
  for (let j = 0; j < 9; j++) { s.blue[j] *= sb; s.green[j] *= sg; }
  for (let j = 0; j < 3; j++) s.acceleration[j] = s.blue[j] + s.green[j];
  s.acceleration[2] += field.blue.gravityZ;
  s.blueRate = rb * sb;
  s.greenRate = rg * sg;
}

export function sequenceRadiation(position, velocity, params, channels) {
  const field = lightField(compile(params)), s = scratch();
  configure(field, channels);
  scattering(position, velocity, field, s);
  return s;
}

function recoil(velocity, dt, s, rng) {
  if (s.blueRate > 0) {
    // 宽线复用工作台已有的吸收散粒噪声与各向同性自发辐射扩散近似。
    for (let j = 0; j < 6; j += 2) {
      const kick = BLUE_TRANSITION.recoil * Math.sqrt((s.blue[3+j] + s.blue[4+j]) * dt) * rng.normal();
      for (let a = 0; a < 3; a++) velocity[a] += kick * BEAM_DIRECTIONS[j][a];
    }
    const width = BLUE_TRANSITION.recoil * Math.sqrt(s.blueRate * dt / 3);
    for (let a = 0; a < 3; a++) velocity[a] += width * rng.normal();
  }
  if (s.greenRate > 0) {
    // 低功率窄线逐光子抽样。先扣掉中点积分已计入的平均绿光冲量。
    for (let a = 0; a < 3; a++) velocity[a] -= dt * s.green[a];
    const limit = Math.exp(-s.greenRate * dt);
    for (let product = rng.uniform(); product > limit; product *= rng.uniform()) {
      let j = 0, r = s.greenRate * rng.uniform();
      while (j < 5 && r >= s.green[3+j]) r -= s.green[3+j++];
      const z = 2 * rng.uniform() - 1, phi = 2 * Math.PI * rng.uniform(), radial = Math.sqrt(1-z*z);
      const d = BEAM_DIRECTIONS[j];
      velocity[0] += GREEN_TRANSITION.recoil * (d[0] - radial * Math.cos(phi));
      velocity[1] += GREEN_TRANSITION.recoil * (d[1] - radial * Math.sin(phi));
      velocity[2] += GREEN_TRANSITION.recoil * (d[2] - z);
    }
  }
}

function inside(p, v) {
  return p[0]*p[0] + p[1]*p[1] + p[2]*p[2] < radius*radius && v[0]*v[0] + v[1]*v[1] + v[2]*v[2] < 1;
}

function observationGrid(program) {
  const [load, handoff, green, compress] = program.stages;
  const loadEnd = Math.min(load.endMS, 20);
  const grid = [{ time: 0 }];
  function section(start, end, interval, cap, windowStart, checkpoint) {
    const count = Math.max(1, Math.min(cap, Math.ceil((end-start) / interval)));
    for (let i = 1; i <= count; i++) {
      const time = i === count ? end : start + (end-start)*i/count;
      grid.push({ time, windowStart, checkpoint: i === count ? checkpoint : null });
    }
  }
  section(0, loadEnd, .1, 200, Math.max(0, loadEnd-5), 'N0');
  if (loadEnd < load.endMS) grid.push({ time: load.endMS, freeze: true });
  const greenWindow = Math.max(handoff.startMS, green.endMS-5);
  section(handoff.startMS, handoff.endMS, .1, 32, greenWindow);
  section(green.startMS, green.endMS, .25, 80, greenWindow, 'N1');
  section(compress.startMS, compress.endMS, .5, 150, Math.max(compress.startMS,compress.endMS-5), 'N2');
  return { grid, loadEnd };
}

function atomFrom(initial, i, seed) {
  return { p: initial.slice(6*i, 6*i+3), v: initial.slice(6*i+3, 6*i+6),
    rng: random((seed ^ Math.imul(i + 1, 0x9E3779B1) ^ 0xA341316C) >>> 0), live: true, held: true };
}

export function prepareSequenceRun(input, config, options = {}) {
  const model = compile(input), field = lightField(model);
  const { n } = model.params;
  const program = compileSequence(config), { grid, loadEnd } = observationGrid(program);
  const initial = options.initialStates ? Float64Array.from(options.initialStates) : sampleInitialStates(model.params);
  if (initial.length !== n*6 || initial.some(x => !Number.isFinite(x))) throw new RangeError('时序初始相空间尺寸或数值无效。');
  const samples = n * grid.length;
  const result = {
    n, frameCount:grid.length, stages:program.stages, loadWindowMS:loadEnd,
    timesMS:Float64Array.from(grid, point => point.time),
    positionsM:new Float32Array(samples * 3), alive:new Uint8Array(samples), trapped:new Uint8Array(samples),
    blueRates:new Float32Array(samples), greenRates:new Float32Array(samples),
    metrics:[], summary:{N0:0, N1:0, N2:0},
  };
  return {model, field, program, grid, loadEnd, initial, result};
}

function frameMoments() {
  return {count:0, live:0, width:0, thermal:0, center:[0,0,0], meanV:[0,0,0]};
}

function writeAtom(result, k, pos, offsetP, vel, offsetV, live, trapped, blueRate, greenRate, m) {
  result.positionsM[3*k] = pos[offsetP];
  result.positionsM[3*k+1] = pos[offsetP+1];
  result.positionsM[3*k+2] = pos[offsetP+2];
  if (!live) return;
  m.live++;
  result.alive[k] = 1;
  result.blueRates[k] = blueRate;
  result.greenRates[k] = greenRate;
  if (!trapped) return;
  result.trapped[k] = 1;
  m.count++;
  for (let a = 0; a < 3; a++) {
    const mm = 1000 * pos[offsetP+a], speed = vel[offsetV+a];
    const dx = mm - m.center[a], dv = speed - m.meanV[a];
    m.center[a] += dx/m.count;
    m.meanV[a] += dv/m.count;
    m.width += dx * (mm - m.center[a]);
    m.thermal += dv * (speed - m.meanV[a]);
  }
}

function finishFrame(run, frame, m) {
  const {count, center, width, thermal} = m, checkpoint = run.grid[frame].checkpoint;
  if (checkpoint) run.result.summary[checkpoint] = m.live;
  run.result.metrics.push({
    count, centroidMM:count ? center : null,
    rmsRadiusMM:count ? Math.sqrt(Math.max(0,width)/count) : null,
    temperatureUK:count > 1 ? C.mass*Math.max(0,thermal)*1e6/(3*C.kB*(count-1)) : null,
  });
}

// 每个粒子的三个 vec4 顺序为位置／存活、速度／阱内判据、两色散射率。
export function writeSequenceGPUFrames(run, data, firstFrame, frameCount) {
  const {result} = run;
  if (firstFrame !== result.metrics.length || !Number.isInteger(frameCount) || frameCount < 1 ||
      firstFrame + frameCount > result.frameCount ||
      data.length < 12 * result.n * frameCount) throw new RangeError('GPU 返回的时序帧范围或长度无效。');
  for (let f = firstFrame; f < firstFrame + frameCount; f++) {
    const m = frameMoments();
    for (let i = 0; i < result.n; i++) {
      const offset = 12 * ((f - firstFrame) * result.n + i);
      const live = data[offset+3], trapped = data[offset+7];
      const blueRate = data[offset+8], greenRate = data[offset+9];
      if (!Number.isFinite(data[offset]+data[offset+1]+data[offset+2]+data[offset+4]+data[offset+5]+
          data[offset+6]+blueRate+greenRate) || blueRate < 0 || greenRate < 0 || (live !== 0 && live !== 1) ||
          (trapped !== 0 && trapped !== 1) || trapped > live) throw new Error('GPU 时序帧的相空间、散射率或留存标记无效。');
      writeAtom(result, f*result.n + i, data, offset, data, offset+4, live, trapped, blueRate, greenRate, m);
    }
    finishFrame(run, f, m);
  }
}

export function finishSequenceRun(run, started) {
  if (run.result.metrics.length !== run.result.frameCount) throw new Error('时序输出帧不完整。');
  run.result.samplingDiagnostics = sequenceSamplingDiagnostics(run.result.n, run.result.summary);
  return Object.assign(run.result, run.result.summary, {elapsedMS:performance.now()-started});
}

export function simulateSequence(input, config, options = {}) {
  const start = performance.now(), run = prepareSequenceRun(input,config,options);
  const {model, program, grid, initial, result} = run;
  const {n, seed, dtUS} = model.params;
  const atoms = Array.from({ length:n }, (_, i) => atomFrom(initial, i, seed));
  const first = run.field, middle = lightField(model), s = scratch();
  const hp = new Float64Array(3), hv = new Float64Array(3);

  function frame(f) {
    configure(first, sequenceAt(program, grid[f].time));
    const m = frameMoments();
    for (let i = 0; i < n; i++) {
      const {p, v, live} = atoms[i], k = f*n + i;
      if (live) scattering(p, v, first, s);
      writeAtom(result,k,p,0,v,0,live,live && inside(p,v),s.blueRate,s.greenRate,m);
    }
    finishFrame(run,f,m);
  }
  function propagate(t, end, windowStart) {
    // 物理单位在积分核内为 SI。在阶段边界结束当前步，避免突跳被时间平均。
    const steps = Math.max(1, Math.ceil((end-t) * 1000 / Math.min(5,dtUS) - 1e-8));
    const h = (end-t)/steps, dt = h * .001;
    for (let step = 0; step < steps; step++) {
      const now = t + step*h;
      configure(first, sequenceAt(program, now));
      configure(middle, sequenceAt(program, now+.5*h));
      for (const atom of atoms) {
        if (!atom.live) continue;
        const {p,v} = atom;
        if (now >= windowStart - 1e-12 && !inside(p,v)) atom.held = false;
        scattering(p, v, first, s);
        for (let a=0; a<3; a++) { hp[a]=p[a]+.5*dt*v[a]; hv[a]=v[a]+.5*dt*s.acceleration[a]; }
        scattering(hp, hv, middle, s);
        for (let a=0; a<3; a++) { p[a] += dt*hv[a]; v[a] += dt*s.acceleration[a]; }
        if (model.params.recoil) recoil(v, dt, s, atom.rng);
        if (!Number.isFinite(p[0]+p[1]+p[2]+v[0]+v[1]+v[2])) throw new Error('时序积分出现非有限相空间。');
        if (p[0]*p[0]+p[1]*p[1]+p[2]*p[2] > domain*domain) atom.live = false;
        if (now+h >= windowStart - 1e-12 && !inside(p,v)) atom.held = false;
      }
    }
  }

  frame(0);
  for (let f = 1; f < grid.length; f++) {
    const point = grid[f];
    if (!point.freeze) propagate(grid[f-1].time, point.time, point.windowStart);
    if (point.checkpoint) {
      for (const atom of atoms) {
        atom.live = atom.live && atom.held;
        atom.held = true;
      }
    }
    frame(f);
    options.onProgress?.(f/(grid.length-1));
  }
  return finishSequenceRun(run,start);
}
