import { DEFAULTS } from './physics.js';
import { DEFAULT_FLUX } from './fluorescence.js';
import { IMAGING_DEFAULTS } from './sequence-imaging.js';
import { compileSequence, sequenceFieldsFor } from './sequence.js';
import { sequenceLossStages } from './sequence-population.js';

const numeric = (id, label, unit, min, max, scale = 1) => ({id, label, unit, min, max, scale, kind:'number'});
const choice = (id, label, options) => ({id, label, unit:'', kind:'choice', choices:options.map(([value, label]) => ({value, label}))});
const gates = [[false,'关闭'],[true,'开启']];
const ramps = [['linear','线性'],['geometric','等比'],['smooth','平滑 S 形']];
const axes = ['X','Y','Z'];
const lenses = [numeric('params.waistMM','399 nm 束腰半径','mm',1,15), numeric('params.greenWaistMM','556 nm 束腰半径','mm',1,15)];
const source = [
  numeric('params.sourceSpeed','冷束纵速均值','m/s',0,100,.1), numeric('params.sourceSpread','冷束纵速标准差','m/s',0,30,.05),
  numeric('params.sourceRadiusMM','冷束初始位置 RMS','mm',0,10,.1), numeric('params.sourceTempMK','冷束横向温度','mK',0,100,.001),
  numeric('params.sourceYawDeg','冷束偏航角','°',-45,45,.5), numeric('params.sourcePitchDeg','冷束俯仰角','°',-45,45,.5),
  numeric('params.sourceOffsetYMM','入射 Y 偏心','mm',-20,20,.25), numeric('params.sourceOffsetZMM','入射 Z 偏心','mm',-20,20,.25),
  numeric('params.sourceDistanceMM','注入面到原点距离','mm',0,100,1),
];
const magnetic = [choice('params.mainAxis','四极场主轴',[['y','Y 轴'],['z','Z 轴']]), ...axes.flatMap((label,i) => [
  numeric('params.biasCurrentA.' + i,label + ' 偏置电流','A',-2,2,.05),
  numeric('params.biasPerAmp.' + i,label + ' 偏置场系数','G/A',0,50,.05),
])];
const camera = [
  choice('imaging.mode','成像模式',[['fluorescence','荧光成像'],['absorption','吸收成像'],['off','关闭成像']]),
  choice('imaging.axis','观察方向',axes.map(label => [label.toLowerCase(),'沿 ' + label + ' 轴'])),
  choice('imaging.band','荧光波段',[['both','399 + 556 nm'],['399','399 nm'],['556','556 nm']]),
  numeric('imaging.exposureUS','曝光时间','µs',1,1000), numeric('imaging.fovMM','物方视场宽度','mm',1,50),
  numeric('imaging.psfSigmaUM','光学点扩散 σ','µm',0,100), numeric('imaging.detectionEfficiency','荧光总探测效率','',0,1,.001),
  numeric('imaging.probeSaturation','吸收探针强度','I/Iₛₐₜ',.001,.05,.001),
  numeric('imaging.probeEfficiency','吸收探针探测效率','',0,1,.01),
  numeric('imaging.darkElectrons','吸收成像暗场读出偏置','光电子/像素',0,1e6,1),
  numeric('imaging.minDetectableElectrons','吸收成像最低可分辨信号','光电子/像素',.001,1e6,1),
];
const modelSettings = [choice('params.gravity','重力',gates), choice('params.recoil','随机光子反冲',gates),
  numeric('imaging.sampleSigmaUM','样本密度平滑 σ','µm',0,200)];

export function experimentControls(experiment) {
  const {config} = experiment, blueOnly = config.mode === 'blue-only';
  const sequence = Object.entries(sequenceFieldsFor(config)).map(([id,args]) => numeric(id,...args));
  sequence.push(choice('blueEnabled','399 nm 光闸',gates));
  if (!blueOnly) sequence.push(choice('greenEnabled','556 nm 光闸',gates), choice('powerRamp','压缩功率波形',ramps));
  const losses = [numeric('loading.flux','入射原子通量','原子/s',0,1e15,1e6)];
  for (const {id,label} of compileSequence(config).stages) {
    const load = id === 'load';
    losses.push(numeric('loading.' + (load ? 'alpha' : id + 'Alpha'),label + '单体损失 α','s⁻¹',0,1e4,.01),
      numeric('loading.' + (load ? 'beta' : id + 'Beta'),label + '双体损失 β','(原子·s)⁻¹',0,1,1e-9));
  }
  return [['时序',sequence],['光束几何',blueOnly ? [lenses[0]] : lenses],['冷原子束',source],['磁场',magnetic],
    ['通量与损失',losses],['相机成像',camera],['模型设置',modelSettings]].flatMap(([group,controls]) => controls.map(control => ({...control, group})));
}

// 表单留空时继承当前光色的文献系数。未被选中试探的空字段继续随光色变化。
export function readControl(experiment, id) {
  const [section, key, index] = id.split('.');
  if (!key) return experiment.config[id];
  if (section === 'params') {
    const params = experiment.params ?? {};
    const value = params[key] ?? (key === 'greenWaistMM' ? params.waistMM ?? DEFAULTS.waistMM : DEFAULTS[key]);
    return index === undefined ? value : value[index];
  }
  if (section === 'imaging') return experiment.imaging?.[key] ?? IMAGING_DEFAULTS[key];
  if (section !== 'loading') throw new RangeError('未知控制量：' + id);
  const stored = experiment.loading?.[key];
  if (stored != null) return stored;
  if (key === 'flux') return experiment.params?.incidentFlux ?? DEFAULT_FLUX;
  const program = compileSequence(experiment.config);
  for (const stage of sequenceLossStages(program)) {
    if (key === (stage.id === 'load' ? 'alpha' : stage.id + 'Alpha')) return stage.alpha;
    if (key === (stage.id === 'load' ? 'beta' : stage.id + 'Beta')) return stage.beta;
  }
  throw new RangeError('当前时序没有损失系数：' + key);
}

export function setControl(experiment, id, value) {
  const [section, key, index] = id.split('.');
  if (!key) return {...experiment, config:{...experiment.config, [id]:value}};
  const settings = {...experiment[section]};
  if (index === undefined) settings[key] = value;
  else {
    settings[key] = [...(settings[key] ?? DEFAULTS[key])];
    settings[key][Number(index)] = value;
  }
  return {...experiment, [section]:settings};
}
