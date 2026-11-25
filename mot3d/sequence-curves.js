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

export function mountSequenceCurves(section, onSeek) {
  const select = section.querySelector('#seq-curve-stage');
  const plot = section.querySelector('#seq-curve-plot');
  const area = section.querySelector('#seq-curve-area');
  const axes = section.querySelector('.seq-curve-axes');
  const cursor = section.querySelector('#seq-curve-cursor');
  const timeOutput = section.querySelector('#seq-curve-time');
  const atomOutput = section.querySelector('#seq-curve-atoms');
  const psdOutput = section.querySelector('#seq-curve-psd');
  const loadingTime = section.querySelector('#seq-curve-tau-loading');
  const lossTime = section.querySelector('#seq-curve-tau-loss');
  let points = [], stages = [], start = 0, end = 0, time = 0, width = 0;

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
    plot.setAttribute('aria-valuenow', Math.min(end, Math.max(start, time)));
    plot.setAttribute('aria-valuetext', timeFormat.format(time) + ' ms');
    timeOutput.textContent = timeFormat.format(time) + ' ms';
  }

  function render() {
    width = plot.clientWidth;
    if (width <= plotLeft + plotRight) return;
    const stage = stages.find(s => s.id === select.value);
    start = stage?.startMS ?? 0;
    end = stage?.endMS ?? stages.at(-1)?.endMS ?? 0;
    const visible = points.filter(p => p.timeMS >= start && p.timeMS <= end);
    const graphWidth = width - plotLeft - plotRight;
    plot.setAttribute('viewBox', [0,0,width,height].join(' '));
    plot.setAttribute('aria-valuemin', start);
    plot.setAttribute('aria-valuemax', end);
    plot.tabIndex = visible.length ? 0 : -1;
    select.disabled = !points.length;
    axes.replaceChildren();
    const line = (x1,y1,x2,y2) => axes.append(svgElement('line',{x1,y1,x2,y2}));
    function label(x,y,text,anchor = 'start') {
      axes.append(svgElement('text', {x,y,'text-anchor':anchor}, text));
    }
    function drawBand(key, title, top, path) {
      const values = visible.map(p => p[key]).filter(Number.isFinite);
      const max = Math.max(0, ...values);
      const min = Math.min(...values);
      // 数量级相差较大时用对数坐标展开正值；含零值的曲线仍可在线性轴读出。
      const logarithmic = key === 'psd' && min > 0 && max/min >= 10;
      const upper = logarithmic ? Math.ceil(Math.log10(max)) : (max || 1);
      const lower = logarithmic ? Math.floor(Math.log10(min)) : 0;
      label(3, top-8, title + (logarithmic ? ' · 对数刻度' : ''));
      for (const fraction of [0,.5,1]) {
        const y = top + bandHeight * (1 - fraction);
        line(plotLeft, y, width-plotRight, y);
        const level = lower + (upper-lower)*fraction;
        if (values.length) label(plotLeft-5,y+4,axisValue(logarithmic ? 10**level : level), 'end');
      }
      if (!values.length) label(plotLeft+6, top+bandHeight/2-5, points.length ? '无可用数据' : '等待模拟数据');
      const commands = [];
      let move = true;
      for (const p of visible) {
        if (!Number.isFinite(p[key])) { move = true; continue; }
        const level = logarithmic ? Math.log10(p[key]) : p[key];
        const y = top+bandHeight*(1-(level-lower)/(upper-lower));
        commands.push((move ? 'M' : 'L') + xAt(p.timeMS).toFixed(2) + ',' + y.toFixed(2));
        move = false;
      }
      path.setAttribute('d', commands.join(' '));
    }

    drawBand('atoms','阱内原子数 / 个',24,plot.querySelector('.seq-atoms-trace'));
    drawBand('psd','峰值 PSD / 无量纲',136,plot.querySelector('.seq-psd-trace'));
    if (end > start) {
      const intervals = Math.min(5, Math.max(1, Math.floor(graphWidth/95)));
      for (let i=0; i<=intervals; i++) {
        const fraction = i/intervals, t = start+(end-start)*fraction, x = xAt(t);
        line(x,204,x,208);
        label(x,222,timeFormat.format(t),i === 0 ? 'start' : i === intervals ? 'end' : 'middle');
      }
      label(plotLeft + graphWidth/2,245,'实验时间 / ms','middle');
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
  select.addEventListener('change', () => {
    render();
    if (time < start || time > end) onSeek(start);
  });
  const observer = new ResizeObserver(render);
  observer.observe(plot);

  return {
    setSeries(series, sequenceStages, timeConstants) {
      if (stages !== sequenceStages) {
        const previous = select.value;
        select.replaceChildren(new Option('完整时序', 'all'), ...sequenceStages.map(s => new Option(s.label,s.id)));
        select.value = sequenceStages.some(s => s.id === previous) ? previous : 'all';
      }
      points = series; stages = sequenceStages;
      setTimeConstant(loadingTime, timeConstants?.loading, '无原子装载');
      setTimeConstant(lossTime, timeConstants?.loss, '关源时阱内无原子');
      render();
    },
    setCursor(t, atoms, psd) {
      time = t;
      for (const [output, value] of [[atomOutput, atoms], [psdOutput, psd]]) {
        if (Number.isFinite(value)) {
          output.dataset.value = String(value);
          output.textContent = output === atomOutput ? countFormat.format(value) : axisValue(value);
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
    output.textContent = (lowerBound ? '> ' : '') + value + ' ms';
    return;
  }
  delete output.dataset.value;
  const messages = {unavailable:'暂无模拟数据', empty:emptyText, 'no-steady-state':'无有限稳态', 'out-of-range':'超出数值范围'};
  output.textContent = messages[status];
}
