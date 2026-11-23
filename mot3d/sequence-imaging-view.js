import { IMAGING_DEFAULTS, simulateImagingFrame, validateImagingSettings as validateModel } from './sequence-imaging.js';

const stages = {
  fluorescence: [
    ['emission', '物方发射', '发射光子/像素', '沿观察方向累加曝光期间发射的光子。'],
    ['signal', '相机荧光帧', '光电子/像素', '发射光经过光学系统，再按总探测效率换算成相机光电子。'],
  ],
  absorption: [
    ['atoms', '有原子帧', '光电子/像素', '399 nm 探针穿过原子云，在相机上形成吸收阴影。'],
    ['reference', '参考帧', '光电子/像素', '移除原子后，以相同探针强度和曝光时间计算参考图像。'],
    ['dark', '暗场帧', '光电子/像素', '关闭探针，记录相机的固定读出偏置。'],
    ['od', '重建光学厚度', 'OD', '两张探针帧分别扣除暗场，得到透射率 T 和光学厚度 −ln T。最低可分辨透射信号取 1 个光电子/像素。'],
  ],
};
const stageKey = mode => mode === 'absorption' ? 'absorptionStage' : 'fluorescenceStage';
const displayLimits = { emission:1e10, signal:1e8, atoms:1e5, reference:1e5, dark:1e5, od:12 };
const gains = [.01, .1, 1, 10, 100];
const controls = [
  ['axis','观察方向',[['y','沿 Y · XZ 平面'],['x','沿 X · YZ 平面'],['z','沿 Z · XY 平面']]],
  ['exposureUS','曝光时间 / µs',1,1000],
  ['band','荧光波段',[['399','399 nm'],['556','556 nm'],['both','399 + 556 nm']]],
  ['fovMM','物方视场宽度 / mm',1,50],
  ['psfSigmaUM','光学点扩散 σ / µm',0,100],
  ['sampleSigmaUM','样本密度平滑 σ / µm',0,200],
  ['detectionEfficiency','荧光总探测效率',0,1],
  ['probeSaturation','探针强度 I / Iₛₐₜ',.001,.05],
  ['displayGain','显示增益',gains.map(g => [String(g),g + ' ×'])],
];
const inputIds = { exposureUS:'exposure', fovMM:'fov', psfSigmaUM:'psf', sampleSigmaUM:'smoothing',
  detectionEfficiency:'efficiency', probeSaturation:'probe', displayGain:'gain' };
const grey = [[0,0,0],[255,255,255]];
const heat = [[8,14,22],[19,57,84],[38,127,156],[113,212,200],[255,242,185]];

export function validateImagingSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('成像设置须为对象。');
  const mode = input.mode ?? IMAGING_DEFAULTS.mode;
  if (!['off','fluorescence','absorption'].includes(mode)) throw new RangeError('成像模式无效。');
  const model = validateModel({ ...IMAGING_DEFAULTS, ...input, mode:mode === 'off' ? 'fluorescence' : mode });
  const settings = { ...model, mode, fluorescenceStage:input.fluorescenceStage ?? 'signal',
    absorptionStage:input.absorptionStage ?? 'od', displayGain:input.displayGain ?? 1 };
  for (const type of Object.keys(stages)) {
    if (!stages[type].some(([key]) => key === settings[stageKey(type)])) throw new RangeError('成像步骤无效。');
  }
  if (!gains.includes(settings.displayGain)) throw new RangeError('成像显示增益无效。');
  return settings;
}

function lut(stops) {
  return Array.from({length:256}, (_, i) => {
    const level = i / 255 * (stops.length-1), a = Math.min(Math.floor(level), stops.length-2);
    return stops[a].map((v, j) => Math.round(v+(stops[a+1][j]-v)*(level-a)));
  });
}
const palettes = { grey:lut(grey), heat:lut(heat) };
const format = v => Number.isFinite(v) ? (Math.abs(v) >= 100000 || (Math.abs(v) < .001 && v !== 0)
  ? v.toExponential(2) : Number(v.toPrecision(4)).toLocaleString('zh-CN', { maximumFractionDigits:5 })) : '—';
const clockFormat = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3});

export function mountImagingPanel(host, { onSettingsChange, onValidityChange, onReplayStart, onShowFinal } = {}) {
  const initial = validateImagingSettings();
  let settings = initial, live = null, frozen = null, sequenceTimer = 0, replayIndex = 0;
  let timer = 0, animation = 0, lastPaint = -Infinity, version = 0, calculated = -1;
  let image = null, raster = null, valid = true, destroyed = false, visible = false;
  const events = new AbortController();
  const listen = (el,type,fn) => el.addEventListener(type,fn,{signal:events.signal});
  const el = selector => host.querySelector(selector);
  host.classList.add('seq-imager');
  host.innerHTML = `
    <div class="si-head"><h2>相机成像</h2><select id="seq-imaging-mode" aria-label="成像模式">
      <option value="fluorescence">荧光成像</option><option value="absorption">吸收成像</option><option value="off">关闭成像</option>
    </select></div>
    <div class="si-body">
      <div class="si-step-controls"><label>成像步骤<select id="seq-image-stage" aria-label="成像步骤"></select></label>
        <button type="button" id="seq-image-replay" class="small-button">回放成像步骤</button></div>
      <div class="si-output">
        <figure class="si-figure">
          <div class="si-y-title"></div>
          <div class="si-vertical"><span class="si-high"></span><span>0</span><span class="si-low"></span></div>
          <div class="si-detector"><canvas id="seq-imaging-canvas" width="128" height="128" role="img" aria-label="模拟相机图像"></canvas>
            <span class="si-blank"></span></div>
          <div class="si-horizontal"><span class="si-low"></span><span class="si-x-title"></span><span class="si-high"></span></div>
        </figure>
        <div class="si-readings">
          <p id="seq-imaging-status" class="si-clock"></p>
          <div class="si-scale"><div class="si-colorbar"></div><div class="si-ticks"><span>0</span><span class="si-mid"></span><span class="si-max"></span></div>
            <span class="si-scale-caption"></span></div>
          <div class="si-reading"><span>图像峰值</span><output id="seq-imaging-value"></output></div>
          <div class="si-reading"><span class="si-total-label"></span><output id="seq-imaging-total"></output></div>
          <p class="si-frame-help"></p><p class="si-size"></p>
          <button type="button" class="small-button si-final" id="seq-imaging-final" hidden>查看压缩末态</button>
        </div>
      </div>
      <details class="si-settings"><summary>曝光与成像参数</summary><div class="si-fields"></div><p class="si-assumptions"></p></details>
      <p class="si-error" role="status" hidden></p>
    </div>`;
  const modeInput = el('#seq-imaging-mode'), stageInput = el('#seq-image-stage');
  const replay = el('#seq-image-replay'), body = el('.si-body'), blank = el('.si-blank');
  const canvas = el('canvas'), ctx = canvas.getContext('2d', {alpha:false});
  const fieldGrid = el('.si-fields'), peakOutput = el('#seq-imaging-value'), totalOutput = el('#seq-imaging-total'), error = el('.si-error');
  const fields = new Map();
  for (const [key,label,options,max] of controls) {
    const wrap = document.createElement('label');
    wrap.append(label);
    const select = Array.isArray(options);
    const field = document.createElement(select ? 'select' : 'input');
    field.id = 'seq-imaging-' + (inputIds[key] ?? key);
    field.name = key;
    if (select) {
      for (const [value,title] of options) field.add(new Option(title,value));
    } else {
      field.type = 'number'; field.required = true; field.step = 'any';
      field.min = String(options); field.max = String(max);
    }
    wrap.append(field); fieldGrid.append(wrap); fields.set(key,field);
  }

  function syncControls() {
    const {mode} = settings;
    modeInput.value = mode; body.hidden = mode === 'off';
    for (const [key,field] of fields) {
      field.value = String(settings[key]);
      const hidden = (key === 'probeSaturation' && mode !== 'absorption') ||
        (['band','detectionEfficiency'].includes(key) && mode !== 'fluorescence');
      field.parentElement.hidden = field.disabled = hidden;
    }
    if (mode === 'off') return;
    stageInput.replaceChildren(...stages[mode].map(([key,title]) => new Option(title,key)));
    stageInput.value = settings[stageKey(mode)];
    const absorption = mode === 'absorption';
    el('.si-total-label').textContent = absorption ? '全视场探针衰减' : '全视场荧光信号';
    el('.si-assumptions').textContent = (absorption
      ? '曝光按游标时刻冻结阱内原子，假设熄灭冷却光后以均匀的 399 nm 共振弱探针成像。三帧采用同一曝光，读出偏置取每像素 12 个光电子，透过率与量子效率乘积取 0.5。'
      : '在截至游标的曝光时间内，累加所选波段的逐原子散射光。总探测效率包括收集立体角、光路透过率和量子效率。') +
      ' 视场以曝光结束时的磁场零点为中心，梯度为零时使用线圈几何中心。计算相机信号时，每条阱内轨迹代表的原子数随当前阶段的单体与双体损失更新。图像显示期望信号。';
  }

  function setValid(value, message = '') {
    const changed = valid !== value;
    valid = value; error.hidden = !message; error.textContent = message;
    if (changed) onValidityChange?.(value);
  }
  function stopReplay() {
    if (sequenceTimer) clearInterval(sequenceTimer);
    if (frozen) version++;
    frozen = null; sequenceTimer = 0; replayIndex = 0;
    replay.textContent = '回放成像步骤'; replay.setAttribute('aria-pressed','false');
  }
  function cancelDraw() {
    if (timer) clearTimeout(timer);
    if (animation) cancelAnimationFrame(animation);
    timer = 0; animation = 0;
  }
  function schedule(immediate = false) {
    if (destroyed || !visible) return;
    if (immediate || settings.mode === 'off') cancelDraw();
    if (settings.mode === 'off' || timer || animation) return;
    const queue = () => { timer = 0; animation = requestAnimationFrame(draw); };
    const delay = immediate ? 0 : Math.max(0,80 - (performance.now()-lastPaint));
    if (delay > 0) timer = setTimeout(queue,delay);
    else queue();
  }
  function writeGraphic(values, max, nonlinear, palette) {
    if (!raster || raster.width !== image.size) {
      canvas.width = canvas.height = image.size;
      raster = ctx.createImageData(image.size,image.size);
    }
    const scale = 255 / (nonlinear ? Math.log1p(max) : max);
    for (let i = 0; i < values.length; i++) {
      const level = Math.min(255, Math.max(0, Math.round((nonlinear ? Math.log1p(values[i]) : values[i]) * scale)));
      const color = palette[level], k = i * 4;
      raster.data[k] = color[0]; raster.data[k+1] = color[1]; raster.data[k+2] = color[2]; raster.data[k+3] = 255;
    }
    ctx.putImageData(raster,0,0);
  }
  function draw() {
    animation = 0;
    if (!visible || !host.clientWidth || !host.clientHeight) return;
    lastPaint = performance.now();
    const source = frozen ?? live, {mode} = settings;
    const stage = frozen ? stages[mode][replayIndex][0] : settings[stageKey(mode)];
    stageInput.value = stage;
    const [,label,unit,description] = stages[mode].find(([key]) => key === stage);
    const raw = ['atoms','reference','dark'].includes(stage);
    const nonlinear = mode === 'fluorescence', max = displayLimits[stage] / settings.displayGain;
    const colors = raw || stage === 'signal' ? grey : heat;
    el('.si-colorbar').style.backgroundImage = 'linear-gradient(to right,' + colors.map(rgb => 'rgb('+rgb.join(',')+')').join(',')+')';
    el('.si-mid').textContent = format(nonlinear ? Math.expm1(Math.log1p(max)/2) : max/2);
    el('.si-max').textContent = '≥' + format(max);
    el('.si-scale-caption').textContent = unit + ' · ' + (nonlinear ? 'log(1 + 信号) 色标' : '线性色标');
    el('.si-frame-help').textContent = description;
    const half = settings.fovMM / 2;
    for (const node of host.querySelectorAll('.si-high')) node.textContent = '+' + format(half);
    for (const node of host.querySelectorAll('.si-low')) node.textContent = '−' + format(half);
    const axes = {x:['Y','Z'], y:['X','Z'], z:['X','Y']}[settings.axis];
    el('.si-y-title').textContent = axes[1] + ' / mm';
    el('.si-x-title').textContent = axes[0] + ' / mm';
    canvas.dataset.stage = stage;
    canvas.setAttribute('aria-label',label+'，沿 '+settings.axis.toUpperCase()+' 轴投影');
    const ready = Boolean(source?.sample?.positionsM) && valid && Number.isFinite(source.weight ?? source.sample.weight);
    el('#seq-imaging-final').hidden = !(ready && onShowFinal && source.timeMS === 0 && !source.sample.alive.some(Boolean));
    replay.disabled = !ready;
    const status = el('#seq-imaging-status');
    status.textContent = source ? (frozen ? '曝光回放 · ' : '') + source.stageLabel + ' · ' + clockFormat.format(source.timeMS) + ' ms' : '';
    if (!ready) {
      image = null; calculated = -1;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      blank.textContent = valid ? '等待有效的原子样本与装载参数' : '请检查成像参数';
      blank.hidden = false; peakOutput.textContent = '—'; delete peakOutput.dataset.value;
      totalOutput.textContent = '—'; delete totalOutput.dataset.value;
      el('.si-size').textContent = ''; return;
    }
    if (calculated !== version) {
      const sample = mode === 'fluorescence' ? source.fluorescenceSample(settings.exposureUS) : source.sample;
      image = simulateImagingFrame(sample, settings);
      calculated = version;
    }
    const peak = image.peaks[stage];
    writeGraphic(image.images[stage],max,nonlinear,raw || stage === 'signal' ? palettes.grey : palettes.heat);
    blank.textContent = nonlinear && peak === 0 ? (stage === 'emission' ? '视场内发射光子数为零' : '本次曝光未探测到荧光') : '';
    blank.hidden = !blank.textContent;
    peakOutput.textContent = format(peak) + ' ' + unit; peakOutput.dataset.value = String(peak);
    totalOutput.textContent = format(image.totalSignal) + ' 光电子'; totalOutput.dataset.value = String(image.totalSignal);
    el('.si-size').textContent = image.size + ' × ' + image.size + ' 像素 · ' + format(image.pixelSizeUM) + ' µm/像素' +
      (stage === 'od' && image.clippedPixels ? ' · ' + image.clippedPixels + ' 个像素达到探测上限 OD ' + format(image.odLimit) : '');
  }

  function setSettings(input) {
    const next = validateImagingSettings(input);
    stopReplay(); settings = next; version++;
    setValid(true); syncControls(); schedule(true);
    onSettingsChange?.({...settings});
  }
  function readFields() {
    stopReplay();
    for (const field of fields.values()) {
      if (!field.disabled && !field.checkValidity()) {
        setValid(false,field.parentElement.firstChild.textContent+' 的输入范围为 '+field.min+' 至 '+field.max+'。');
        schedule(true); return;
      }
    }
    let changed = false;
    for (const [key,field] of fields) {
      if (field.disabled) continue;
      const value = ['band','axis'].includes(key) ? field.value : Number(field.value);
      if (settings[key] !== value) {
        settings = {...settings,[key]:value};
        if (key !== 'displayGain') version++;
        changed = true;
      }
    }
    setValid(true); schedule(true);
    if (changed) onSettingsChange?.({...settings});
  }
  listen(modeInput,'change', () => setSettings({...settings,mode:modeInput.value}));
  listen(el('#seq-imaging-final'),'click', () => { stopReplay(); onShowFinal?.(); });
  listen(stageInput,'change', () => {
    const key = stageInput.value;
    stopReplay(); settings = {...settings,[stageKey(settings.mode)]:key}; schedule(true);
    onSettingsChange?.({...settings});
  });
  for (const field of fields.values()) listen(field,field.tagName === 'SELECT' ? 'change' : 'input',readFields);
  listen(replay,'click', () => {
    if (frozen) {
      const step = stages[settings.mode][replayIndex][0];
      stopReplay(); settings = {...settings,[stageKey(settings.mode)]:step}; schedule(true); onSettingsChange?.({...settings}); return;
    }
    if (!live?.sample.positionsM || !valid) return;
    onReplayStart?.();
    frozen = live; version++; replayIndex = 0;
    replay.textContent = '结束回放'; replay.setAttribute('aria-pressed','true'); schedule(true);
    sequenceTimer = setInterval(() => {
      if (replayIndex < stages[settings.mode].length-1) { replayIndex++; schedule(true); }
      else {
        const last = stages[settings.mode][replayIndex][0];
        stopReplay(); settings = {...settings,[stageKey(settings.mode)]:last};
        schedule(true); onSettingsChange?.({...settings});
      }
    },1100);
  });
  const observer = new ResizeObserver(() => {
    const shown = host.clientWidth > 0 && host.clientHeight > 0;
    if (shown === visible) return;
    visible = shown;
    if (shown) schedule(true);
    else cancelDraw();
  });
  observer.observe(host);
  syncControls(); stopReplay();
  return {
    setFrame(frame) {
      live = frame;
      if (frozen && (live?.timeMS !== frozen.timeMS || live?.weight !== frozen.weight ||
          live.sample?.positionsM?.buffer !== frozen.sample.positionsM.buffer)) stopReplay();
      if (!frozen) { version++; schedule(); }
    },
    getSettings:() => ({...settings}), isValid:() => valid, setSettings,
    destroy() { destroyed = true; observer.disconnect(); stopReplay(); cancelDraw(); events.abort(); host.replaceChildren(); },
  };
}
