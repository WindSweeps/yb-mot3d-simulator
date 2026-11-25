import { availableEngines, defaultEngine } from './engines.js';

const sub = (symbol, index) => '<msub><mi>' + symbol + '</mi><mi>' + index + '</mi></msub>';
const sum = index => '<munder><mo>∑</mo><mi>' + index + '</mi></munder>';
const detuning = '<msup><mrow><mo>(</mo><mfrac><mrow><mn>2</mn>' + sub('δ','jq') +
  '</mrow><mi>Γ</mi></mfrac><mo>)</mo></mrow><mn>2</mn></msup>';
const gammaHalf = '<mfrac><mi>Γ</mi><mn>2</mn></mfrac>';
const coupling = '<mrow>' + sub('s','j') + sub('w','jq') + '</mrow>';

function equation(title, expression) {
  return '<div class="engine-equation"><dt>' + title + '</dt><dd>' +
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow>' +
    expression + '</mrow></math></dd></div>';
}

function modelEquations(twoColor, resolved) {
  const shared = resolved ? '' : '<mo>+</mo>' + sum('ℓ') + sub('s','ℓ');
  const denominator = '<mrow><mn>1</mn>' + shared + '<mo>+</mo>' + detuning + '</mrow>';
  const lines = [equation(resolved ? '受激跃迁率' : '单色散射率',
    sub(resolved ? 'W' : 'r','jq') + '<mo>=</mo>' + gammaHalf + '<mfrac>' + coupling + denominator + '</mfrac>')];
  if (resolved) {
    lines.push(equation('局部稳态布居',
      sub('W','q') + '<mo>(</mo>' + sub('p','g') + '<mo>−</mo>' + sub('p','q') + '<mo>)</mo>' +
      '<mo>=</mo>' + sub('Γ','q') + sub('p','q')));
    lines.push(equation('平均光力',
      '<mi mathvariant="bold">F</mi><mo>=</mo>' + sum('jq') + '<mi>ℏ</mi>' + sub('𝐤','j') +
      sub('W','jq') + '<mo>(</mo>' + sub('p','g') + '<mo>−</mo>' + sub('p','q') + '<mo>)</mo>'));
  } else if (twoColor) {
    const ratio = '<mfrac>' + sub('f','c') + '<mrow><mn>1</mn><mo>−</mo>' + sub('f','c') + '</mrow></mfrac>';
    lines.push(equation('共享基态布居',
      sub('p','g') + '<mo>=</mo><mfrac><mn>1</mn><mrow><mn>1</mn><mo>+</mo>' + sum('c') + ratio + '</mrow></mfrac>'));
    lines.push(equation('双色光场中各跃迁的散射率',
      sub('R','c') + '<mo>=</mo>' + sub('Γ','c') + sub('p','g') + ratio));
  } else {
    lines.push(equation('平均光力',
      '<mi mathvariant="bold">F</mi><mo>=</mo>' + sum('jq') + '<mi>ℏ</mi>' + sub('𝐤','j') + sub('r','jq')));
  }
  const branch = '<mo>(</mo>' + sub('b','b0') + '<mo>+</mo>' + sub('b','b2') + '<mo>)</mo>' + sub('R','b') +
    (twoColor ? '<mo>+</mo>' + sub('b','g0') + sub('R','g') : '');
  lines.push(equation('进入暗态的速率', '<mi>κ</mi><mo>=</mo>' + branch));
  return lines.join('');
}

function describe(simulation, engine) {
  const twoColor = simulation === 'two-color', resolved = engine === 'rate-equations';
  const states = twoColor ? '¹P₁ 和 ³P₁ 各有三个磁子能级' : '¹P₁ 有三个磁子能级';
  const light = twoColor ? '399 nm 和 556 nm 光分别激发 ¹P₁ 和 ³P₁' : '399 nm 光激发 ¹P₁';
  const branches = twoColor ? '蓝光经级联进入 ³P₀、³P₂，绿光可经磁偶极跃迁进入 ³P₀。' :
    '蓝光经 D 态级联可进入 ³P₀ 或 ³P₂。';
  const intro = resolved ?
    states + '。在原子当前位置求解各态布居，用吸收与受激发射的净动量推进轨迹。' :
    (twoColor ? '先分别计算 399 nm 和 556 nm 单独照明时的散射率，再按共享的基态布居修正各束光力。' :
      '六束 399 nm 光共同产生饱和。各束散射率由原子位置、速度、偏振与局部磁场决定。');
  const terms = '<var>j</var> 表示光束，<var>s<sub>j</sub></var> 是局部饱和参数，' +
    '<var>w<sub>jq</sub></var> 是偏振权重。有效失谐 <var>δ<sub>jq</sub></var> 包含多普勒和塞曼频移，' +
    '与自然线宽 Γ 使用相同的角频率单位。';
  const population = resolved ? '<var>q</var> 遍历各激发磁子能级。<var>W<sub>q</sub></var> 是各束受激跃迁率之和，基态和各激发态的布居之和等于 1。' :
    (twoColor ? '<var>c</var> 表示蓝光或绿光。<var>f<sub>c</sub></var> 是该色单独照明时的总散射率除以 <var>Γ<sub>c</sub></var>。' :
      '<var>q</var> 遍历三种偏振分量，ℏ<b>k</b><sub>j</sub> 是一个入射光子的动量。');
  const recoil = twoColor ? '启用随机反冲时，蓝光采用动量扩散，绿光逐次抽样散射事件。' :
    '启用随机反冲时，蓝光用动量扩散计算速度涨落。';
  return {intro, terms, population, recoil,
    alt:'从 ¹S₀ 基态出发，' + light + '。' + (resolved ? states + '。' : '') + branches,
    caption:'主要自发衰变返回 ¹S₀。进入长寿命暗态的原子退出亮态捕获计数。',
    dark: (twoColor ? '<var>R<sub>b</sub></var>、<var>R<sub>g</sub></var> 是蓝光和绿光的总散射率。' :
      '<var>R<sub>b</sub></var> 是蓝光总散射率。') +
      'b 是一次衰变进入对应暗态的概率。亮态存活概率随累计的 κ 按指数衰减。',
    equations:modelEquations(twoColor, resolved)};
}

export function mountEnginePanel(host, {simulation, engine = defaultEngine, onSelect}) {
  host.classList.add('engine-panel');
  host.innerHTML =
    '<label class="engine-picker"><span>模拟引擎</span><select data-engine-select></select></label>' +
    '<p class="engine-intro"></p><div class="engine-principles">' +
    '<figure class="engine-scheme"><img><figcaption></figcaption></figure>' +
    '<dl class="engine-equations"></dl></div>' +
    '<details class="engine-notes"><summary>符号与近似</summary><p></p><p></p></details>';
  const select = host.querySelector('[data-engine-select]');
  const intro = host.querySelector('.engine-intro');
  const image = host.querySelector('img'), caption = host.querySelector('figcaption');
  const equations = host.querySelector('dl'), notes = host.querySelectorAll('.engine-notes p');
  let activeSimulation, activeEngine;

  function update({simulation, engine = defaultEngine}) {
    if (simulation === activeSimulation && engine === activeEngine) return;
    const available = availableEngines(simulation);
    if (!available.some(option => option.id === engine))
      throw new RangeError('所选引擎无法运行当前模拟。');
    if (simulation !== activeSimulation) select.replaceChildren(...available.map(({id, label}) => new Option(label, id)));
    activeSimulation = simulation;
    activeEngine = engine;
    select.value = engine;
    host.dataset.engine = engine;
    host.dataset.simulation = simulation;
    const guide = describe(simulation, engine);
    intro.textContent = guide.intro;
    image.alt = guide.alt;
    image.src = new URL('./engine-diagrams/' + simulation + '-' + engine + '.svg', import.meta.url).href;
    caption.textContent = guide.caption;
    equations.innerHTML = guide.equations;
    notes[0].innerHTML = guide.terms + guide.population;
    notes[1].innerHTML = guide.dark + guide.recoil;
  }

  select.addEventListener('change', () => {
    update({simulation:activeSimulation, engine:select.value});
    onSelect(activeEngine);
  });
  update({simulation, engine});
  return {update};
}
