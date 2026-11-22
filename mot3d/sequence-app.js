import { DEFAULTS, compile, derive, magneticCenterMM } from './physics.js';
import { compileSequence, sequenceAt, songSequence } from './sequence.js';
import { mountSequenceEditor } from './sequence-ui.js';
import { mountScene } from './render.js';
import { DEFAULT_FLUX } from './fluorescence.js';
import { sequencePopulation } from './sequence-population.js';
import { fluorescenceExposure, sequenceFrameAt } from './sequence-exposure.js';
import { mountImagingPanel, validateImagingSettings } from './sequence-imaging-view.js';
import { mountSequenceDock } from './sequence-dock.js';

// 时序与求解器持续更新同一组控件，停靠过程可以移动它们的父节点。
const elements = new Map(Array.from(document.querySelectorAll('[id]'), el => ['#' + el.id, el]));
const $ = selector => elements.get(selector);
const form = $('#sequence-inputs');
const fields = Array.from(form.elements);
const loadingForm = $('#seq-loading-inputs');
const loadingFields = Array.from(loadingForm.elements);
const formatId = 'yb-mot-sequence-v1';
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
let params = await initialInputs(), program = compileSequence(songSequence()), timeMS = 0;
let geometry = derive(params);
const referenceLoss = { flux:params.incidentFlux ?? DEFAULT_FLUX, alpha:.53, beta:1.7e-9 };
let loading = { ...referenceLoss };
let worker = null, timer = 0, job = 0, result = null, scene = null, population = null;
let editValid = true, suspended = false, started = 0;

async function initialInputs() {
  let previous;
  try { previous = JSON.parse(sessionStorage.getItem('yb-mot3d-sequence-inputs')) || {}; }
  catch { previous = {}; }
  const base = { ...DEFAULTS, ...previous };
  // 双色序列单独设置采样数；实验文件导入时使用文件中明确保存的数量。
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  const n = adapter ? (matchMedia('(max-width: 800px)').matches ? 4096 : 16384) : 1024;
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

function summarize() {
  const counts = result?.summary;
  population = result && loadingForm.checkValidity()
    ? sequencePopulation(program.stages[0].durationMS, result.n, counts.N0, loading) : null;
  for (const key of ['N0','N1','N2']) {
    const suffix = key.toLowerCase();
    $('#seq-' + suffix).textContent = counts?.[key] ?? blank;
    showAtoms($('#seq-atoms-' + suffix), population && population.transferWeight * counts[key]);
  }
  $('#seq-e0').textContent = efficiency(counts?.N0, result?.n);
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
  const sample = { ...channels, greenWaistMM:params.greenWaistMM, incidentFlux:loading.flux, positionsM:null };
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
  const count = population && population.at(timeMS, metric.count);
  showAtoms($('#seq-population'), count);
  $('#seq-scene-population').textContent = Number.isFinite(count) ? '估计阱内 ' + scientificCount(count) + ' 个原子' : '';
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
  if (result && population) {
    const trajectory = result, estimate = population;
    const weightAt = (frame, t) => estimate.weightAt(t, trajectory.metrics[frame].count);
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
      if (!data.result) {
        const progress = Math.round(100 * data.progress);
        status(data.backend + ' · 正在积分 ' + params.n.toLocaleString('zh-CN') + ' 条轨迹 · ' +
          progress + '%' + (data.reason ? ' · ' + data.reason : ''));
        return;
      }
      result = data.result;
      worker.terminate(); worker = null;
      summarize(); showFrame(timeMS); editor.setEnabled(true);
      status('计算完成 · ' + result.backend + ' · ' + result.n.toLocaleString('zh-CN') + ' 条入射轨迹 · ' +
        ((performance.now() - started) / 1000).toFixed(2) + ' s');
    };
    worker.postMessage({id, params, config:program.config, shader:computeShader});
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
  if (population) {
    file.estimatedAtoms = Object.fromEntries(Object.entries(result.summary).map(([key, n]) => [key, n * population.transferWeight]));
  }
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
    const inputParams = { ...data.params };
    delete inputParams._mot3dCompiled;
    const imported = compile(inputParams).params;
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
$('#sequence-sample-count').addEventListener('input', recalculate);
for (const button of document.querySelectorAll('[data-checkpoint]')) button.addEventListener('click', () => {
  editor.pause();
  editor.setTime(program.stages[Number(button.dataset.checkpoint)].endMS);
});
form.addEventListener('submit', event => event.preventDefault());
loadingForm.addEventListener('input', () => {
  if (loadingForm.checkValidity()) {
    loading = Object.fromEntries(loadingFields.map(field => [field.name, field.valueAsNumber]));
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
  clearTimeout(timer); worker?.terminate(); imaging.destroy(); editor.destroy(); scene?.destroy();
});
mountSequenceDock();
fillInputs();
initializeScene();
recalculate();
