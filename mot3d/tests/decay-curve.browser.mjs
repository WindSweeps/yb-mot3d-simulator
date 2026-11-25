import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {blueSequence} from '../sequence.js';

const url = process.argv[2] ?? 'http://127.0.0.1:4197/mot3d/sequence.html';
const runtime = fileURLToPath(new URL('./.runtime/decay-curve/',import.meta.url));
await mkdir(runtime,{recursive:true});
process.env.TMPDIR = process.env.TMP = process.env.TEMP = runtime;
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const args = process.platform === 'darwin' ? ['--enable-gpu','--use-angle=metal'] : ['--enable-gpu'];
const browser = await chromium.launch({channel:'chrome',chromiumSandbox:true,args});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.goto(url + '#sequence-curves', {waitUntil:'domcontentloaded'});
  const panel = page.locator('#sequence-curves'), range = panel.locator('#seq-curve-stage');
  const button = panel.locator('#seq-show-decay'), guide = panel.locator('.seq-loss-guides');
  const reading = panel.locator('#seq-curve-tau-loss'), annotations = panel.locator('#seq-loss-values');
  async function exportState() {
    const download = page.waitForEvent('download');
    await page.locator('#sequence-export').click();
    return JSON.parse(await readFile(await (await download).path(),'utf8'));
  }
  async function importState(state, waitFor) {
    await page.locator('#sequence-file').setInputFiles({name:'decay.json',mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify(state))});
    await page.waitForFunction(waitFor, null, {timeout:120000});
  }
  const state = await exportState();
  state.params.n = 192;
  state.config = {...blueSequence(),holdMS:5000};
  await importState(state, () => document.querySelector('#seq-curve-tau-loss').dataset.status === 'reached');
  const run = await exportState(), {timeMS,bracketMS} = run.timeConstants.loss;
  assert.ok(timeMS > 0 && timeMS < run.config.holdMS);
  if (bracketMS) {
    assert.match(await reading.innerText(), /–/);
    assert.ok(await panel.locator('#seq-loss-sampling').isVisible());
  }
  assert.match(await annotations.innerText(), /关源 5000 ms/);
  assert.match(await annotations.innerText(), /观测结束 10000 ms/);
  // 用关源读数核对留存比例纵轴和实验时间横轴。
  await button.click();
  assert.equal(await range.inputValue(), 'decay');
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  const geometry = await guide.evaluate(g => {
    const attr = (name, key) => Number(g.querySelector(name).getAttribute(key));
    return {y0:attr('rect','y')+3, threshold:attr('line','y1'), crossing:attr('circle','cy'),
      x0:attr('line','x1'), x1:attr('line','x2'), x:attr('circle','cx')};
  });
  assert.ok(Math.abs((204-geometry.threshold)/(204-geometry.y0)-1/Math.E) < 1e-12);
  assert.ok(Math.abs((geometry.x-geometry.x0)/(geometry.x1-geometry.x0)-timeMS/run.config.holdMS) < 1e-12);
  assert.ok(geometry.crossing >= geometry.threshold-1e-9);
  const axes = await panel.locator('.seq-curve-axes').textContent();
  assert.match(axes,/关源后时间/);
  assert.match(axes,/36.8%/);
  assert.doesNotMatch(axes,/PSD/);
  await button.click();
  assert.equal(await range.inputValue(), 'all');
  for (const stage of ['all','hold']) {
    await range.selectOption(stage);
    const axes = panel.locator('.seq-curve-axes');
    assert.match(await axes.textContent(), /阱内原子数 \/ 个 · 线性刻度/);
    assert.match(await axes.textContent(), /峰值 PSD \/ 无量纲 · 线性刻度/);
    const ticks = await axes.locator('line + text[text-anchor="end"]').evaluateAll(labels =>
      labels.filter(label => label.previousElementSibling.y1.baseVal.value === label.previousElementSibling.y2.baseVal.value)
        .map(label => ({value:Number(label.textContent),y:label.previousElementSibling.y1.baseVal.value})));
    assert.equal(ticks.length, 6);
    for (const band of [ticks.slice(0,3),ticks.slice(3)]) {
      const [zero,half,peak] = band;
      assert.equal(zero.value, 0);
      assert.ok(peak.value > 0 && Math.abs(half.value / peak.value - .5) < .05);
      assert.equal(zero.y - half.y, half.y - peak.y);
    }
    const zero = ticks[0].y;
    const cutoffY = Number(await guide.locator('rect').getAttribute('y')) + 3;
    const targetY = Number(await guide.locator('line').getAttribute('y1'));
    assert.ok(Math.abs((zero-targetY)/(zero-cutoffY) - 1/Math.E) < 1e-12);
  }
  state.config.holdMS = 1;
  await importState(state, () => document.querySelector('#seq-curve-tau-loss').dataset.status === 'lower-bound');
  assert.equal(await guide.locator('circle').count(),0);
  assert.ok(await button.isEnabled());
  // 首次观察之前的连续单体衰减具有解析的 1/e 到达时间。
  state.loading.holdAlpha = 2600;
  state.loading.holdBeta = 0;
  await importState(state, () => document.querySelector('#seq-curve-tau-loss').dataset.status === 'reached');
  assert.ok(Math.abs(Number(await reading.getAttribute('data-value')) - 1000/2600) < 1e-9);
  assert.ok(await panel.locator('#seq-loss-sampling').isHidden());
  await page.setViewportSize({width:390,height:844});
  await page.locator('#sequence-dock .dv-tab').filter({hasText:'原子数与 PSD'}).click();
  await button.click();
  assert.equal(await range.inputValue(),'decay');
  const sizes = await panel.evaluate(el => [el.clientWidth,el.scrollWidth]);
  assert.ok(sizes[0]>0 && sizes[1]<=sizes[0]+1);
  state.loading.flux = 0;
  await importState(state, () => document.querySelector('#seq-curve-tau-loss').dataset.status === 'empty');
  assert.equal(await guide.locator('*').count(),0);
  assert.ok(await button.isDisabled());
  assert.ok(await annotations.isHidden());
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({loss:run.timeConstants.loss,axis:axes,geometry}));
} finally {await browser.close();}
