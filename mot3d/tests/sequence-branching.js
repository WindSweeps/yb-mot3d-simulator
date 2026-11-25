import { BLUE_TRANSITION, CONSTANTS as C } from '../physics.js';
import { DARK_BRANCHES, branchDraws } from '../branching.js';
import { GREEN_TRANSITION, simulateSequence } from '../sequence-physics.js';
import { blueSequence, songSequence } from '../sequence.js';

// 零场、零速度时，六束等功率共振光给出恒定散射率，暗态跃迁时刻可直接计算。
function resonantRate(powerMW, line, waistM, engine) {
  const wavelength = 2*Math.PI/line.k;
  const saturationIntensity = Math.PI*C.h*C.c*line.gamma/(3*wavelength**3);
  const saturation = 6*2*powerMW*.001/(Math.PI*waistM**2*saturationIntensity);
  const factor = engine === 'rate-equations' ? 2/3 : 1;
  return line.gamma*.5*saturation/(1+factor*saturation);
}

function targetedSample(rates, expectedChannel) {
  const total = rates.blueP0+rates.blueP2+rates.greenP0;
  // 选取真实随机流中在观察窗内发生跃迁的样本，覆盖包括微弱绿光通道在内的全部分支。
  for (let seed=0; seed<4_000_000; seed++) {
    const {threshold,choice} = branchDraws(seed,0);
    const timeMS = 1000*threshold/total, mark = choice*total;
    const channel = mark<rates.greenP0 ? 'greenP0' : mark<rates.greenP0+rates.blueP0 ? 'blueP0' : 'blueP2';
    if (channel === expectedChannel && timeMS>1 && timeMS<4 &&
        Math.abs(timeMS*10-Math.round(timeMS*10))>.1) return {seed,timeMS};
  }
  throw new Error('给定的物理分支在种子搜索范围内没有产生窗内事件。');
}

async function checkBoundaryEvent(gpu, engine) {
  // 水平对射共振光在此速度下给出相等的两束散射率，原子沿光轴匀速运动。
  const v=1, powerMW=10, waist=.006, seed=238330;
  const saturationIntensity = Math.PI*C.h*C.c*C.gamma/(3*C.wavelength**3);
  const saturation = 4*powerMW*.001/(Math.PI*waist**2*saturationIntensity);
  const detuning = 2*BLUE_TRANSITION.k*v/C.gamma;
  // 两束水平光各驱动一个圆偏振分量，各有 Wq/Γ = s/[4(1+δ²)]。
  const factor = engine === 'rate-equations' ? .75 : 1;
  const rate = C.gamma*.5*saturation/(1+factor*saturation+detuning**2);
  const opticalTime = branchDraws(seed,0).threshold/(rate*(DARK_BRANCHES.blueP0+DARK_BRANCHES.blueP2));
  const input = {n:1,seed,engine,dtUS:5,recoil:false,gravity:false,waistMM:6};
  const config = {...blueSequence(),loadMS:.1,holdMS:.01,blueHorizontalMW:powerMW,
    blueObliqueMW:0,blueDetuningMHz:0,loadGradient:0};
  for (const distanceM of [1e-6,4e-6]) {
    const y = .15-distanceM;
    const options = {initialStates:[0,y,0,0,v,0]};
    const results = [simulateSequence(input,config,options),await gpu.run(input,config,options)];
    for (const result of results) {
      const count = Object.values(result.metrics.at(-1).darkBranches).reduce((sum,n)=>sum+n,0);
      const opticalFirst = opticalTime<distanceM/v;
      if (count!==Number(opticalFirst)) throw new Error('计算边界和暗态跃迁的先后次序有误。');
      if (opticalFirst && Math.abs(result.positionsM.at(-2)-(y+v*opticalTime))>3e-8)
        throw new Error('进入暗态时的位置与解析弹道不符。');
    }
  }
}

export async function checkSequenceBranching(gpu, engine = 'lightweight') {
  await checkBoundaryEvent(gpu,engine);
  const cases = [
    {blueMW:10,greenMW:0,channel:'blueP0'},
    {blueMW:10,greenMW:0,channel:'blueP2'},
    {blueMW:0,greenMW:1,channel:'greenP0'},
    {blueMW:10,greenMW:1,channel:'blueP0'},
    {blueMW:.02,greenMW:1,channel:'greenP0'},
  ];
  const report = [];
  for (const {blueMW,greenMW,channel} of cases) {
    const config = greenMW ? {...songSequence(),loadMS:5,handoffMS:.1,greenMS:.1,compressMS:.1} :
      {...blueSequence(),loadMS:5,holdMS:1};
    Object.assign(config,{blueDetuningMHz:0,shieldingMHz:0,loadGradient:0,
      blueObliqueMW:blueMW,blueHorizontalMW:blueMW,greenObliqueMW:greenMW,greenHorizontalMW:greenMW});
    const blue = resonantRate(blueMW,BLUE_TRANSITION,.006,engine), green = resonantRate(greenMW,GREEN_TRANSITION,.006,engine);
    const fb = blue/BLUE_TRANSITION.gamma, fg = green/GREEN_TRANSITION.gamma;
    const rb = blue*(1-fg)/(1-fb*fg), rg = green*(1-fb)/(1-fb*fg);
    const rates = {blueP0:rb*DARK_BRANCHES.blueP0,blueP2:rb*DARK_BRANCHES.blueP2,greenP0:rg*DARK_BRANCHES.greenP0};
    const totalRate = rates.blueP0+rates.blueP2+rates.greenP0;
    const {seed,timeMS} = targetedSample(rates,channel);
    const input = {n:1,seed,engine,dtUS:5,recoil:false,gravity:false,waistMM:6,greenWaistMM:6};
    const options = {initialStates:new Float64Array(6)};
    const reference = simulateSequence(input,config,options);
    const result = await gpu.run(input,config,options);
    for (const run of [reference,result]) {
      for (let f=0; f<run.frameCount; f++) {
        const dark = run.timesMS[f]>=timeMS;
        const counts = run.metrics[f].darkBranches;
        const measuredRate = run.metrics[f].branchLossRate;
        if (Math.abs(measuredRate-(dark?0:totalRate))>totalRate*2e-6)
          throw new Error('阱内样本的平均暗态跃迁速率与解析结果不符。');
        for (const name of Object.keys(rates)) {
          if (counts[name]!==Number(dark && name===channel)) throw new Error(name+' 暗态计数与解析结果不符。');
        }
        if (run.alive[f]!==Number(!dark) || run.trapped[f]!==Number(!dark) ||
            (dark && (run.blueRates[f]!==0 || run.greenRates[f]!==0))) throw new Error('进入暗态后的光学读数异常。');
      }
    }
    report.push({blueMW,greenMW,channel,seed,analyticTimeMS:timeMS,
      firstDarkFrameMS:result.timesMS[result.alive.indexOf(0)]});
  }
  return report;
}
