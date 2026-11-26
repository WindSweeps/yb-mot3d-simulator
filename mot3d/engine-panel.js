import { atomTier, availableEngines, defaultEngine } from './engines.js';
import { DARK_BRANCHES, EMISSION_BRANCHES } from './branching.js';

const returnProbability = new Intl.NumberFormat('zh-CN', {style:'percent', maximumFractionDigits:7});

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
  const tier = atomTier(engine);
  if (tier) return describeMultilevel(simulation,tier);
  const twoColor = simulation === 'two-color', resolved = engine === 'rate-equations';
  const states = twoColor ? '¹P₁ 和 ³P₁ 各有三个磁子能级' : '¹P₁ 有三个磁子能级';
  const light = twoColor ? '399 nm 和 556 nm 光分别激发 ¹P₁ 和 ³P₁' : '399 nm 光激发 ¹P₁';
  const branches = '¹P₁ 经 ³D 态级联到 ³P₀、³P₁、³P₂ 的有效分支比分别为 ' +
    [DARK_BRANCHES.blueP0, EMISSION_BRANCHES.blue556, DARK_BRANCHES.blueP2].map(b => b.toExponential(2)).join('、') + '。' +
    (twoColor ? '³P₁ 到 ³P₀ 的磁偶极分支比估计为 ' + DARK_BRANCHES.greenP0.toExponential(2) + '。' : '');
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
    alt:'¹⁷⁴Yb 能级从低到高依次为 ¹S₀、³P₀、³P₁、³P₂、¹P₁。' + light + '。' + (resolved ? states + '。' : '') + branches,
    caption:'能量向上，间距仅示意。¹P₁ 直接返回基态的概率约为 ' + returnProbability.format(EMISSION_BRANCHES.blue399) +
      '。图中通往 ³P₀、³P₁、³P₂ 的蓝光分支比均计入经过 ³D 态的完整级联。³P₀、³P₂ 为暗态。' +
      (twoColor ? '³P₁ 发射 556 nm 光返回基态的概率约为 ' + returnProbability.format(EMISSION_BRANCHES.green556) +
        '，其通往 ³P₀ 的磁偶极分支比按 LS 耦合估算。' : '到达 ³P₁ 的原子发射 556 nm 光返回基态。'),
    dark: (twoColor ? '<var>R<sub>b</sub></var>、<var>R<sub>g</sub></var> 是蓝光和绿光的总散射率。' :
      '<var>R<sub>b</sub></var> 是蓝光总散射率。') +
      'b 是一次衰变进入对应暗态的概率。亮态存活概率随累计的 κ 按指数衰减。',
    equations:modelEquations(twoColor, resolved)};
}

function describeMultilevel(simulation,tier) {
  const dark = tier >= 2, twoColor = simulation === 'two-color';
  const text = ['在局部磁场方向上投影三种偏振。费米同位素保留各条超精细线以及基态磁子能级之间的光抽运。',
    '³P₀ 原子在重力和可用的光阱中运动。³P₂ 另受塞曼势约束，重泵浦可将暗态原子送回冷却循环。',
    '556 nm 反冲按空碰撞抽样。光偶极阱与晶格改变各态的势能和冷却共振。'];
  const excited = equation('激发态稳态布居',sub('p','e') + '<mo>=</mo><mfrac><mrow>' + sum('g') +
    sub('W','ge') + sub('p','g') + '</mrow><mrow>' + sub('Γ','e') + '<mo>+</mo>' + sum('g') + sub('W','ge') +
    '</mrow></mfrac>');
  const force = equation('辐射压力','<mi mathvariant="bold">F</mi><mo>=</mo>' + sum('jge') +
    '<mi>ℏ</mi>' + sub('𝐤','j') + sub('W','jge') + '<mo>(</mo>' + sub('p','g') + '<mo>−</mo>' + sub('p','e') + '<mo>)</mo>');
  const escape = equation('蓝光暗态跃迁速率', '<mi>κ</mi><mo>=</mo>' + sub('f','¹P₁') +
    '<mo>(</mo>' + sub('a','0') + '<mo>+</mo>' + sub('a','2') + '<mo>)</mo>');
  return {intro:text.slice(0,tier).join(''), alt:'镱的冷却、暗态与重泵浦能级。',
    caption:dark ? '紫蓝色虚线标注 ¹P₁ 经过 ³D 态到达三重态的有效分支比。黄色箭头标注有限时间重泵浦的波长和自发分支。' :
      '能级图以 ¹⁷⁴Yb 为例。费米同位素将冷却能级进一步分解为 F 和 mF。',
    terms:'g、e 分别表示基态和激发态磁子能级。W 包含局部偏振、Clebsch–Gordan 系数、Doppler、Zeeman 和启用时的 AC Stark 频移。',
    population:'两种颜色共用同一组基态布居。',
    dark:dark ? '光学泄漏按激发布居推进，重泵浦按有限循环速率计算。' : '长寿命态跃迁终止亮态轨迹。',
    recoil:tier === 3 ? '蓝光采用局部阻尼与动量扩散，绿光逐次抽样。' : '冷却光采用局部阻尼与动量扩散。',
    equations:excited+force+escape,
    image:dark ? 'yb-multilevel.svg' : (twoColor ? 'two-color' : 'blue')+'-rate-equations.svg'};
}

export function mountEnginePanel(host, {simulation, engine = defaultEngine, enginesFor = availableEngines, onSelect}) {
  host.classList.add('engine-panel');
  host.innerHTML =
    '<div class="engine-picker"><label>模拟引擎</label><select data-engine-select></select>' +
    '<button type="button" class="button" data-engine-confirm disabled>确认并重算</button></div>' +
    '<p class="engine-pending" role="status"></p>' +
    '<p class="engine-intro"></p><div class="engine-principles">' +
    '<figure class="engine-scheme"><figcaption><strong>¹⁷⁴Yb 能级与分支比</strong>' +
    '<a class="engine-original" target="_blank" rel="noopener">查看原图</a></figcaption>' +
    '<div class="engine-diagram-scroll" role="region" aria-label="能级图" tabindex="0"><img></div>' +
    '<p class="engine-pan-hint">左右滚动可查看全部跃迁。</p><p class="engine-caption"></p></figure>' +
    '<dl class="engine-equations"></dl></div>' +
    '<details class="engine-notes"><summary>符号、近似与来源</summary><p></p><p></p>' +
    '<p class="engine-references"><a href="https://physics.nist.gov/PhysRefData/Handbook/Tables/ytterbiumtable5.htm" target="_blank" rel="noopener">NIST 镱能级表</a>' +
    '<a href="https://arxiv.org/pdf/1111.6225#page=3" target="_blank" rel="noopener">Cho 等 · 蓝光级联速率</a>' +
    '<a data-atom-reference href="./YB-ATOM.md">镱引擎参数与验证</a>' +
    '<a data-green-reference href="https://arxiv.org/pdf/1208.0552#page=9" target="_blank" rel="noopener">Beloy 等 · 磁偶极矩阵元</a>' +
    '<a data-green-reference href="https://physics.nist.gov/Pubs/AtSpec/node17.html" target="_blank" rel="noopener">NIST 磁偶极辐射公式</a></p></details>';
  const select = host.querySelector('[data-engine-select]');
  select.id = host.id + '-select';
  host.querySelector('.engine-picker label').htmlFor = select.id;
  const confirm = host.querySelector('[data-engine-confirm]');
  const pending = host.querySelector('.engine-pending');
  const intro = host.querySelector('.engine-intro');
  const image = host.querySelector('img'), caption = host.querySelector('.engine-caption');
  const original = host.querySelector('.engine-original'), greenReferences = host.querySelectorAll('[data-green-reference]');
  const atomReference = host.querySelector('[data-atom-reference]');
  const equations = host.querySelector('dl'), notes = host.querySelectorAll('.engine-notes p');
  let activeSimulation, activeEngine;

  function preview() {
    const engine = select.value;
    confirm.disabled = engine === activeEngine;
    pending.textContent = confirm.disabled ? '' : '当前使用' +
      enginesFor(activeSimulation).find(option => option.id === activeEngine).label + '，所选引擎待确认。';
    const guide = describe(activeSimulation, engine);
    intro.textContent = guide.intro;
    image.alt = guide.alt;
    image.src = new URL('./engine-diagrams/' + (guide.image ?? activeSimulation + '-' + engine + '.svg'),import.meta.url).href;
    original.href = image.src;
    host.dataset.previewTier = String(atomTier(engine));
    atomReference.hidden = !atomTier(engine);
    host.querySelector('figcaption strong').textContent = atomTier(engine) >= 2 ? '镱能级与重泵浦分支比' : '¹⁷⁴Yb 能级与分支比';
    for (const link of greenReferences) link.hidden = activeSimulation !== 'two-color';
    caption.textContent = guide.caption;
    equations.innerHTML = guide.equations;
    notes[0].innerHTML = guide.terms + guide.population;
    notes[1].innerHTML = guide.dark + guide.recoil;
  }

  function update({simulation, engine = defaultEngine}) {
    if (activeSimulation === simulation && activeEngine === engine && select.value === engine) return;
    const available = enginesFor(simulation);
    if (!available.some(option => option.id === engine))
      throw new RangeError('所选引擎无法运行当前模拟。');
    if (simulation !== activeSimulation) select.replaceChildren(...available.map(({id, label}) => new Option(label, id)));
    activeSimulation = simulation;
    activeEngine = engine;
    host.dataset.simulation = simulation;
    host.dataset.engine = engine;
    select.value = engine;
    preview();
  }

  select.addEventListener('change', preview);
  confirm.addEventListener('click', () => {
    if (select.value === activeEngine) return;
    update({simulation:activeSimulation, engine:select.value});
    onSelect(activeEngine);
  });
  update({simulation, engine});
  return {update};
}
