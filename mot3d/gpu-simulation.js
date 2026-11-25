import {
  BEAM_DIRECTIONS, CONSTANTS, HELICITIES, compile, finishSimulation, sampleInitialStates, sampleBlueBranch,
} from './physics.js';
import { EMISSION_BRANCHES } from './branching.js';

const ATOM_WORDS = 16;
const ATOM_BYTES = ATOM_WORDS * 4;
const CHUNK_BYTES = 16;
const WORKGROUP_SIZE = 32;
const MAX_CHUNK_STEPS = 64;
const MAX_DISPATCHES_PER_SUBMISSION = 16;
const ATOM_STEPS_PER_SUBMISSION = 131072;

function parameterBlock(model, steps, frameCount, firstHeldStep, dt) {
  const { gamma, wavelength, muB, hbar } = CONSTANTS;
  const { params, derived, fieldSlope, bias, detuning, inverseWaistSquared, gravityZ, peakS } = model;
  return new Float32Array([
    params.n, steps, frameCount, firstHeldStep,
    dt, inverseWaistSquared, gravityZ, Number(params.recoil),
    ...fieldSlope, derived.recoilVelocityMS,
    ...bias, 2 * detuning / gamma,
    4 * Math.PI / (wavelength * gamma), 2 * muB / (hbar * gamma), gamma / 2, Number(params.engine === 'rate-equations'),
    ...BEAM_DIRECTIONS[0], HELICITIES[0],
    ...BEAM_DIRECTIONS[2], HELICITIES[2],
    ...BEAM_DIRECTIONS[4], HELICITIES[4],
    ...peakS, 0, 0,
  ]);
}

function writeInitialAtoms(device, buffer, params, initial, checkInitialHold, frameCount) {
  const packed = new ArrayBuffer(params.n * ATOM_BYTES);
  const floats = new Float32Array(packed);
  const flags = new Uint32Array(packed);
  for (let i = 0; i < params.n; i++) {
    const offset = i * ATOM_WORDS;
    const input = i * 6;
    const position = initial.subarray(input, input + 3);
    const velocity = initial.subarray(input + 3, input + 6);
    floats.set(position, offset);
    floats.set(velocity, offset + 4);
    flags[offset + 3] = frameCount;
    flags[offset + 7] = Number(!checkInitialHold || (Math.hypot(...position) < .003 && Math.hypot(...velocity) < 1));
    flags[offset + 8] = params.seed ^ Math.imul(i + 1, 0x9E3779B1) ^ 0xA341316C;
    flags[offset + 9] = 1;
    const branch = sampleBlueBranch(params.seed, i);
    floats[offset + 12] = branch.photonBudget;
    flags[offset + 13] = branch.target;
  }
  device.queue.writeBuffer(buffer, 0, packed);
}

function readOutput(mapped, n, frameCount, duration) {
  const frames = new Float32Array(frameCount * n * 3);
  const frameAlive = new Uint8Array(frameCount * n);
  const framePhotons = new Float32Array(frameCount * n);
  const history = new Float32Array(mapped, n * ATOM_BYTES);
  for (let i = 0; i < frameAlive.length; i++) {
    frames[3 * i] = history[4 * i];
    frames[3 * i + 1] = history[4 * i + 1];
    frames[3 * i + 2] = history[4 * i + 2];
    framePhotons[i] = history[4 * i + 3] * EMISSION_BRANCHES.blue399;
  }

  const finalPositions = new Float64Array(3 * n);
  const finalVelocities = new Float64Array(3 * n);
  const alive = new Uint8Array(n);
  const retained = new Uint8Array(n);
  const darkState = new Uint8Array(n);
  const floats = new Float32Array(mapped, 0, n * ATOM_WORDS);
  const flags = new Uint32Array(mapped, 0, n * ATOM_WORDS);
  for (let i = 0; i < n; i++) {
    const offset = i * ATOM_WORDS;
    finalPositions.set(floats.subarray(offset, offset + 3), 3 * i);
    finalVelocities.set(floats.subarray(offset + 4, offset + 7), 3 * i);
    const visibleFrames = flags[offset + 3];
    for (let frame = 0; frame < visibleFrames; frame++) frameAlive[frame * n + i] = 1;
    alive[i] = Number(visibleFrames === frameCount);
    retained[i] = alive[i] && flags[offset + 7];
    darkState[i] = flags[offset + 14];
  }

  const times = Float64Array.from({ length: frameCount }, (_, i) => duration * i / (frameCount - 1));
  return { n, frameCount, frames, frameAlive, framePhotons, times, finalPositions, finalVelocities, alive, retained, darkState };
}

async function integrate(device, pipeline, layout, input, options) {
  const started = performance.now();
  const { frameCount = 120, initialStates, isCurrent = () => true } = options;
  if (!isCurrent()) return null;
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 1000) throw new RangeError('Invalid frameCount');
  const model = compile(input);
  const { n, durationMS, dtUS } = model.params;
  const duration = durationMS * 1e-3;
  const steps = Math.ceil(duration / (dtUS * 1e-6));
  const dt = duration / steps;
  const holdStart = Math.max(0, duration - .005);
  const firstHeldStep = Math.max(0, Math.ceil((holdStart - 1e-15) / dt));
  const historyBytes = n * frameCount * 16;
  const stateBytes = n * ATOM_BYTES;
  if (historyBytes > device.limits.maxStorageBufferBindingSize || stateBytes + historyBytes > device.limits.maxBufferSize) {
    throw new RangeError('原子数量和回放帧数超出当前 GPU 缓冲区容量。');
  }
  const initial = initialStates === undefined ? sampleInitialStates(model.params) : Float64Array.from(initialStates);
  if (initial.length !== 6 * n || initial.some(value => !Number.isFinite(value))) {
    throw new TypeError('initialStates must contain n*6 finite SI values');
  }

  const buffers = [];
  const allocate = (label, size, usage) => {
    const buffer = device.createBuffer({ label, size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    const parameters = parameterBlock(model, steps, frameCount, firstHeldStep, dt);
    const state = allocate('MOT atoms', stateBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const history = allocate('MOT playback', historyBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const constants = allocate('MOT settings', parameters.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const readback = allocate('MOT readback', stateBytes + historyBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    // 每次提交的原子积分次数设有上限，浏览器可在批次之间绘制场景和取消旧计算。
    const stepsPerSubmission = Math.max(1, Math.floor(ATOM_STEPS_PER_SUBMISSION / n));
    const chunkSteps = Math.min(MAX_CHUNK_STEPS, stepsPerSubmission);
    const chunksPerBatch = Math.min(MAX_DISPATCHES_PER_SUBMISSION, Math.floor(stepsPerSubmission / chunkSteps));
    const uniformStride = Math.max(CHUNK_BYTES, device.limits.minUniformBufferOffsetAlignment);
    const uniforms = new Uint32Array(chunksPerBatch * uniformStride / 4);
    const chunks = allocate('MOT time steps', uniforms.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: constants } },
        { binding: 1, resource: { buffer: state } },
        { binding: 2, resource: { buffer: history } },
        { binding: 3, resource: { buffer: chunks, size: CHUNK_BYTES } },
      ],
    });
    device.queue.writeBuffer(constants, 0, parameters);
    writeInitialAtoms(device, state, model.params, initial, holdStart === 0, frameCount);

    const groups = Math.ceil(n / WORKGROUP_SIZE);
    for (let firstStep = 0; firstStep < steps;) {
      if (!isCurrent()) return null;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      let chunkIndex = 0;
      while (chunkIndex < chunksPerBatch && firstStep < steps) {
        const count = Math.min(chunkSteps, steps - firstStep);
        const offset = chunkIndex * uniformStride;
        uniforms[offset / 4] = firstStep;
        uniforms[offset / 4 + 1] = count;
        pass.setBindGroup(0, group, [offset]);
        pass.dispatchWorkgroups(groups);
        firstStep += count;
        chunkIndex++;
      }
      pass.end();
      device.queue.writeBuffer(chunks, 0, uniforms.buffer, 0, chunkIndex * uniformStride);
      if (firstStep === steps) {
        encoder.copyBufferToBuffer(state, 0, readback, 0, stateBytes);
        encoder.copyBufferToBuffer(history, 0, readback, stateBytes, historyBytes);
      }
      device.queue.submit([encoder.finish()]);
      if (firstStep < steps) await device.queue.onSubmittedWorkDone();
    }
    await readback.mapAsync(GPUMapMode.READ);
    if (!isCurrent()) return null;
    const output = readOutput(readback.getMappedRange(), n, frameCount, duration);
    const result = finishSimulation(model, initial, output, started);
    result.summary.backend = 'WebGPU';
    return result;
  } finally {
    for (const buffer of buffers) buffer.destroy();
  }
}

export async function createGpuSimulation(shaderSource) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  if (!shaderSource?.includes('fn resolvedLineRates(')) throw new Error('网页已更新，请刷新后重新计算。');
  const device = await adapter.requestDevice();
  let loss = null;
  device.lost.then(info => { loss = new Error('WebGPU 设备连接已断开。' + info.message); });
  try {
    const shader = device.createShaderModule({ label: 'MOT Monte Carlo', code: shaderSource });
    const diagnostics = await shader.getCompilationInfo();
    const errors = diagnostics.messages.filter(message => message.type === 'error');
    if (errors.length) {
      throw new Error(errors.map(message => `WGSL ${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
    }
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CHUNK_BYTES } },
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: shader, entryPoint: 'advance' },
    });
    let running = false;
    return {
      async run(input, options = {}) {
        if (loss) throw loss;
        if (running) throw new Error('WebGPU 计算任务尚未结束。');
        running = true;
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('validation');
        try {
          return await integrate(device, pipeline, layout, input, options);
        } finally {
          const [validation, allocation] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
          running = false;
          if (loss) throw loss;
          if (validation || allocation) throw new Error((validation || allocation).message);
        }
      },
      destroy() { device.destroy(); },
    };
  } catch (error) {
    device.destroy();
    throw error;
  }
}
