import {experimentControls, readControl} from './sequence-controls.js';
import {sequenceObjectives} from './sequence-objectives.js';

const format = new Intl.NumberFormat('zh-CN', {maximumSignificantDigits:6});
const selectedGroup = '__selected__';

function numberText(value, unit = '') {
  if (unit === '0 / 1') return value ? '1（是）' : '0（否）';
  const magnitude = Math.abs(value);
  const number = magnitude && (magnitude < .001 || magnitude >= 1e8)
    ? value.toExponential(5) : format.format(value);
  return unit ? number + ' ' + unit : number;
}

function controlValue(experiment, field) {
  const value = readControl(experiment, field.id);
  if (field.kind === 'choice') return field.choices.find(choice => choice.value === value).label;
  return numberText(value, field.unit);
}

function categoryOptions(select, entries, includeSelected = false) {
  const previous = select.value;
  const groups = new Set(entries.map(field => field.group));
  const options = [new Option('全部类别', '')];
  if (includeSelected) options.push(new Option('已选操作变量', selectedGroup));
  for (const group of groups) options.push(new Option(group, group));
  select.replaceChildren(...options);
  if (options.some(option => option.value === previous)) select.value = previous;
}

function matches(field, query) {
  return !query || [field.label, field.id, field.unit, field.group].join(' ').normalize('NFKC').toLowerCase().includes(query);
}

export function mountGradientPanel(section, {getCursor, onStart, onStop, onApply, onInvalidate}) {
  const form = section.querySelector('form');
  const {objective, objectiveGroup, objectiveSearch, variableGroup, variableSearch, direction, timeMS, maxEvaluations} = form.elements;
  const settings = form.querySelector('fieldset');
  const checks = form.querySelector('.seq-opt-checks');
  const results = section.querySelector('.seq-opt-results');
  const parameters = section.querySelector('.seq-opt-params');
  const item = name => section.querySelector('[data-opt="' + name + '"]');
  const start = item('start'), stop = item('stop'), apply = item('apply');
  let fields = new Map(), objectives = new Map(), durations = new Set(), experiment;
  let ready = false, running = false, canApply = false, autoTime = true, report = '';

  function selectedKeys() {
    return Array.from(checks.querySelectorAll('input:checked'), field => field.value);
  }

  function displayObjectives(previous) {
    const groups = new Map();
    const query = objectiveSearch.value.trim().normalize('NFKC').toLowerCase();
    for (const field of objectives.values()) {
      if ((objectiveGroup.value && objectiveGroup.value !== field.group) || !matches(field, query)) continue;
      if (!groups.has(field.group)) {
        const group = document.createElement('optgroup');
        group.label = field.group;
        groups.set(field.group, group);
      }
      const label = field.unit ? field.label + ' / ' + field.unit : field.label;
      groups.get(field.group).append(new Option(label, field.id));
    }
    objective.replaceChildren(...groups.values());
    const options = Array.from(objective.options);
    const preferred = options.find(option => option.value === previous) ?? options.find(option => option.value === 'psd');
    if (preferred) objective.value = preferred.value;
    if (!options.length) objective.add(new Option('没有符合筛选条件的目标', ''));
  }

  function displayControls(previous) {
    const groups = new Map();
    for (const field of fields.values()) {
      if (!groups.has(field.group)) {
        const grouping = document.createElement('fieldset'), legend = document.createElement('legend');
        legend.textContent = field.group;
        grouping.append(legend);
        groups.set(field.group, grouping);
      }
      const label = document.createElement('label'), checkbox = document.createElement('input');
      const name = document.createElement('span'), value = document.createElement('span');
      checkbox.type = 'checkbox'; checkbox.name = 'variable'; checkbox.value = field.id;
      checkbox.checked = previous.includes(field.id);
      checkbox.setAttribute('aria-label', field.label + (field.unit ? ' / ' + field.unit : ''));
      name.textContent = field.label;
      value.className = 'seq-opt-current';
      value.id = 'seq-opt-current-' + field.id;
      checkbox.setAttribute('aria-describedby', value.id);
      value.textContent = controlValue(experiment, field);
      label.append(checkbox, name, value);
      groups.get(field.group).append(label);
    }
    checks.replaceChildren(...groups.values());
    filterControls();
  }

  function filterControls() {
    const query = variableSearch.value.trim().normalize('NFKC').toLowerCase();
    let count = 0;
    for (const group of checks.children) {
      let visible = false;
      for (const checkbox of group.querySelectorAll('input')) {
        const field = fields.get(checkbox.value);
        const selected = variableGroup.value === selectedGroup ? checkbox.checked :
          !variableGroup.value || variableGroup.value === field.group;
        const show = selected && matches(field, query);
        checkbox.parentElement.hidden = !show;
        if (show) { visible = true; count++; }
      }
      group.hidden = !visible;
    }
    item('empty-controls').hidden = count > 0;
  }

  function refreshButtons() {
    const chosen = selectedKeys();
    const selection = chosen.length === 1 ? fields.get(chosen[0]).label : '已选 ' + chosen.length + ' 项';
    item('selection').textContent = selection + ' · 共 ' + fields.size + ' 项';
    const target = objectives.get(objective.value);
    const threshold = target?.availableFromMS;
    const tooEarly = Number.isFinite(threshold) && timeMS.valueAsNumber < threshold;
    const requiredMode = target?.requiredImagingMode;
    const modeLabel = requiredMode === 'absorption' ? '吸收成像' : '荧光成像';
    let note = '在目标时刻读取物理量。装载等待期间沿用捕获云快照。';
    if (requiredMode) note = '此读数需要' + modeLabel + '。';
    else if (Number.isFinite(threshold)) note = '当前时序最早可在 ' + format.format(threshold) + ' ms 评估此目标。';
    else if (target?.id.startsWith('input.')) note = '比较每组候选实验的设置值。';
    item('time-note').textContent = note;
    let hint = '';
    if (!ready) hint = '等待当前时序准备就绪。';
    else if (!target) hint = '请更改目标类别或搜索条件以选择目标。';
    else if (!chosen.length) hint = '请选择至少一个操作变量。';
    else if (!timeMS.validity.valid) hint = '目标时刻须在 0 至 ' + timeMS.max + ' ms 之间。';
    else if (tooEarly && !chosen.some(key => durations.has(key))) hint = '请调整目标时刻，或将阶段时长选为操作变量。';
    else if (requiredMode && requiredMode !== experiment.imaging.mode && !chosen.includes('imaging.mode'))
      hint = '请启用' + modeLabel + '，或将成像模式选为操作变量。';
    else if (!maxEvaluations.validity.valid) hint = '最多试算次数须为大于等于 2 的整数。';
    start.disabled = running || Boolean(hint);
    stop.disabled = !running;
    apply.disabled = !ready || running || !canApply;
    item('status').textContent = report || hint;
  }

  function setContext(program, valid, next) {
    const previous = selectedKeys(), previousTarget = objective.value || 'psd';
    const changedMode = experiment && experiment.config.mode !== next.config.mode;
    const first = !experiment;
    experiment = next;
    ready = valid;
    durations = new Set(program.stages.map(stage => stage.id + 'MS'));
    const controls = experimentControls(experiment), targets = sequenceObjectives(experiment);
    fields = new Map(controls.map(field => [field.id, field]));
    objectives = new Map(targets.map(field => [field.id, field]));
    if (changedMode) {
      objectiveGroup.value = ''; objectiveSearch.value = '';
      variableGroup.value = ''; variableSearch.value = '';
    }
    categoryOptions(objectiveGroup, targets);
    categoryOptions(variableGroup, controls, true);
    const chosen = previous.filter(key => fields.has(key));
    if (first || (changedMode && previous.length && !chosen.length))
      chosen.push(fields.has('compressMHz') ? 'compressMHz' : 'blueDetuningMHz');
    displayObjectives(previousTarget);
    displayControls(chosen);
    timeMS.max = String(program.durationMS);
    if (autoTime) timeMS.value = timeMS.max;
    refreshButtons();
  }

  function setState({running:active = false, message = '', iteration = 0, evaluations = 0,
    initialValue = null, bestValue = null, bestExperiment = null, canApply:applicable = false} = {}) {
    running = active;
    canApply = applicable;
    settings.disabled = running;
    const progress = evaluations > 0 ? '迭代 ' + iteration + ' 次 · 已试算 ' + evaluations + ' 次' : '';
    report = [message, progress].filter(Boolean).join(' · ');
    results.hidden = !Number.isFinite(initialValue) && !Number.isFinite(bestValue);
    for (const [name, value] of [['initial',initialValue],['best',bestValue]]) {
      const output = item(name);
      if (Number.isFinite(value)) {
        output.textContent = numberText(value, objectives.get(objective.value).unit);
        output.dataset.value = String(value);
      } else {
        output.textContent = '—';
        delete output.dataset.value;
      }
    }
    parameters.replaceChildren();
    if (bestExperiment) {
      for (const key of selectedKeys()) {
        const field = fields.get(key);
        const name = document.createElement('dt'), value = document.createElement('dd');
        name.textContent = field.label;
        value.textContent = controlValue(bestExperiment, field);
        parameters.append(name,value);
      }
    }
    refreshButtons();
  }

  form.addEventListener('input', event => {
    const field = event.target;
    if (field === variableGroup || field === variableSearch) {
      filterControls();
      return;
    }
    if (field === objectiveGroup || field === objectiveSearch) {
      const previous = objective.value;
      displayObjectives(previous);
      if (objective.value === previous) { refreshButtons(); return; }
    }
    if (field.name === 'variable') filterControls();
    if (field === timeMS) autoTime = false;
    onInvalidate();
  });
  for (const search of [variableSearch, objectiveSearch]) {
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter') event.preventDefault();
    });
  }
  function setTargetTime(value) {
    autoTime = false;
    timeMS.value = String(value);
    refreshButtons();
  }
  item('cursor').addEventListener('click', () => {
    setTargetTime(getCursor());
    onInvalidate();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (start.disabled || !form.reportValidity()) return;
    onStart({variables:selectedKeys(), objective:objective.value, direction:direction.value,
      timeMS:timeMS.valueAsNumber, maxEvaluations:maxEvaluations.valueAsNumber});
  });
  stop.addEventListener('click', onStop);
  apply.addEventListener('click', onApply);
  return {setContext, setState, setTargetTime};
}
