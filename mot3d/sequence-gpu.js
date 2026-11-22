import { BEAM_DIRECTIONS, CONSTANTS, HELICITIES } from './physics.js';
import { sequenceAt } from './sequence.js';
import { prepareSequenceRun, writeSequenceGPUFrames, finishSequenceRun } from './sequence-physics.js';

const atomBytes = 48, frameAtomBytes = 48, planBytes = 64;
const historyPageBytes = 12 * 1024 * 1024;
const maxStepsPerDispatch = 96, maxDispatchesPerSubmit = 32, particleStepBudget = 2 * 1024 * 1024;
const normalizedMHzFactor = 4 * Math.PI * 1e6;

export class SequenceDeviceUnavailable extends Error {}

function packApparatus({model,field,program}) {
  const c = program.config, {blue,green} = field;
  const line = ({transition: t}) => [2*t.k/t.gamma, 2*t.lande*CONSTANTS.muB/(CONSTANTS.hbar*t.gamma),
    t.gamma/2, t.recoil];
  const b = c.blueEnabled ? blue.factor : 0, g = c.greenEnabled ? green.factor : 0;
  return new Float32Array([
    ...line(blue), ...line(green), ...model.derived.mainTensor.map(x => x*.01), model.gravityZ,
    ...model.bias, Number(model.params.recoil),
    ...[0,2,4].flatMap(i => [...BEAM_DIRECTIONS[i],HELICITIES[i]]),
    blue.inverseWaistSquared, green.inverseWaistSquared, g*c.finalObliqueUW/1000, g*c.finalHorizontalUW/1000,
    b*c.blueObliqueMW, b*c.blueHorizontalMW, g*c.greenObliqueMW, g*c.greenHorizontalMW,
    normalizedMHzFactor*c.blueDetuningMHz/blue.transition.gamma, normalizedMHzFactor*c.shieldingMHz/green.transition.gamma,
    normalizedMHzFactor*c.receiveMHz/green.transition.gamma, normalizedMHzFactor*c.compressMHz/green.transition.gamma,
    c.loadGradient, c.receiveGradient, c.finalGradient, ['linear','smooth','geometric'].indexOf(c.powerRamp),
  ]);
}

function packAtoms({model,initial}) {
  const {n,seed} = model.params;
  const buffer = new ArrayBuffer(atomBytes*n), floats = new Float32Array(buffer), flags = new Uint32Array(buffer);
  for (let i=0; i<n; i++) {
    const k = i*12;
    floats.set(initial.subarray(6*i,6*i+3),k);
    floats.set(initial.subarray(6*i+3,6*i+6),k+4);
    flags[k+3] = flags[k+7] = 1;
    flags[k+8] = seed ^ Math.imul(i+1,0x9E3779B1) ^ 0xA341316C;
  }
  return buffer;
}

function packFrames({model,field,program,grid}) {
  const endSteps = new Uint32Array(grid.length);
  const buffer = new ArrayBuffer(planBytes*grid.length);
  const flags = new Uint32Array(buffer), values = new Float32Array(buffer);
  for (let f=0; f<grid.length; f++) {
    const point = grid[f], start = grid[Math.max(0,f-1)].time;
    const delta = point.time-start, stageIndex = sequenceAt(program,start).stageIndex, stage = program.stages[stageIndex];
    const steps = f===0 || point.freeze ? 0 : Math.max(1,Math.ceil(delta*1000/Math.min(5,model.params.dtUS)-1e-8));
    const stepMS = steps ? delta/steps : 0;
    const firstHeld = steps ? Math.max(0,Math.min(steps+1,Math.ceil((point.windowStart-start-1e-12)/stepMS))) : 1;
    const end = sequenceAt(program,point.time), k = f*16;
    flags.set([stageIndex, steps, firstHeld, Number(Boolean(point.checkpoint))], k);
    values.set([stepMS*.001,(start-stage.startMS)/stage.durationMS,stepMS/stage.durationMS,0,
      field.blue.factor*end.bluePowersMW[0], field.blue.factor*end.bluePowersMW[4],
      field.green.factor*end.greenPowersMW[0], field.green.factor*end.greenPowersMW[4],
      normalizedMHzFactor*end.blueDetuningMHz/field.blue.transition.gamma, normalizedMHzFactor*end.greenDetuningMHz/field.green.transition.gamma,
      end.gradientGCM, 0],k+4);
    endSteps[f] = steps;
  }
  return {buffer,endSteps};
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
    const stride = Math.max(16,device.limits.minUniformBufferOffsetAlignment);
    const argumentsBuffer = new Uint32Array(maxDispatchesPerSubmit*stride/4);
    const commands = allocate('Integration intervals',argumentsBuffer.byteLength,GPUBufferUsage.UNIFORM|upload);
    const group = device.createBindGroup({layout, entries:[
      {binding:0,resource:{buffer:settings}}, {binding:1,resource:{buffer:particles}},
      {binding:2,resource:{buffer:frames}}, {binding:3,resource:{buffer:output}},
      {binding:4,resource:{buffer:commands,size:16}},
    ]});
    for (let first=0; first<frameCount; first+=pageSize) {
      const end = Math.min(first+pageSize,frameCount), bytes = (end-first)*n*frameAtomBytes;
      let frame = first, step = 0;
      while (frame < end) {
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        let count=0, particleSteps=0;
        while (frame<end && particleSteps<particleStepBudget && count<maxDispatchesPerSubmit) {
          const total = plan.endSteps[frame], steps = Math.min(total-step,maxStepsPerDispatch);
          const offset = count*stride;
          argumentsBuffer.set([frame,frame-first,step,steps],offset/4);
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
      writeSequenceGPUFrames(run,new Float32Array(readback.getMappedRange(0,bytes)),first,end-first);
      readback.unmap();
      options.onProgress?.(end/frameCount);
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
      {binding:4, visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:16}},
    ]});
    const pipeline = await device.createComputePipelineAsync({
      layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:shader,entryPoint:'advance'},
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
