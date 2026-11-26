import { CASCADE_RATES, YB_REPUMPS } from './yb-atom.js';

export const YB_SEQUENCE_FIELDS = Object.freeze({
  atomStepUS:['镱引擎最大时间步长','µs',.1,100,50],
  p2Branches:['首次暗态分裂的 ³P₂ 子轨迹数','',1,8,1],
  leakP0:['¹P₁ → ³P₀ 有效速率','s⁻¹',0,1000,CASCADE_RATES.p0],
  leakP1:['¹P₁ → ³P₁ 有效速率','s⁻¹',0,1000,CASCADE_RATES.p1],
  leakP2:['¹P₁ → ³P₂ 有效速率','s⁻¹',0,1000,CASCADE_RATES.p2],
  repumpLeadMS:['重泵浦开启距时序结束','ms',.001,60000,10],
  repumpDurationMS:['重泵浦持续时间','ms',.001,60000,10],
  repumpWaistMM:['重泵浦束腰半径','mm',.1,100,6],
  ...Object.fromEntries(YB_REPUMPS.map(({key,label}) => [key,[label+' 循环速率','s⁻¹',0,100000,0]])),
  trapLeadMS:['光阱开启距时序结束','ms',.001,60000,10],
  trapDurationMS:['光阱持续时间','ms',.001,60000,10],
  trapWavelengthNM:['光阱波长','nm',200,2500,1064],
  trapPowerMW:['焦点功率或晶格波腹等效功率','mW',0,10000,0],
  trapWaistUM:['光阱束腰半径','µm',1,100000,50],
  trapPolarizationDeg:['偏振从 +Z 向 +Y 的夹角','°',-180,180,0],
  alphaGround:['¹S₀ 标量极化率','a.u.',-1e5,1e5,null],
  alphaBlue:['¹P₁ 标量极化率','a.u.',-1e5,1e5,null],
  tensorBlue:['¹P₁ 张量极化率','a.u.',-1e5,1e5,null],
  alphaGreen:['³P₁ 标量极化率','a.u.',-1e5,1e5,null],
  tensorGreen:['³P₁ 张量极化率','a.u.',-1e5,1e5,null],
  alphaP0:['³P₀ 标量极化率','a.u.',-1e5,1e5,null],
  alphaP2:['³P₂ 标量极化率','a.u.',-1e5,1e5,null],
  tensorP2:['³P₂ 张量极化率','a.u.',-1e5,1e5,null],
});
export const YB_SEQUENCE_CHOICES = Object.freeze({
  atomLossMode:['暗态计算','reservoir',[['reservoir','跟踪暗态与重泵浦'],['lifetime','连续亮态存活权重']]],
  darkDecay:['暗态自发衰变','on',[['on','计入'],['off','关闭']]],
  trapMode:['光阱类型','off',[['off','关闭'],['gaussian','高斯光偶极阱'],['lattice','一维光晶格']]],
  detuningReference:['光频零点','isotope',[['isotope','所选同位素的 F′ 最大跃迁'],['174Yb','¹⁷⁴Yb 跃迁']]],
});

function pulse(lead, width, duration, name) {
  if (width > lead || lead > duration) {
    if (name) throw new RangeError(name+'须完整位于时序内。');
    return null;
  }
  return {startMS:duration-lead, endMS:duration-(lead-width)};
}

export function compileAtomSettings(config, durationMS) {
  const values = {};
  for (const [key,[label,unit,min,max,defaultValue]] of Object.entries(YB_SEQUENCE_FIELDS)) {
    const value = config[key] ?? defaultValue;
    if (value !== null && (!Number.isFinite(value) || value < min || value > max))
      throw new RangeError(label+'须在 '+min+' 至 '+max+' '+unit+' 之间。');
    values[key] = value;
  }
  if (!Number.isInteger(values.p2Branches)) throw new RangeError('³P₂ 子轨迹数须为整数。');
  for (const [key,[label,defaultValue,choices]] of Object.entries(YB_SEQUENCE_CHOICES)) {
    const value = config[key] ?? defaultValue;
    if (!choices.some(([id]) => id === value)) throw new RangeError(label+'选项无效。');
    values[key] = value;
  }
  const repumpRates = YB_REPUMPS.map(({key}) => values[key]);
  if (values.atomLossMode === 'lifetime' && repumpRates.some(Boolean))
    throw new RangeError('开启重泵浦时须跟踪暗态。');
  const repumpOn = repumpRates.some(Boolean), trapOn = values.trapMode !== 'off' && values.trapPowerMW > 0;
  const repumpWindow = pulse(values.repumpLeadMS,values.repumpDurationMS,durationMS,repumpOn ? '重泵浦脉冲' : null);
  const trapWindow = pulse(values.trapLeadMS,values.trapDurationMS,durationMS,trapOn ? '光阱脉冲' : null);
  const repump = repumpOn ? {...repumpWindow,
    rates:repumpRates, waistM:values.repumpWaistMM*.001} : null;
  let trap = null;
  if (trapOn) {
    for (const key of ['alphaGround','alphaBlue','tensorBlue','alphaGreen','tensorGreen','alphaP0','alphaP2','tensorP2'])
      if (values[key] === null) throw new RangeError('开启光阱须填写 '+YB_SEQUENCE_FIELDS[key][0]+'。');
    trap = {...trapWindow,
      mode:values.trapMode, wavelengthM:values.trapWavelengthNM*1e-9, waistM:values.trapWaistUM*1e-6,
      powerW:values.trapPowerMW*.001, polarization:values.trapPolarizationDeg*Math.PI/180,
      coefficients:{ground:[values.alphaGround,0], blue:[values.alphaBlue,values.tensorBlue],
        green:[values.alphaGreen,values.tensorGreen], p0:[values.alphaP0,0], p2:[values.alphaP2,values.tensorP2]}};
  }
  return {values,repump,trap,repumpWindow,trapWindow,windows:[repump,trap].filter(Boolean)};
}

export function activeAtomPulse(pulse, timeMS) {
  return pulse && timeMS >= pulse.startMS && timeMS < pulse.endMS ? pulse : null;
}
