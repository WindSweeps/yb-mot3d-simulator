import { createFluorescence, DEFAULT_FLUX, FLUORESCENCE_VIEW } from './fluorescence.js';

const scaleMinimum = 1e6;
const scaleMaximum = 1e14;
const colors = [[23,24,48], [61,66,125], [56,116,162], [98,193,198], [255,235,189]];
const palette = Array.from({length:256}, (_, index) => {
  const position = index / 255 * (colors.length - 1);
  const stop = Math.min(Math.floor(position), colors.length - 2);
  return colors[stop].map((c, i) => Math.round(c + (position - stop) * (colors[stop + 1][i] - c)));
});
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';

function rateText(value) {
  if (value === 0) return '0';
  if (value >= .01 && value < 1e4) return Number(value.toPrecision(3)).toString();
  const [mantissa, exponent] = value.toExponential(2).split('e');
  const power = [...String(Number(exponent))].map(c => c === '-' ? '⁻' : superscripts[Number(c)]).join('');
  return Number(mantissa) + '×10' + power;
}

function powerText(watts) {
  if (!watts) return '0 W';
  const [scale, unit] = [[1,'W'],[1e-3,'mW'],[1e-6,'µW'],[1e-9,'nW'],[1e-12,'pW']].find(([scale]) => watts >= scale) ?? [1e-15,'fW'];
  return rateText(watts / scale) + ' ' + unit;
}

export function mountFluorescence(panel, onFluxChange) {
  const {width, height} = FLUORESCENCE_VIEW;
  const input = panel.querySelector('#incident-flux');
  const canvas = panel.querySelector('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {alpha:false});
  const raster = context.createImageData(width, height);
  const logMinimum = Math.log10(scaleMinimum);
  const logScale = 255 / Math.log10(scaleMaximum / scaleMinimum);
  const empty = panel.querySelector('#fluorescence-empty');
  const outputs = [...panel.querySelectorAll('output')];
  let result = null, projection = null, paintedFrame = -1, paintedFlux = null, flux = DEFAULT_FLUX;

  function setFlux(value) {
    if (!Number.isFinite(value) || value < 0 || value > Number(input.max) * 1e9) throw new RangeError('入射通量超出输入范围。');
    flux = value;
    input.value = String(value / 1e9);
  }
  input.addEventListener('input', () => {
    const value = input.valueAsNumber * 1e9;
    if (input.validity.valid && Number.isFinite(value) && value !== flux) {
      flux = value;
      onFluxChange();
    }
  });
  input.addEventListener('change', () => {
    if (!input.validity.valid) setFlux(flux);
  });

  function setResult(next) {
    result = next;
    projection = null;
    paintedFrame = -1;
    if (next) return;
    context.clearRect(0, 0, width, height);
    for (const output of outputs) {
      output.textContent = '—';
      delete output.dataset.value;
    }
    setMessage('正在计算散射光子数');
  }

  function setMessage(text) {
    empty.textContent = text;
    empty.hidden = !text;
  }

  function sample(frame, image) {
    projection ??= createFluorescence(result);
    return projection.at(frame, flux, image);
  }

  function show(frame) {
    if (!result || (frame === paintedFrame && flux === paintedFlux)) return;
    const values = sample(frame, true);
    const {emittedRate, emittedPowerW, roiRate, loadingRate, image} = values;
    const readings = [
      [emittedRate, rateText(emittedRate) + ' 光子/s'],
      [emittedPowerW, powerText(emittedPowerW)],
      [roiRate, rateText(roiRate) + ' 光子/s'],
      [loadingRate, rateText(loadingRate) + ' 原子/s'],
    ];
    readings.forEach(([value, text], index) => {
      outputs[index].dataset.value = value;
      outputs[index].textContent = text;
    });
    for (let i = 0; i < image.length; i++) {
      const level = image[i] > 0 ? Math.round(Math.max(0, Math.min(255, (Math.log10(image[i]) - logMinimum) * logScale))) : -1;
      const color = level < 0 ? null : palette[level];
      raster.data[4 * i] = color ? color[0] : 8;
      raster.data[4 * i + 1] = color ? color[1] : 12;
      raster.data[4 * i + 2] = color ? color[2] : 20;
      raster.data[4 * i + 3] = 255;
    }
    context.putImageData(raster, 0, 0);
    setMessage(roiRate > 0 ? '' : flux === 0 ? '入射通量为零' : frame === 0 ? '开束时刻 · 初始空阱' : '当前视野内的发射率为零');
    paintedFrame = frame;
    paintedFlux = flux;
  }

  function exportData(frame) {
    let observation = null;
    if (result) {
      const {timeS, emittedRate, emittedPowerW, roiRate, loadingRate} = sample(frame, true);
      observation = {frame, timeS, emittedPhotonsPerS:emittedRate, emittedPowerW,
        roiPhotonsPerS:roiRate, terminalLoadingAtomsPerS:loadingRate};
    }
    return {incidentFluxAtomsPerS:flux, source:'continuous-from-empty', isotope:174,
      wavelengthNM:399, projection:'XZ', view:FLUORESCENCE_VIEW, observation};
  }

  return {setResult, setMessage, setFlux, getFlux:() => flux, show, exportData};
}
