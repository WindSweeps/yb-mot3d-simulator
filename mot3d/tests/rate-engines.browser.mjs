import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:4194/mot3d/';
const runtime = fileURLToPath(new URL('./.runtime/rate-engines/', import.meta.url));
await mkdir(runtime, {recursive:true});
process.env.TMPDIR = process.env.TMP = process.env.TEMP = runtime;
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const args = process.platform === 'darwin' ? ['--enable-gpu','--use-angle=metal'] : ['--enable-gpu'];
const browser = await chromium.launch({channel:'chrome', chromiumSandbox:true, args});
try {
  const page = await browser.newPage();
  await page.goto(new URL('index.html', base).href, {waitUntil:'domcontentloaded'});
  const evidence = await page.evaluate(async () => {
    const {createGpuSimulation} = await import('./gpu-simulation.js');
    const {createSequenceGpu} = await import('./sequence-gpu.js');
    const {CONSTANTS:C, simulate, sampleInitialStates} = await import('./physics.js');
    const {simulateSequence} = await import('./sequence-physics.js');
    const {blueSequence,songSequence} = await import('./sequence.js');
    const {DARK_BRANCHES,EMISSION_BRANCHES,GREEN_DECAY_RATE} = await import('./branching.js');
    const {checkBlueBranches} = await import('./tests/blue-branch-checks.mjs');
    const {checkSequenceBranching} = await import('./tests/sequence-branching.js');
    async function shader(page, selector) {
      const response = await fetch(page);
      if (!response.ok) throw new Error(page + ' ' + response.status);
      return new DOMParser().parseFromString(await response.text(),'text/html').querySelector(selector).textContent;
    }
    const mot = await createGpuSimulation(await shader('index.html','#mot-compute'));
    const sequence = await createSequenceGpu(await shader('sequence.html','#sequence-compute'));
    if (!mot || !sequence) throw new Error('测试需要真实的 WebGPU 设备。');
    const adapter = await navigator.gpu.requestAdapter();
    const adapterInfo = {vendor:adapter.info.vendor,architecture:adapter.info.architecture};
    function ratio(powerOblique, powerHorizontal, gamma, wavelength) {
      // 零场取 +Y；四束斜光的 π 权重各为 1/2，两束水平光各激发一个圆偏振分量。
      const isat = Math.PI*C.h*C.c*gamma / (3*wavelength**3);
      const unit = .002/(Math.PI*.006**2*isat);
      const circular = .5*(powerOblique+powerHorizontal)*unit;
      const pi = powerOblique*unit;
      return 2*circular/(1+circular) + pi/(1+pi);
    }
    function diff(a,b) {
      if (a.length !== b.length) throw new Error('观测数组长度不一致。');
      return a.reduce((max,v,i)=>Math.max(max,Math.abs(v-b[i])),0);
    }
    const max = a => a.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
    const engine = 'rate-equations';
    const dark = {n:1,seed:399174,gravity:false,recoil:false,waistMM:6,greenWaistMM:6,engine};
    const center = {initialStates:new Float64Array(6)};
    const oblique = .3, horizontal = 31, greenOblique = .09, greenHorizontal = .035;
    const blueRatio = ratio(oblique,horizontal,C.gamma,C.wavelength);
    const greenRatio = ratio(greenOblique,greenHorizontal,GREEN_DECAY_RATE,555.8e-9);
    const monoExpected = C.gamma*blueRatio/(1+blueRatio);
    const sharedGround = 1/(1+blueRatio+greenRatio);
    const blueExpected = C.gamma*blueRatio*sharedGround;
    const greenExpected = GREEN_DECAY_RATE*greenRatio*sharedGround;
    const branchExpected = blueExpected*(DARK_BRANCHES.blueP0+DARK_BRANCHES.blueP2)+greenExpected*DARK_BRANCHES.greenP0;
    try {
      const staticConfig = {...dark,durationMS:.02,dtUS:1,detuningMHz:0,mainCurrentA:0,
        powersMW:[oblique,oblique,oblique,oblique,horizontal,horizontal]};
      const config = {...songSequence(),loadMS:.15,handoffMS:.05,greenMS:.05,compressMS:.05,
        loadGradient:0,blueDetuningMHz:0,shieldingMHz:0,blueObliqueMW:oblique,blueHorizontalMW:horizontal,
        greenObliqueMW:greenOblique,greenHorizontalMW:greenHorizontal};
      const blueOnly = {...blueSequence(),loadMS:config.loadMS,holdMS:.05,loadGradient:0,
        blueDetuningMHz:0,blueObliqueMW:oblique,blueHorizontalMW:horizontal};
      const measured = {};
      for (const backend of ['CPU','WebGPU']) {
        const runMot = backend === 'CPU' ? simulate : mot.run;
        const runSequence = backend === 'CPU' ? simulateSequence : sequence.run;
        const steady = await runMot(staticConfig, {...center,frameCount:3});
        const mono = await runSequence(dark,blueOnly,center);
        const two = await runSequence(dark,config,center);
        measured[backend] = {
          mono:steady.framePhotons.at(-1)/(staticConfig.durationMS*.001*EMISSION_BRANCHES.blue399*monoExpected),
          blueSequence:mono.blueRates[0]/monoExpected, darkGreen:mono.greenRates[0],
          blue:two.blueRates[0]/blueExpected, green:two.greenRates[0]/greenExpected,
          branch:two.metrics[0].branchLossRate/branchExpected, loadingBranch:two.loadBranchLossRate/branchExpected,
        };
      }
      const moving = {engine,n:31,seed:421,sourceDistanceMM:.8,sourceSpeed:.7,sourceSpread:.08,
        sourceRadiusMM:.1,sourceTempMK:.001,recoil:false,gravity:true,mainAxis:'z',biasCurrentA:[.07,-.13,.15]};
      const samples = {initialStates:sampleInitialStates(moving),observeVelocity:true};
      const asymmetric = {...moving,durationMS:.3,dtUS:1,powersMW:[0,11,8,3,12,6]};
      const staticGPU = await mot.run(asymmetric,samples), staticCPU = simulate(asymmetric,samples);
      const twoGPU = await sequence.run(moving,config,samples), twoCPU = simulateSequence(moving,config,samples);
      const dynamics = {staticPosition:diff(staticGPU.frames,staticCPU.frames),
        staticVelocity:diff(staticGPU.finalVelocities,staticCPU.finalVelocities),
        framesPhotons:diff(staticGPU.framePhotons,staticCPU.framePhotons)/max(staticCPU.framePhotons),
        sequencePosition:diff(twoGPU.positionsM,twoCPU.positionsM),sequenceVelocity:diff(twoGPU.velocitiesMS,twoCPU.velocitiesMS),
        blue:diff(twoGPU.blueRates,twoCPU.blueRates)/max(twoCPU.blueRates),
        green:diff(twoGPU.greenRates,twoCPU.greenRates)/max(twoCPU.greenRates)};
      const n = 2048, observeAtMS = .005, dt = observeAtMS*.001;
      const initialStates = new Float64Array(6*n);
      const greenOnly = {...config,blueEnabled:false};
      const recoilRatios = {};
      const blueRecoil = C.h/(C.mass*C.wavelength), greenRecoil = C.h/(C.mass*555.8e-9);
      // 平衡光场中，吸收与自发发射各贡献一个反冲能量。
      for (const [label,pulse,blueRate,greenRate] of [
        ['green',greenOnly,0,GREEN_DECAY_RATE*greenRatio/(1+greenRatio)],
        ['two-color',config,blueExpected,greenExpected],
      ]) {
        const run = await sequence.run({...dark,n,recoil:true},pulse,{initialStates,observeAtMS,metricsOnly:true});
        const frame = run.timesMS.indexOf(observeAtMS);
        const expectedUK = 2*C.mass*dt*(blueRecoil**2*blueRate+greenRecoil**2*greenRate)*1e6/(3*C.kB);
        recoilRatios[label] = run.metrics[frame].temperatureUK/expectedUK;
      }
      const branches = {};
      for (const model of ['lightweight',engine]) {
        branches[model] = {blue:await checkBlueBranches(mot.run,model),
          sequence:await checkSequenceBranching(sequence,model)};
      }
      return {adapterInfo,measured,dynamics,recoilRatios,branches};
    } finally {mot.destroy(); sequence.destroy();}
  });
  console.log(JSON.stringify(evidence,null,2));
  for (const ratios of Object.values(evidence.measured)) {
    for (const [name,ratio] of Object.entries(ratios))
      assert.ok(Math.abs(ratio - (name === 'darkGreen' ? 0 : 1)) < 3e-6,name + ' ' + ratio);
  }
  const d = evidence.dynamics;
  assert.ok(d.staticPosition < 1e-6 && d.staticVelocity < .001 && d.framesPhotons < .0001);
  assert.ok(d.sequencePosition < 1e-6 && d.sequenceVelocity < .001 && d.blue < .002 && d.green < .008);
  for (const ratio of Object.values(evidence.recoilRatios)) assert.ok(Math.abs(ratio-1) < .08);
} finally {await browser.close();}

const cpuBrowser = await chromium.launch({channel:'chrome',chromiumSandbox:true,args:[...args,'--disable-features=WebGPUService']});
try {
  const page = await cpuBrowser.newPage();
  await page.goto(new URL('index.html',base).href, {waitUntil:'domcontentloaded'});
  const backends = await page.evaluate(async () => {
    if (await navigator.gpu?.requestAdapter()) throw new Error('CPU 测试需要关闭 WebGPU。');
    const {blueSequence} = await import('./sequence.js');
    const response = await fetch('sequence.html');
    if (!response.ok) throw new Error('时序测试页面读取失败。');
    const html = new DOMParser().parseFromString(await response.text(),'text/html');
    const params = {n:1,engine:'rate-equations',durationMS:.1};
    async function workerRun(path,message) {
      const worker = new Worker(path,{type:'module'});
      try {
        const done = new Promise((resolve,reject) => {
          worker.onerror = event => reject(new Error(event.message));
          worker.onmessage = ({data}) => {
            if (data.error) reject(new Error(data.error));
            if (data.result) resolve(data.result);
          };
        });
        worker.postMessage({id:1,params,...message});
        return await done;
      } finally {worker.terminate();}
    }
    const mot = await workerRun('./sim-worker.js',{shader:document.querySelector('#mot-compute').textContent});
    const sequence = await workerRun('./sequence-worker.js',{shader:html.querySelector('#sequence-compute').textContent,
      config:{...blueSequence(),loadMS:.1,holdMS:.02}});
    return [mot.summary.backend,sequence.backend];
  });
  assert.deepEqual(backends,['CPU','CPU']);
  console.log('关闭 WebGPU 后，两个网页的 Worker 均完成 CPU 积分。');
} finally {await cpuBrowser.close();}
