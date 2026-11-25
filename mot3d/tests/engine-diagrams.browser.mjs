import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DARK_BRANCHES, EMISSION_BRANCHES} from '../branching.js';

const base = process.argv[2] ?? 'http://127.0.0.1:4199/mot3d/';
const runtime = fileURLToPath(new URL('./.runtime/engine-diagrams/', import.meta.url));
await mkdir(runtime, {recursive:true});
process.env.TMPDIR = process.env.TMP = process.env.TEMP = runtime;
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

function scientificLabel(value) {
  const [coefficient, exponent] = value.toExponential(2).split('e');
  const superscript = {'-':'⁻', '0':'⁰', '1':'¹', '2':'²', '3':'³', '4':'⁴',
    '5':'⁵', '6':'⁶', '7':'⁷', '8':'⁸', '9':'⁹'};
  return coefficient + '×10' + [...exponent].map(character => superscript[character]).join('');
}

async function checkGuide(page, panel, simulation, engine) {
  const image = panel.locator('.engine-scheme img');
  await image.evaluate(el => el.decode());
  const source = await image.getAttribute('src');
  assert.ok(source.endsWith('/' + simulation + '-' + engine + '.svg'), source);
  const original = panel.getByRole('link', {name:/原图/});
  assert.equal(new URL(await original.getAttribute('href'), page.url()).href, new URL(source, page.url()).href);
  const popupPromise = page.waitForEvent('popup');
  await original.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  try {
    const artwork = await popup.evaluate(() => {
      const svg = document.documentElement;
      const labels = [...svg.querySelectorAll('text')].filter(text => {
        const box = text.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(text).visibility !== 'hidden';
      });
      const levels = [...svg.querySelectorAll('g.level')].map(level => {
        const bar = level.querySelector('line.level-line');
        return {term:level.querySelector('text.term').textContent, bar:bar.getBoundingClientRect().toJSON(),
          stroke:getComputedStyle(bar).stroke};
      });
      const transitions = [...svg.querySelectorAll('g.transition')].map(edge => ({
        from:edge.dataset.from, to:edge.dataset.to, text:edge.querySelector('text').textContent.replace(/\s+/gu,''),
      }));
      return {name:svg.localName, levels, transitions, labels:labels.map(label => ({
        text:label.textContent.replace(/\s+/gu, ''),
        box:label.getBoundingClientRect().toJSON(),
      }))};
    });
    assert.equal(artwork.name, 'svg');
    const blue = [['B','P0',DARK_BRANCHES.blueP0], ['B','V',EMISSION_BRANCHES.blue556], ['B','P2',DARK_BRANCHES.blueP2]];
    const branches = simulation === 'two-color' ? [...blue, ['V','P0',DARK_BRANCHES.greenP0]] : blue;
    const labels = artwork.labels.map(label => label.text).join(' ');
    for (const [from,to,value] of branches) {
      const transition = artwork.transitions.find(edge => edge.from === from && edge.to === to);
      assert.ok(transition?.text.includes(scientificLabel(value)), from + ' → ' + to + ' ' + labels);
    }
    if (simulation === 'blue') assert.ok(!artwork.transitions.some(edge => edge.from === 'V' && edge.to === 'P0'));
    const levels = ['¹P₁', '³P₂', '³P₁', '³P₀', '¹S₀'].map(term => {
      const bar = artwork.levels.find(level => level.term === term);
      const label = artwork.labels.find(label => label.text === term);
      assert.ok(bar && label, term);
      assert.ok(bar.bar.width > 0 && bar.bar.height < 1 && bar.stroke !== 'none', term);
      return {y:bar.bar.y, label:label.box};
    });
    for (let i=1; i<levels.length; i++) {
      assert.ok(levels[i-1].y < levels[i].y, labels);
      assert.ok(levels[i-1].label.bottom <= levels[i].label.top, labels);
    }
    for (const [index, first] of artwork.labels.entries()) {
      for (const second of artwork.labels.slice(index + 1)) {
        const a = first.box, b = second.box;
        const overlapX = Math.min(a.right,b.right) - Math.max(a.left,b.left);
        const overlapY = Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top);
        assert.ok(overlapX <= 1 || overlapY <= 1,
          first.text + ' 与 ' + second.text + ' 标签重叠 ' + overlapX + ' × ' + overlapY + ' px');
      }
    }
  } finally {await popup.close();}
  const bounds = await panel.getByRole('region', {name:'能级图'}).evaluate(view => {
    const imageWidth = view.querySelector('img').getBoundingClientRect().width;
    view.scrollLeft = view.scrollWidth;
    const visibleRight = view.scrollLeft + view.clientWidth;
    view.scrollLeft = 0;
    return {imageWidth, visibleRight, panelWidth:view.clientWidth,
      overflow:document.documentElement.scrollWidth - innerWidth};
  });
  assert.ok(bounds.imageWidth > 0 && bounds.panelWidth > 0 && bounds.overflow <= 1, JSON.stringify(bounds));
  assert.ok(bounds.visibleRight >= bounds.imageWidth - 1, JSON.stringify(bounds));
}

const args = process.platform === 'darwin' ? ['--enable-gpu','--use-angle=metal'] : ['--enable-gpu'];
const browser = await chromium.launch({channel:'chrome', chromiumSandbox:true, args});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({viewport:{width, height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(base, {waitUntil:'domcontentloaded'});
      for (const [simulation, selector] of [['blue','#mot-engine-panel'], ['two-color','#sequence-engine']]) {
        if (simulation === 'two-color') {
          await page.locator('#open-sequence').click();
          await page.getByRole('link', {name:'模拟引擎', exact:true}).click();
        }
        const panel = page.locator(selector);
        const select = panel.locator('[data-engine-select]'), confirm = panel.locator('[data-engine-confirm]');
        await select.waitFor({state:'visible'});
        for (const engine of ['lightweight','rate-equations']) {
          await select.selectOption(engine);
          await checkGuide(page, panel, simulation, engine);
          if (await confirm.isEnabled()) await confirm.click();
          assert.equal(await panel.getAttribute('data-engine'), engine);
          assert.ok(await confirm.isDisabled());
        }
      }
      assert.deepEqual(errors, []);
      console.log(width + ' px · 已核对两个页面、四张能级图和分支比。');
    } finally {await page.close();}
  }
} finally {await browser.close();}
