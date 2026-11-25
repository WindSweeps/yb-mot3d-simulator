import { DEFAULTS, compile, derive } from './physics.js';
import { compileSequence, SEQUENCE_PRESETS } from './sequence.js';
import { mountSequenceEditor } from './sequence-ui.js';
import { mountScene } from './render.js';
import { DEFAULT_FLUX } from './fluorescence.js';
import { sequenceLossStages, sequencePopulation } from './sequence-population.js';
import { cloudReadout, sequenceObservation } from './sequence-observation.js';
import { mountImagingPanel, validateImagingSettings } from './sequence-imaging-view.js';
import { IMAGING_DEFAULTS } from './sequence-imaging.js';
import { mountSequenceDock } from './sequence-dock.js';
import { mountSequenceCurves } from './sequence-curves.js';
import { mountSequenceOptimization } from './sequence-optimization.js';
import { availableEngines, defaultEngine } from './engines.js';
import { mountEnginePanel } from './engine-panel.js';

// 时序与求解器持续更新同一组控件，停靠过程可以移动它们的父节点。
const elements = new Map(Array.from(document.querySelectorAll('[id]'), el => ['#' + el.id, el]));
const $ = selector => elements.get(selector);
const form = $('#sequence-inputs');
const fields = Array.from(form.elements);
const loadingForm = $('#seq-loading-inputs');
const loadingFields = Array.from(loadingForm.querySelectorAll('input'));
const alphaModeField = $('#seq-alpha-mode');
const lossRows = Array.from(loadingForm.querySelectorAll('[data-loss-stage]'));
const checkpointButtons = Array.from(document.querySelectorAll('[data-checkpoint]'));
const formatId = 'yb-mot-sequence-v2';
const blank = '—';
const maxFileBytes = 256000;
const atomFormat = new Intl.NumberFormat('zh-CN', {notation:'compact', maximumSignificantDigits:3});
function scientificCount(value) {
  if (value === 0) return '0';
  const [mantissa, exponent] = value.toExponential(2).split('e');
  const power = Array.from(String(Number(exponent)), digit => digit === '-' ? '⁻' : '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]).join('');
  return mantissa + ' × 10' + power;
}
const computeShader = $('#sequence-compute').textContent;
const requestedPreset = new URLSearchParams(location.search).get('preset');
const initialPreset = SEQUENCE_PRESETS.find(preset => preset.id === requestedPreset) ?? SEQUENCE_PRESETS[0];
let params = await initialInputs(), program = compileSequence(initialPreset.config), timeMS = 0;
let simulation = simulationType(program);
let geometry = derive(params);
let loading = { flux:params.incidentFlux ?? DEFAULT_FLUX };
const loadingByMode = new Map();
const engineBySimulation = new Map();
let worker = null, timer = 0, job = 0, result = null, scene = null, population = null;
let editValid = true, suspended = false, started = 0;
let observeAtMS, importedObserveAtMS;
let cameraSettings = IMAGING_DEFAULTS;

async function initialInputs() {
  let previous;
  try { previous = JSON.parse(sessionStorage.getItem('yb-mot3d-sequence-inputs')) || {}; }
  catch { previous = {}; }
  const base = { ...DEFAULTS, ...previous };
  // 时序页单独设置采样数；实验文件导入时使用文件中明确保存的数量。
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  const n = adapter ? (matchMedia('(max-width: 800px)').matches ? 4096 : 16384) : 1024;
  return { ...base, engine:base.engine ?? defaultEngine, n, greenWaistMM: base.waistMM };
}

function fillLoadingInputs() {
  alphaModeField.value = loading.alphaMode ?? 'background';
  for (const field of loadingFields) field.value = loading[field.name] ?? '';
}

function fillInputs() {
  for (const field of fields) field.value = String(params[field.name]);
  fillLoadingInputs();
  const bias = params.biasCurrentA.map((value, i) => +(value * params.biasPerAmp[i]).toFixed(3));
  $('#sequence-geometry').textContent = '冷束沿 +X 入射，两组斜光在 XZ 平面内夹 120°。主轴 ' +
    params.mainAxis.toUpperCase() + '，偏置场 (X, Y, Z) = (' + bias.join(', ') + ') G。重力' +
    (params.gravity ? '已开启' : '已关闭') + '，随机反冲' + (params.recoil ? '已开启' : '已关闭') + '。从蓝 MOT 工作台进入时沿用其冷束、几何及偏置设置。';
}

function showReferenceLoss() {
  const labels = {blue:'蓝光', green:'绿光', twoColor:'双色光', dark:'无光'};
  const stages = sequenceLossStages(program, {alphaMode:alphaModeField.value});
  const total = alphaModeField.value === 'total';
  $('#seq-alpha-label').textContent = total ? '总单体 α 目标' : '背景单体 α';
  $('#seq-alpha-note').textContent = total
    ? '总损失目标包含光学分支。模型从总系数中扣除模拟分支损失率，剩余背景最低取零。留空时沿用宋博组表 II 的总单体损失系数。'
    : '背景单体损失默认取宋博组给出的背景碰撞率上限 0.012 s⁻¹。模拟另外根据 399 nm 和 556 nm 散射造成的暗态跃迁计算光学损失。';
  for (const row of lossRows) {
    const stage = stages.find(s => s.id === row.dataset.lossStage);
    const [alpha, beta] = row.querySelectorAll('input');
    row.hidden = !stage;
    alpha.disabled = beta.disabled = !stage;
    if (!stage) continue;
    alpha.setAttribute('aria-label', row.querySelector('th').firstChild.textContent + (total ? '总单体损失目标' : '背景单体损失系数'));
    row.querySelector('small').textContent = labels[stage.light];
    alpha.placeholder = String(stage.alpha);
    beta.placeholder = String(stage.beta);
  }
  const blueOnly = program.config.mode === 'blue-only';
  const heading = blueOnly ? '纯蓝 MOT 实验时序' : '双色 MOT 实验时序';
  $('#sequence-heading').textContent = heading;
  document.title = 'Yb · ' + heading;
  $('#sequence-wavelengths').textContent = blueOnly ? '¹⁷⁴Yb · 399 nm' : '¹⁷⁴Yb · 399 nm / 556 nm';
  $('#seq-green-branch').hidden = simulation === 'blue';
  checkpointButtons[1].textContent = blueOnly ? '保持中点 N₁' : '纯绿接收 N₁';
  checkpointButtons[2].textContent = blueOnly ? '保持结束 N₂' : '压缩结束 N₂';
  $('#seq-total-label').textContent = blueOnly ? '保持留存 N₂ / N₀' : '转移和压缩合计 N₂ / N₀';
  $('#seq-transfer-reference').hidden = $('#seq-loading-reference').hidden = blueOnly;
  form.elements.greenWaistMM.disabled = blueOnly;
  form.elements.greenWaistMM.closest('label').hidden = blueOnly;
}

function numberOrBlank(x, digits) {
  return Number.isFinite(x) ? x.toLocaleString('zh-CN', { maximumFractionDigits:digits }) : blank;
}

function efficiency(a, b) { return b > 0 ? (a / b * 100).toFixed(1) + '%' : blank; }

function showAtoms(output, count) {
  output.textContent = Number.isFinite(count) ? atomFormat.format(count) : blank;
  if (Number.isFinite(count)) {
    output.dataset.atoms = String(count);
    output.title = Math.round(count).toLocaleString('zh-CN') + ' 个原子（模型估计）';
  } else {
    delete output.dataset.atoms;
    output.removeAttribute('title');
  }
}

function refreshCurves() {
  const points = [];
  if (population) {
    const end = program.stages[0].endMS;
    for (const [frame, time] of result.timesMS.entries()) {
      // 关源后，帧内权重连续演化，阱内轨迹数只在下一帧更新。
      if (frame > 0 && time > end) {
        const before = cloudReadout(program, result, population, time, frame - 1);
        points.push({...before, leftLimit:true});
      }
      points.push(cloudReadout(program, result, population, time, frame));
      // 装载等待期复用捕获云快照，原子数继续按非线性装载方程增长。
      if (time === result.loadWindowMS && end > time) {
        for (let i = 1; i < 160; i++) points.push(cloudReadout(program, result, population, time + (end - time) * (i / 160) ** 2, frame));
      }
    }
  }
  curves.setSeries(points, program.stages, population?.timeConstants());
}

function summarize() {
  const counts = result?.summary;
  population = result && loadingForm.checkValidity()
    ? sequencePopulation(program, result, loading) : null;
  refreshCurves();
  refreshOptimization();
  const atoms = population?.estimatedAtoms;
  for (const key of ['N0','N1','N2']) {
    const suffix = key.toLowerCase();
    $('#seq-' + suffix).textContent = counts?.[key] ?? blank;
    showAtoms($('#seq-atoms-' + suffix), atoms?.[key]);
  }
  $('#seq-e0').textContent = efficiency(counts?.N0, result?.n);
  $('#seq-e1').textContent = efficiency(atoms?.N1, atoms?.N0);
  $('#seq-e2').textContent = efficiency(atoms?.N2, atoms?.N1);
  $('#seq-transfer').textContent = efficiency(atoms?.N2, atoms?.N0);
}

function refreshOptimization() {
  optimization.setContext(program, Boolean(result && population && editValid && form.checkValidity() && imaging.isValid()));
}

function showFrame(t) {
  timeMS = Math.max(0, Math.min(program.durationMS, t));
  const point = sequenceObservation({config:program.config, params, loading, imaging:cameraSettings},
    program, result, timeMS, {population, geometry});
  const {channels, frame:f, cloud:metric, atoms:count, psd} = point;
  $('#sequence-stage-text').textContent = point.stage.label +
    ' · ' + numberOrBlank(timeMS, 2) + ' ms';
  const sample = { ...channels, greenWaistMM:params.greenWaistMM, incidentFlux:loading.flux, positionsM:null };
  if (result) {
    const start = f * result.n, end = start + result.n;
    Object.assign(sample, {
      positionsM:result.positionsM.subarray(3 * start, 3 * end),
      alive:result.alive.subarray(start, end), blueRates:result.blueRates.subarray(start, end),
      greenRates:result.greenRates.subarray(start, end),
    });
    if (f > 0 && timeMS - result.timesMS[f] <= .5) {
      sample.previousPositionsM = result.positionsM.subarray(3 * (start - result.n), 3 * start);
      sample.previousAlive = result.alive.subarray(start - result.n, start);
      sample.previousDtMS = result.timesMS[f] - result.timesMS[f-1];
    }
  }
  scene?.setSequenceFrame({ ...sample, loadingSource: result });
  imaging.setFrame(point.cameraFrame());
  $('#seq-count').textContent = metric?.count ?? blank;
  $('#seq-blue-p0').textContent = metric?.darkBranches.blueP0 ?? blank;
  $('#seq-blue-p2').textContent = metric?.darkBranches.blueP2 ?? blank;
  $('#seq-green-p0').textContent = metric?.darkBranches.greenP0 ?? blank;
  $('#seq-temperature').textContent = numberOrBlank(metric?.temperatureUK, 1);
  $('#seq-radius').textContent = numberOrBlank(metric?.rmsRadiusMM, 3);
  curves.setCursor(timeMS, count, psd);
  showAtoms($('#seq-population'), count);
  $('#seq-scene-population').textContent = Number.isFinite(count) ? '估计阱内 ' + scientificCount(count) + ' 个原子' : '';
  const windowMS = Math.min(20, program.stages[0].durationMS);
  const onPlateau = timeMS <= program.stages[0].endMS && timeMS > windowMS;
  $('#seq-window-note').textContent = onPlateau
    ? '装载等待段使用 ' + windowMS + ' ms 的捕获云快照。轨迹图层用入射样本示意连续装载，亮纹沿飞行方向移动。'
    : '入射样本 ' + params.n + ' 个，装载轨迹积分 ' + windowMS + ' ms。当前读数取 r < 3 mm、速率 < 1 m/s 的样本，阶段末留存还要求在末段持续满足两项条件。';
}

function simulationType(compiled) {
  const hasGreen = sequenceLossStages(compiled).some(stage => stage.light === 'green' || stage.light === 'twoColor');
  return hasGreen ? 'two-color' : 'blue';
}

const enginePanel = mountEnginePanel($('#sequence-engine'), {
  simulation, engine:params.engine,
  onSelect(engine) {
    params = {...params, engine};
    recalculate();
  },
});
const curves = mountSequenceCurves($('#sequence-curves'), t => { editor.pause(); editor.setTime(t); });
const editor = mountSequenceEditor($('#sequence-editor'), {
  initialPreset,
  onPreset(id) {
    observeAtMS = id === 'imported' ? importedObserveAtMS : undefined;
    const url = new URL(location.href);
    if (id === 'imported') url.searchParams.delete('preset');
    else url.searchParams.set('preset', id);
    history.replaceState(history.state, '', url);
    $('#sequence-file-status').textContent = '';
  },
  onTime(t) {
    if (suspended) timeMS = t;
    else showFrame(t);
  },
  onChange(config, compiled) {
    editValid = true;
    if (!suspended && program.config.mode !== compiled.config.mode) {
      loadingByMode.set(program.config.mode, loading);
      loading = {...loadingByMode.get(compiled.config.mode), flux:loading.flux};
      fillLoadingInputs();
    }
    const nextSimulation = simulationType(compiled);
    if (!suspended && simulation !== nextSimulation) {
      engineBySimulation.set(simulation, params.engine);
      params = {...params, engine:engineBySimulation.get(nextSimulation) ?? defaultEngine};
    }
    simulation = nextSimulation;
    program = compiled;
    if (observeAtMS > program.durationMS) observeAtMS = undefined;
    if (!suspended) recalculate();
  },
  onInvalid(message) {
    editValid = false;
    cancelRun();
    status(message);
  },
});

const optimization = mountSequenceOptimization($('#sequence-optimizer'), {
  getCursor:() => timeMS,
  shader:computeShader,
  getExperiment:() => ({config:program.config, params, loading, imaging:imaging.getSettings()}),
  apply(experiment, targetMS) {
    const view = imaging.getSettings();
    const best = {...experiment, imaging:{...experiment.imaging, displayGain:view.displayGain,
      fluorescenceStage:view.fluorescenceStage, absorptionStage:view.absorptionStage}};
    loadExperiment(best, {presetId:'imported', name:'梯度优化时序'}, targetMS);
  },
});

const imaging = mountImagingPanel($('#sequence-imaging'), {
  onSettingsChange(settings) {
    editor.setImagingGate(settings);
    const changed = Object.keys(IMAGING_DEFAULTS).some(key => settings[key] !== cameraSettings[key]);
    cameraSettings = settings;
    if (changed && !suspended) {
      optimization.invalidate();
      refreshOptimization();
    }
  },
  onReplayStart: () => editor.pause(),
  onShowFinal: () => { editor.pause(); editor.setTime(program.durationMS); },
  onValidityChange: valid => {
    $('#sequence-export').disabled = !valid || !editValid || !form.checkValidity() || !loadingForm.checkValidity();
    if (!suspended) {
      if (!valid) optimization.invalidate();
      refreshOptimization();
    }
  },
});
editor.setImagingGate(imaging.getSettings());

// 导入和应用最佳结果都要同时更换装置、损失和成像设置，然后只提交一次计算。
function loadExperiment(experiment, preset, targetMS) {
  suspended = true;
  try {
    loadingByMode.set(program.config.mode, loading);
    engineBySimulation.set(simulation, params.engine);
    params = structuredClone(experiment.params);
    loading = {...experiment.loading};
    fillInputs();
    imaging.setSettings(experiment.imaging);
    importedObserveAtMS = targetMS;
    editor.replace(experiment.config, preset);
    observeAtMS = targetMS;
    if (targetMS !== undefined) {
      editor.setTime(targetMS);
      optimization.setTargetTime(targetMS);
    }
  } finally { suspended = false; }
  recalculate();
}

function status(message, retry = false) {
  $('#sequence-compute-status').textContent = message;
  $('#sequence-retry').hidden = !retry;
}

function cancelRun() {
  optimization.invalidate();
  job++;
  clearTimeout(timer);
  worker?.terminate();
  worker = null;
  result = null;
  editor.pause();
  editor.setEnabled(false);
  summarize();
  showFrame(timeMS);
  $('#sequence-export').disabled = true;
}

function recalculate() {
  enginePanel.update({simulation, engine:params.engine});
  showReferenceLoss();
  cancelRun();
  if (!editValid || !form.checkValidity()) {
    status('请完成有效的时序与模拟参数。');
    return;
  }
  for (const field of fields) if (!field.disabled) params[field.name] = Number(field.value);
  geometry = derive(params);
  scene?.setParams(params, geometry);
  showFrame(timeMS);
  $('#sequence-export').disabled = !loadingForm.checkValidity() || !imaging.isValid();
  status('正在积分 MOT 光力与原子轨迹…');
  const id = job;
  timer = setTimeout(() => {
    started = performance.now();
    function fail(message) {
      if (job !== id) return;
      worker?.terminate();
      worker = null;
      status('计算未完成 · ' + message, true);
    }
    try { worker = new Worker(new URL('./sequence-worker.js', import.meta.url), {type:'module'}); }
    catch (e) { fail(e.message); return; }
    worker.onerror = event => { event.preventDefault(); fail(event.message); };
    worker.onmessage = ({data}) => {
      if (data.id !== job || data.id !== id) return;
      if (data.error) { fail(data.error); return; }
      if (!data.result) {
        const progress = Math.round(100 * data.progress);
        status(data.backend + ' · 正在积分 ' + params.n.toLocaleString('zh-CN') + ' 条轨迹 · ' +
          progress + '%' + (data.reason ? ' · ' + data.reason : ''));
        return;
      }
      if (data.result.engine !== params.engine) {
        fail('计算结果的引擎与当前选择不一致。请刷新网页后重试。');
        return;
      }
      result = data.result;
      worker.terminate(); worker = null;
      summarize(); showFrame(timeMS); editor.setEnabled(true);
      const engineName = availableEngines(simulation).find(engine => engine.id === result.engine).label;
      status('计算完成 · ' + engineName + ' · ' + result.backend + ' · ' + result.n.toLocaleString('zh-CN') + ' 条入射轨迹 · ' +
        ((performance.now() - started) / 1000).toFixed(2) + ' s');
    };
    worker.postMessage({id, params, config:program.config, shader:computeShader, observeAtMS});
  }, 140);
}

function updateLayers() {
  scene?.setLayers(Object.fromEntries([...document.querySelectorAll('[data-seq-layer]')].map(input => [input.dataset.seqLayer, input.checked])));
}

function initializeScene() {
  try {
    scene = mountScene($('#sequence-viewport'));
    scene.setParams(params, geometry);
    updateLayers();
    showFrame(timeMS);
  } catch (e) {
    $('#sequence-scene-error').textContent = '三维视图无法显示 · ' + e.message;
    $('#sequence-scene-error').hidden = false;
  }
}

$('#sequence-export').addEventListener('click', () => {
  const preset = editor.getPreset();
  const file = { format:formatId, presetId:preset.id, presetName:preset.name, config:editor.getConfig(),
    params, loading:{alphaMode:alphaModeField.value, ...Object.fromEntries(loadingFields.filter(field => !field.disabled && field.name in loading)
      .map(field => [field.name, loading[field.name]]))}, imaging:imaging.getSettings(), summary:result?.summary ?? null };
  if (observeAtMS !== undefined) file.observeAtMS = observeAtMS;
  if (result) file.samplingDiagnostics = result.samplingDiagnostics;
  if (population) {
    file.estimatedAtoms = population.estimatedAtoms;
    file.timeConstants = population.timeConstants();
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url;
  a.download = preset.id === 'imported' ? 'yb-mot-sequence.json' : preset.name.replace(':', '-') + '.json';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#sequence-import').addEventListener('click', () => $('#sequence-file').click());
$('#sequence-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > maxFileBytes) throw new Error('文件超过 256 KB。');
    const data = JSON.parse(await file.text());
    const legacy = data.format === 'yb-mot-sequence-v1';
    if ((!legacy && data.format !== formatId) || !data.params) throw new Error('请选择本工作台导出的时序 JSON。');
    const compiled = compileSequence(data.config);
    if (data.observeAtMS !== undefined && (!Number.isFinite(data.observeAtMS) ||
        data.observeAtMS < 0 || data.observeAtMS > compiled.durationMS))
      throw new Error('目标观察时刻超出导入时序范围。');
    const inputParams = { ...data.params };
    delete inputParams._mot3dCompiled;
    const imported = compile(inputParams).params;
    for (const field of fields) {
      const v = imported[field.name];
      if (!Number.isFinite(v) || (field.min && v < Number(field.min)) || (field.max && v > Number(field.max)) ||
          (field.options && !Array.from(field.options, o => Number(o.value)).includes(v)))
        throw new Error('模拟参数超出可编辑范围 · ' + field.name);
    }
    if (data.loading != null && (typeof data.loading !== 'object' || Array.isArray(data.loading)))
      throw new Error('通量和损失参数须保存在 JSON 对象中。');
    const alphaMode = legacy ? 'total' : data.loading?.alphaMode;
    if (!['background', 'total'].includes(alphaMode)) throw new Error('时序文件缺少有效的单体损失系数定义。');
    const importedLoading = { flux:imported.incidentFlux ?? DEFAULT_FLUX, ...data.loading, alphaMode };
    for (const field of loadingFields) {
      if (!(field.name in importedLoading)) continue;
      const v = importedLoading[field.name];
      if (!Number.isFinite(v) || v < Number(field.min) || v > Number(field.max))
        throw new Error('通量或损失系数超出可编辑范围 · ' + field.name);
    }
    const name = typeof data.presetName === 'string' && data.presetName.trim() ? data.presetName : file.name.replace(/\.json$/i, '');
    loadExperiment({config:compiled.config, params:imported, loading:importedLoading, imaging:validateImagingSettings(data.imaging)},
      {presetId:data.presetId, name}, data.observeAtMS);
    $('#sequence-file-status').textContent = '已载入 ' + file.name + (legacy ? ' · 沿用总单体损失目标' : '');
  } catch (e) {
    $('#sequence-file-status').textContent = '导入未完成 · ' + e.message;
    return;
  } finally { event.target.value = ''; }
});

for (const button of document.querySelectorAll('[data-seq-view]')) button.addEventListener('click', () => {
  scene?.setView(button.dataset.seqView);
  for (const b of document.querySelectorAll('[data-seq-view]')) b.setAttribute('aria-pressed', String(b === button));
});
for (const layer of document.querySelectorAll('[data-seq-layer]')) layer.addEventListener('change', updateLayers);
form.addEventListener('input', recalculate);
$('#sequence-sample-count').addEventListener('input', recalculate);
for (const [index, button] of checkpointButtons.entries()) button.addEventListener('click', () => {
  editor.pause();
  editor.setTime(program.checkpointTimesMS[index]);
});
form.addEventListener('submit', event => event.preventDefault());
loadingForm.addEventListener('input', event => {
  optimization.invalidate();
  if (event.target === alphaModeField) {
    loading.alphaMode = alphaModeField.value;
    showReferenceLoss();
  }
  if (loadingForm.checkValidity()) {
    for (const field of loadingFields) {
      if (field.disabled) continue;
      if (field.value === '') delete loading[field.name];
      else loading[field.name] = field.valueAsNumber;
    }
  }
  summarize();
  $('#sequence-export').disabled = !form.checkValidity() || !editValid || !loadingForm.checkValidity() || !imaging.isValid();
  showFrame(timeMS);
});
loadingForm.addEventListener('submit', event => event.preventDefault());
$('#sequence-retry').addEventListener('click', recalculate);
document.addEventListener('visibilitychange', () => { if (document.hidden) editor.pause(); });
window.addEventListener('pagehide', e => {
  editor.pause();
  if (e.persisted) return;
  clearTimeout(timer); worker?.terminate(); optimization.destroy(); curves.destroy(); imaging.destroy(); editor.destroy(); scene?.destroy();
});
mountSequenceDock();
fillInputs();
initializeScene();
recalculate();
