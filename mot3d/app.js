import * as Physics from "./physics.js";
import { mountScene } from "./render.js";

const { DEFAULTS, derive } = Physics;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = "yb-mot3d-settings-v1";
const beamLabels = Physics.BEAM_LABELS || ["+V1", "−V1", "+V2", "−V2", "+H", "−H"];
const axes = ["X", "Y", "Z"];
const controls = new Map();
let params = clone(DEFAULTS);
let derived = null;
let scene = null;
let result = null;
let worker = null;
let jobId = 0;
let debounce = 0;
let baseline = null;
let fraction = 1;
let playing = false;
let lastFrame = null;
let animationFrame = 0;
let mode = "trajectories";
let view = "iso";
let busy = true;
const playbackSeconds = 7;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const scalarSpecs = [
  { key: "detuningMHz", label: "共同失谐 Δ", unit: "MHz", min: -100, max: 10, step: 1, target: "#light-controls", range: true },
  { key: "waistMM", label: "共同 1/e² 腰斑半径", unit: "mm", min: 1, max: 15, step: 0.25, target: "#light-controls", range: true },
  { key: "mainCurrentA", label: "主线圈电流", unit: "A", min: -8, max: 8, step: 0.1, target: "#main-coil-controls", range: true },
  { key: "sourceSpeed", label: "纵向均值 μ", unit: "m/s", min: 0, max: 100, step: 1, target: "#source-controls" },
  { key: "sourceSpread", label: "纵向标准差 σ", unit: "m/s", min: 0, max: 30, step: 0.1, target: "#source-controls" },
  { key: "sourceRadiusMM", label: "源位置 RMS", unit: "mm", min: 0, max: 10, step: 0.1, target: "#source-controls" },
  { key: "sourceTempMK", label: "横向温度", unit: "mK", min: 0, max: 100, step: 0.5, target: "#source-controls" },
  { key: "sourceYawDeg", label: "偏航角", unit: "°", min: -45, max: 45, step: 0.5, target: "#source-controls" },
  { key: "sourcePitchDeg", label: "俯仰角", unit: "°", min: -45, max: 45, step: 0.5, target: "#source-controls" },
  { key: "sourceOffsetYMM", label: "入射 Y 偏心", unit: "mm", min: -20, max: 20, step: 0.25, target: "#source-controls" },
  { key: "sourceOffsetZMM", label: "入射 Z 偏心", unit: "mm", min: -20, max: 20, step: 0.25, target: "#source-controls" },
  { key: "sourceDistanceMM", label: "注入面到原点", unit: "mm", min: 0, max: 100, step: 1, target: "#source-controls" },
  { key: "gradientPerAmp", label: "主梯度系数", unit: "G/cm/A", min: 0.01, max: 100, step: 0.01, target: "#calibration-controls" },
  { key: "durationMS", label: "演化时长", unit: "ms", min: 10, max: 60, step: 1, target: "#sampling-controls" },
  { key: "dtUS", label: "积分时间步", unit: "µs", min: 1, max: 20, step: 1, target: "#sampling-controls" },
  { key: "seed", label: "随机种子", unit: "", min: 1, max: 2147483647, step: 1, target: "#sampling-controls" },
];

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function valueAt(key) {
  const [field, index] = key.split(".");
  return index === undefined ? params[field] : params[field][Number(index)];
}

function setValue(key, value) {
  const [field, index] = key.split(".");
  if (index === undefined) params[field] = value;
  else params[field][Number(index)] = value;
}

function fillRange(input) {
  const min = Number(input.min), max = Number(input.max);
  const value = Number(input.value);
  input.style.setProperty("--fill", ((value - min) / (max - min) * 100) + "%");
}

function inputFor(spec, type) {
  const input = element("input");
  input.type = type;
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(valueAt(spec.key));
  input.dataset.param = spec.key;
  input.setAttribute("aria-label", spec.label + (spec.unit ? "，单位 " + spec.unit : ""));
  if (type === "number") {
    input.id = spec.key.replaceAll(".", "-");
    input.inputMode = "decimal";
  }
  input.addEventListener("input", () => {
    if (input.value === "" || !input.validity.valid || !Number.isFinite(input.valueAsNumber)) return;
    const next = input.valueAsNumber;
    if (next === valueAt(spec.key)) return;
    if (spec.key.startsWith("powersMW.") && $("#link-powers").checked) params.powersMW = params.powersMW.map(() => next);
    else setValue(spec.key, next);
    syncControls(input);
    parametersChanged();
  });
  input.addEventListener("change", () => {
    if (!input.validity.valid || input.value === "") input.value = String(valueAt(spec.key));
    if (type === "range") fillRange(input);
  });
  return input;
}

function buildControl(spec) {
  const number = inputFor(spec, "number");
  const wrap = element("div", spec.range ? "range-control" : "number-control");
  const label = element("label", "", spec.label);
  label.htmlFor = number.id;
  if (spec.range) {
    const row = element("div", "range-label-row");
    const numberWrap = element("div", "number-with-unit");
    numberWrap.append(number, element("span", "", spec.unit));
    row.append(label, numberWrap);
    const range = inputFor(spec, "range");
    range.tabIndex = -1;
    fillRange(range);
    wrap.append(row, range);
    controls.set(spec.key, { spec, number, range });
  } else {
    const unit = element("span", "field-unit", spec.unit);
    const title = element("span");
    title.append(label);
    if (spec.unit) title.append(document.createTextNode(" "), unit);
    wrap.append(title, number);
    controls.set(spec.key, { spec, number });
  }
  $(spec.target).append(wrap);
}

function buildControls() {
  scalarSpecs.forEach(buildControl);
  params.powersMW.forEach((power, index) => {
    const label = String(beamLabels[index]);
    const spec = { key: "powersMW." + index, label: label + " 单束功率", unit: "mW", min: 0, max: 60, step: 0.25 };
    const wrap = element("div", "power-control");
    const input = inputFor(spec, "number");
    const controlLabel = element("label", "", label);
    controlLabel.htmlFor = input.id;
    wrap.append(controlLabel, input);
    const optical = element("output", "power-optical");
    optical.id = "beam-optical-" + index;
    optical.setAttribute("aria-label", label + " 峰值光强与饱和参数");
    optical.setAttribute("for", input.id + " waistMM");
    const intensity = element("span", "beam-intensity", "— mW/cm²");
    intensity.id = "beam-intensity-" + index;
    const saturation = element("span", "beam-saturation", "s₀ = —");
    saturation.id = "beam-saturation-" + index;
    optical.append(intensity, saturation);
    input.setAttribute("aria-describedby", optical.id);
    wrap.append(optical);
    $("#power-controls").append(wrap);
    controls.set(spec.key, { spec, number: input });
  });
  axes.forEach((axis, index) => {
    buildControl({ key: "biasCurrentA." + index, label: axis + " 偏置", unit: "A", min: -2, max: 2, step: 0.01, target: "#bias-controls", range: true });
    buildControl({ key: "biasPerAmp." + index, label: axis + " 偏置系数", unit: "G/A", min: 0, max: 50, step: 0.01, target: "#calibration-controls" });
  });
}

function format(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits).replace(/^-0(\.0+)?$/, (text) => text.slice(1)) : "—";
}

function signed(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return (value > 0 ? "+" : "") + format(value, digits);
}

function coordinates(values, digits = 2) {
  return Array.isArray(values) || ArrayBuffer.isView(values)
    ? axes.map((axis, index) => axis + " " + format(values[index], digits)).join("   ")
    : "无唯一零点";
}

function announce(message) {
  $("#announcement").textContent = message;
}

function syncControls(except = null) {
  controls.forEach(({ spec, number, range }) => {
    const value = String(valueAt(spec.key));
    if (number !== except) number.value = value;
    if (range) { if (range !== except) range.value = value; fillRange(range); }
  });
  $("#gravity-toggle").checked = Boolean(params.gravity);
  $("#recoil-toggle").checked = Boolean(params.recoil);
  $("#main-axis").value = params.mainAxis || "y";
  $("#sample-count").value = String(params.n);
  if (!$("#sample-count").value) {
    const option = element("option", "", String(params.n));
    option.value = String(params.n);
    $("#sample-count").append(option);
    $("#sample-count").value = String(params.n);
  }
  $("#sample-mini").textContent = params.n + " 原子";
  $("#source-mini").textContent = "μ " + format(params.sourceSpeed, 0) + " · σ " + format(params.sourceSpread, 1) + " m/s";
  $("#retained-total").textContent = "/ " + params.n;
  $("#duration-label").textContent = params.durationMS + " ms";
  $("#gradient-label").textContent = params.mainAxis === "z" ? "主轴梯度 ∂Bz/∂z" : "主轴梯度 ∂By/∂y";
}

function forceVelocity() {
  if ($("#force-velocity").value !== "source") return [0, 0, 0];
  const yaw = params.sourceYawDeg * Math.PI / 180;
  const pitch = params.sourcePitchDeg * Math.PI / 180;
  return [params.sourceSpeed * Math.cos(pitch) * Math.cos(yaw), params.sourceSpeed * Math.cos(pitch) * Math.sin(yaw), params.sourceSpeed * Math.sin(pitch)];
}

function updateDerived() {
  derived = derive(params);
  $("#total-power").textContent = format(derived.totalPowerMW, 1) + " mW";
  // Reuse the same peak saturation values as the force model. 1 W/m² = 0.1 mW/cm².
  const isat = derived.saturationIntensityWPerM2 * 0.1;
  $("#saturation-reference").textContent = format(isat, 1) + " mW/cm²";
  derived.peakS.forEach((s, index) => {
    $("#beam-intensity-" + index).textContent = "I₀ " + format(s * isat, 1) + " mW/cm²";
    $("#beam-saturation-" + index).textContent = "s₀ = " + format(s, 2);
  });
  $("#total-saturation").textContent = format(derived.peakS.reduce((sum, s) => sum + s, 0), 2);
  $("#gradient-output").textContent = format(derived.gradientGPerCm, 1) + " G/cm";
  $("#bias-output").textContent = coordinates(derived.biasG, 2);
  $("#zero-output").textContent = derived.zeroUnique ? coordinates(derived.zeroMM, 2) : derived.biasG.every((value) => value === 0) ? "全空间零场" : "均匀偏置场 · 无零点";
  updateCurrentDirections();
  scene?.setParams(params, derived);
  scene?.setForceVelocity?.(forceVelocity());
}

function updateCurrentDirections() {
  const axis = (params.mainAxis || "y").toUpperCase();
  const sign = Math.sign(params.mainCurrentA);
  $("#main-current-direction").textContent = sign === 0 ? "I = 0 · 无电流" : "+" + axis + " 圈" + (sign > 0 ? "逆时针 ↺" : "顺时针 ↻") + "\n−" + axis + " 圈" + (sign > 0 ? "顺时针 ↻" : "逆时针 ↺");
  $("#main-current-observer").textContent = "观察者位于 +" + axis + "，朝原点看两圈。";
  $("#bias-current-directions").querySelectorAll("dd").forEach((output, index) => {
    const current = params.biasCurrentA[index];
    output.textContent = current === 0 ? "I = 0 · 无电流" : "两圈均" + (current > 0 ? "逆时针 ↺" : "顺时针 ↻") + " · " + signed(current, 2) + " A";
  });
}

function setStatus(text, state = "") {
  $("#run-status").textContent = text;
  $("#run-status").classList.toggle("is-running", state === "running");
  $("#run-status").classList.toggle("is-error", state === "error");
}

function clearMetrics() {
  $(".metrics-section").setAttribute("aria-busy", "true");
  $("#metric-phase").textContent = "正在计算";
  ["#retained-count", "#mean-speed", "#cloud-radius"].forEach((selector) => { $(selector).textContent = "—"; });
  $("#retained-fraction").textContent = "计算中";
  $("#centroid-output").querySelectorAll("dd").forEach((node) => { node.textContent = "—"; });
  $("#empty-note").hidden = true;
  $("#compute-time").textContent = "";
  $("#input-sample-output").textContent = "计算中";
  $("#save-baseline").disabled = true;
  $("#play").disabled = true;
  $("#timeline").disabled = true;
  $("#cloud-view").disabled = true;
  $("#time-output").textContent = "— ms";
  if (baseline) {
    ["#compare-retained", "#compare-center", "#compare-speed"].forEach((selector) => { $(selector).textContent = "计算中"; });
    $("#baseline-caption").textContent = "基准 A 已保留 · 当前参数计算中";
  }
}

function parametersChanged({ immediate = false } = {}) {
  clearTimeout(debounce);
  worker?.terminate();
  worker = null;
  jobId += 1;
  busy = true;
  result = null;
  setPlaying(false);
  scene?.setResult(null);
  clearMetrics();
  $("#simulation-error").hidden = true;
  updateDerived();
  setStatus(params.n + " 原子 · 计算中…", "running");
  debounce = setTimeout(runSimulation, immediate ? 0 : 180);
}

function failSimulation(message) {
  busy = false;
  worker?.terminate();
  worker = null;
  setStatus("计算未完成", "error");
  $(".metrics-section").setAttribute("aria-busy", "false");
  $("#metric-phase").textContent = "计算未完成";
  $("#retained-fraction").textContent = "—";
  $("#input-sample-output").textContent = "计算未完成";
  $("#simulation-error-text").textContent = message;
  $("#simulation-error").hidden = false;
  if (baseline) ["#compare-retained", "#compare-center", "#compare-speed"].forEach((selector) => { $(selector).textContent = "—"; });
}

function runSimulation() {
  const id = jobId;
  const snapshot = clone(params);
  try {
    const currentWorker = new Worker(new URL("./sim-worker.js", import.meta.url), { type: "module" });
    worker = currentWorker;
    currentWorker.onmessage = ({ data }) => {
      if (id !== jobId || data.id !== id) return;
      currentWorker.terminate();
      if (worker === currentWorker) worker = null;
      if (data.error) { failSimulation(data.error); return; }
      if (!data.result?.summary || !data.result?.frameCount) { failSimulation("计算结果缺少帧或统计数据。"); return; }
      result = data.result;
      busy = false;
      scene?.setResult(result);
      showTime(1);
      showMetrics();
      setStatus("计算完成 · seed " + snapshot.seed);
      $("#play").disabled = false;
      $("#timeline").disabled = false;
      $("#save-baseline").disabled = false;
      $("#simulation-error").hidden = true;
      announce("计算完成，留存 " + result.summary.retained + " / " + result.n + " 个原子。");
    };
    currentWorker.onerror = (event) => {
      if (id !== jobId) return;
      event.preventDefault();
      failSimulation(event.message || "计算线程未能运行，请通过本地网页服务打开本页。");
    };
    currentWorker.postMessage({ id, params: snapshot });
  } catch (error) { failSimulation(error.message); }
}

function radius(summary) {
  return summary.rmsMM ? Math.hypot(...summary.rmsMM) : null;
}

function showMetrics() {
  const summary = result.summary;
  const initial = summary.initialLongitudinal;
  $("#input-sample-output").textContent = initial ? "均值 " + format(initial.meanMS, 2) + " / σ " + format(initial.stdMS, 2) + " m/s · N = " + initial.n : "未返回入口抽样统计";
  $(".metrics-section").setAttribute("aria-busy", "false");
  $("#metric-phase").textContent = "t = " + format(result.params?.durationMS ?? params.durationMS, 0) + " ms · 终态";
  $("#retained-count").textContent = String(summary.retained);
  $("#retained-total").textContent = "/ " + result.n;
  $("#retained-fraction").textContent = format(summary.retainedFraction * 100, 1) + "% 留存";
  $("#mean-speed").textContent = format(summary.meanSpeed, 3);
  $("#cloud-radius").textContent = format(radius(summary), 3);
  $("#centroid-output").querySelectorAll("dd").forEach((node, index) => { node.textContent = format(summary.centroidMM?.[index], 2); });
  $("#empty-note").hidden = summary.retained !== 0;
  $("#cloud-view").disabled = !summary.centroidMM;
  const criterion = summary.criterion;
  if (criterion) $("#criterion-current").textContent = "以光束交点为原点，末 " + format(criterion.holdMS, 1) + " ms 持续满足 r < " + criterion.radiusMM + " mm、速率 < " + criterion.speedMS + " m/s。";
  const elapsed = summary.elapsedMS ?? result.elapsedMS;
  $("#compute-time").textContent = Number.isFinite(elapsed) ? "计算耗时 " + (elapsed < 1000 ? format(elapsed, 0) + " ms" : format(elapsed / 1000, 2) + " s") : "";
  updateComparison();
}

function showTime(value) {
  fraction = Math.max(0, Math.min(1, value));
  $("#timeline").value = String(fraction);
  fillRange($("#timeline"));
  scene?.setTime(fraction);
  if (!result) return;
  const times = result.times;
  const endMS = times?.length ? times[times.length - 1] * 1000 : (result.params?.durationMS ?? params.durationMS);
  $("#time-output").textContent = format(fraction * endMS, 1) + " ms";
}

function setPlaying(value) {
  playing = Boolean(value && result);
  $("#play").setAttribute("aria-pressed", String(playing));
  $("#play span").textContent = playing ? "暂停" : "回放";
  lastFrame = null;
  cancelAnimationFrame(animationFrame);
  if (playing) animationFrame = requestAnimationFrame(playbackTick);
}

function playbackTick(now) {
  if (!playing || !result) return;
  if (lastFrame !== null) showTime(fraction + Math.min(now - lastFrame, 100) / (playbackSeconds * 1000));
  lastFrame = now;
  if (fraction >= 1) { setPlaying(false); return; }
  animationFrame = requestAnimationFrame(playbackTick);
}

function updateComparison() {
  $("#comparison-result").hidden = !baseline;
  if (!baseline) return;
  $("#save-baseline").textContent = "更新基准 A";
  const total = baseline.params.powersMW.reduce((sum, power) => sum + power, 0);
  $("#baseline-caption").textContent = "A：Δ " + format(baseline.params.detuningMHz, 0) + " MHz · " + format(total, 1) + " mW · 主电流 " + format(baseline.params.mainCurrentA, 2) + " A";
  if (!result || busy) return;
  const now = result.summary, old = baseline.summary;
  $("#compare-retained").textContent = signed((now.retainedFraction - old.retainedFraction) * 100, 1) + " 个百分点";
  const distance = now.centroidMM && old.centroidMM ? Math.hypot(...now.centroidMM.map((value, index) => value - old.centroidMM[index])) : null;
  $("#compare-center").textContent = distance === null ? "—" : format(distance, 3) + " mm";
  const change = Number.isFinite(now.meanSpeed) && Number.isFinite(old.meanSpeed) ? now.meanSpeed - old.meanSpeed : null;
  $("#compare-speed").textContent = change === null ? "—" : signed(change, 3) + " m/s";
}

function setMode(next, focus = false) {
  mode = next;
  const descriptions = {
    trajectories: "同一批冷束原子在六束光与磁场中的运动。",
    field: "主四极场与三轴偏置叠加后的磁场线。",
    force: "光加速度：3 mm 箭长对应 5×10⁴ m/s²（平方根刻度，最长 5 mm）；平面视角显示中心切片。",
    density: "当前时刻的热原子云；密度核化平滑用于观察云形与位置。",
  };
  $("#mode-description").textContent = descriptions[mode];
  $("#force-velocity-control").hidden = mode !== "force";
  $("#cloud-view").hidden = mode !== "density";
  $("#scene-panel").setAttribute("aria-labelledby", "mode-" + mode);
  $("#mode-legend").textContent = { trajectories: "原子", field: "磁场线", force: "光力方向", density: "热云密度" }[mode];
  if (view === "cloud" && mode !== "density") {
    view = "iso";
    scene?.setView(view);
    $$("[data-view]").forEach((button) => {
      const selected = button.dataset.view === view;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  $$("[data-mode]").forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.classList.toggle("is-active", selected);
    if (selected && focus) button.focus();
  });
  scene?.setMode(mode);
  scene?.setForceVelocity?.(forceVelocity());
}

function selectedLayers() {
  return { beams: $("#layer-beams").checked, coils: $("#layer-coils").checked, trails: $("#layer-trails").checked };
}

function restoredParams(saved) {
  if (!saved || typeof saved !== "object") throw new Error("保存的参数格式不正确。");
  const next = clone(DEFAULTS);
  Object.entries(next).forEach(([key, fallback]) => {
    const candidate = saved[key];
    if (Array.isArray(fallback) && Array.isArray(candidate) && candidate.length === fallback.length && candidate.every(Number.isFinite)) next[key] = candidate.slice();
    else if (typeof fallback === "number" && Number.isFinite(candidate)) next[key] = candidate;
    else if (typeof fallback === "boolean" && typeof candidate === "boolean") next[key] = candidate;
    else if (key === "mainAxis" && ["y", "z"].includes(candidate)) next[key] = candidate;
  });
  controls.forEach(({ spec }) => {
    const [key, index] = spec.key.split(".");
    const value = index === undefined ? next[key] : next[key][Number(index)];
    const bounded = Math.min(spec.max, Math.max(spec.min, value));
    if (index === undefined) next[key] = bounded;
    else next[key][Number(index)] = bounded;
  });
  next.n = Math.min(768, Math.max(32, Math.round(next.n)));
  next.seed = Math.round(next.seed);
  return next;
}

function replaceParams(next) {
  params = restoredParams(next);
  syncControls();
  parametersChanged({ immediate: true });
}

function storageAvailable() {
  try { $("#restore-settings").disabled = !localStorage.getItem(STORAGE_KEY); }
  catch { $("#restore-settings").disabled = true; $("#storage-status").textContent = "当前浏览器未开放本地存储"; }
}

function wireActions() {
  $("#gravity-toggle").addEventListener("change", (event) => { params.gravity = event.target.checked; parametersChanged(); });
  $("#recoil-toggle").addEventListener("change", (event) => { params.recoil = event.target.checked; parametersChanged(); });
  $("#main-axis").addEventListener("change", (event) => { params.mainAxis = event.target.value; syncControls(); parametersChanged(); });
  $("#sample-count").addEventListener("change", (event) => { params.n = Number(event.target.value); syncControls(); parametersChanged(); });
  $("#reseed").addEventListener("click", () => { params.seed = 1 + Math.floor(Math.random() * 2147483646); syncControls(); parametersChanged({ immediate: true }); });
  $(".calibration-link").addEventListener("click", () => { $("#calibration-details").open = true; });
  $(".basis-link").addEventListener("click", () => { $("#polarization-basis").open = true; });
  ["beams", "coils", "trails"].forEach((layer) => $("#layer-" + layer).addEventListener("change", () => scene?.setLayers(selectedLayers())));
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => {
    view = button.dataset.view;
    scene?.setView(view);
    $$("[data-view]").forEach((other) => {
      const selected = other === button;
      other.classList.toggle("is-active", selected);
      other.setAttribute("aria-pressed", String(selected));
    });
  }));
  $$("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $(".mode-tabs").addEventListener("keydown", (event) => {
    const names = ["trajectories", "field", "force", "density"];
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? 3 : (names.indexOf(mode) + (event.key === "ArrowRight" ? 1 : 3)) % 4;
    setMode(names[index], true);
  });
  $("#force-velocity").addEventListener("change", () => scene?.setForceVelocity?.(forceVelocity()));
  $("#play").addEventListener("click", () => { if (!playing && fraction >= 1) showTime(0); setPlaying(!playing); });
  $("#timeline").addEventListener("input", (event) => { setPlaying(false); showTime(Number(event.target.value)); });
  $("#retry").addEventListener("click", () => parametersChanged({ immediate: true }));
  $("#reset-settings").addEventListener("click", () => { replaceParams(DEFAULTS); $("#storage-status").textContent = "已恢复默认参数；保存的设置仍保留"; });
  $("#save-baseline").addEventListener("click", () => {
    if (!result || busy) return;
    baseline = { params: clone(result.params || params), summary: clone(result.summary) };
    updateComparison();
    announce("当前参数与结果已记为基准 A。");
  });
  $("#restore-baseline").addEventListener("click", () => { if (baseline) replaceParams(baseline.params); });
  $("#save-settings").addEventListener("click", () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), params, linkPowers: $("#link-powers").checked }));
      $("#restore-settings").disabled = false;
      $("#storage-status").textContent = "已保存当前参数 · " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } catch { $("#storage-status").textContent = "保存失败：浏览器未允许本地存储。可导出 JSON 保存参数。"; }
  });
  $("#restore-settings").addEventListener("click", () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved?.params) throw new Error("没有可恢复的设置。");
      replaceParams(saved.params);
      $("#link-powers").checked = saved.linkPowers !== false;
      $("#storage-status").textContent = "已恢复保存的参数";
    } catch (error) { $("#storage-status").textContent = "恢复失败：" + error.message; }
  });
  $("#export-json").addEventListener("click", () => {
    const payload = { format: "yb-blue-mot-parameters-v1", exportedAt: new Date().toISOString(), params: clone(params), derived, summary: !busy && result ? result.summary : null, baseline };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "yb-399-mot-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("#storage-status").textContent = "已导出当前参数" + (payload.summary ? "及终态统计" : "；当前计算尚未完成");
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) setPlaying(false); });
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) setPlaying(false); });
  window.addEventListener("resize", () => scene?.resize());
  window.addEventListener("pagehide", () => { clearTimeout(debounce); worker?.terminate(); cancelAnimationFrame(animationFrame); scene?.destroy(); });
}

async function initScene() {
  try {
    scene = await mountScene($("#scene-viewport"), {});
    scene.setParams(params, derived);
    scene.setLayers(selectedLayers());
    scene.setView(view);
    scene.setMode(mode);
    scene.setForceVelocity?.(forceVelocity());
    if (result) { scene.setResult(result); scene.setTime(fraction); }
    $("#scene-loading").hidden = true;
    scene.resize();
  } catch (error) {
    $("#scene-loading").classList.add("is-error");
    $("#scene-loading").replaceChildren(element("span", "", "三维视图未能建立：" + error.message));
  }
}

buildControls();
syncControls();
wireActions();
storageAvailable();
parametersChanged({ immediate: true });
initScene();
