import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 构建使用 mermaid@10.9.6 和 playwright，网页直接载入生成的 SVG。
const mermaidBundle = process.env.MERMAID_BUNDLE ??
  fileURLToPath(new URL('./mermaid.min.js', import.meta.resolve('mermaid')));
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const directory = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(directory, 'mermaid-config.json'), 'utf8'));
const browser = await chromium.launch({channel:process.env.CHROMIUM_CHANNEL, chromiumSandbox:true});

// Mermaid 编译能级、跃迁、分支比和箭头方向。能级图的纵坐标取能量次序，间距供标注使用。
async function renderLevels({id, source}) {
  const {svg:markup} = await window.mermaid.render(id, source);
  const template = document.createElement('template');
  template.innerHTML = markup;
  const svg = template.content.querySelector('svg');
  const graph = await window.mermaid.mermaidAPI.getDiagramFromText(source);
  const edges = graph.db.getEdges();
  const paths = [...svg.querySelectorAll('.edgePaths > path')];
  const labels = [...svg.querySelectorAll('.edgeLabels > .edgeLabel')];
  if (edges.length !== paths.length || edges.length !== labels.length)
    throw new Error('Mermaid 的跃迁与标注数量不一致。');

  function element(tag, attributes = {}, content) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (content !== undefined) node.textContent = content;
    return node;
  }
  const colors = {blue:'#80cbff', green:'#abe890', dark:'#ffd19b', ground:'#e5eef5'};
  const multi = id === 'yb-multilevel';
  const heights = multi ? {S:45,B:110,D:175,P2:240,V:305,P0:370,G:435} : {B:46,P2:116,V:185,P0:253,G:324};
  const width = multi ? 1180 : 600, height = multi ? 475 : 362;
  const channels = multi ? {
    'G-B':[145,394,'blue'], 'G-V':[233,393,'green'],
    'B-P0':[329,342,'blue'], 'B-V':[417,277,'blue'], 'B-P2':[505,211,'blue'],
    'P0-S':[591,85,'dark'], 'P2-S':[674,85,'dark'],
    'S-P0':[752,335,'dark'], 'S-V':[824,269,'dark'], 'S-P2':[897,204,'dark'],
    'P0-D':[936,338,'dark'], 'P2-D':[1021,207,'dark'],
    'D-P0':[1021,338,'dark'], 'D-V':[1094,273,'dark'], 'D-P2':[1151,207,'dark'],
  } : {
    'G-B':[151,293,'blue'], 'G-V':[241,293,'green'], 'V-G':[241,293,'green'],
    'B-P0':[350,219,'blue'], 'B-V':[450,151,'blue'], 'B-P2':[545,81,'blue'],
    'V-P0':[545,219,'green'],
  };
  const levels = [...svg.querySelectorAll('.node[data-id]')];
  const lines = element('g'), transitions = element('g'), defs = element('defs');
  const title = svg.querySelector('title'), description = svg.querySelector('desc');
  if (!title || !description) throw new Error('Mermaid 图源缺少标题或能级说明。');
  svg.replaceChildren(title, description, defs);
  svg.removeAttribute('style');
  svg.setAttribute('viewBox', '0 0 '+width+' '+height);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-roledescription', '能级图');
  svg.setAttribute('font-family', 'Inter, PingFang SC, Microsoft YaHei, system-ui, sans-serif');
  svg.setAttribute('font-size', '18');
  svg.append(element('rect', {width,height,fill:'#09121c'}), lines, transitions);
  lines.append(element('text',{x:3,y:17,fill:'#afc0cc','font-size':12},'能量'),
    element('path',{d:'M14 '+(heights.G+3)+'V27m-4 6 4-6 4 6',stroke:'#71879a',fill:'none'}));
  const used = Object.fromEntries(levels.map(node => [node.dataset.id, []]));
  const heads = new Set();
  for (const [index,edge] of edges.entries()) {
    const {start:from,end:to} = edge;
    const [x,labelY,color] = channels[from+'-'+to];
    used[from].push(x);
    used[to].push(x);
    const path = paths[index];
    const label = labels[index].querySelector('text').textContent.trim();
    const upwardOrDownward = Math.sign(heights[to] - heights[from]);
    const bidirectional = path.hasAttribute('marker-start');
    const arrowId = id+'-arrow-'+color;
    if (!heads.has(arrowId)) {
      const marker = element('marker',{id:arrowId,viewBox:'0 0 10 8',refX:9,refY:4,
        markerUnits:'userSpaceOnUse',markerWidth:10,markerHeight:8,orient:'auto-start-reverse'});
      marker.append(element('path',{d:'M0 0L10 4L0 8Z',fill:colors[color]}));
      defs.append(marker);
      heads.add(arrowId);
    }
    const y1 = heights[from] + 2*upwardOrDownward, y2 = heights[to] - 2*upwardOrDownward;
    path.removeAttribute('style');
    path.setAttribute('class','transition-line');
    path.setAttribute('d','M'+x+' '+y1+'V'+y2);
    path.setAttribute('stroke',colors[color]);
    path.setAttribute('stroke-width','2');
    path.setAttribute('fill','none');
    if (from === 'B') path.setAttribute('stroke-dasharray','5 3');
    path.setAttribute('marker-end','url(#'+arrowId+')');
    if (bidirectional) path.setAttribute('marker-start','url(#'+arrowId+')');
    const group = element('g',{class:'transition','data-from':from,'data-to':to});
    const text = element('text',{x,y:labelY+6,'text-anchor':'middle',fill:colors[color],
      'paint-order':'stroke',stroke:'#09121c','stroke-width':6,'stroke-linejoin':'round'},label);
    group.append(path,text);
    transitions.append(group);
  }
  for (const node of levels) {
    const key = node.dataset.id, y = heights[key];
    const [term,note] = [...node.querySelectorAll('.label text tspan.row')].map(row => row.textContent);
    if (!term || !note || !used[key].length) throw new Error('能级缺少项名、模型说明或跃迁。');
    const left = Math.min(...used[key])-16, right = Math.max(...used[key])+16;
    const color = {B:colors.blue,V:colors.green,P0:colors.dark,P2:colors.dark,G:colors.ground,D:colors.dark,S:colors.dark}[key];
    node.removeAttribute('transform');
    node.setAttribute('class','level');
    node.setAttribute('id',id+'-'+key);
    node.replaceChildren(
      element('text',{class:'term',x:28,y:y+5,fill:color,'font-weight':600},term),
      element('text',{x:28,y:y+29,'font-size':12,fill:'#b1c0cd'},note),
      element('line',{x1:81,x2:left,y1:y,y2:y,stroke:'#546575','stroke-dasharray':'2 5'}),
      element('line',{class:'level-line',x1:left,x2:right,y1:y,y2:y,stroke:color,'stroke-width':3})
    );
    lines.append(node);
  }
  return new XMLSerializer().serializeToString(svg);
}

try {
  const page = await browser.newPage();
  await page.addScriptTag({path:mermaidBundle});
  await page.evaluate(config => window.mermaid.initialize({...config,startOnLoad:false}), config);
  const models = ['blue-lightweight','blue-rate-equations','two-color-lightweight','two-color-rate-equations','yb-multilevel'];
  const selection = process.argv[2] ? [process.argv[2]] : models;
  for (const id of selection) {
    if (!models.includes(id)) throw new RangeError('未知能级图。');
    const source = await readFile(join(directory,id+'.mmd'),'utf8');
    const svg = await page.evaluate(renderLevels,{id,source});
    await writeFile(join(directory,id+'.svg'),svg+'\n');
  }
} finally {
  await browser.close();
}
