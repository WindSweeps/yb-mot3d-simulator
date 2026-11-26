import { compileSequence, matchingSequencePreset, sequenceAt, sequenceFieldsFor, SEQUENCE_PRESETS } from './sequence.js';
import { YB_SEQUENCE_CHOICES, YB_SEQUENCE_FIELDS } from './sequence-atom-settings.js';
import { YB_REPUMPS } from './yb-atom.js';

const phases = [
  { keys: ['loadMS', 'blueDetuningMHz', 'shieldingMHz', 'loadGradient', 'blueObliqueMW', 'blueHorizontalMW',
    'greenDuringLoad','greenObliqueMW','greenHorizontalMW'],
    note: '5 s 取自论文图 4 的双色装载时间。光功率以每个传播方向计，按主梯度轴将论文的弱束分配给水平 H 光，各对中的正反向功率相同。' },
  { keys: ['handoffMS', 'receiveMHz', 'receiveGradient'],
    note: '交接开始时绿光跳到红失谐，随后关断 399 nm 接收光。论文给出蓝光关断不超过 1 ms；蓝光和磁场梯度采用线性变化，表示模拟中的时序假设。' },
  { keys: ['greenMS', 'receiveMHz', 'receiveGradient', 'greenObliqueMW', 'greenHorizontalMW'],
    note: '接收阶段维持高功率绿光，失谐、功率和梯度与交接终点共用。' },
  { keys: ['compressMS', 'compressMHz', 'finalGradient', 'finalObliqueUW', 'finalHorizontalUW', 'powerRamp'],
    note: '压缩开始时切换绿光失谐。斜光和水平光各自按所选曲线降至末端功率，主轴梯度线性变化。' },
];
const bluePhases = [
  { keys:['loadMS', 'blueDetuningMHz', 'loadGradient', 'blueObliqueMW', 'blueHorizontalMW'],
    note:'原子束进入 399 nm MOT 连续装载。蓝光的功率、失谐和磁场梯度在两个阶段保持相同。' },
  { keys:['holdMS'],
    note:'关闭入射原子束，保持 399 nm 囚禁光和磁场，观察蓝 MOT 中的原子数衰减。' },
];
const channels = [
  { label: '399 nm 光闸', tone: 'blue', value: s => Number(s.blueOn), gate: true },
  { label: '399 nm 总功率', tone: 'blue', value: s => sum(s.bluePowersMW), unit: 'mW', base: 0 },
  { label: '399 nm 失谐', tone: 'blue', value: s => s.blueDetuningMHz, unit: 'MHz' },
  { label: '556 nm 光闸', tone: 'green', value: s => Number(s.greenOn), gate: true },
  { label: '556 nm 总功率', tone: 'green', value: s => sum(s.greenPowersMW), unit: 'mW', base: 0 },
  { label: '556 nm 失谐', tone: 'green', value: s => s.greenDetuningMHz, unit: 'MHz' },
  { label: '主轴梯度', tone: 'field', value: s => s.gradientGCM, unit: 'G/cm' },
  { label: '入射原子束', tone: 'source', value: s => Number(s.stageId === 'load'), gate: true },
  ...YB_REPUMPS.map(({label},i) => ({label:label+' 重泵浦',tone:'source',
    value:s => s.repump?.rates[i] ?? 0,unit:'s⁻¹',shown:(program,tier) => tier >= 2 && program.atom.repump?.rates[i]})),
  {label:'光阱功率',tone:'field',value:s => 1000*(s.trap?.powerW ?? 0),unit:'mW',shown:(p,tier) => tier === 3 && p.atom.trap},
];
const atomGroups = [
  {tier:1,keys:['detuningReference','atomStepUS']},
  {tier:2,title:'暗态与级联',keys:['atomLossMode','darkDecay','p2Branches','leakP0','leakP1','leakP2']},
  {tier:2,title:'重泵浦脉冲',keys:['repumpLeadMS','repumpDurationMS','repumpWaistMM',...YB_REPUMPS.map(({key}) => key)],
    note:'速率为阱中心每个暗态原子每秒经历的重泵浦循环数。零速率关闭对应光路。'},
  {tier:3,title:'光偶极阱与晶格',keys:['trapMode','trapLeadMS','trapDurationMS','trapWavelengthNM','trapPowerMW',
    'trapWaistUM','trapPolarizationDeg','alphaGround','alphaBlue','tensorBlue','alphaGreen','tensorGreen',
    'alphaP0','alphaP2','tensorP2'],
    note:'光束沿 X 方向传播。输入所选波长下各态的极化率，晶格功率以波腹强度换算。'},
];
const sum = a => a.reduce((x, y) => x + y, 0);
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3, useGrouping: false });
const fmt = x => number.format(x);
const seconds = t => t >= 1000 ? fmt(t / 1000) + ' s' : fmt(t) + ' ms';
const svgNS = 'http://www.w3.org/2000/svg';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountSequenceEditor(host, { initialPreset = SEQUENCE_PRESETS[0], onPreset, onChange, onTime, onInvalid } = {}) {
  let activePreset = initialPreset, importedPreset = null;
  let program = compileSequence(activePreset.config);
  let timeMS = 0, activePhase = 0, scale = 'phase', playback = 0, lastTick = 0;
  let enabled = true, valid = true;
  let exposureUS = 0, atomTier = 0;
  host.classList.add('seq-editor');
  host.innerHTML = `
    <div class="seq-title"><div><h2>时序通道</h2><p>各通道共用实验时间，光功率为六束单向光之和。</p></div>
      <div class="seq-presets"><label>时序预设<select data-action="preset"></select></label>
      <button type="button" class="small-button" data-action="reset">恢复时序预设</button></div></div>
    <div class="seq-chart-head"><div class="seq-gates" role="group" aria-label="时序光路开关">
      <label><input type="checkbox" data-gate="blueEnabled">399 nm 光路</label>
      <label><input type="checkbox" data-gate="greenEnabled">556 nm 光路</label></div>
      <label class="seq-scale">横轴<select aria-label="时间轴比例"><option value="phase">各阶段展开</option><option value="time">实际时间比例</option></select></label></div>
    <div class="seq-chart"><div class="seq-ruler-row"><span class="seq-label">实验时间</span>
      <div class="seq-ruler"><div class="seq-ticks"></div><span class="seq-playhead" aria-hidden="true"></span></div>
      <span class="seq-readout-head">游标读数</span></div>
      <div class="seq-lanes"></div>
      <div class="seq-lane seq-camera" hidden><a href="#sequence-imaging" class="seq-label">相机曝光</a><div class="seq-plot"><span class="seq-exposure-window"></span></div><output class="seq-value"></output></div></div>
    <div class="seq-transport"><button type="button" class="button" data-action="play" aria-pressed="false">播放时序</button>
      <label class="seq-slider-label"><span class="sr-only">实验时序游标</span><input class="seq-slider" type="range" min="0" max="10000" step="1" value="0"></label>
      <label class="seq-time-input"><span class="sr-only">游标时间</span><input type="number" aria-label="游标时间，单位 ms" min="0" step="any" required value="0"><span>ms</span></label></div>
    <div class="seq-phase-controls" role="group" aria-label="切换到阶段起点并编辑参数"></div>
    <div class="seq-form-head"><h3></h3><output class="seq-stage-span"></output></div>
    <div class="seq-fields"></div><p class="seq-note"></p>
    <details class="seq-atom-controls" hidden><summary>镱引擎时序参数</summary><div class="seq-atom-fields"></div></details>
    <p class="seq-error" role="status" aria-live="polite"></p>
    <div class="seq-reference"><a href="https://arxiv.org/pdf/2503.24383v2#page=3" target="_blank" rel="noopener">论文实验参数 ↗</a>
    <a href="https://m-labs.hk/artiq/manual/rtio.html#timeline-and-output-events" target="_blank" rel="noopener">ARTIQ 时间游标 ↗</a></div>`;
  const get = selector => host.querySelector(selector);
  const presetSelect = get('[data-action=preset]');
  for (const preset of SEQUENCE_PRESETS) presetSelect.add(new Option(preset.name, preset.id));
  presetSelect.value = activePreset.id;
  const chart = get('.seq-chart');
  const slider = get('.seq-slider'), cursorInput = get('.seq-time-input input');
  const rulerTicks = get('.seq-ticks');
  const play = get('[data-action=play]'), form = get('.seq-fields'), error = get('.seq-error');
  const atomControls = get('.seq-atom-controls'), atomFields = get('.seq-atom-fields');
  const title = get('.seq-form-head h3'), span = get('.seq-stage-span'), note = get('.seq-note');
  const cameraLane = get('.seq-camera'), cameraWindow = get('.seq-exposure-window');
  const reader = [];
  const phaseButtons = [];
  const events = new AbortController();
  const listen = (target, type, callback) => target.addEventListener(type, callback, { signal: events.signal });

  function timeScale(t) {
    if (scale === 'time') return t / program.durationMS;
    const state = sequenceAt(program, t), s = program.stages[state.stageIndex];
    return (state.stageIndex + state.elapsedMS / s.durationMS) / program.stages.length;
  }
  function physicalTime(x) {
    x = Math.min(1, Math.max(0, x));
    if (scale === 'time') return x * program.durationMS;
    const position = x * program.stages.length;
    const index = Math.min(program.stages.length - 1, Math.floor(position)), s = program.stages[index];
    return x === 1 ? program.durationMS : s.startMS + (position - index) * s.durationMS;
  }
  function playbackPosition(t) {
    const state = sequenceAt(program, t);
    const stage = program.stages[state.stageIndex];
    let fraction = state.elapsedMS / stage.durationMS;
    if (stage.id === 'load' && stage.durationMS > 40) {
      fraction = t <= 20 ? .5 * t / 20 : .5 + .5 * (t - 20) / (stage.durationMS - 20);
    }
    return state.stageIndex + fraction;
  }
  function playbackTime(position) {
    const i = Math.min(program.stages.length - 1, Math.floor(position)), stage = program.stages[i];
    const fraction = position - i;
    if (i === 0 && stage.durationMS > 40)
      return fraction <= .5 ? 40 * fraction : 20 + (fraction - .5) * 2 * (stage.durationMS - 20);
    return stage.startMS + stage.durationMS * fraction;
  }
  function setTime(ms, announce = true) {
    const state = sequenceAt(program, ms);
    timeMS = state.timeMS;
    const x = timeScale(timeMS);
    host.style.setProperty('--seq-cursor', (100 * x) + '%');
    slider.value = String(Math.round(10000 * x));
    slider.style.setProperty('--fill', (100 * x) + '%');
    slider.setAttribute('aria-valuetext', program.stages[state.stageIndex].label + '，' + fmt(timeMS) + ' ms');
    if (document.activeElement !== cursorInput) cursorInput.value = fmt(timeMS);
    phaseButtons.forEach((b, i) => {
      b.classList.toggle('is-current', state.stageIndex === i);
      if (state.stageIndex === i) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    channels.forEach((c, i) => {
      const value = c.value(state);
      reader[i].output.textContent = c.gate ? (value ? '开启' : '关闭') : fmt(value) + ' ' + c.unit;
    });
    positionExposure();
    if (!playback) play.textContent = timeMS >= program.durationMS ? '重播时序' : '播放时序';
    if (announce) onTime?.(timeMS);
  }
  function positionExposure() {
    if (!exposureUS) return;
    const left = timeScale(Math.max(0, timeMS - exposureUS / 1000));
    cameraWindow.style.left = (left * 100) + '%';
    cameraWindow.style.width = ((timeScale(timeMS) - left) * 100) + '%';
  }
  function setImagingGate(settings) {
    exposureUS = settings.mode === 'off' ? 0 : settings.exposureUS;
    cameraLane.hidden = !exposureUS;
    get('.seq-camera .seq-label').textContent = settings.mode === 'absorption' ? '吸收曝光' : '荧光曝光';
    get('.seq-camera .seq-value').textContent = fmt(exposureUS) + ' µs';
    positionExposure();
  }
  function pause() {
    cancelAnimationFrame(playback);
    playback = 0;
    lastTick = 0;
    play.setAttribute('aria-pressed', 'false');
    play.textContent = timeMS >= program.durationMS ? '重播时序' : '播放时序';
  }
  function tick(now) {
    if (!playback) return;
    // 给加载起始 20 ms 留出足够的屏幕播放时间，再推进至真实的交接时刻。
    const next = Math.min(program.stages.length, playbackPosition(timeMS) + (now - lastTick) / 2500);
    lastTick = now;
    setTime(playbackTime(next));
    if (next === program.stages.length) pause();
    else playback = requestAnimationFrame(tick);
  }
  function applyAvailability() {
    const unavailable = !enabled || !valid;
    play.disabled = slider.disabled = cursorInput.disabled = unavailable;
    host.classList.toggle('seq-invalid', !valid);
  }
  function invalidate(message) {
    const changed = valid || error.textContent !== message;
    pause();
    valid = false;
    error.textContent = message;
    applyAvailability();
    if (changed) onInvalid?.(message);
  }
  function drawTraces() {
    const samples = [];
    for (const [index, stage] of program.stages.entries()) {
      for (let j = 0; j <= 40; j++) {
        const t = stage.startMS + stage.durationMS * (j / 40);
        // 同一个阶段边界分别绘制左、右极限，保持光闸及频率跳变为垂直沿。
        const sampleTime = j === 40 && index < program.stages.length - 1 ?
          stage.endMS - Math.min(1e-8, stage.durationMS * 1e-8) : t;
        samples.push([t,sampleTime]);
      }
    }
    for (const pulse of program.atom.windows) for (const time of [pulse.startMS,pulse.endMS]) {
      const before = Math.max(0,time-Math.min(.00000001,(pulse.endMS-pulse.startMS)/1000));
      samples.push([time,before],[time,time]);
    }
    samples.sort(([x,a],[y,b]) => (x-y) || (a-b));
    const traces = samples.map(([time,sampleTime]) => [timeScale(time)*1000,sequenceAt(program,sampleTime)]);
    const markers = [0, ...program.stages.map(s => s.endMS)];
    rulerTicks.replaceChildren();
    const ticks = scale === 'phase' ? markers : [0, program.durationMS / 2, program.durationMS];
    for (const t of ticks) {
      const tickLabel = element('span', 'seq-tick', fmt(t));
      tickLabel.style.left = (100 * timeScale(t)) + '%';
      rulerTicks.append(tickLabel);
    }
    for (const [i, { path, dividers, row }] of reader.entries()) {
      const channel = channels[i], values = traces.map(([, s]) => channel.value(s));
      row.hidden = Boolean(channel.shown && !channel.shown(program,atomTier));
      const lo = channel.gate ? 0 : Math.min(0, ...values), hi = channel.gate ? 1 : Math.max(0, ...values);
      path.setAttribute('d', traces.map(([x], k) => {
        const y = hi > lo ? 26 - 20 * (values[k] - lo) / (hi - lo) : 16;
        return (k === 0 ? 'M' : 'L') + x.toFixed(5) + ' ' + y.toFixed(3);
      }).join(' '));
      dividers.setAttribute('d', markers.slice(1, -1).map(t => 'M' + (1000 * timeScale(t)) + ' 0v32').join(' '));
    }
    cursorInput.max = String(program.durationMS);
  }
  function makeAtomFields() {
    atomControls.hidden = !atomTier;
    atomFields.replaceChildren();
    for (const group of atomGroups.filter(group => group.tier <= atomTier)) {
      const area = element('fieldset','seq-atom-group'), controls = element('div','seq-fields');
      if (group.title) area.append(element('legend','',group.title));
      for (const key of group.keys) {
        const label = element('label','seq-field'), definitions = YB_SEQUENCE_CHOICES[key];
        let input;
        if (definitions) {
          label.append(element('span','',definitions[0]));
          input = element('select');
          for (const [value,name] of definitions[2]) input.add(new Option(name,value));
          label.append(input);
        } else {
          const [name,unit,min,max,defaultValue] = YB_SEQUENCE_FIELDS[key];
          label.append(element('span','',name));
          const wrap = element('span','seq-unit-field');
          input = element('input');
          input.type = 'number'; input.step = key === 'p2Branches' ? '1' : 'any'; input.min = min; input.max = max;
          input.required = defaultValue !== null;
          if (unit) input.setAttribute('aria-label',name+'，单位 '+unit);
          wrap.append(input,element('span','seq-unit',unit));
          label.append(wrap);
        }
        input.dataset.key = key;
        input.value = program.atom.values[key] ?? '';
        controls.append(label);
      }
      area.append(controls);
      if (group.note) area.append(element('p','seq-note',group.note));
      atomFields.append(area);
    }
  }
  function makeFields() {
    const phase = program.stages[activePhase];
    const definitions = program.config.mode === 'blue-only' ? bluePhases : phases;
    phaseButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === activePhase)));
    title.textContent = phase.label + '参数';
    note.textContent = phase.id === 'load' && program.config.greenDuringLoad === false ?
      '装载期间使用 399 nm 光。交接开始时开启 556 nm，蓝光在设定时间内关断。' : definitions[activePhase].note;
    form.replaceChildren();
    for (const key of definitions[activePhase].keys) {
      const label = element('label', 'seq-field');
      if (key === 'greenDuringLoad') {
        label.append(element('span','','装载时的 556 nm 光路'));
        const input = element('select');
        input.dataset.key = key;
        input.add(new Option('开启','true')); input.add(new Option('关闭','false'));
        input.value = String(program.config.greenDuringLoad !== false); label.append(input);
      } else if (key === 'powerRamp') {
        label.append(element('span', '', '绿光功率斜坡'));
        const input = element('select');
        input.dataset.key = key;
        for (const [value, name] of [['linear','线性'],['geometric','等比'],['smooth','平滑 S 形']]) {
          const option = element('option', '', name); option.value = value; input.append(option);
        }
        input.value = program.config[key]; label.append(input);
      } else {
        const [name, unit, min, max] = sequenceFieldsFor(program.config)[key];
        label.append(element('span', '', name));
        const wrap = element('span', 'seq-unit-field'), input = element('input');
        input.type = 'number'; input.step = 'any'; input.min = min;
        if (Number.isFinite(max)) input.max = max;
        input.required = true; input.dataset.key = key;
        input.setAttribute('aria-label', name + '，单位 ' + unit);
        input.value = String(program.config[key]);
        wrap.append(input, element('span', 'seq-unit', unit)); label.append(wrap);
      }
      form.append(label);
    }
  }
  function refreshLabels() {
    program.stages.forEach((s, i) => { phaseButtons[i].lastElementChild.textContent = seconds(s.durationMS); });
    const s = program.stages[activePhase];
    span.textContent = fmt(s.startMS) + ' – ' + fmt(s.endMS) + ' ms';
    const blueOnly = program.config.mode === 'blue-only';
    host.classList.toggle('seq-blue-only', blueOnly);
    host.querySelectorAll('[data-gate]').forEach(input => {
      input.checked = program.config[input.dataset.gate];
      input.disabled = blueOnly && input.dataset.gate === 'greenEnabled';
    });
  }
  function applyConfig(config, redrawFields) {
    const previous = sequenceAt(program, timeMS);
    const localFraction = previous.elapsedMS / program.stages[previous.stageIndex].durationMS;
    const oldMode = program.config.mode;
    const oldFrequency = program.atom.values.detuningReference;
    program = compileSequence(config);
    let nextTime = 0;
    if (oldMode !== program.config.mode) {
      activePhase = 0;
      makePhaseButtons();
    } else {
      const stage = program.stages[previous.stageIndex];
      nextTime = stage.startMS + localFraction * stage.durationMS;
    }
    pause(); valid = true; error.textContent = '';
    if (redrawFields || oldFrequency !== program.atom.values.detuningReference) makeFields();
    if (activePhase === 0 && program.config.mode !== 'blue-only')
      note.textContent = program.config.greenDuringLoad === false ?
        '装载期间使用 399 nm 光。交接开始时开启 556 nm，蓝光在设定时间内关断。' : phases[0].note;
    if (redrawFields) makeAtomFields();
    refreshLabels(); drawTraces(); applyAvailability();
    onChange?.({ ...program.config }, program);
    setTime(nextTime);
  }
  function readInputs() {
    const config = { ...program.config };
    for (const input of form.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      if (key === 'greenDuringLoad') {
        const enabled = input.value === 'true';
        if (!enabled || Object.hasOwn(config,key)) config[key] = enabled;
      } else config[key] = input.tagName === 'SELECT' ? input.value : input.valueAsNumber;
    }
    for (const input of atomFields.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      if (!input.checkValidity()) throw new RangeError(input.validationMessage);
      const value = input.tagName === 'SELECT' ? input.value : input.value === '' ? null : input.valueAsNumber;
      if (value !== program.atom.values[key] || Object.hasOwn(config,key)) config[key] = value;
    }
    host.querySelectorAll('[data-gate]').forEach(input => { config[input.dataset.gate] = input.checked; });
    return config;
  }
  function handleEdit(commit) {
    let config;
    try { config = readInputs(); compileSequence(config); }
    catch (err) { invalidate(err.message); return; }
    const changed = Object.keys(config).some(key => config[key] !== program.config[key]);
    if ((commit && changed) || (!valid && (commit || !changed))) applyConfig(config, false);
  }
  for (const [i, c] of channels.entries()) {
    const row = element('div', 'seq-lane seq-' + c.tone);
    const plot = element('div', 'seq-plot'), graphic = document.createElementNS(svgNS, 'svg');
    graphic.setAttribute('viewBox', '0 0 1000 32'); graphic.setAttribute('preserveAspectRatio', 'none');
    graphic.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path'), dividers = document.createElementNS(svgNS, 'path');
    dividers.setAttribute('class', 'seq-dividers'); path.setAttribute('class', 'seq-trace');
    graphic.append(dividers, path); plot.append(graphic);
    const output = element('output', 'seq-value');
    row.append(element('span', 'seq-label', c.label), plot, output); get('.seq-lanes').append(row);
    reader[i] = { output, path, dividers, row };
  }
  function seekAtPointer(event) {
    const rect = rulerTicks.getBoundingClientRect();
    setTime(physicalTime((event.clientX - rect.left) / rect.width));
  }
  listen(chart, 'pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !event.target.closest('.seq-ruler, .seq-plot')) return;
    event.preventDefault();
    if (!enabled || !valid) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && host.contains(focused)) focused.blur();
    if (!enabled || !valid) return;
    chart.setPointerCapture(event.pointerId);
    pause();
    seekAtPointer(event);
  });
  listen(chart, 'pointermove', event => {
    if (enabled && valid && chart.hasPointerCapture(event.pointerId)) seekAtPointer(event);
  });
  function makePhaseButtons() {
    phaseButtons.length = 0;
    for (const s of program.stages) {
      const button = element('button', 'seq-phase');
      button.type = 'button'; button.dataset.stage = s.id;
      button.append(element('span', '', s.label), element('small', '', seconds(s.durationMS)));
      phaseButtons.push(button);
    }
    get('.seq-phase-controls').replaceChildren(...phaseButtons);
  }
  makePhaseButtons();
  listen(get('.seq-phase-controls'), 'click', event => {
    const button = event.target.closest('button[data-stage]');
    if (!button) return;
    if (!valid) { form.querySelector(':invalid')?.focus(); return; }
    activePhase = phaseButtons.indexOf(button);
    makeFields(); refreshLabels(); pause(); setTime(program.stages[activePhase].startMS);
  });
  listen(form, 'input', () => handleEdit(false));
  listen(form, 'change', () => handleEdit(true));
  listen(atomFields,'input',() => handleEdit(false));
  listen(atomFields,'change',() => handleEdit(true));
  host.querySelectorAll('[data-gate]').forEach(input => listen(input, 'change', () => handleEdit(true)));
  function restorePreset() {
    activePhase = 0;
    applyConfig(activePreset.config, true);
    setTime(0);
  }
  listen(presetSelect, 'change', () => {
    activePreset = SEQUENCE_PRESETS.find(preset => preset.id === presetSelect.value) ?? importedPreset;
    onPreset?.(activePreset.id);
    restorePreset();
  });
  listen(get('[data-action=reset]'), 'click', restorePreset);
  listen(get('.seq-scale select'), 'change', event => {
    pause(); scale = event.target.value; drawTraces(); setTime(timeMS);
  });
  listen(play, 'click', () => {
    if (playback) { pause(); return; }
    if (timeMS >= program.durationMS) setTime(0);
    play.textContent = '暂停'; play.setAttribute('aria-pressed', 'true');
    lastTick = performance.now(); playback = requestAnimationFrame(tick);
  });
  listen(slider, 'input', () => { pause(); setTime(physicalTime(slider.valueAsNumber / 10000)); });
  listen(cursorInput, 'change', () => {
    if (!cursorInput.validity.valid) { cursorInput.reportValidity(); return; }
    pause(); setTime(cursorInput.valueAsNumber);
  });
  listen(cursorInput, 'blur', () => { cursorInput.value = fmt(timeMS); });
  listen(document, 'visibilitychange', () => { if (document.hidden) pause(); });
  makeFields(); refreshLabels(); drawTraces(); setTime(0, false);
  return {
    setTime, pause, setImagingGate,
    setAtomTier(tier) {
      if (tier === atomTier) return false;
      atomTier = tier;
      if (!valid) {
        valid = true;
        error.textContent = '';
        makeFields();
        applyAvailability();
      }
      makeAtomFields();
      drawTraces();
      setTime(timeMS,false);
      return true;
    },
    setEnabled(value) { enabled = Boolean(value); if (!enabled) pause(); applyAvailability(); },
    replace(config, {presetId, name = '导入时序'} = {}) {
      activePreset = presetId === 'imported' ? null :
        SEQUENCE_PRESETS.find(preset => preset.id === presetId && preset.config.mode === config.mode) ?? matchingSequencePreset(config);
      presetSelect.querySelector('option[value="imported"]')?.remove();
      importedPreset = null;
      if (!activePreset) {
        importedPreset = {id:'imported', name, config:{...config}};
        activePreset = importedPreset;
        presetSelect.add(new Option(name, activePreset.id));
      }
      presetSelect.value = activePreset.id;
      onPreset?.(activePreset.id);
      applyConfig(config, true);
    },
    getPreset() { return activePreset; },
    getConfig() { return { ...program.config }; },
    destroy() { pause(); events.abort(); host.replaceChildren(); },
  };
}
