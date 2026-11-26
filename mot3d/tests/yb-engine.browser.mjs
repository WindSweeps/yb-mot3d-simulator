import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:4199/mot3d/';
const runtime = fileURLToPath(new URL('./.runtime/yb-engine/',import.meta.url));
await mkdir(runtime,{recursive:true});
process.env.TMPDIR = process.env.TMP = process.env.TEMP = runtime;
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const args = process.platform === 'darwin' ? ['--enable-gpu','--use-angle=metal'] : ['--enable-gpu'];
const browser = await chromium.launch({channel:'chrome',chromiumSandbox:true,args});
const statusSelector = '#sequence-compute-status';
const url = new URL('sequence.html?preset=blue-mot-399nm',base).href;

async function complete(page, engine) {
  await page.waitForFunction(({selector,engine}) => {
    const status = document.querySelector(selector).textContent;
    if (status.startsWith('计算未完成')) throw new Error(status);
    return status.startsWith('计算完成 · '+engine);
  },{selector:statusSelector,engine},{timeout:60000});
}
async function exportRun(page) {
  const download = page.waitForEvent('download');
  await page.locator('#sequence-export').click();
  return JSON.parse(await readFile(await (await download).path(),'utf8'));
}
async function loadRun(page,run,engine) {
  await page.locator('#sequence-file').setInputFiles({name:'yb-run.json',mimeType:'application/json',
    buffer:Buffer.from(JSON.stringify(run))});
  await page.waitForFunction(() => document.querySelector('#sequence-file-status').textContent.startsWith('已载入'));
  await complete(page,engine);
}

try {
  for (const width of [1440,390]) {
    const page = await browser.newPage({viewport:{width,height:920}});
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    page.on('response',response => { if (response.status() >= 400) errors.push(response.url()+' '+response.status()); });
    try {
      await page.goto(url,{waitUntil:'domcontentloaded'});
      await complete(page,'L2');
      assert.match(await page.locator(statusSelector).textContent(),/CPU .*192 条入射轨迹/);
      assert.equal(await page.locator('#seq-dark-ess').textContent(),'磁阱有效样本量 0（低于 200）');
      await page.getByRole('link',{name:'模拟引擎',exact:true}).click();
      const panel = page.locator('#sequence-engine');
      const selector = panel.getByRole('combobox',{name:'模拟引擎'});
      assert.equal(await selector.inputValue(),'yb-l2');
      const diagram = panel.getByRole('region',{name:'能级图'});
      await diagram.locator('img').evaluate(image => image.decode());
      const bounds = await diagram.evaluate(view => {
        view.scrollLeft = view.scrollWidth;
        return {right:view.scrollLeft+view.clientWidth,width:view.querySelector('img').getBoundingClientRect().width,
          overflow:document.documentElement.scrollWidth-innerWidth};
      });
      assert.ok(bounds.right >= bounds.width-1 && bounds.overflow <= 1,JSON.stringify(bounds));
      const confirm = panel.getByRole('button',{name:'确认并重算'});
      await selector.selectOption('yb-l3');
      assert.ok(await confirm.isEnabled());
      assert.equal(await panel.getAttribute('data-engine'),'yb-l2');
      await confirm.click();
      await complete(page,'L3');
      if (width === 390) {
        assert.deepEqual(errors,[]);
        continue;
      }
      await panel.getByRole('combobox',{name:'同位素'}).selectOption('171Yb');
      await page.waitForFunction(() => document.querySelector('#sequence-wavelengths').textContent.startsWith('¹⁷¹Yb'));
      await complete(page,'L3');
      const imported = await exportRun(page);
      assert.equal(imported.params.isotope,'171Yb');
      assert.equal(imported.samplingDiagnostics.isotope,'171Yb');
      assert.equal(imported.samplingDiagnostics.incident,192);
      const {stages} = imported.samplingDiagnostics;
      for (const stage of Object.values(stages)) assert.ok(Math.abs(stage.ledger.residual) < 1e-8);
      const beamSource = {...imported.params};

      Object.assign(imported.params,{engine:'yb-l2',n:96,isotope:'174Yb',gravity:false,recoil:false,
        sourceDistanceMM:0,sourceSpeed:0,sourceSpread:0,sourceRadiusMM:0,sourceTempMK:0});
      Object.assign(imported.config,{loadMS:400,holdMS:80,loadGradient:0,blueDetuningMHz:0,
        blueObliqueMW:38,blueHorizontalMW:38,repumpLeadMS:40,repumpDurationMS:40});
      Object.assign(imported.loading,{flux:1e6,alphaMode:'background',alpha:0,beta:0,holdAlpha:0,holdBeta:0});
      await loadRun(page,imported,'L2');
      const before = await exportRun(page);
      assert.ok(before.samplingDiagnostics.stages.N2.ledger.p0 > 5);
      await page.getByRole('tab',{name:'通道时序',exact:true}).click();
      const controls = page.locator('.seq-atom-controls');
      await controls.locator('summary').click();
      for (const key of ['repump649','repump770']) {
        await controls.locator('[data-key='+key+']').fill('2400');
        await controls.locator('[data-key='+key+']').press('Tab');
      }
      await complete(page,'L2');
      const after = await exportRun(page);
      assert.equal(after.config.repump649,2400);
      assert.equal(after.config.repump770,2400);
      assert.ok(after.samplingDiagnostics.stages.N2.ledger.recovered > 0);
      assert.ok(after.samplingDiagnostics.stages.N2.ledger.trappedBright > before.samplingDiagnostics.stages.N2.ledger.trappedBright);
      const row = page.locator('.seq-lane').filter({hasText:'649 nm 重泵浦'});
      assert.ok(await row.isVisible());
      const cursor = page.getByRole('spinbutton',{name:'游标时间，单位 ms'});
      await cursor.fill('452');
      await cursor.press('Tab');
      assert.match(await row.locator('output').textContent(),/2400 s⁻¹/);
      await page.getByRole('combobox',{name:'时序预设'}).selectOption('blue-to-green-yb');
      await complete(page,'L3');
      const transfer = await exportRun(page);
      assert.equal(transfer.config.greenDuringLoad,false);
      assert.equal(transfer.params.engine,'yb-l3');
      transfer.params = {...beamSource,engine:'yb-l3',isotope:'174Yb',n:96};
      await loadRun(page,transfer,'L3');
      assert.ok((await exportRun(page)).samplingDiagnostics.greenEvents > 0);
      assert.deepEqual(errors,[]);
      console.log('纯蓝入口、确认切换、同位素、可见重泵浦、顺序冷却、时序读数及导入导出已通过。');
    } finally {await page.close();}
  }
} finally {await browser.close();}
