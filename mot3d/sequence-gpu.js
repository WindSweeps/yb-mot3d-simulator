import { BEAM_DIRECTIONS, CONSTANTS, HELICITIES } from './physics.js';
import { DARK_BRANCHES, branchDraws } from './branching.js';
import { sequenceAt } from './sequence.js';
import { prepareSequenceRun, writeSequenceGPUFrames, finishSequenceRun } from './sequence-physics.js';

const atomBytes = 64, frameAtomBytes = 48, planBytes = 64;
const batchBytes = 24;
const historyPageBytes = 12 * 1024 * 1024;
const maxStepsPerDispatch = 96, maxDispatchesPerSubmit = 32, particleStepBudget = 2 * 1024 * 1024;
const normalizedMHzFactor = 4 * Math.PI * 1e6;

export class SequenceDeviceUnavailable extends Error {}

function packApparatus({model,field,program}) {
  const c = program.config, {blue,green} = field;
  const line = ({transition: t}) => [2*t.k/t.gamma, 2*t.lande*CONSTANTS.muB/(CONSTANTS.hbar*t.gamma),
    t.gamma/2, t.recoil];
  const load = sequenceAt(program, 0);
  const receive = sequenceAt(program, program.stages.find(s => s.id === 'green')?.startMS ?? program.durationMS);
  const final = sequenceAt(program, program.durationMS);
  return new Float32Array([
    ...line(blue), ...line(green), ...model.derived.mainTensor.map(x => x*.01), model.gravityZ,
    ...model.bias, Number(model.params.recoil),
    ...[0,2,4].flatMap(i => [...BEAM_DIRECTIONS[i],HELICITIES[i]]),
    blue.inverseWaistSquared, green.inverseWaistSquared, green.factor*final.greenPowersMW[0], green.factor*final.greenPowersMW[4],
    blue.factor*load.bluePowersMW[0], blue.factor*load.bluePowersMW[4], green.factor*load.greenPowersMW[0], green.factor*load.greenPowersMW[4],
    normalizedMHzFactor*load.blueDetuningMHz/blue.transition.gamma, normalizedMHzFactor*load.greenDetuningMHz/green.transition.gamma,
    normalizedMHzFactor*receive.greenDetuningMHz/green.transition.gamma, normalizedMHzFactor*final.greenDetuningMHz/green.transition.gamma,
    load.gradientGCM, receive.gradientGCM, final.gradientGCM, ['linear','smooth','geometric'].indexOf(c.powerRamp ?? 'linear'),
    DARK_BRANCHES.blueP0, DARK_BRANCHES.blueP2, DARK_BRANCHES.greenP0, Number(model.params.engine === 'rate-equations'),
  ]);
}

function packAtoms({model,initial}) {
  const {n,seed} = model.params;
  const buffer = new ArrayBuffer(atomBytes*n), floats = new Float32Array(buffer), flags = new Uint32Array(buffer);
  for (let i=0; i<n; i++) {
    const k = i*(atomBytes/4), {threshold,choice} = branchDraws(seed,i);
    floats.set(initial.subarray(6*i,6*i+3),k);
    floats.set(initial.subarray(6*i+3,6*i+6),k+4);
    flags[k+3] = flags[k+7] = 1;
    flags[k+8] = seed ^ Math.imul(i+1,0x9E3779B1) ^ 0xA341316C;
    floats[k+9] = threshold;
    floats[k+10] = Math.min(choice,1-2**-24);
  }
  return buffer;
}

function packFrames({field,program,grid}) {
  const firstHeld = new Float64Array(grid.length);
  const buffer = new ArrayBuffer(planBytes*grid.length);
  const flags = new Uint32Array(buffer), values = new Float32Array(buffer);
  for (let f=0; f<grid.length; f++) {
    const point = grid[f], start = grid[Math.max(0,f-1)].time;
    const delta = point.time-start, stageIndex = sequenceAt(program,start).stageIndex, stage = program.stages[stageIndex];
    const steps = point.steps;
    if (!Number.isSafeInteger(steps) || steps < 0) throw new Error('积分步数缺失或无效，请刷新网页后重新计算。');
    const stepMS = steps ? delta/steps : 0;
    firstHeld[f] = steps ? Math.max(0,Math.min(steps+1,Math.ceil((point.windowStart-start-1e-12)/stepMS))) : 1;
    const end = sequenceAt(program,point.time), k = f*16;
    // 纯蓝装载和保持使用同一恒定光场；关源时刻只改变原子数方程。
    const opticalStage = stage.id === 'hold' ? 0 : stageIndex;
    const checkpoint = Boolean(point.checkpoint);
    const observeOnly = checkpoint && program.config.mode === 'blue-only' && point.checkpoint !== 'N0';
    flags.set([opticalStage, Number(checkpoint), Number(observeOnly)], k);
    values.set([stepMS*.001,(start-stage.startMS)/stage.durationMS,stepMS/stage.durationMS,0,
      field.blue.factor*end.bluePowersMW[0], field.blue.factor*end.bluePowersMW[4],
      field.green.factor*end.greenPowersMW[0], field.green.factor*end.greenPowersMW[4],
      normalizedMHzFactor*end.blueDetuningMHz/field.blue.transition.gamma, normalizedMHzFactor*end.greenDetuningMHz/field.green.transition.gamma,
      end.gradientGCM, 0],k+4);
  }
  return {buffer,firstHeld};
}

async function integrate(device,pipeline,layout,input,config,options) {
  const start = performance.now(), run = prepareSequenceRun(input,config,options);
  const {n,frameCount} = run.result;
  const pageSize = Math.min(32, frameCount, Math.floor(Math.min(historyPageBytes,
    device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)/(n*frameAtomBytes)));
  if (pageSize < 1) throw new RangeError('显卡的缓冲区无法保存一帧轨迹。');
  const buffers = [];
  function allocate(label,size,usage,initial) {
    const buffer = device.createBuffer({label,size,usage});
    buffers.push(buffer);
    if (initial) device.queue.writeBuffer(buffer,0,initial);
    return buffer;
  }
  try {
    const storage = GPUBufferUsage.STORAGE, upload = GPUBufferUsage.COPY_DST;
    const params = packApparatus(run), plan = packFrames(run);
    const settings = allocate('MOT apparatus',params.byteLength,storage|upload,params);
    const particles = allocate('Monte Carlo atoms',atomBytes*n,storage|upload,packAtoms(run));
    const frames = allocate('MOT observation intervals',plan.buffer.byteLength,storage|upload,plan.buffer);
    const pageBytes = pageSize*n*frameAtomBytes;
    const output = allocate('Atomic frame page',pageBytes,storage|GPUBufferUsage.COPY_SRC);
    const readback = allocate('Atomic readback',pageBytes,GPUBufferUsage.MAP_READ|upload);
    const stride = Math.ceil(batchBytes/device.limits.minUniformBufferOffsetAlignment)*device.limits.minUniformBufferOffsetAlignment;
    const argumentsBuffer = new Uint32Array(maxDispatchesPerSubmit*stride/4);
    const floatArguments = new Float32Array(argumentsBuffer.buffer);
    const commands = allocate('Integration intervals',argumentsBuffer.byteLength,GPUBufferUsage.UNIFORM|upload);
    const group = device.createBindGroup({layout, entries:[
      {binding:0,resource:{buffer:settings}}, {binding:1,resource:{buffer:particles}},
      {binding:2,resource:{buffer:frames}}, {binding:3,resource:{buffer:output}},
      {binding:4,resource:{buffer:commands,size:batchBytes}},
    ]});
    // 读回装载末帧即可知道是否捕获了原子。所有轨迹均已丢失时，后续只须写出静止的历史帧。
    const afterCapture = run.grid.findIndex(point => point.checkpoint === 'N0')+1;
    let liveCount = n;
    for (let first=0; first<frameCount;) {
      const end = Math.min(first+pageSize,first<afterCapture ? afterCapture : frameCount), bytes = (end-first)*n*frameAtomBytes;
      let frame = first, step = 0;
      while (frame < end) {
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        let count=0, particleSteps=0;
        while (frame<end && particleSteps<particleStepBudget && count<maxDispatchesPerSubmit) {
          const total = liveCount ? run.grid[frame].steps : 0;
          const steps = Math.min(total-step,maxStepsPerDispatch);
          const offset = count*stride;
          // 着色器内只使用单次调度的局部步号。总步数和驻留窗口的起点保留 JavaScript 整数精度。
          const heldFrom = Math.max(0,Math.min(steps+1,plan.firstHeld[frame]-step));
          argumentsBuffer.set([frame,frame-first,steps,heldFrom,0,Number(step+steps===total)],offset/4);
          floatArguments[offset/4+4] = step;
          pass.setBindGroup(0,group,[offset]);
          pass.dispatchWorkgroups(Math.ceil(n/32));
          count++;
          particleSteps += Math.max(1,steps)*n; step += steps;
          if (step===total) { frame++; step=0; }
        }
        pass.end();
        device.queue.writeBuffer(commands,0,argumentsBuffer.buffer,0,count*stride);
        if (frame===end) encoder.copyBufferToBuffer(output,0,readback,0,bytes);
        device.queue.submit([encoder.finish()]);
        if (frame<end) await device.queue.onSubmittedWorkDone();
      }
      await readback.mapAsync(GPUMapMode.READ,0,bytes);
      liveCount = writeSequenceGPUFrames(run,new Float32Array(readback.getMappedRange(0,bytes)),first,end-first);
      readback.unmap();
      options.onProgress?.(end/frameCount);
      first = end;
    }
    return Object.assign(finishSequenceRun(run,start),{backend:'WebGPU'});
  } finally {
    for (const buffer of buffers) buffer.destroy();
  }
}

export async function createSequenceGpu(source) {
  if (!navigator.gpu) return null;
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); }
  catch (error) { throw new SequenceDeviceUnavailable('WebGPU 适配器不可用。' + error.message); }
  if (!adapter) return null;
  if (!source?.includes('fn recordCheckpoint(')) throw new Error('网页已更新，请刷新后重新计算。');
  let device;
  try { device = await adapter.requestDevice(); }
  catch (error) { throw new SequenceDeviceUnavailable('WebGPU 设备无法启动。' + error.message); }
  let lost;
  device.lost.then(info => { lost = new SequenceDeviceUnavailable('WebGPU 设备已断开。' + info.message); });
  try {
    const shader = device.createShaderModule({label:'Yb two-colour MOT',code:source});
    const diagnostics = await shader.getCompilationInfo();
    const errors = diagnostics.messages.filter(m => m.type==='error');
    if (errors.length) throw new Error(errors.map(m => 'WGSL ' + m.lineNum + ':' + m.linePos + ' ' + m.message).join('\n'));
    const layout = device.createBindGroupLayout({entries:[
      {binding:0, visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:1, visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
      {binding:2, visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:3, visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
      {binding:4, visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:batchBytes}},
    ]});
    const pipeline = await device.createComputePipelineAsync({
      layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:shader,entryPoint:'advanceBatch'},
    });
    return {
      async run(input,config,options={}) {
        if (lost) throw lost;
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('validation');
        try { return await integrate(device,pipeline,layout,input,config,options); }
        finally {
          const [validation,memory] = await Promise.all([device.popErrorScope(),device.popErrorScope()]);
          if (lost) throw lost;
          if (validation || memory) throw new Error((validation || memory).message);
        }
      },
      destroy() { device.destroy(); },
    };
  } catch (error) {
    device.destroy();
    throw lost ?? error;
  }
}
