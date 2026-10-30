// Lightweight MOT scene. Reuses Anatomy's local Three runtime; the CAD viewer
// has no field/trajectory interface, so this renderer shares the dependency only.
import * as THREE from '../anatomy-demo/vendor/three-r160.module.js';
import { OrbitControls } from '../anatomy-demo/vendor/OrbitControls-r160.js';
import { compile, fieldAt, opticalAcceleration, BEAM_DIRECTIONS } from './physics.js';

const C = { cyan: 0x58d5eb, lime: 0xc1ed79, amber: 0xf4bb69, copper: 0xc68a58, text: '#c8d8e6' };
const vector = a => new THREE.Vector3(...a);

export function mountScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1725);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 500);
  camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.setAttribute('aria-label', '三维 MOT 场景；拖动旋转，滚轮缩放');
  renderer.domElement.setAttribute('role', 'img');
  container.append(renderer.domElement);
  const overlay = document.createElement('div');
  Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  container.append(overlay);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(-4, 0, 0);
  controls.enableDamping = false;
  controls.minDistance = 2;
  controls.maxDistance = 220;

  const groups = {};
  for (const name of ['fixed', 'beams', 'coils', 'source', 'field', 'force', 'trails', 'atoms', 'density', 'densityScale', 'zero']) {
    groups[name] = new THREE.Group(); scene.add(groups[name]);
  }
  const labels = [];
  let params, derived, compiled, result = null, mode = 'trajectories', fraction = 1, activeView = 'iso';
  let forceVelocity = [0, 0, 0], layers = { beams: true, coils: true, trails: true };
  let disposed = false;
  const disposables = new Set();
  function clear(group) {
    group.traverse(o => {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
      else o.material?.dispose();
    });
    group.clear();
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].group === group) {
      labels[i].el.remove(); labels.splice(i, 1);
    }
  }
  function line(points, color, group, opacity = 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(points.map(p => p.isVector3 ? p : vector(p)));
    const obj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
    group.add(obj); return obj;
  }
  function label(text, p, group, color = C.text) {
    const el = document.createElement('span'); el.textContent = text;
    Object.assign(el.style, { position: 'absolute', fontSize: '12px', lineHeight: '18px', color,
      padding: '1px 4px', background: 'rgba(11,23,37,.75)', borderRadius: '3px', whiteSpace: 'nowrap' });
    overlay.append(el); labels.push({ el, p: vector(p), group });
  }
  function arrow(start, dir, length, color, group, head = 1.5, opacity = 1) {
    if (length < .01) return;
    const a = new THREE.ArrowHelper(vector(dir).normalize(), vector(start), length, color,
      Math.min(head, length * .4), Math.min(head * .5, length * .2));
    a.line.material.transparent = a.cone.material.transparent = opacity < 1;
    a.line.material.opacity = a.cone.material.opacity = opacity;
    group.add(a); return a;
  }
  function ring(center, normal, radius, color, group, opacity = 1) {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), vector(normal).normalize());
    const ps = Array.from({ length: 81 }, (_, i) => new THREE.Vector3(radius * Math.cos(i * Math.PI / 40),
      radius * Math.sin(i * Math.PI / 40), 0).applyQuaternion(q).add(vector(center)));
    return line(ps, color, group, opacity);
  }
  // Positive winding is counterclockwise for one observer on +normal looking
  // toward the origin. Both members of a pair use this SAME observer.
  function currentArrows(center, normal, radius, winding, color, group) {
    if (!winding) return;
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), vector(normal).normalize());
    for (const startAngle of [.2 * Math.PI, 1.2 * Math.PI]) {
      const endAngle = startAngle + winding * .34 * Math.PI;
      const points = Array.from({ length: 14 }, (_, i) => {
        const angle = startAngle + (endAngle - startAngle) * i / 13;
        return new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), 0).applyQuaternion(rotation).add(vector(center));
      });
      line(points, color, group, .95);
      const tangent = new THREE.Vector3(-Math.sin(endAngle) * winding, Math.cos(endAngle) * winding, 0).applyQuaternion(rotation);
      arrow(points.at(-1).toArray(), tangent.toArray(), 2.1, color, group, 1.3, .95);
    }
  }
  function cylinder(a, b, radius, color, group, opacity) {
    const d = vector(b).sub(vector(a));
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, d.length(), 32, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    mesh.position.copy(vector(a).add(vector(b)).multiplyScalar(.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    group.add(mesh);
  }

  // A 10 mm grid in the horizontal XY plane, below the interaction volume.
  for (let v = -40; v <= 40; v += 10) {
    line([[v, -40, -13], [v, 40, -13]], 0x213142, groups.fixed, .6);
    line([[-40, v, -13], [40, v, -13]], 0x213142, groups.fixed, .6);
  }
  const axisOrigin = [-33, -28, -13];
  for (const [d, t, col] of [[[1, 0, 0], 'X · 冷束', C.cyan], [[0, 1, 0], 'Y · H', C.lime], [[0, 0, 1], 'Z · 竖直', C.amber]]) {
    arrow(axisOrigin, d, 9, col, groups.fixed, 1.3);
    label(t, axisOrigin.map((v, i) => v + d[i] * 11), groups.fixed);
  }
  line([[14, -24, -13], [24, -24, -13]], 0xb7c9dc, groups.fixed);
  label('10 mm', [19, -25, -13], groups.fixed);

  const radialCanvas = document.createElement('canvas'); radialCanvas.width = radialCanvas.height = 64;
  const ctx = radialCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.3, 'rgba(255,255,255,.65)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  const radialTexture = new THREE.CanvasTexture(radialCanvas); disposables.add(radialTexture);

  function buildCoils() {
    clear(groups.coils);
    const main = params.mainAxis === 'z' ? [0, 0, 1] : [0, 1, 0];
    for (const sign of [-1, 1]) {
      for (let t = 0; t < 3; t++) ring(main.map(v => v * (12 + t * .55) * sign), main, 20 + t * .4,
        C.copper, groups.coils, params.mainCurrentA === 0 ? .2 : .65);
      currentArrows(main.map(v => v * 12.55 * sign), main, 20.4,
        sign * Math.sign(params.mainCurrentA), C.amber, groups.coils);
    }
    label(`主线圈 · ${params.mainAxis?.toUpperCase() || 'Y'} 轴`, main.map(v => v * 15).map((v, i) => v + (i === 0 ? 22 : 0)), groups.coils, '#e9b58b');
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((axis, i) => {
      for (const sign of [-1, 1]) {
        const center = axis.map(v => v * (21 + i) * sign), color = [C.cyan, C.lime, C.amber][i];
        ring(center, axis, 26 + i, color, groups.coils, params.biasCurrentA[i] === 0 ? .23 : .4);
        currentArrows(center, axis, 26 + i, Math.sign(params.biasCurrentA[i]), color, groups.coils);
      }
    });
  }
  function buildBeams() {
    clear(groups.beams);
    BEAM_DIRECTIONS.forEach((raw, i) => {
      const d = Array.from(raw), col = [C.cyan, C.cyan, C.lime, C.lime, C.amber, C.amber][i];
      const power = params.powersMW[i];
      const far = d.map(v => -32 * v), near = d.map(v => -1 * v);
      cylinder(far, near, params.waistMM, col, groups.beams, power > 0 ? Math.min(.11, .035 + power * .0015) : .008);
      ring(far, d, params.waistMM, col, groups.beams, power > 0 ? .45 : .12);
      arrow(d.map(v => -28 * v), d, 12, col, groups.beams, 1.8, power > 0 ? .85 : .12);
      label(`${['V1+', 'V1−', 'V2+', 'V2−', 'H+', 'H−'][i]} · ${power} mW`, d.map(v => -35 * v), groups.beams,
        ['#7cdeef', '#7cdeef', '#c1ed79', '#c1ed79', '#f4bb69', '#f4bb69'][i]);
    });
    // Positive input ray directions subtend 120 degrees; the counter-rays are paired.
    const arc = Array.from({ length: 33 }, (_, i) => {
      const a = (-60 + 120 * i / 32) * Math.PI / 180;
      return [9 * Math.sin(a), 0, -9 * Math.cos(a)];
    });
    line(arc, 0x7c93a6, groups.beams, .8); label('120°', [0, 0, -11], groups.beams);
  }
  function buildSource() {
    clear(groups.source);
    const yaw = params.sourceYawDeg * Math.PI / 180, pitch = params.sourcePitchDeg * Math.PI / 180;
    const d = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
    const p = [-params.sourceDistanceMM, params.sourceOffsetYMM, params.sourceOffsetZMM];
    arrow(p, d, 13, 0xe5eef5, groups.source, 2);
    ring(p, [1, 0, 0], params.sourceRadiusMM, 0xe5eef5, groups.source, .65);
    label('冷束 →', p.map((v, i) => v + (i === 2 ? 3 : 0)), groups.source);
    if (params.gravity) { arrow([-17, 17, 10], [0, 0, -1], 7, C.amber, groups.source); label('g', [-17, 17, 12], groups.source); }
  }
  function buildZero() {
    clear(groups.zero);
    if (!derived.zeroUnique || !derived.zeroMM || Math.max(...derived.zeroMM.map(Math.abs)) > 48) return;
    const p = derived.zeroMM;
    const small = mode === 'density' && activeView === 'cloud', half = small ? .16 : 1.5, offset = small ? .65 : 2;
    for (let j = 0; j < 3; j++) line([p.map((v, i) => v - (i === j ? half : 0)), p.map((v, i) => v + (i === j ? half : 0))], 0xffffff, groups.zero, .7);
    label('B = 0', [p[0] + offset, p[1], p[2] + offset], groups.zero, '#ffffff');
  }
  function buildField() {
    clear(groups.field);
    const center = derived.zeroMM?.every(v => Math.abs(v) < 25) ? derived.zeroMM : [0, 0, 0];
    const seeds = [];
    for (let i = 0; i < 18; i++) {
      const z = 1 - 2 * (i + .5) / 18, r = Math.sqrt(1 - z * z), a = i * 2.399963229728653;
      seeds.push(center.map((v, j) => v + 7 * [r * Math.cos(a), r * Math.sin(a), z][j]));
    }
    const direction = p => {
      const b = fieldAt(p.map(v => v / 1000), compiled);
      return vector(b).normalize();
    };
    for (const seed of seeds) {
      const branches = [];
      for (const sign of [-1, 1]) {
        const ps = [vector(seed)]; let p = vector(seed);
        for (let j = 0; j < 100; j++) {
          const d = direction(p.toArray()); if (d.lengthSq() < .5) break;
          const mid = p.clone().addScaledVector(d, .4 * sign);
          const next = p.clone().addScaledVector(direction(mid.toArray()), .8 * sign);
          if (next.distanceTo(p) < .2 || next.toArray().some(v => Math.abs(v) > 40)) break;
          ps.push(next); p = next;
        }
        branches.push(ps);
      }
      const points = [...branches[0].reverse(), ...branches[1].slice(1)];
      if (points.length < 3) continue;
      line(points, C.cyan, groups.field, .5);
      const mid = points[Math.floor(points.length * .6)];
      arrow(mid.toArray(), direction(mid.toArray()).toArray(), 2.8, C.cyan, groups.field, .9, .8);
    }
  }
  function buildForce() {
    clear(groups.force);
    const samples = [], positions = [-8, -4, 0, 4, 8];
    for (const x of positions) for (const y of positions) for (const z of positions) {
      if ((activeView === 'xy' && z !== 0) || (activeView === 'xz' && y !== 0) || (activeView === 'yz' && x !== 0)) continue;
      const pos = [x, y, z], a = opticalAcceleration(pos.map(v => v / 1000), forceVelocity, compiled);
      const norm = Math.hypot(...a); samples.push({ pos, a, norm });
    }
    const max = Math.max(...samples.map(a => a.norm));
    if (max < 1e-10) return;
    // Fixed scale across parameter edits: do not normalize each new force field
    // by its own maximum, which would hide an overall change in optical force.
    for (const s of samples) if (s.norm > 30)
      arrow(s.pos, s.a, Math.min(5, 3 * Math.sqrt(s.norm / 50000)), C.lime, groups.force, .85, .9);
  }
  function setMode(next) {
    const changed = mode !== next; mode = next; updateVisibility();
    if (changed) setView(activeView); else draw();
  }
  function updateVisibility() {
    groups.beams.visible = layers.beams && mode !== 'density';
    groups.coils.visible = layers.coils && mode !== 'density';
    groups.field.visible = mode === 'field'; groups.force.visible = mode === 'force';
    groups.trails.visible = layers.trails && mode === 'trajectories';
    groups.atoms.visible = mode === 'trajectories'; groups.density.visible = mode === 'density';
    groups.densityScale.visible = mode === 'density' && activeView === 'cloud';
    groups.source.visible = mode !== 'density';
  }
  let points = null, densityPoints = null;
  function setResult(next) {
    result = next; clear(groups.atoms); clear(groups.density); clear(groups.densityScale); clear(groups.trails); points = densityPoints = null;
    if (result) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(result.n * 3), 3));
      points = new THREE.Points(g, new THREE.PointsMaterial({ size: .65, vertexColors: true, map: radialTexture, transparent: true, depthWrite: false, alphaTest: .05 }));
      groups.atoms.add(points);
      const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.n * 3), 3));
      densityPoints = new THREE.Points(dg, new THREE.PointsMaterial({ size: .6, color: C.cyan, map: radialTexture, transparent: true,
        opacity: .06, depthWrite: false, blending: THREE.AdditiveBlending }));
      groups.density.add(densityPoints);
      if (result.summary.centroidMM) {
        const c = result.summary.centroidMM, start = [c[0] - .5, c[1] - .8, c[2] - .8];
        line([start, [start[0] + 1, start[1], start[2]]], 0xc8d8e6, groups.densityScale);
        label('1 mm', [start[0] + .5, start[1], start[2] - .12], groups.densityScale);
      }
      for (let i = 0; i < Math.min(18, result.n); i++) {
        const ps = [];
        for (let f = 0; f < result.frameCount; f++) {
          const k = (f * result.n + i) * 3;
          if ((!result.frameAlive || result.frameAlive[f * result.n + i]) && Number.isFinite(result.frames[k]))
            ps.push(vector(Array.from(result.frames.slice(k, k + 3))).multiplyScalar(1000));
        }
        if (ps.length > 1) line(ps, result.retained[i] ? C.lime : 0x628da9, groups.trails, .4);
      }
    }
    setTime(fraction);
  }
  function setTime(value) {
    fraction = Math.max(0, Math.min(1, value));
    if (result && points) {
      const f = Math.min(result.frameCount - 1, Math.round(fraction * (result.frameCount - 1)));
      const p = points.geometry.attributes.position, color = points.geometry.attributes.color;
      const dp = densityPoints.geometry.attributes.position;
      const c = new THREE.Color();
      for (let i = 0; i < result.n; i++) {
        const k = (f * result.n + i) * 3;
        const visible = !result.frameAlive || result.frameAlive[f * result.n + i];
        const pos = Array.from(result.frames.slice(k, k + 3)).map(v => visible && Number.isFinite(v) ? v * 1000 : 1e5);
        p.setXYZ(i, ...pos); dp.setXYZ(i, ...pos);
        c.set(result.retained[i] && fraction > .99 ? C.lime : C.cyan); color.setXYZ(i, c.r, c.g, c.b);
      }
      p.needsUpdate = dp.needsUpdate = color.needsUpdate = true;
      points.geometry.computeBoundingSphere(); densityPoints.geometry.computeBoundingSphere();
      // Replays only the already traversed part of each computed trajectory.
      groups.trails.children.forEach(l => l.geometry.setDrawRange(0, Math.max(1, f + 1)));
    }
    draw();
  }
  function setParams(next, d) {
    params = next; derived = d; compiled = compile(params);
    buildCoils(); buildBeams(); buildSource(); buildZero(); buildField(); buildForce(); updateVisibility(); draw();
  }
  function setForceVelocity(v) { forceVelocity = [...v]; if (compiled) buildForce(); draw(); }
  function draw() {
    if (disposed) return;
    camera.updateMatrixWorld();
    const width = container.clientWidth, height = container.clientHeight;
    for (const l of labels) {
      const p = l.p.clone().project(camera);
      const compactAxisLabel = width < 500 && l.group === groups.fixed && l.el.textContent.includes('·');
      const shown = l.group.visible && !compactAxisLabel && p.z > -1 && p.z < 1;
      l.el.style.display = shown ? '' : 'none';
      l.el.style.transform = `translate(${(p.x + 1) * width / 2}px,${(1 - p.y) * height / 2}px) translate(-50%,-50%)`;
    }
    renderer.render(scene, camera);
  }
  function setView(view) {
    activeView = view;
    const center = view === 'cloud' && result?.summary.centroidMM ? vector(result.summary.centroidMM) : new THREE.Vector3(-4, 0, 0);
    const offsets = { iso: [61, -79, 55], xy: [0, 0, 110], xz: [0, -110, 0], yz: [110, 0, 0], cloud: [3, -4.3, 3] };
    camera.up.set(0, 0, 1); if (view === 'xy') camera.up.set(0, 1, 0);
    if (mode === 'force') center.set(0, 0, 0);
    controls.target.copy(center); camera.position.copy(center).add(vector(offsets[view] || offsets.iso).multiplyScalar(mode === 'force' ? .62 : 1));
    if (compiled) { buildForce(); buildZero(); }
    updateVisibility();
    controls.update(); draw();
  }
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = 2 * Math.atan(Math.tan(18 * Math.PI / 180) * Math.max(1, 1.45 / camera.aspect)) * 180 / Math.PI;
    camera.updateProjectionMatrix(); draw();
  }
  const observer = new ResizeObserver(resize); observer.observe(container);
  controls.addEventListener('change', draw); setView('iso'); resize();
  return { setParams, setResult, setTime, setView, setMode, setForceVelocity,
    setLayers(v) { layers = { ...layers, ...v }; updateVisibility(); draw(); }, resize,
    destroy() { disposed = true; observer.disconnect(); controls.dispose(); Object.values(groups).forEach(clear);
      disposables.forEach(o => o.dispose()); renderer.dispose(); renderer.domElement.remove(); overlay.remove(); } };
}
