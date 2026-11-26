const svgNS = 'http://www.w3.org/2000/svg';
const height = 254, plotLeft = 55, plotRight = 12, bandHeight = 68;
const countFormat = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:0});
const timeFormat = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:3, useGrouping:false});

function svgElement(tag, attributes, text) {
  const el = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

function axisValue(value) {
  if (value === 0) return '0';
  return value >= 1e4 || value < .01 ? value.toExponential(1) : String(+value.toPrecision(3));
}

const percent = new Intl.NumberFormat('zh-CN', {style:'percent', maximumFractionDigits:1});

export function retentionScale(values, loaded) {
  const peak = Math.max(loaded, ...values);
  const ticks = [0, loaded/Math.E, loaded];
  if (peak > 1.15*loaded) ticks.push(peak);
  return {fraction:value => value/peak, ticks, tickLabel:value => percent.format(value/loaded), label:'线性刻度'};
}

export function linearScale(values) {
  const max = Math.max(0, ...values);
  return {fraction:value => value/(max || 1), ticks:max > 0 ? [0,max/2,max] : [0],
    label:'线性刻度'};
}

export function mountSequenceCurves(section, onSeek) {
  const select = section.querySelector('#seq-curve-stage');
  const plot = section.querySelector('#seq-curve-plot');
  const area = section.querySelector('#seq-curve-area');
  const axes = section.querySelector('.seq-curve-axes');
  const cursor = section.querySelector('#seq-curve-cursor');
  const timeOutput = section.querySelector('#seq-curve-time');
  const atomMarker = svgElement('circle', {id:'seq-curve-atom-marker', r:3.5, visibility:'hidden',
    fill:'var(--lime)', stroke:'var(--panel)', 'aria-hidden':'true'});
  area.before(atomMarker);
  const atomOutput = section.querySelector('#seq-curve-atoms');
  const psdOutput = section.querySelector('#seq-curve-psd');
  const loadingTime = section.querySelector('#seq-curve-tau-loading');
  const lossTime = section.querySelector('#seq-curve-tau-loss');
  const decayButton = section.querySelector('#seq-show-decay');
  const lossValues = section.querySelector('#seq-loss-values');
  const sampling = section.querySelector('#seq-loss-sampling');
  const guides = plot.querySelector('.seq-loss-guides');
  let points = [], stages = [], start = 0, end = 0, time = 0, width = 0;
  let cursorAtoms = null, atomY = null;
  let loaded = 0, cutoff = 0, crossing = null, previousRange = 'all';

  function updateLossReadout(loss) {
    crossing = loss?.status === 'reached' ? points.find(p => p.timeMS === cutoff + loss.timeMS && !p.leftLimit) : null;
    if (loss?.status === 'reached' && !crossing) throw new Error('原子数曲线缺少首次降至 1/e 的模拟读数。');
    const bracket = loss?.bracketMS;
    sampling.hidden = !bracket;
    sampling.textContent = bracket ? '上一帧高于阈值，下一帧已降至阈值以下。读数范围为这两次采样之间的时间。' : '';
    decayButton.disabled = !(loaded > 0);
    select.querySelector('[value="decay"]').disabled = decayButton.disabled;
    if (loss?.status === 'empty' && select.value === 'decay') select.value = 'all';
    lossValues.replaceChildren();
    lossValues.hidden = decayButton.disabled;
    if (lossValues.hidden) return;
    const final = points.at(-1);
    function reading(name, at, count, marker) {
      const item = document.createElement('span');
      if (marker) item.dataset.marker = marker;
      item.textContent = name + ' ' + timeFormat.format(at) + ' ms · ' +
        (count >= 1 ? countFormat.format(count) : axisValue(count)) + ' 个（' + percent.format(count/loaded) + '）';
      lossValues.append(item);
    }
    reading('关源', cutoff, loaded, 'shutoff');
    if (crossing) reading('首次 ≤ 1/e', crossing.timeMS, crossing.atoms, 'crossing');
    if (crossing?.timeMS !== final.timeMS) reading('观测结束', final.timeMS, final.atoms);
  }

  function xAt(t) {
    return plotLeft + (t-start)/(end-start) * (width-plotLeft-plotRight);
  }
  function updateCursor() {
    const inRange = points.length && time >= start && time <= end && end > start;
    cursor.style.display = inRange ? '' : 'none';
    if (inRange) {
      cursor.setAttribute('x1', xAt(time));
      cursor.setAttribute('x2', xAt(time));
    }
    const showAtom = inRange && atomY && Number.isFinite(cursorAtoms);
    atomMarker.setAttribute('visibility', showAtom ? 'visible' : 'hidden');
    if (showAtom) {
      atomMarker.setAttribute('cx', xAt(time));
      atomMarker.setAttribute('cy', atomY(cursorAtoms));
      atomMarker.dataset.value = String(cursorAtoms);
    } else delete atomMarker.dataset.value;
    plot.setAttribute('aria-valuenow', Math.min(end, Math.max(start, time)));
    timeOutput.textContent = select.value === 'decay' && time >= cutoff
      ? '关源后 ' + timeFormat.format(time-cutoff) + ' ms' : timeFormat.format(time) + ' ms';
    plot.setAttribute('aria-valuetext', timeOutput.textContent);
  }

  function render() {
    width = plot.clientWidth;
    if (width <= plotLeft + plotRight) return;
    const decay = select.value === 'decay';
    const stage = stages.find(s => s.id === select.value);
    start = decay ? cutoff : stage?.startMS ?? 0;
    end = stage?.endMS ?? stages.at(-1)?.endMS ?? 0;
    const visible = points.filter(p => p.timeMS >= start && p.timeMS <= end && !(p.leftLimit && p.timeMS === start));
    const graphWidth = width - plotLeft - plotRight;
    plot.setAttribute('viewBox', [0,0,width,height].join(' '));
    plot.setAttribute('aria-valuemin', start);
    plot.setAttribute('aria-valuemax', end);
    plot.tabIndex = visible.length ? 0 : -1;
    select.disabled = !points.length;
    decayButton.setAttribute('aria-pressed',String(decay));
    decayButton.textContent = decay ? '返回原时间范围' : '查看关源衰减';
    axes.replaceChildren();
    guides.replaceChildren();
    const line = (x1,y1,x2,y2) => axes.append(svgElement('line',{x1,y1,x2,y2}));
    function label(x,y,text,anchor = 'start') {
      axes.append(svgElement('text', {x,y,'text-anchor':anchor}, text));
    }
    function drawBand(key, title, top, path, size = bandHeight) {
      const values = visible.map(p => p[key]).filter(Number.isFinite);
      const scale = decay && loaded > 0 ? retentionScale(values, loaded) : linearScale(values);
      const yAt = value => top + size * (1 - scale.fraction(value));
      label(3, top-8, title + ' · ' + scale.label);
      for (const tick of scale.ticks) {
        const y = yAt(tick);
        line(plotLeft, y, width-plotRight, y);
        if (values.length) label(plotLeft-5,y+4,(scale.tickLabel ?? axisValue)(tick), 'end');
      }
      if (!values.length) label(plotLeft+6, top+bandHeight/2-5, points.length ? '无可用数据' : '等待模拟数据');
      const commands = [];
      let move = true;
      for (const p of visible) {
        if (!Number.isFinite(p[key])) { move = true; continue; }
        commands.push((move ? 'M' : 'L') + xAt(p.timeMS).toFixed(2) + ',' + yAt(p[key]).toFixed(2));
        move = false;
      }
      path.setAttribute('d', commands.join(' '));
      return yAt;
    }

    atomY = drawBand('atoms',decay ? '关源后留存比例 N / N关源' : '阱内原子数 / 个',24,
      plot.querySelector('.seq-atoms-trace'), decay ? 180 : bandHeight);
    const psdPath = plot.querySelector('.seq-psd-trace');
    if (decay) psdPath.removeAttribute('d');
    else drawBand('psd','峰值 PSD / 无量纲',136,psdPath);
    if (loaded > 0 && end > start && end >= cutoff) {
      const target = loaded/Math.E, atTarget = atomY(target);
      const left = Math.max(start, cutoff);
      // 仅在当前纵轴范围内显示阈值，以免超出原子数绘图区。
      if (left < end && atTarget >= 24 && atTarget <= (decay ? 204 : 24+bandHeight))
        guides.append(svgElement('line',{x1:xAt(left),x2:xAt(end),y1:atTarget,y2:atTarget}));
      if (cutoff >= start && cutoff <= end)
        guides.append(svgElement('rect',{x:xAt(cutoff)-3,y:atomY(loaded)-3,width:6,height:6}));
      if (crossing && crossing.timeMS >= start && crossing.timeMS <= end)
        guides.append(svgElement('circle',{cx:xAt(crossing.timeMS),cy:atomY(crossing.atoms),r:4}));
    }
    if (end > start) {
      const intervals = Math.min(5, Math.max(1, Math.floor(graphWidth/95)));
      for (let i=0; i<=intervals; i++) {
        const fraction = i/intervals, t = start+(end-start)*fraction, x = xAt(t);
        line(x,204,x,208);
        label(x,222,timeFormat.format(decay ? t-cutoff : t),i === 0 ? 'start' : i === intervals ? 'end' : 'middle');
      }
      label(plotLeft + graphWidth/2,245,decay ? '关源后时间 / ms' : '实验时间 / ms','middle');
    }
    for (const [name,value] of Object.entries({x:plotLeft,y:24,width:graphWidth,height:180}))
      area.setAttribute(name, value);
    cursor.setAttribute('y1',24); cursor.setAttribute('y2',204);
    updateCursor();
  }

  function seekPointer(event) {
    const box = area.getBoundingClientRect();
    if (!box.width || !points.length) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX-box.left)/box.width));
    onSeek(start + fraction*(end-start));
  }
  area.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !points.length) return;
    event.preventDefault();
    plot.focus({preventScroll:true});
    area.setPointerCapture(event.pointerId);
    seekPointer(event);
  });
  area.addEventListener('pointermove', event => {
    if (area.hasPointerCapture(event.pointerId)) seekPointer(event);
  });
  plot.addEventListener('keydown', event => {
    if (!points.length) return;
    const step = (end-start)/100;
    const next = {ArrowLeft:time-step, ArrowRight:time+step, Home:start, End:end}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onSeek(Math.min(end, Math.max(start, next)));
  });
  function showRange() {
    render();
    if (time < start || time > end) onSeek(start);
  }
  select.addEventListener('change', () => {
    if (select.value !== 'decay') previousRange = select.value;
    showRange();
  });
  decayButton.addEventListener('click', () => {
    if (select.value === 'decay') select.value = previousRange;
    else { previousRange = select.value; select.value = 'decay'; }
    showRange();
  });
  const observer = new ResizeObserver(render);
  observer.observe(plot);

  return {
    setSeries(series, sequenceStages, timeConstants, loadedAtoms) {
      if (stages !== sequenceStages) {
        const previous = select.value;
        select.replaceChildren(new Option('完整时序', 'all'), new Option('关源衰减', 'decay'),
          ...sequenceStages.map(s => new Option(s.label,s.id)));
        select.value = previous === 'decay' || sequenceStages.some(s => s.id === previous) ? previous : 'all';
        if (!sequenceStages.some(s => s.id === previousRange)) previousRange = 'all';
      }
      points = series; stages = sequenceStages;
      loaded = loadedAtoms ?? 0;
      cutoff = sequenceStages[0].endMS;
      setTimeConstant(loadingTime, timeConstants?.loading, '无原子装载');
      setTimeConstant(lossTime, timeConstants?.loss, '关源时阱内无原子');
      updateLossReadout(timeConstants?.loss);
      render();
    },
    setCursor(t, atoms, psd) {
      time = t;
      cursorAtoms = atoms;
      for (const [output, value] of [[atomOutput, atoms], [psdOutput, psd]]) {
        if (Number.isFinite(value)) {
          output.dataset.value = String(value);
          output.textContent = output === atomOutput && value >= 1 ? countFormat.format(value) : axisValue(value);
        } else {
          delete output.dataset.value;
          output.textContent = '—';
        }
      }
      updateCursor();
    },
    destroy() { observer.disconnect(); },
  };
}

function setTimeConstant(output, reading, emptyText) {
  const status = reading?.status ?? 'unavailable';
  output.dataset.status = status;
  if (status === 'reached' || status === 'lower-bound') {
    const {timeMS} = reading;
    const lowerBound = status === 'lower-bound';
    const value = lowerBound ? timeMS : Number(timeMS.toPrecision(5));
    output.dataset.value = String(timeMS);
    if (reading.bracketMS) {
      const [start, end] = reading.bracketMS;
      const digits = Math.max(0, Math.min(9, 2 - Math.floor(Math.log10(end-start))));
      output.textContent = +start.toFixed(digits) + '–' + +end.toFixed(digits) + ' ms';
    } else output.textContent = (lowerBound ? '> ' : '') + value + ' ms';
    return;
  }
  delete output.dataset.value;
  const messages = {unavailable:'暂无模拟数据', empty:emptyText, 'no-steady-state':'无有限稳态', 'out-of-range':'超出数值范围',
    'sampled-loading':'逐轨迹装载'};
  output.textContent = messages[status];
}
