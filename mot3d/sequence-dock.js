import { createDockview, themeDark } from './vendor/dockview/dockview.esm.js';

const panels = [
  ['timeline', '通道时序', 'sequence-editor'],
  ['scene', '三维 MOT', 'sequence-scene'],
  ['imaging', '相机成像', 'sequence-imaging'],
  ['readings', '原子样本', 'sequence-readings'],
  ['curves', '原子数与 PSD', 'sequence-curves'],
  ['optimizer', '梯度优化', 'sequence-optimizer'],
  ['engine', '模拟引擎', 'sequence-engine'],
];
const compactScreen = matchMedia('(max-width: 800px)');
const storagePrefix = 'yb-mot3d-sequence-layout-v1-';
const groupGap = 7;

function shelfName() {
  return compactScreen.matches ? 'compact' : 'wide';
}

function validLayout(layout, expected) {
  if (!layout?.grid || layout.grid.root?.type !== 'branch' || !layout.panels ||
      Object.keys(layout.panels).length !== expected.length || layout.popoutGroups?.length) return false;
  if (!expected.every(([id]) => layout.panels[id]?.id === id && layout.panels[id].contentComponent === id)) return false;
  const groups = [];
  function visit(node) {
    if (node.type === 'leaf') groups.push(node.data);
    else node.data.forEach(visit);
  }
  visit(layout.grid.root);
  for (const floating of layout.floatingGroups ?? []) groups.push(floating.data);
  const ids = groups.flatMap(group => group.views);
  return ids.length === expected.length && expected.every(([id]) => ids.includes(id));
}

export function mountSequenceDock() {
  const host = document.getElementById('sequence-dock');
  const menu = document.getElementById('sequence-layout-menu');
  const form = menu.querySelector('form');
  const {panel: source, target, placement} = form.elements;
  const sections = new Map(panels.map(([id, , elementId]) => [id, document.getElementById(elementId)]));
  const titles = new Map(panels.map(([id, title]) => [id, title]));
  const shelf = document.getElementById('sequence-panel-source');
  const contents = new Map();
  for (const [id, title] of titles) {
    source.add(new Option(title, id));
    target.add(new Option(title, id));
    // 尚未显示过的标签也需要接收求解器的读数。
    const element = document.createElement('div');
    element.id = 'dock-panel-' + id;
    element.className = 'dock-panel';
    element.setAttribute('role', 'tabpanel');
    element.setAttribute('aria-label', title);
    shelf.append(element);
    element.append(sections.get(id));
    contents.set(id, element);
  }
  const dock = createDockview(host, {
    theme: {...themeDark, gap: groupGap}, defaultRenderer: 'always',
    floatingGroupBounds: 'boundedWithinViewport',
    defaultTabComponent: 'sequence-tab',
    createTabComponent({id}) {
      const element = document.createElement('span');
      element.className = 'layout-tab';
      element.dataset.panel = id;
      element.textContent = titles.get(id);
      return {element, init() {}};
    },
    createComponent({id}) {
      const element = contents.get(id);
      return {element, init() {}, dispose() { shelf.append(element); }};
    },
  });
  let profile = shelfName(), saveTimer = 0, layoutFrame = 0;
  // 发生断点切换时容器可能已经变窄，保留最近一次完整布局的尺寸。
  let lastLayout = null, lastWidth = host.clientWidth;

  function add(id, referencePanel, direction, inactive = false) {
    const compact = profile === 'compact';
    return dock.addPanel({
      id, title: titles.get(id), component: id, renderer: 'always', inactive,
      minimumWidth: compact ? 120 : 228, minimumHeight: 110,
      ...(referencePanel && {position: {referencePanel, direction}}),
    });
  }
  function defaults() {
    dock.clear();
    dock.layout(host.clientWidth, host.clientHeight);
    const compact = profile === 'compact';
    const timeline = add('timeline');
    const scene = add('scene', timeline, compact ? 'within' : 'right');
    const imaging = add('imaging', scene, compact ? 'within' : 'below');
    const readings = add('readings', imaging, 'within', true);
    add('curves', readings, 'within', true);
    add('optimizer', timeline, 'within', true);
    add('engine', timeline, 'within', true);
    if (!compact) {
      timeline.api.setSize({width: Math.round(host.clientWidth * .46)});
      scene.api.setSize({height: Math.round(host.clientHeight * .52)});
    }
    timeline.api.setActive();
  }

  function writeLayout(layout) {
    if (!layout) return;
    try { localStorage.setItem(storagePrefix + profile, JSON.stringify(layout)); }
    catch { /* 浏览器关闭本地存储时仍可调整当前布局。 */ }
  }
  function save() {
    clearTimeout(saveTimer);
    if (profile !== shelfName()) return;
    lastLayout = dock.toJSON();
    lastWidth = host.clientWidth;
    writeLayout(lastLayout);
  }
  function load() {
    let restored = false;
    dock.layout(host.clientWidth, host.clientHeight);
    try {
      const saved = JSON.parse(localStorage.getItem(storagePrefix + profile));
      // 面板按加入顺序登记，载入旧布局时保留用户的分组与尺寸。
      const count = Object.keys(saved?.panels ?? {}).length;
      if (count >= 4 && count <= panels.length && validLayout(saved, panels.slice(0, count))) {
        dock.fromJSON(saved);
        if (count < panels.length) {
          if (!dock.getPanel('curves')) add('curves', dock.getPanel('readings'), 'within', true);
          if (!dock.getPanel('optimizer')) add('optimizer', dock.getPanel('timeline'), 'within', true);
          add('engine', dock.getPanel('timeline'), 'within', true);
          writeLayout(dock.toJSON());
        }
        restored = true;
      }
    } catch { /* 过期或被浏览器截断的布局从默认排列重新开始。 */ }
    if (!restored) defaults();
    lastWidth = host.clientWidth;
    lastLayout = dock.toJSON();
  }

  function resizeAxis(sash) {
    const split = sash.parentElement.parentElement;
    const across = split.classList.contains('dv-horizontal');
    const index = [...sash.parentElement.children].indexOf(sash);
    const views = split.querySelector(':scope > .dv-view-container').children;
    return {split, across, before: views[index], after: views[index + 1]};
  }
  function labelDockControls() {
    for (const list of host.querySelectorAll('.dv-tabs-container')) {
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-label', '工作区面板');
      for (const tab of list.querySelectorAll('.dv-tab')) {
        const id = tab.querySelector('.layout-tab')?.dataset.panel;
        if (!id) continue;
        const active = tab.classList.contains('dv-active-tab');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(active));
        tab.setAttribute('aria-controls', 'dock-panel-' + id);
        tab.tabIndex = active ? 0 : -1;
      }
    }
    for (const sash of host.querySelectorAll('.dv-sash')) {
      const {split, across, before} = resizeAxis(sash);
      const size = across ? split.clientWidth : split.clientHeight;
      const position = across ? sash.offsetLeft + sash.offsetWidth / 2 : sash.offsetTop + sash.offsetHeight / 2;
      const percent = Math.min(100, Math.max(0, Math.round(100 * position / (size || 1))));
      const controls = [...before.querySelectorAll('.layout-tab')].map(tab => 'dock-panel-' + tab.dataset.panel);
      const disabled = sash.classList.contains('dv-disabled');
      sash.tabIndex = disabled ? -1 : 0;
      sash.setAttribute('role', 'separator');
      sash.setAttribute('aria-orientation', across ? 'vertical' : 'horizontal');
      sash.setAttribute('aria-label', across ? '调整左右面板宽度' : '调整上下区域高度');
      sash.setAttribute('aria-controls', controls.join(' '));
      sash.setAttribute('aria-valuemin', '0');
      sash.setAttribute('aria-valuemax', '100');
      sash.setAttribute('aria-valuenow', String(percent));
      sash.setAttribute('aria-valuetext', (across ? '左侧' : '上方') + '占 ' + percent + '%');
      sash.setAttribute('aria-disabled', String(disabled));
    }
  }

  function resizeWithKeys(event, sash) {
    const {across, before, after} = resizeAxis(sash);
    const direction = across ? {ArrowLeft: -1, ArrowRight: 1} : {ArrowUp: -1, ArrowDown: 1};
    const sign = direction[event.key];
    if (!sign || sash.classList.contains('dv-disabled')) return;
    event.preventDefault();
    const dimension = across ? 'width' : 'height';
    // 嵌套分栏中，选择沿此次调整方向横跨邻接区域的组。
    const count = before.parentElement.childElementCount;
    // Dockview 将分隔距离平均计入各区域的逻辑尺寸。
    const margin = groupGap * (count - 1) / count;
    const adjacent = [before, after].map((view, index) => {
      const size = view.getBoundingClientRect()[dimension];
      const groups = dock.groups.filter(group => view.contains(group.element));
      const group = groups.reduce((largest, current) =>
        current.element.getBoundingClientRect()[dimension] > largest.element.getBoundingClientRect()[dimension]
          ? current : largest);
      return {group, sign: index === 0 ? sign : -sign, size: size + margin,
        gap: Math.abs(size - group.element.getBoundingClientRect()[dimension])};
    });
    const [primary, secondary] = adjacent.sort((a, b) => a.gap - b.gap);
    primary.group.api.setSize({[dimension]: primary.size + primary.sign * 24});
    if (count > 2) {
      const moved = primary.group.element.getBoundingClientRect()[dimension] + margin - primary.size;
      secondary.group.api.setSize({[dimension]: secondary.size - moved});
    }
    labelDockControls();
    save();
  }
  function changed() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      labelDockControls();
      if (profile !== shelfName()) return;
      lastLayout = dock.toJSON();
      lastWidth = host.clientWidth;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => writeLayout(lastLayout), 160);
    });
  }
  load();
  labelDockControls();
  dock.onDidLayoutChange(changed);
  dock.onDidActivePanelChange(changed);
  dock.onDidMovePanel(() => queueMicrotask(save));
  host.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const sash = event.target.closest('.dv-sash');
    if (!sash) return;
    // 保留 Dockview 的指针拖动，只取消浏览器的原生文字选择。
    event.preventDefault();
    if (sash.tabIndex >= 0) sash.focus({preventScroll: true});
  }, {capture: true});
  host.addEventListener('pointerup', () => queueMicrotask(save));
  compactScreen.addEventListener('change', () => {
    clearTimeout(saveTimer);
    writeLayout(host.clientWidth === lastWidth ? dock.toJSON() : lastLayout);
    profile = shelfName();
    load();
    changed();
    syncMenu();
  });
  window.addEventListener('pagehide', save);

  host.addEventListener('keydown', event => {
    if (event.target.matches('.dv-sash')) {
      resizeWithKeys(event, event.target);
      return;
    }
    const tab = event.target.closest('.dv-tab');
    if (!tab) return;
    const list = [...tab.closest('.dv-tabs-container').querySelectorAll('.dv-tab')];
    const index = list.indexOf(tab);
    const next = {ArrowLeft: (index + list.length - 1) % list.length, ArrowRight: (index + 1) % list.length,
      Home: 0, End: list.length - 1, Enter: index, ' ': index}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    dock.getPanel(list[next].querySelector('.layout-tab').dataset.panel).api.setActive();
    list[next].focus({preventScroll: true});
  });

  function syncMenu() {
    const sourcePanel = dock.getPanel(source.value);
    const floatOption = placement.querySelector('[value="float"]');
    floatOption.disabled = compactScreen.matches || sourcePanel.api.location.type === 'floating' ||
      (dock.groups.filter(g => g.api.location.type === 'grid').length === 1 && sourcePanel.group.size === 1);
    const sides = ['left', 'right', 'top', 'bottom'];
    const gridTarget = dock.panels.some(p => p !== sourcePanel && p.api.location.type === 'grid');
    for (const side of sides) placement.querySelector('[value="' + side + '"]').disabled = !gridTarget;
    if (placement.selectedOptions[0].disabled) placement.value = 'show';
    for (const option of target.options) {
      option.disabled = option.value === source.value ||
        (sides.includes(placement.value) && dock.getPanel(option.value).api.location.type === 'floating');
    }
    if (target.selectedOptions[0].disabled) target.value = [...target.options].find(o => !o.disabled).value;
    target.parentElement.hidden = ['show', 'float'].includes(placement.value);
  }
  menu.querySelector('summary').addEventListener('click', () => {
    if (menu.open) return;
    source.value = dock.activePanel?.id ?? 'timeline';
    placement.value = 'show';
    syncMenu();
  });
  form.addEventListener('change', syncMenu);
  function closeMenu() {
    menu.open = false;
    menu.querySelector('summary').focus({preventScroll: true});
  }
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const panel = dock.getPanel(source.value);
    if (placement.value === 'float') {
      dock.addFloatingGroup(panel, {x: 32, y: 32, width: Math.round(host.clientWidth * .53),
        height: Math.round(host.clientHeight * .65)});
    } else if (placement.value !== 'show') {
      panel.api.moveTo({group: dock.getPanel(target.value).group, position: placement.value});
    }
    panel.api.setActive();
    save();
    closeMenu();
    changed();
  });
  document.getElementById('sequence-layout-reset').addEventListener('click', () => {
    defaults();
    save();
    changed();
  });

  function reveal(hash, focus) {
    const element = document.getElementById(hash.slice(1));
    if (!element) return;
    for (const [id, section] of sections) {
      if (element !== section && !section.contains(element)) continue;
      dock.getPanel(id).api.setActive();
      requestAnimationFrame(() => {
        if (focus) {
          const tab = host.querySelector('.dv-tab .layout-tab[data-panel="' + id + '"]');
          tab?.parentElement.focus({preventScroll: true});
        }
        element.scrollIntoView({block: 'nearest'});
      });
      return;
    }
  }
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a[href^="#"]');
    if (anchor && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) reveal(anchor.hash, true);
  });
  window.addEventListener('hashchange', () => reveal(location.hash, true));
  if (location.hash) reveal(location.hash, false);
}
