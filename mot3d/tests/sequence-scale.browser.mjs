import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const url = process.argv[2] ?? 'http://127.0.0.1:4174/mot3d/sequence.html';
const runtime = fileURLToPath(new URL('./.runtime/sequence-scale/', import.meta.url));
await mkdir(runtime, {recursive:true});
process.env.TMPDIR = process.env.TMP = process.env.TEMP = runtime;
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const gpuFlags = process.platform === 'darwin' ? ['--enable-gpu', '--use-angle=metal'] : ['--enable-gpu'];

function observeRuns() {
  const probe = window.sequenceScaleTest = {jobs:[], completions:[], terminated:[], result:null};
  const post = Worker.prototype.postMessage;
  const terminate = Worker.prototype.terminate;
  const ids = new WeakMap();
  Worker.prototype.postMessage = function (...args) {
    const request = args[0];
    if (request.config && request.params) {
      if (!ids.has(this)) {
        this.addEventListener('message', ({data}) => {
          if (!data.result) return;
          probe.result = data.result;
          probe.completions.push({id:data.id, n:data.result.n, backend:data.result.backend});
        });
      }
      ids.set(this, request.id);
      probe.jobs.push({id:request.id, n:request.params.n});
    }
    return post.apply(this,args);
  };
  Worker.prototype.terminate = function (...args) {
    if (ids.has(this)) probe.terminated.push(ids.get(this));
    return terminate.apply(this,args);
  };
}

function waitForResult(page, after = -1) {
  return page.waitForFunction(id => {
    const test = window.sequenceScaleTest, job = test.jobs.at(-1);
    if (document.querySelector('#sequence-retry')?.hidden === false)
      throw new Error(document.querySelector('#sequence-compute-status').textContent);
    return job?.id > id && test.completions.at(-1)?.id === job.id &&
      !document.querySelector('[data-action=play]').disabled;
  }, after, {timeout:180000});
}

async function scientificChecks() {
  const {createSequenceGpu} = await import(new URL('sequence-gpu.js',location.href));
  const {simulateSequence} = await import(new URL('sequence-physics.js',location.href));
  const {sampleInitialStates, CONSTANTS:C} = await import(new URL('physics.js',location.href));
  const {songSequence} = await import(new URL('sequence.js',location.href));
  const shader = document.querySelector('#sequence-compute').textContent;
  const gpu = await createSequenceGpu(shader);
  if (!gpu) throw new Error('真实 WebGPU 适配器不可用');
  const maxDifference = (a,b) => a.reduce((max,x,i)=>Math.max(max,Math.abs(x-b[i])),0);
  const preset = songSequence();
  try {
    const nearTrap = {n:37, seed:421, sourceDistanceMM:.3, sourceSpeed:.1, sourceSpread:.02,
      sourceRadiusMM:.1, sourceTempMK:.001, gravity:true, recoil:true};
    const initial = sampleInitialStates(nearTrap);
    const short = {...preset,loadMS:1,handoffMS:.2,greenMS:.8,compressMS:2};
    const dark = await gpu.run(nearTrap, {...short,blueEnabled:false,greenEnabled:false}, {initialStates:initial});
    let gravityErrorM = 0;
    for (let f=0; f<dark.frameCount; f++) {
      const t = dark.timesMS[f]*.001;
      for (let i=0; i<nearTrap.n; i++) {
        for (let axis=0; axis<3; axis++) {
          const reference = initial[6*i+axis] + initial[6*i+axis+3]*t - (axis === 2 ? .5*C.gravity*t*t : 0);
          const actual = dark.positionsM[3*(f*dark.n+i)+axis];
          gravityErrorM = Math.max(gravityErrorM,Math.abs(actual-reference));
        }
      }
    }
    const opticsInput = {...nearTrap,recoil:false,mainAxis:'z',biasCurrentA:[.07,-.13,.15],greenWaistMM:4};
    const opticsConfig = {...short,powerRamp:'geometric',finalObliqueUW:57};
    const reference = simulateSequence(opticsInput,opticsConfig,{initialStates:initial});
    const optics = await gpu.run(opticsInput,opticsConfig,{initialStates:initial});
    const stochasticInput = {n:384, seed:399174, recoil:true};
    const beginCPU = performance.now();
    const cpu = simulateSequence(stochasticInput,preset);
    const cpuMS = performance.now()-beginCPU;
    const beginGPU = performance.now();
    const run = await gpu.run(stochasticInput,preset);
    const gpuMS = performance.now()-beginGPU;
    const repeat = await gpu.run(stochasticInput,preset);
    // 均匀弱光短脉冲中，每次散射的吸收与自发发射各贡献一个反冲能量。
    const powerMW=.02,dt=.1e-3;
    const recoilParams={n:4096,seed:5336,recoil:true,gravity:false};
    const pulse={...preset,loadMS:.1,handoffMS:.01,greenMS:.01,compressMS:.01,loadGradient:0,
      blueDetuningMHz:0,greenEnabled:false,blueHorizontalMW:powerMW,blueObliqueMW:powerMW};
    const diffusion=await gpu.run(recoilParams,pulse,{initialStates:new Float64Array(6*recoilParams.n)});
    const isat=Math.PI*C.h*C.c*C.gamma/(3*C.wavelength**3);
    const saturation=6*2*powerMW*.001/(Math.PI*(.006**2)*isat);
    const rate=.5*C.gamma*saturation/(1+saturation);
    const recoil=C.h/(C.mass*C.wavelength);
    const predictedUK=2*C.mass*recoil**2*rate*dt*1e6/(3*C.kB);
    const observedUK=diffusion.metrics[diffusion.timesMS.indexOf(pulse.loadMS)].temperatureUK;
    const stats = r => ({...r.summary,temperatureUK:r.metrics.at(-1).temperatureUK,
      radiusMM:r.metrics.at(-1).rmsRadiusMM});
    return {dark:{...dark.summary,gravityErrorM,darkRates:dark.blueRates.every(x=>x===0)&&dark.greenRates.every(x=>x===0)},
      optics:{counts:optics.summary,reference:reference.summary,positionM:maxDifference(optics.positionsM,reference.positionsM),
        blueFraction:maxDifference(optics.blueRates,reference.blueRates)/reference.blueRates.reduce((m,v)=>Math.max(m,v),0),
        greenFraction:maxDifference(optics.greenRates,reference.greenRates)/reference.greenRates.reduce((m,v)=>Math.max(m,v),0)},
      recoilTemperatureRatio:observedUK/predictedUK,
      cpu:stats(cpu),gpu:stats(run),cpuMS,gpuMS,n:stochasticInput.n,
      repeatable:maxDifference(run.positionsM,repeat.positionsM)===0 && maxDifference(run.greenRates,repeat.greenRates)===0};
  } finally {gpu.destroy();}
}

function validatePhysics(science) {
  const {dark,optics,cpu,gpu,n} = science;
  assert.deepEqual([dark.N0,dark.N1,dark.N2],[37,37,37]);
  assert.ok(dark.darkRates && dark.gravityErrorM<1e-7,JSON.stringify(dark));
  assert.deepEqual(optics.counts,optics.reference);
  assert.ok(optics.positionM<2e-6 && optics.blueFraction<.002 && optics.greenFraction<.008,JSON.stringify(optics));
  for (const key of ['N0','N1','N2']) {
    const mean = (cpu[key]+gpu[key])/(2*n);
    const sigma = Math.sqrt(2*mean*(1-mean)/n);
    assert.ok(Math.abs(gpu[key]-cpu[key])/n < 4.5*sigma,`CPU/GPU capture mismatch at ${key}`);
  }
  assert.ok(science.repeatable);
  assert.ok(Math.abs(science.recoilTemperatureRatio-1)<.08,JSON.stringify(science.recoilTemperatureRatio));
  assert.ok(gpu.temperatureUK>0 && gpu.radiusMM>0);
}

async function summarized(page) {
  return page.evaluate(() => {
    const r=window.sequenceScaleTest.result;
    const replayCount=r.positionsM.length/(3*r.frameCount);
    const bytes=[r.positionsM,r.alive,r.trapped,r.blueRates,r.greenRates,r.timesMS].reduce((sum,v)=>sum+v.byteLength,0);
    return {backend:r.backend,n:r.n,elapsedMS:r.elapsedMS,counts:r.summary,frames:r.frameCount,
      replayCount,replayMiB:bytes/1048576,status:document.querySelector('#sequence-compute-status').textContent};
  });
}

async function checkFinalCloud(page) {
  await page.evaluate(async()=>{
    const three=await import(new URL('../anatomy-demo/vendor/three-r160.module.js',location.href));
    const draw=three.Points.prototype.onBeforeRender;
    three.Points.prototype.onBeforeRender=function(...args) {
      if(this.name==='sequence-atoms') window.sequenceScaleTest.drawn=this.geometry.drawRange.count;
      return draw.apply(this,args);
    };
  });
  const clock=page.locator('.seq-time-input input');
  const end=await clock.getAttribute('max');
  await clock.fill(end);
  await clock.press('Tab');
  await page.locator('[data-seq-view=cloud]').click();
  await page.waitForFunction(()=>{
    const {result:r,drawn}=window.sequenceScaleTest;
    const stride=r.alive.length/r.frameCount;
    let represented=0;
    for(const alive of r.alive.subarray((r.frameCount-1)*stride)) represented+=alive;
    return drawn===represented && represented>0;
  });
  return page.evaluate(()=>window.sequenceScaleTest.drawn);
}

async function checkPopulation(page, high) {
  const tab=name=>page.getByRole('tab',{name});
  await tab('原子样本').click();
  await page.locator('[data-checkpoint="3"]').click();
  const read=()=>page.evaluate(()=>({
    population:['#seq-atoms-n0','#seq-atoms-n1','#seq-atoms-n2','#seq-population']
      .map(id=>Number(document.querySelector(id).dataset.atoms)),
    counts:['#seq-n0','#seq-n1','#seq-n2','#seq-count']
      .map(id=>Number(document.querySelector(id).textContent.replaceAll(',',''))),
    jobs:window.sequenceScaleTest.jobs.length,
  }));
  const full=await read();
  const {N0,N1,N2}=high.counts;
  assert.deepEqual(full.counts,[N0,N1,N2,N2]);
  const [loadStage, handoffStage, receiveStage, compressStage] = await page.evaluate(() => window.sequenceScaleTest.result.stages);
  const rate=1e9*N0/high.n, alpha=.53, beta=1.7e-9;
  const lambda=Math.sqrt(alpha**2+4*beta*rate), exponential=Math.exp(-loadStage.durationMS*lambda/1000);
  const loading=2*rate*(1-exponential)/(lambda+alpha+(lambda-alpha)*exponential);
  assert.ok(Math.abs(full.population[0]-loading)<.001);
  assert.equal(full.population[3],full.population[2]);
  const compressMS = compressStage.durationMS;
  const expectedFinal = full.population[1] * N2/N1 * Math.exp(-.012 * compressMS/1000);
  assert.ok(Math.abs(full.population[2]-expectedFinal)<.001);
  await page.locator('.sequence-loading-controls > summary').click();
  const form = page.locator('#seq-loading-inputs');
  const handoffBeta = form.locator('[name=handoffBeta]');
  assert.equal(await handoffBeta.getAttribute('placeholder'),'1e-9');
  await handoffBeta.fill('0');
  const oneBody = await read();
  const afterHandoff = loading * Math.exp(-.21*handoffStage.durationMS/1000);
  assert.ok(Math.abs(oneBody.population[1] - afterHandoff * N1/N0 * Math.exp(-.012*receiveStage.durationMS/1000)) < .001);
  assert.ok(oneBody.population[1] > full.population[1]);
  await handoffBeta.fill('');
  assert.deepEqual(await read(),full);
  const compressAlpha = form.locator('[name=compressAlpha]');
  await compressAlpha.fill('2');
  const fasterDecay = await read();
  assert.deepEqual(fasterDecay.counts,full.counts);
  assert.equal(fasterDecay.population[1],full.population[1]);
  assert.ok(Math.abs(fasterDecay.population[2]/full.population[2] - Math.exp(-(2-.012)*compressMS/1000)) < 1e-10);
  assert.equal(fasterDecay.jobs,full.jobs);
  await compressAlpha.fill('');
  const flux=page.locator('#seq-loading-inputs [name=flux]');
  const original=await flux.inputValue();
  await flux.fill('0');
  const dark=await read();
  assert.deepEqual(dark.population,[0,0,0,0]);
  assert.deepEqual(dark.counts,full.counts);
  assert.equal(dark.jobs,full.jobs);
  await tab('相机成像').click();
  await page.waitForFunction(()=>document.querySelector('#seq-imaging-total').dataset.value==='0');
  await tab('原子样本').click();
  await flux.fill(original);
  assert.deepEqual(await read(),full);
  await tab('相机成像').click();
  await page.waitForFunction(()=>Number(document.querySelector('#seq-imaging-total').dataset.value)>0);
  await tab('原子样本').click();
  const compressBeta = form.locator('[name=compressBeta]');
  await compressBeta.fill('1e-8');
  const withPairLoss = await read();
  assert.ok(withPairLoss.population[2] < full.population[2]);
  const download = page.waitForEvent('download');
  await page.locator('#sequence-export').click();
  const path = await (await download).path();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.loading, {flux:1e9, compressBeta:1e-8});
  assert.equal(saved.estimatedAtoms.N2, withPairLoss.population[2]);
  await compressBeta.fill('');
  const previousJob = await page.evaluate(() => window.sequenceScaleTest.jobs.at(-1).id);
  await page.locator('#sequence-file').setInputFiles(path);
  await waitForResult(page, previousJob);
  assert.equal(await compressBeta.inputValue(), '1e-8');
  assert.deepEqual((await read()).population.slice(0,3), withPairLoss.population.slice(0,3));
  await compressBeta.fill('');
  return full.population;
}

async function checkPage(useGPU) {
  const args=useGPU?gpuFlags:[...gpuFlags,'--disable-features=WebGPUService'];
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,args});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    await page.addInitScript(observeRuns);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    const adapter=await page.evaluate(async()=>{
      const gpu=await navigator.gpu?.requestAdapter();
      return gpu?{vendor:gpu.info.vendor,architecture:gpu.info.architecture,description:gpu.info.description,
        fallback:gpu.info.isFallbackAdapter}:null;
    });
    assert.equal(Boolean(adapter), useGPU, JSON.stringify(adapter));
    if(useGPU) assert.ok(!adapter.fallback && !/swiftshader|llvmpipe|lavapipe/i.test(JSON.stringify(adapter)));
    await waitForResult(page);
    const initial=await summarized(page);
    assert.equal(initial.backend,useGPU?'WebGPU':'CPU',initial.status);
    assert.equal(initial.n,useGPU?16384:1024);
    console.log(JSON.stringify({adapter,initial}));
    if(!useGPU) return;

    const science=await page.evaluate(scientificChecks);
    console.log(JSON.stringify({science}));
    validatePhysics(science);
    const select=page.locator('#sequence-sample-count');
    await page.getByRole('tab',{name:'原子样本'}).click();
    const tiers=await select.locator('option').evaluateAll(options=>options.map(o=>Number(o.value)).filter(Number.isFinite));
    const max=Math.max(...tiers),small=Math.min(...tiers.filter(n=>n>0));
    assert.ok(max >= 4096);
    const lastId=()=>page.evaluate(()=>window.sequenceScaleTest.jobs.at(-1).id);
    let previous=await lastId();
    if(Number(await select.inputValue())!==max){
      await select.selectOption(String(max));
      await waitForResult(page,previous);
    }
    const high=await summarized(page);
    assert.equal(high.n,max);
    assert.ok(high.replayCount>0 && high.replayCount<=max);
    assert.ok(high.counts.N0>=high.counts.N1 && high.counts.N1>=high.counts.N2 && high.counts.N2>0);
    const drawn=await checkFinalCloud(page), populations=await checkPopulation(page,high);
    console.log(JSON.stringify({high,drawn,populations}));
    previous=await lastId();
    await page.locator('#sequence-apparatus > summary').click();
    await page.locator('#sequence-inputs [name=seed]').fill('5336');
    await page.waitForFunction(id=>window.sequenceScaleTest.jobs.at(-1).id>id,previous);
    const interrupted=await lastId();
    await select.selectOption(String(small));
    await waitForResult(page,interrupted);
    assert.equal((await summarized(page)).n,small);
    assert.ok(await page.evaluate(id=>window.sequenceScaleTest.terminated.includes(id) &&
      !window.sequenceScaleTest.completions.some(c=>c.id===id),interrupted));
    await page.setViewportSize({width:390,height:840});
    await page.reload();
    await waitForResult(page);
    const compact=await summarized(page);
    assert.equal(compact.n,4096);
    console.log(JSON.stringify({compact}));
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
}

await checkPage(true);
await checkPage(false);
