import { createGpuSimulation } from '../gpu-simulation.js';
import { DEFAULTS, derive, radiation, sampleInitialStates, simulate } from '../physics.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function close(actual, expected, tolerance, label) {
  check(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} (expected ${expected} ± ${tolerance})`);
}

function maxDifference(a, b) {
  check(a.length === b.length, 'Array lengths differ');
  return a.reduce((largest, value, i) => Math.max(largest, Math.abs(value - b[i])), 0);
}

const noLight = { powersMW: [0, 0, 0, 0, 0, 0], gravity: false, recoil: false };

async function checkBallistics(gpu) {
  const initialStates = [
    .0047, 0, 0, -.6, 0, 0,
    .0049, 0, 0, -.6, 0, 0,
    .149, 0, 0, 21, 0, 0,
  ];
  const params = { ...noLight, n: 3, durationMS: 8, dtUS: 12 };
  const result = await gpu.run(params, { initialStates, frameCount: 19 });
  check(result.framePhotons.every(value => value === 0), 'No fluorescence with all beams disabled');
  check(result.retained.join() === '1,0,0', 'Continuous hold window');
  check(result.alive.join() === '1,1,0', 'Escape sphere');
  for (let f = 0; f < result.frameCount; f++) {
    close(result.frames[f * 9], .0047 - .6 * result.times[f], 2e-7, 'Interpolated trajectory');
    check(result.frameAlive[f * 3 + 2] === Number(f === 0), 'Escape replay mask');
  }
  const gravity = await gpu.run({ ...noLight, gravity: true, n: 1, durationMS: .005 }, {
    initialStates: [0, 0, 0, .2, 0, .5], frameCount: 31,
  });
  for (let f = 0; f < gravity.frameCount; f++) {
    close(gravity.frames[3 * f], .2 * gravity.times[f], 1e-11, 'Multiple frames within one step');
  }
  close(gravity.finalVelocities[2], .5 - 9.80665 * .000005, 2e-7, 'Gravity');
}

async function checkOptics(gpu) {
  const params = {
    n: 45, durationMS: 1.7, dtUS: 9, recoil: false, seed: 242,
    mainAxis: 'z', mainCurrentA: -1.6, biasCurrentA: [.5, -.3, .8],
    powersMW: [0, 11, 8, 3, 12, 6], sourceDistanceMM: 4, sourceSpeed: 7,
  };
  const options = { initialStates: sampleInitialStates(params), frameCount: 19 };
  const cpu = simulate(params, options);
  const gpuResult = await gpu.run(params, options);
  const positionError = maxDifference(cpu.frames, gpuResult.frames);
  const speedError = maxDifference(cpu.finalVelocities, gpuResult.finalVelocities);
  const photonError = maxDifference(cpu.framePhotons, gpuResult.framePhotons);
  close(positionError, 0, 1e-6, 'Asymmetric beams and field, position (m)');
  close(speedError, 0, 1e-3, 'Asymmetric beams and field, velocity (m/s)');
  close(photonError, 0, 1, 'Asymmetric beams and field, accumulated photons per atom');
  return { maxPositionErrorM: positionError, maxVelocityErrorMS: speedError, maxPhotonError: photonError };
}

async function checkRecoil(gpu) {
  const n = 4096, durationMS = .005, dt = durationMS / 1000;
  const params = { n, durationMS, dtUS: 5, mainCurrentA: 0, gravity: false, powersMW: [15, 15, 0, 0, 0, 0] };
  const options = { initialStates: new Float64Array(6 * n), frameCount: 2 };
  const { finalVelocities: v } = await gpu.run(params, options);
  const rate = radiation([0, 0, 0], [0, 0, 0], params).totalRate;
  const scale = derive(params).recoilVelocityMS ** 2 * rate * dt;
  const expected = [3 / 4 + 1 / 3, 1 / 3, 1 / 4 + 1 / 3, Math.sqrt(3) / 4];
  const secondMoments = [0, 0, 0, 0];
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a++) secondMoments[a] += v[i + a] ** 2;
    secondMoments[3] += v[i] * v[i + 2];
  }
  const ratios = secondMoments.map((sum, a) => sum / (n * scale * expected[a]));
  ratios.forEach((ratio, a) => close(ratio, 1, .12, 'Recoil second moment ' + ['xx','yy','zz','xz'][a]));
  return ratios;
}

const median = times => times.slice().sort((x,y) => x-y)[Math.floor(times.length/2)];

async function benchmark(gpu, n) {
  const params = { ...DEFAULTS, n }, options = { initialStates: sampleInitialStates(params), frameCount: 120 };
  const gpuTimes = [], cpuTimes = [];
  let firstGpu, lastCpu;
  for (let pass = 0; pass < 4; pass++) {
    let start = performance.now();
    const result = await gpu.run(params, options);
    const gpuTime = performance.now() - start;
    start = performance.now();
    lastCpu = simulate(params, options);
    const cpuTime = performance.now() - start;
    if (pass > 0) {
      gpuTimes.push(gpuTime);
      cpuTimes.push(cpuTime);
      close(maxDifference(firstGpu.finalVelocities, result.finalVelocities), 0, 0, 'Fixed-seed replay');
    } else {
      firstGpu = result;
    }
  }
  close(firstGpu.summary.retainedFraction, lastCpu.summary.retainedFraction, .03, 'Default captured fraction');
  close(firstGpu.summary.meanSpeed, lastCpu.summary.meanSpeed, .06, 'Default retained mean speed (m/s)');
  const finalPhotons = output => output.framePhotons.subarray((output.frameCount - 1) * n)
    .reduce((sum, value) => sum + value, 0) / n;
  const gpuPhotonsPerAtom = finalPhotons(firstGpu);
  const cpuPhotonsPerAtom = finalPhotons(lastCpu);
  check(cpuPhotonsPerAtom > 0, 'Default MOT emits fluorescence');
  close(gpuPhotonsPerAtom / cpuPhotonsPerAtom, 1, .03, 'Default fluorescence at the final observation time');
  return {
    n, gpuRetained: firstGpu.summary.retained, cpuRetained: lastCpu.summary.retained,
    gpuPhotonsPerAtom, cpuPhotonsPerAtom,
    gpuMeanSpeed: firstGpu.summary.meanSpeed, cpuMeanSpeed: lastCpu.summary.meanSpeed,
    medianGpuMS: median(gpuTimes), medianCpuMS: median(cpuTimes), gpuTimes, cpuTimes,
  };
}

export async function runShaderChecks(source, progress) {
  const start = performance.now();
  const gpu = await createGpuSimulation(source);
  check(gpu, 'A real WebGPU adapter is required');
  const setupMS = performance.now() - start;
  try {
    await checkBallistics(gpu);
    const optical = await checkOptics(gpu);
    const recoilMomentRatios = await checkRecoil(gpu);
    progress('GPU ballistics, retention, optics and recoil passed');
    const timings = [];
    for (const n of [192, 768]) {
      timings.push(await benchmark(gpu, n));
      progress('Completed ' + n + ' atoms');
    }
    return {setupMS, optical, recoilMomentRatios, timings};
  } finally {
    gpu.destroy();
  }
}

self.onmessage = async ({ data: source }) => {
  try {
    const result = await runShaderChecks(source, progress => self.postMessage({progress}));
    self.postMessage({result});
  } catch (error) {
    self.postMessage({error: error.stack ?? String(error)});
  }
};
