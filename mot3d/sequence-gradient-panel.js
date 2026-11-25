import { SEQUENCE_FIELDS } from './sequence.js';

const objectiveUnits = {psd:'', atoms:' 个', temperatureUK:' µK', rmsRadiusMM:' mm'};
const format = new Intl.NumberFormat('zh-CN', {maximumSignificantDigits:6});

export function mountGradientPanel(section, {getCursor, onStart, onStop, onApply, onInvalidate}) {
  const form = section.querySelector('form');
  const {objective, direction, timeMS, maxEvaluations} = form.elements;
  const settings = form.querySelector('fieldset');
  const checks = form.querySelector('.seq-opt-checks');
  const results = section.querySelector('.seq-opt-results');
  const parameters = section.querySelector('.seq-opt-params');
  const item = name => section.querySelector('[data-opt="' + name + '"]');
  const start = item('start'), stop = item('stop'), apply = item('apply');
  let keys = [], ready = false, running = false, canApply = false, autoTime = true, report = '';

  function selectedKeys() {
    return Array.from(checks.querySelectorAll('input:checked'), field => field.value);
  }
  function refreshButtons() {
    const chosen = selectedKeys();
    const selection = chosen.length <= 2 ? chosen.map(key => SEQUENCE_FIELDS[key][0]).join('、') : '已选 ' + chosen.length + ' 项';
    item('selection').textContent = '（' + (selection || '尚未选择') + '）';
    start.disabled = !ready || running || !chosen.length || !form.checkValidity();
    stop.disabled = !running;
    apply.disabled = !ready || running || !canApply;
    let hint = '';
    if (!ready) hint = '等待当前时序准备就绪。';
    else if (!chosen.length) hint = '请选择至少一个操作变量。';
    else if (!timeMS.validity.valid) hint = '目标时刻须在 0 至 ' + timeMS.max + ' ms 之间。';
    else if (!maxEvaluations.validity.valid) hint = '最多试算次数须为大于等于 2 的整数。';
    item('status').textContent = report || hint;
  }
  function setContext(program, valid) {
    ready = valid;
    const offered = Object.keys(SEQUENCE_FIELDS).filter(key => Number.isFinite(program.config[key]));
    if (offered.join() !== keys.join()) {
      const previous = selectedKeys().filter(key => offered.includes(key));
      const initial = offered.includes('compressMHz') ? 'compressMHz' : 'blueDetuningMHz';
      const chosen = previous.length ? previous : [initial];
      keys = offered;
      checks.replaceChildren(...keys.map(key => {
        const [name, unit] = SEQUENCE_FIELDS[key];
        const label = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.name = 'variable'; checkbox.value = key;
        checkbox.checked = chosen.includes(key);
        label.append(checkbox, document.createTextNode(name + ' / ' + unit));
        return label;
      }));
    }
    timeMS.max = String(program.durationMS);
    if (autoTime) timeMS.value = timeMS.max;
    refreshButtons();
  }
  function setState({running:active = false, message = '', iteration = 0, evaluations = 0,
    initialValue = null, bestValue = null, bestConfig = null, canApply:applicable = false} = {}) {
    running = active;
    canApply = applicable;
    settings.disabled = running;
    const progress = evaluations > 0 ? '迭代 ' + iteration + ' 次 · 已试算 ' + evaluations + ' 次' : '';
    report = [message, progress].filter(Boolean).join(' · ');
    results.hidden = !Number.isFinite(initialValue) && !Number.isFinite(bestValue);
    for (const [name, value] of [['initial',initialValue],['best',bestValue]]) {
      const output = item(name);
      output.textContent = Number.isFinite(value) ? format.format(value) + objectiveUnits[objective.value] : '—';
      if (Number.isFinite(value)) output.dataset.value = String(value);
      else delete output.dataset.value;
    }
    parameters.replaceChildren();
    if (bestConfig) {
      for (const key of selectedKeys()) {
        if (!Number.isFinite(bestConfig[key])) continue;
        const [label, unit] = SEQUENCE_FIELDS[key];
        const name = document.createElement('dt'), value = document.createElement('dd');
        name.textContent = label;
        value.textContent = format.format(bestConfig[key]) + ' ' + unit;
        parameters.append(name, value);
      }
    }
    refreshButtons();
  }
  function invalidate() {
    setState();
    onInvalidate?.();
  }
  form.addEventListener('input', event => {
    if (event.target === timeMS) autoTime = false;
    invalidate();
  });
  item('cursor').addEventListener('click', () => {
    autoTime = false;
    timeMS.value = String(getCursor());
    invalidate();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (start.disabled || !form.reportValidity()) return;
    onStart({variables:selectedKeys(), objective:objective.value, direction:direction.value,
      timeMS:timeMS.valueAsNumber, maxEvaluations:maxEvaluations.valueAsNumber});
  });
  stop.addEventListener('click', () => onStop());
  apply.addEventListener('click', () => onApply());
  return {setContext, setState};
}
