import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://127.0.0.1:4174/mot3d/sequence.html';
const runtime = fileURLToPath(new URL('./.runtime/dock-qa/', import.meta.url));
await mkdir(runtime, { recursive:true });
process.env.TMPDIR = process.env.TMP = process.env.TEMP = runtime;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  channel:'chrome', chromiumSandbox:true, headless:true,
  args:process.platform === 'darwin' ? ['--enable-gpu','--use-angle=metal'] : ['--enable-gpu'],
  downloadsPath:runtime,
});
const context = await browser.newContext({ viewport:{ width:1440, height:960 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
await page.addInitScript(()=>{
  window.dockTestErrors=[];
  window.addEventListener('error',event=>window.dockTestErrors.push(event.message));
});
const labels = { timeline:'通道时序', scene:'三维 MOT', imaging:'相机成像', readings:'原子样本' };
const entries = new Map(Object.entries(labels).map(([id,text])=>[text,id]));
const keyPrefix = 'yb-mot3d-sequence-layout-v1-';
const find = selector => page.locator(selector);
const host = find('#sequence-dock');
const tab = id => host.locator('.dv-tab').filter({ hasText:labels[id] });
const clock = find('.seq-time-input input');
const key = variant => keyPrefix+variant;
let workers = 0, retained;
const errors = [];
page.on('pageerror', err=>errors.push(err.message));
page.on('worker', worker=>{ if (new URL(worker.url()).pathname.endsWith('/sequence-worker.js')) workers++; });
async function layout() {
  const groups = await host.locator('.dv-groupview').evaluateAll(nodes=>nodes.filter(el => el.clientWidth>0 && el.clientHeight>0).map(el => {
    const b=el.getBoundingClientRect(), tabs=[...el.querySelectorAll('.dv-tab')];
    return {x:b.x,y:b.y,w:b.width,h:b.height,tabs:tabs.map(t=>t.textContent.trim()),active:tabs.find(t=>t.classList.contains('dv-active-tab'))?.textContent.trim()};
  }));
  groups.forEach(g=>{g.tabs=g.tabs.map(t=>entries.get(t)??t);g.active=entries.get(g.active)??g.active;});
  return groups.sort((a,b)=>a.x-b.x || a.y-b.y);
}
const groupOf = (groups,id) => groups.find(g=>g.tabs.includes(id));
const fingerprint = groups => groups.map(g=>({tabs:g.tabs,active:g.active}));
async function settled() {
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
}
async function storage(variant) { return page.evaluate(k=>localStorage.getItem(k),key(variant)); }
async function visible(id) { await tab(id).click(); await settled(); }
async function drop(from, onto, side) {
  await host.scrollIntoViewIfNeeded();
  const src=await tab(from).boundingBox(), group=groupOf(await layout(),onto);
  assert.ok(src && group,'drag source and destination are laid out');
  const start={ x:src.x+Math.min(src.width*.4,45), y:src.y+src.height*.5 };
  const end={ x:group.x+group.w*(side==='left' ? .1 : .5), y:group.y+group.h*.55 };
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(start.x+11,start.y+7,{steps:5});
  await page.mouse.move(end.x-7,end.y,{steps:22});
  await page.mouse.move(end.x,end.y,{steps:3});
  await settled();
  await page.mouse.up();
  await settled();
}
async function resizeColumn() {
  const sash=host.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled').first();
  await sash.scrollIntoViewIfNeeded();
  const r=await sash.boundingBox();
  assert.ok(r && r.height>r.width);
  const x=r.x+r.width*.5,y=r.y+r.height*.4;
  await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+70,y,{steps:12}); await page.mouse.up();
  await settled();
}
async function place(panel,placement,target) {
  const menu=find('#sequence-layout-menu');
  if(!await menu.locator('form').isVisible()) await menu.locator('summary').click();
  await menu.locator('[name=panel]').selectOption(panel);
  await menu.locator('[name=placement]').selectOption(placement);
  if(target) await menu.locator('[name=target]').selectOption(target);
  await menu.locator('button[type=submit]').click(); await settled();
}
async function recordInstances() {
  await visible('scene');
  await find('[data-seq-view=cloud]').click();
  await visible('imaging');
  await find('#seq-imaging-final').click();
  await find('#seq-imaging-mode').selectOption('absorption');
  await find('#seq-image-stage').selectOption('atoms');
  await page.waitForFunction(()=>Number(document.querySelector('#seq-imaging-value')?.dataset.value)>0);
  await page.evaluate(()=>{ window.dockTestNodes={}; });
  for (const [id,selector] of Object.entries({timeline:'.seq-time-input input',scene:'#sequence-viewport canvas',imaging:'#seq-imaging-canvas',readings:'#seq-n2'})) {
    await visible(id);
    await find(selector).evaluate((node,id)=>{window.dockTestNodes[id]=node;},id);
  }
  await visible('scene');
  await find('#sequence-viewport canvas').evaluate(canvas=>{ window.dockTestGL=canvas.getContext('webgl2'); });
  await visible('imaging');
}
async function verifyInstances() {
  for(const [id,selector] of Object.entries({timeline:'.seq-time-input input',scene:'#sequence-viewport canvas',readings:'#seq-n2',imaging:'#seq-imaging-canvas'})) {
    await visible(id);
    const equal=await find(selector).evaluate((node,id)=>node===window.dockTestNodes[id],id);
    assert.equal(equal,true,'preserved DOM node '+id);
    if(id==='timeline') assert.equal(await clock.inputValue(),'5111');
    if(id==='scene') {
      assert.equal(await find('[data-seq-view=cloud]').getAttribute('aria-pressed'),'true');
      assert.ok(await find(selector).evaluate(c=> {
        const gl=c.getContext('webgl2');
        return gl===window.dockTestGL && !gl.isContextLost() && c.width>0 && c.height>0;
      }));
    }
    if(id==='readings') assert.equal(Number(await find(selector).innerText()),retained);
    if(id==='imaging') {
      assert.equal(await find('#seq-imaging-mode').inputValue(),'absorption');
      assert.equal(await find('#seq-image-stage').inputValue(),'atoms');
      assert.ok(await find(selector).evaluate(c=>{
        const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        for(let i=4;i<data.length;i+=4) if(data[i]!==data[0]) return true;
        return false;
      }),'detector still draws the cloud');
    }
  }
}
async function assertFour() {
  const groups=await layout();
  assert.deepEqual(groups.flatMap(g=>g.tabs).sort(),Object.keys(labels).sort(),'all four distinct panels are reachable');
  return groups;
}
try {
  const response=await page.goto(url);
  assert.ok(response?.ok());
  await page.waitForFunction(()=>window.dockTestErrors.length || document.querySelector('#sequence-dock .dv-tab'),null,{timeout:20000});
  assert.deepEqual(errors,[]);
  await page.waitForFunction(()=>window.dockTestErrors.length || document.querySelector('[data-action=play]')?.disabled===false,null,{timeout:90000});
  assert.deepEqual(errors,[]);
  const standard=await assertFour();
  assert.equal(standard.length,3);
  assert.ok(groupOf(standard,'scene').x>groupOf(standard,'timeline').x);
  assert.ok(groupOf(standard,'imaging').y>groupOf(standard,'scene').y);
  assert.deepEqual(groupOf(standard,'imaging').tabs,['imaging','readings']);
  assert.equal(groupOf(standard,'imaging').active,'imaging');
  retained = Number(await find('#seq-n2').textContent());
  assert.ok(retained > 0);
  await recordInstances();
  const firstCount=workers;
  assert.equal(firstCount,1);
  await drop('imaging','scene','center');
  const stacked=await assertFour();
  assert.equal(stacked.length,3,JSON.stringify(stacked));
  assert.ok(groupOf(stacked,'scene').tabs.includes('imaging'),'center drop stacks tabs '+JSON.stringify(stacked));
  await drop('imaging','timeline','left');
  const split=await assertFour();
  assert.equal(split.length,4,'edge drop splits the target '+JSON.stringify(split));
  assert.ok(groupOf(split,'imaging').x<groupOf(split,'timeline').x);
  await resizeColumn();
  const resized=await layout();
  const delta=Math.max(...resized.map(g=>Math.abs(g.w-groupOf(split,g.tabs[0]).w)));
  assert.ok(delta>20,'splitter changes column widths '+JSON.stringify({split,resized}));
  await verifyInstances();
  const saved=await layout();
  await page.waitForFunction(k=>!!localStorage.getItem(k),key('wide'));
  const persisted=await storage('wide'); assert.ok(persisted);
  await page.setViewportSize({width:390,height:850});
  await page.waitForFunction(()=>document.querySelectorAll('#sequence-dock .dv-groupview').length===1);
  const compact=await assertFour();
  assert.equal(compact.length,1);
  await verifyInstances();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  await visible('timeline'); await find('.seq-camera .seq-label').click();
  await page.waitForFunction(()=>document.querySelector('#seq-imaging-mode')?.offsetWidth>0);
  assert.equal(groupOf(await layout(),'imaging').active,'imaging');
  await page.setViewportSize({width:1440,height:960});
  await page.waitForFunction(()=>document.querySelectorAll('#sequence-dock .dv-groupview').length===4);
  await verifyInstances();
  assert.deepEqual(fingerprint(await layout()),fingerprint(saved));
  assert.equal(workers,firstCount,'docking and responsive changes should preserve trajectory worker result');
  await page.goto(new URL('sequence.html#sequence-imaging',url).href);
  await page.reload();
  await tab('imaging').waitFor();
  await page.waitForFunction(()=>document.querySelector('#seq-imaging-mode')?.offsetWidth>0);
  const restored=await assertFour();
  assert.deepEqual(fingerprint(restored),fingerprint(saved));
  for(const g of restored) assert.ok(Math.abs(g.w-groupOf(saved,g.tabs[0]).w)<3,'persisted splitter width');
  const reset=find('#sequence-layout-reset');
  await reset.click(); await settled();
  const resetState=await assertFour();
  assert.deepEqual(fingerprint(resetState),fingerprint(standard),'restore initial default grouping');
  await place('readings','float');
  assert.equal(await host.locator('.dv-groupview-floating .dv-tab').filter({hasText:labels.readings}).count(),1);
  await place('readings','center','imaging');
  assert.deepEqual(groupOf(await layout(),'imaging').tabs.sort(),['imaging','readings']);
  await reset.click();
  const deep=await context.newPage();
  await deep.setViewportSize({width:390,height:850});
  const compactURL=new URL(url); compactURL.hash='sequence-readings';
  await deep.goto(compactURL.href);
  await deep.locator('#sequence-readings').waitFor({state:'visible'});
  const compactTabs=deep.locator('#sequence-dock .dv-tab');
  const readingTab=compactTabs.filter({hasText:labels.readings});
  const imageTab=compactTabs.filter({hasText:labels.imaging});
  assert.equal(await readingTab.getAttribute('aria-selected'),'true','deep link initially hidden compact panel');
  await readingTab.focus(); await readingTab.press('ArrowLeft');
  await imageTab.and(deep.locator('[aria-selected=true]')).waitFor();
  assert.equal(await imageTab.getAttribute('aria-selected'),'true','keyboard switches and focuses neighboring panel');
  await deep.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  await deep.setViewportSize({width:320,height:820});
  assert.equal(await deep.evaluate(()=>document.documentElement.scrollWidth),320);
  await deep.close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({url,standard,afterDrop:fingerprint(stacked),split:fingerprint(split),resizedPixels:delta,
    restoredWidths:restored.map(g=>g.w),compact:compact[0].tabs,workerCountBeforeReload:firstCount,retained}));
} finally {await browser.close();}
