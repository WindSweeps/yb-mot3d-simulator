import { DEFAULTS, compile, derive, magneticCenterMM } from './physics.js';
import { compileSequence, sequenceAt, songSequence } from './sequence.js';
import { mountSequenceEditor } from './sequence-ui.js';
import { mountScene } from './render.js';
import { DEFAULT_FLUX } from './fluorescence.js';
import { loadPopulation } from './sequence-population.js';
import { fluorescenceExposure, sequenceFrameAt } from './sequence-exposure.js';
import { mountImagingPanel, validateImagingSettings } from './sequence-imaging-view.js';

const $ = selector => document.querySelector(selector);
const form = $('#sequence-inputs');
const fields = Array.from(form.elements);
const loadingForm = $('#seq-loading-inputs');
const loadingFields = Array.from(loadingForm.elements);
const formatId = 'yb-mot-sequence-v1';
const blank = '—';
const maxFileBytes = 256000;
let params = initialInputs(), program = compileSequence(songSequence()), timeMS = 0;
let geometry = derive(params);
const referenceLoss = { flux:params.incidentFlux ?? DEFAULT_FLUX, alpha:.53, beta:1.7e-9 };
let loading = { ...referenceLoss };
let worker = null, timer = 0, job = 0, result = null, scene = null;
let editValid = true, suspended = false, started = 0;

function initialInputs() {
  let previous;
  try { previous = JSON.parse(sessionStorage.getItem('yb-mot3d-sequence-inputs')) || {}; }
  catch { previous = {}; }
  const base = { ...DEFAULTS, ...previous };
  const n = [96,192,384,768].includes(base.n) ? base.n : DEFAULTS.n;
  return { ...base, n, greenWaistMM: base.waistMM };
}

function fillInputs() {
  for (const field of fields) field.value = String(params[field.name]);
  for (const field of loadingFields) field.value = String(loading[field.name]);
  const bias = params.biasCurrentA.map((value, i) => +(value * params.biasPerAmp[i]).toFixed(3));
  $('#sequence-geometry').textContent = '冷束沿 +X 入射，两组斜光在 XZ 平面内夹 120°。主轴 ' +
    params.mainAxis.toUpperCase() + '，偏置场 (X, Y, Z) = (' + bias.join(', ') + ') G。重力' +
    (params.gravity ? '已开启' : '已关闭') + '，随机反冲' + (params.recoil ? '已开启' : '已关闭') + '。从蓝 MOT 工作台进入时沿用其冷束、几何及偏置设置。';
}

function stageAt(t) {
  return sequenceAt(program, t);
}

function numberOrBlank(x, digits) {
  return Number.isFinite(x) ? x.toLocaleString('zh-CN', { maximumFractionDigits:digits }) : blank;
}

function efficiency(a, b) { return b > 0 ? (a / b * 100).toFixed(1) + '%' : blank; }

function loadingPopulation(t) {
  return loadPopulation(Math.min(t, program.stages[0].durationMS), loading.flux, result.summary.N0 / result.n, loading.alpha, loading.beta);
}

function showLoadingPopulation() {
  const duration = program.stages[0].durationMS;
  $('#seq-loading-label').textContent = timeMS < duration ? '此时装载原子数估计' : '关蓝前装载原子数估计';
  const count = result && loadingForm.checkValidity()
    ? loadingPopulation(timeMS)
    : null;
  $('#seq-population').textContent = count === null ? blank :
    count.toLocaleString('zh-CN', { maximumSignificantDigits:3, notation:count >= 100000 ? 'scientific' : 'standard' }) + ' 个';
}

function summarize() {
  const counts = result?.summary;
  for (const key of ['N0','N1','N2']) $('#seq-' + key.toLowerCase()).textContent = counts?.[key] ?? blank;
  $('#seq-e1').textContent = efficiency(counts?.N1, counts?.N0);
  $('#seq-e2').textContent = efficiency(counts?.N2, counts?.N1);
  $('#seq-transfer').textContent = efficiency(counts?.N2, counts?.N0);
}

function showFrame(t) {
  timeMS = Math.max(0, Math.min(program.durationMS, t));
  const channels = stageAt(timeMS);
  $('#sequence-stage-text').textContent = program.stages[channels.stageIndex].label +
    ' · ' + numberOrBlank(timeMS, 2) + ' ms';
  let metric, f;
  const sample = { ...channels, greenWaistMM:params.greenWaistMM, positionsM:null };
  if (result) {
    f = sequenceFrameAt(result.timesMS, timeMS);
    const start = f * result.n, end = start + result.n;
    metric = result.metrics[f];
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
  scene?.setSequenceFrame(sample);
  showImaging(sample, f);
  $('#seq-count').textContent = metric?.count ?? blank;
  $('#seq-temperature').textContent = numberOrBlank(metric?.temperatureUK, 1);
  $('#seq-radius').textContent = numberOrBlank(metric?.rmsRadiusMM, 3);
  showLoadingPopulation();
  const windowMS = Math.min(20, program.stages[0].durationMS);
  const onPlateau = channels.stageId === 'load' && timeMS > windowMS;
  $('#seq-window-note').textContent = onPlateau
    ? '装载等待段显示 ' + windowMS + ' ms 的捕获云快照。交接从这批原子的相空间继续积分。'
    : '入射样本 ' + params.n + ' 个，装载轨迹积分 ' + windowMS + ' ms。当前读数取 r < 3 mm、速率 < 1 m/s 的样本，阶段末留存还要求在末段持续满足两项条件。';
}

function showImaging(sceneSample, f) {
  const endMS = timeMS, stage = program.stages[sceneSample.stageIndex];
  const centerMM = magneticCenterMM(sceneSample.gradientGCM, geometry.mainTensor, geometry.biasG) ?? [0, 0, 0];
  const context = { timeMS:endMS, sampledAtMS:endMS, stageLabel:stage.label, sample:{positionsM:null, centerMM} };
  if (result && loadingForm.checkValidity()) {
    const trajectory = result, loadMS = program.stages[0].durationMS, n0 = trajectory.summary.N0;
    const {flux, alpha, beta} = loading, probability = n0 / trajectory.n;
    const finalWeight = n0 ? loadPopulation(loadMS, flux, probability, alpha, beta) / n0 : 0;
    function weightAt(frame, t) {
      if (t >= loadMS) return finalWeight;
      const count = trajectory.metrics[frame].count;
      return count ? loadPopulation(t, flux, probability, alpha, beta) / count : 0;
    }
    context.sampledAtMS = trajectory.timesMS[f];
    context.weight = weightAt(f, endMS);
    context.sample = { ...sceneSample, centerMM, weight:context.weight, alive:trajectory.trapped.subarray(f * trajectory.n, (f + 1) * trajectory.n) };
    context.fluorescenceSample = exposureUS => fluorescenceExposure(trajectory, endMS, exposureUS, centerMM, weightAt);
  }
  imaging.setFrame(context);
}

const editor = mountSequenceEditor($('#sequence-editor'), {
  onTime:showFrame,
  onChange(config, compiled) {
    editValid = true;
    program = compiled;
    if (!suspended) recalculate();
  },
  onInvalid(message) {
    editValid = false;
    cancelRun();
    status(message);
  },
});

const imaging = mountImagingPanel($('#sequence-imaging'), {
  onSettingsChange: settings => editor.setImagingGate(settings),
  onReplayStart: () => editor.pause(),
  onShowFinal: () => { editor.pause(); editor.setTime(program.durationMS); },
  onValidityChange: valid => {
    $('#sequence-export').disabled = !valid || !editValid || !form.checkValidity() || !loadingForm.checkValidity();
  },
});
editor.setImagingGate(imaging.getSettings());

function status(message, retry = false) {
  $('#sequence-compute-status').textContent = message;
  $('#sequence-retry').hidden = !retry;
}

function cancelRun() {
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
  cancelRun();
  if (!editValid || !form.checkValidity()) {
    status('请完成有效的时序与模拟参数。');
    return;
  }
  for (const field of fields) params[field.name] = Number(field.value);
  geometry = derive(params);
  scene?.setParams(params, geometry);
  showFrame(timeMS);
  $('#sequence-export').disabled = !loadingForm.checkValidity() || !imaging.isValid();
  status('正在积分双色光力与绿 MOT 轨迹…');
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
      result = data.result;
      worker.terminate(); worker = null;
      summarize(); showFrame(timeMS); editor.setEnabled(true);
      status('计算完成 · ' + result.n + ' 个入射样本 · ' + ((performance.now() - started) / 1000).toFixed(2) + ' s');
    };
    worker.postMessage({id, params, config:program.config});
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
  const file = { format:formatId, config:editor.getConfig(), params, loading, imaging:imaging.getSettings(), summary:result?.summary ?? null };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'yb-mot-sequence.json';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#sequence-import').addEventListener('click', () => $('#sequence-file').click());
$('#sequence-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > maxFileBytes) throw new Error('文件超过 256 KB。');
    const data = JSON.parse(await file.text());
    if (data.format !== formatId || !data.params) throw new Error('请选择本工作台导出的时序 JSON。');
    const compiled = compileSequence(data.config);
    const imported = compile({ ...data.params, _mot3dCompiled:false }).params;
    for (const field of fields) {
      const v = imported[field.name];
      if (!Number.isFinite(v) || (field.min && v < Number(field.min)) || (field.max && v > Number(field.max)) ||
          (field.options && !Array.from(field.options, o => Number(o.value)).includes(v)))
        throw new Error('模拟参数超出可编辑范围 · ' + field.name);
    }
    const importedLoading = data.loading ?? { ...referenceLoss, flux:imported.incidentFlux ?? DEFAULT_FLUX };
    for (const field of loadingFields) {
      const v = importedLoading[field.name];
      if (!Number.isFinite(v) || v < Number(field.min) || v > Number(field.max))
        throw new Error('装载参数超出可编辑范围 · ' + field.name);
    }
    const cameraSettings = validateImagingSettings(data.imaging);
    suspended = true;
    params = imported; loading = { ...importedLoading }; fillInputs();
    imaging.setSettings(cameraSettings); editor.replace(compiled.config);
    $('#sequence-file-status').textContent = '已载入 ' + file.name;
  } catch (e) {
    $('#sequence-file-status').textContent = '导入未完成 · ' + e.message;
    return;
  } finally { suspended = false; event.target.value = ''; }
  recalculate();
});

for (const button of document.querySelectorAll('[data-seq-view]')) button.addEventListener('click', () => {
  scene?.setView(button.dataset.seqView);
  for (const b of document.querySelectorAll('[data-seq-view]')) b.setAttribute('aria-pressed', String(b === button));
});
for (const layer of document.querySelectorAll('[data-seq-layer]')) layer.addEventListener('change', updateLayers);
form.addEventListener('input', recalculate);
form.addEventListener('submit', event => event.preventDefault());
loadingForm.addEventListener('input', () => {
  if (loadingForm.checkValidity()) {
    loading = Object.fromEntries(loadingFields.map(field => [field.name, field.valueAsNumber]));
  }
  $('#sequence-export').disabled = !form.checkValidity() || !editValid || !loadingForm.checkValidity() || !imaging.isValid();
  showFrame(timeMS);
});
loadingForm.addEventListener('submit', event => event.preventDefault());
$('#sequence-retry').addEventListener('click', recalculate);
document.addEventListener('visibilitychange', () => { if (document.hidden) editor.pause(); });
window.addEventListener('pagehide', e => {
  editor.pause();
  if (e.persisted) return;
  clearTimeout(timer); worker?.terminate(); imaging.destroy(); editor.destroy(); scene?.destroy();
});
fillInputs();
initializeScene();
recalculate();
