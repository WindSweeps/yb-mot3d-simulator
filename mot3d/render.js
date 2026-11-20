// Lightweight MOT scene. Reuses Anatomy's local Three runtime; the CAD viewer
// has no field/trajectory interface, so this renderer shares the dependency only.
import * as THREE from '../anatomy-demo/vendor/three-r160.module.js';
import { OrbitControls } from '../anatomy-demo/vendor/OrbitControls-r160.js';
import { compile, fieldAt, opticalAcceleration, BEAM_DIRECTIONS } from './physics.js';
import { DEFAULT_FLUX } from './fluorescence.js';
import { createFluorescenceVolume, recentWindow, screenFade } from './fluorescence-volume.js';
import { createSequenceRender } from './sequence-render.js';

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
  const cloudFocus = new THREE.Vector3();
  controls.target.set(-4, 0, 0);
  controls.enableDamping = false;
  controls.minDistance = 2;
  controls.maxDistance = 220;

  const groups = {};
  for (const name of ['fixed', 'beams', 'coils', 'source', 'field', 'force', 'trails', 'atoms', 'density', 'densityScale', 'zero', 'fluorescence', 'sequenceBeams', 'sequenceAtoms', 'sequenceTrails', 'sequenceScale']) {
    groups[name] = new THREE.Group();
    groups[name].name = `mot-${name}`;
    scene.add(groups[name]);
  }
  const labels = [];
  let params, derived, compiled, result = null, mode = 'trajectories', fraction = 1, activeView = 'iso';
  let sequenceFrame = null, sequenceRender = null, mainCoilLabel = null;
  let sequenceGeometryChanged = true;
  let forceVelocity = [0, 0, 0], layers = { beams: true, coils: true, trails: true, fluorescence: false };
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
    overlay.append(el);
    const entry = { el, p: vector(p), group };
    labels.push(entry);
    return entry;
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

  let fluorescenceVolume = null, fluorescenceFrame = -1, fluorescenceFlux = DEFAULT_FLUX;
  let currentFrame = -1, motionFade = 0, motionSince = 0, fadeTimer = 0, fadeAnimation = 0;
  function emissionPoints(name, diameterMM, minimumPixels) {
    const material = new THREE.ShaderMaterial({
    uniforms: {
      intensityScale: { value: 1 }, sampleWeight: { value: 1 }, fade: { value: 1 },
      pixelRatio: { value: renderer.getPixelRatio() }, viewportHeight: { value: 1 },
      diameterMM: { value: diameterMM }, minimumPixels: { value: minimumPixels },
    },
    vertexShader: `
      attribute float rate, weight;
      uniform float intensityScale, sampleWeight, fade, pixelRatio, viewportHeight, diameterMM, minimumPixels;
      varying float emission;
      void main() {
        float amplitude = max(0.0, rate * intensityScale * 1e-7);
        emission = fade * weight * sampleWeight * amplitude / (1.0 + amplitude);
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        float diameter = diameterMM * projectionMatrix[1][1] * viewportHeight * 0.5 / max(-viewPosition.z, 0.01);
        gl_PointSize = clamp(diameter, minimumPixels * pixelRatio, 60.0 * pixelRatio);
      }`,
    fragmentShader: `
      varying float emission;
      void main() {
        vec2 offset = 2.0 * gl_PointCoord - 1.0;
        float r2 = dot(offset, offset);
        if (r2 >= 1.0) discard;
        float glow = exp(-3.0 * r2) * (1.0 - r2);
        gl_FragColor = vec4(0.73, 0.70, 1.0, emission * glow);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setDrawRange(0, 0);
    const obj = new THREE.Points(geometry, material);
    obj.name = name;
    obj.frustumCulled = false;
    obj.renderOrder = 2;
    groups.fluorescence.add(obj);
    return obj;
  }
  const cloudLight = emissionPoints('mot-fluorescence-cloud', .34, 6);
  const flybyLight = emissionPoints('mot-fluorescence-transient', .32, 3.5);
  function uploadEmission(obj, data) {
    if (obj.geometry.attributes.position?.array !== data.positions) {
      obj.geometry.dispose();
      obj.geometry = new THREE.BufferGeometry();
      for (const [name, array, size] of [['position', data.positions, 3], ['rate', data.rates, 1], ['weight', data.weights, 1]])
        obj.geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    }
    for (const attr of Object.values(obj.geometry.attributes)) {
      attr.clearUpdateRanges();
      if (data.count) { attr.addUpdateRange(0, data.count * attr.itemSize); attr.needsUpdate = true; }
    }
    obj.geometry.setDrawRange(0, data.count);
  }
  function updateFluorescence() {
    for (const obj of [cloudLight, flybyLight]) {
      obj.material.uniforms.intensityScale.value = fluorescenceFlux / DEFAULT_FLUX;
      obj.material.uniforms.sampleWeight.value = result ? 64 / result.n : 0;
    }
    if (!groups.fluorescence.visible || !fluorescenceFlux || currentFrame <= 0) {
      cloudLight.geometry.setDrawRange(0, 0);
      flybyLight.geometry.setDrawRange(0, 0);
      fluorescenceFrame = -1;
      return;
    }
    if (fluorescenceFrame !== currentFrame) {
      fluorescenceVolume.at(currentFrame, motionFade > 0);
      uploadEmission(cloudLight, fluorescenceVolume.cloud);
      uploadEmission(flybyLight, fluorescenceVolume.transient);
      fluorescenceFrame = currentFrame;
    }
    if (motionFade === 0) flybyLight.geometry.setDrawRange(0, 0);
  }
  function setFluorescenceFlux(value) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('入射通量必须为非负有限数。');
    if (fluorescenceFlux === value) return;
    fluorescenceFlux = value;
    updateFluorescence();
    scheduleFade();
    draw();
  }

  function buildCoils() {
    clear(groups.coils);
    const main = params.mainAxis === 'z' ? [0, 0, 1] : [0, 1, 0];
    const winding = Math.sign(sequenceFrame ? sequenceFrame.gradientGCM : params.mainCurrentA);
    for (const sign of [-1, 1]) {
      for (let t = 0; t < 3; t++) ring(main.map(v => v * (12 + t * .55) * sign), main, 20 + t * .4,
        C.copper, groups.coils, winding === 0 ? .2 : .65);
      currentArrows(main.map(v => v * 12.55 * sign), main, 20.4,
        sign * winding, C.amber, groups.coils);
    }
    mainCoilLabel = label(`主线圈 · ${params.mainAxis?.toUpperCase() || 'Y'} 轴`, main.map(v => v * 15).map((v, i) => v + (i === 0 ? 22 : 0)), groups.coils, '#e9b58b');
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
    groups.zero.position.set(0, 0, 0);
    if (sequenceFrame) {
      const size = activeView === 'cloud' ? .16 : 1.5;
      for (let axis = 0; axis < 3; axis++) {
        const end = [0, 0, 0]; end[axis] = size;
        line([end.map(v => -v), end], 0xffffff, groups.zero, .7);
      }
      label('B = 0', [0, 0, 0], groups.zero, '#ffffff');
      moveSequenceZero();
      return;
    }
    if (!derived.zeroUnique || !derived.zeroMM || Math.max(...derived.zeroMM.map(Math.abs)) > 48) return;
    const p = derived.zeroMM;
    const small = activeView === 'cloud', half = small ? .16 : 1.5;
    for (let j = 0; j < 3; j++) line([p.map((v, i) => v - (i === j ? half : 0)), p.map((v, i) => v + (i === j ? half : 0))], 0xffffff, groups.zero, .7);
    label('B = 0', p, groups.zero, '#ffffff');
  }
  function moveSequenceZero() {
    const gradient = sequenceFrame.gradientGCM;
    const zero = gradient && derived.biasG.map((b, i) => -10*b / (gradient * derived.mainTensor[i]));
    groups.zero.visible = Boolean(zero && zero.every(v => Math.abs(v) <= 48));
    if (groups.zero.visible) groups.zero.position.set(...zero);
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
    const changed = mode !== next;
    const sharedViews = activeView === 'cloud' ? ['density', 'fluorescence'] : ['trajectories', 'fluorescence'];
    const keepOrbit = sharedViews.includes(mode) && sharedViews.includes(next);
    mode = next;
    if (motionFade) applyFade(screenFade(performance.now() - motionSince));
    updateVisibility();
    if (changed && compiled && mode === 'field') buildField();
    if (changed && !keepOrbit) setView(activeView); else draw();
    scheduleFade();
  }
  function updateVisibility() {
    const sequence = Boolean(sequenceFrame);
    const showTrajectories = !sequence && (mode === 'trajectories' || mode === 'fluorescence');
    groups.beams.visible = !sequence && layers.beams && mode !== 'density';
    groups.coils.visible = layers.coils && (sequence || mode !== 'density');
    groups.field.visible = !sequence && mode === 'field'; groups.force.visible = !sequence && mode === 'force';
    groups.trails.visible = layers.trails && showTrajectories;
    groups.atoms.visible = showTrajectories; groups.density.visible = !sequence && mode === 'density';
    if (heldPoints) heldPoints.visible = mode === 'trajectories' && !layers.fluorescence;
    groups.fluorescence.visible = !sequence && layers.fluorescence;
    groups.sequenceBeams.visible = sequence && layers.beams;
    groups.sequenceAtoms.visible = sequence;
    groups.sequenceTrails.visible = sequence && layers.trails;
    if (sequenceRender) sequenceRender.cloud.material.uniforms.fluorescence.value = layers.fluorescence;
    groups.densityScale.visible = !sequence && activeView === 'cloud';
    groups.sequenceScale.visible = sequence && activeView === 'cloud' && Boolean(sequenceFrame.centroidMM);
    groups.source.visible = sequence || mode !== 'density';
  }
  let points = null, heldPoints = null, densityPoints = null, freeDensity = null, trailLines = null;
  function samplePoints(group, name, size, color, opacity) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * result.n), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({ size, color, opacity, map: radialTexture, transparent: true,
      depthWrite: false, blending: group === groups.density ? THREE.AdditiveBlending : THREE.NormalBlending });
    const obj = new THREE.Points(geometry, material);
    obj.name = name;
    obj.frustumCulled = false;
    group.add(obj);
    return obj;
  }
  function makeTrailLines() {
    const geometry = new THREE.BufferGeometry(), capacity = 2 * 8 * Math.min(18, result.n);
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * capacity), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('weight', new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      uniforms: { fade: { value: 0 } },
      vertexShader: `attribute float weight; varying float strength;
        void main() { strength = weight; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float strength; uniform float fade;
        void main() { gl_FragColor = vec4(0.43, 0.68, 0.77, 0.65 * fade * strength); }`,
      transparent: true, depthWrite: false,
    });
    const obj = new THREE.LineSegments(geometry, material);
    obj.name = 'mot-recent-trails';
    obj.frustumCulled = false;
    groups.trails.add(obj);
    return obj;
  }
  function updateTrails(frame) {
    const { frames, n, frameAlive, frameCount } = result;
    const { first, segments, step } = recentWindow(result, frame, 8);
    const { position, weight } = trailLines.geometry.attributes;
    let count = 0;
    for (let s = 0; s < segments; s++) {
      const start = first + s * step, end = s + 1 === segments ? frame : first + (s + 1) * step;
      for (let i = 0; i < Math.min(n, 18); i++) {
        if (start >= fluorescenceVolume.capturedFrom[i] || !frameAlive[Math.floor(start) * n + i]) continue;
        const clippedEnd = Math.min(end, fluorescenceVolume.capturedFrom[i]);
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const t = endpoint === 0 ? start : clippedEnd;
          const lo = Math.floor(t), a = lo * n + i, b = Math.min(lo + 1, frameCount - 1) * n + i;
          for (let axis = 0; axis < 3; axis++)
            position.array[count*3 + axis] = 1000 * (frames[a*3 + axis] + (t - lo) * (frames[b*3 + axis] - frames[a*3 + axis]));
          weight.array[count++] = (t - first) / (frame - first);
        }
      }
    }
    trailLines.geometry.setDrawRange(0, count);
    position.needsUpdate = weight.needsUpdate = true;
  }
  function updateAtoms(frame) {
    const { n, frames, frameAlive } = result;
    const free = points.geometry.attributes.position, held = heldPoints.geometry.attributes.position;
    const density = densityPoints.geometry.attributes.position, flybyDensity = freeDensity.geometry.attributes.position;
    let freeCount = 0, heldCount = 0;
    for (let i = 0; i < n; i++) {
      const k = frame * n + i;
      if (!frameAlive[k]) continue;
      const x = 1000 * frames[3*k], y = 1000 * frames[3*k + 1], z = 1000 * frames[3*k + 2];
      if (fluorescenceVolume.capturedFrom[i] <= frame) {
        held.setXYZ(heldCount, x, y, z); density.setXYZ(heldCount++, x, y, z);
      } else if (motionFade > 0) {
        free.setXYZ(freeCount, x, y, z); flybyDensity.setXYZ(freeCount++, x, y, z);
      }
    }
    points.geometry.setDrawRange(0, freeCount);
    heldPoints.geometry.setDrawRange(0, heldCount);
    densityPoints.geometry.setDrawRange(0, heldCount);
    freeDensity.geometry.setDrawRange(0, freeCount);
    free.needsUpdate = held.needsUpdate = density.needsUpdate = flybyDensity.needsUpdate = true;
  }
  function applyFade(value) {
    motionFade = value;
    if (sequenceFrame && sequenceRender) {
      sequenceRender.tails.material.opacity = .48 * value;
      if (!value) sequenceRender.tails.geometry.setDrawRange(0, 0);
    }
    flybyLight.material.uniforms.fade.value = value;
    if (trailLines) trailLines.material.uniforms.fade.value = value;
    if (points) points.material.opacity = value;
    if (freeDensity) freeDensity.material.opacity = .06 * value;
    if (!value) {
      flybyLight.geometry.setDrawRange(0, 0);
      trailLines?.geometry.setDrawRange(0, 0);
      points?.geometry.setDrawRange(0, 0);
      freeDensity?.geometry.setDrawRange(0, 0);
    }
  }
  function scheduleFade() {
    clearTimeout(fadeTimer);
    cancelAnimationFrame(fadeAnimation);
    if (!motionFade || disposed) return;
    const visible = (groups.fluorescence.visible && flybyLight.geometry.drawRange.count) ||
      (groups.trails.visible && trailLines?.geometry.drawRange.count) || (groups.atoms.visible && points?.geometry.drawRange.count) ||
      (groups.density.visible && freeDensity?.geometry.drawRange.count) ||
      (groups.sequenceTrails.visible && sequenceRender?.tails.geometry.drawRange.count);
    if (!visible) return;
    // 连续播放本身会绘制画面。只有在时间轴停止更新之后才启动余迹动画。
    fadeTimer = setTimeout(() => { fadeAnimation = requestAnimationFrame(fadeTick); }, 40);
  }
  function fadeTick(now) {
    if (disposed) return;
    applyFade(screenFade(now - motionSince));
    draw();
    if (motionFade > 0) fadeAnimation = requestAnimationFrame(fadeTick);
  }
  function setResult(next) {
    if (result === next) return;
    result = next; clear(groups.atoms); clear(groups.density); clear(groups.densityScale); clear(groups.trails);
    points = densityPoints = freeDensity = heldPoints = trailLines = null;
    fluorescenceVolume = result ? createFluorescenceVolume(result) : null;
    fluorescenceFrame = currentFrame = -1;
    for (const obj of [cloudLight, flybyLight]) {
      obj.geometry.dispose(); obj.geometry = new THREE.BufferGeometry(); obj.geometry.setDrawRange(0, 0);
    }
    if (result) {
      if (activeView === 'cloud' && result.summary.centroidMM) {
        const center = vector(result.summary.centroidMM), shift = center.clone().sub(cloudFocus);
        camera.position.add(shift); controls.target.add(shift); cloudFocus.copy(center);
        controls.update();
      }
      points = samplePoints(groups.atoms, 'mot-atoms-in-flight', .55, C.cyan, 1);
      heldPoints = samplePoints(groups.atoms, 'mot-atoms-held', .45, C.lime, 1);
      densityPoints = samplePoints(groups.density, 'mot-cloud-density', .6, C.cyan, .06);
      freeDensity = samplePoints(groups.density, 'mot-in-flight-density', .6, C.cyan, .06);
      trailLines = makeTrailLines();
      {
        const c = result.summary.centroidMM ?? [0, 0, 0], start = [c[0] - .5, c[1] - .8, c[2] - .8];
        line([start, [start[0] + 1, start[1], start[2]]], 0xc8d8e6, groups.densityScale);
        label('1 mm', [start[0] + .5, start[1], start[2] - .12], groups.densityScale);
      }
    }
    updateVisibility();
    setTime(fraction, fraction === 1);
  }
  function setTime(value, settled = false) {
    fraction = Math.max(0, Math.min(1, value));
    if (result) {
      const frame = Math.round(fraction * (result.frameCount - 1));
      if (frame === currentFrame) return;
      currentFrame = frame;
      motionSince = performance.now();
      applyFade(settled ? 0 : 1);
      updateAtoms(frame);
      if (motionFade > 0) updateTrails(frame);
    } else {
      applyFade(0);
    }
    updateFluorescence();
    scheduleFade();
    draw();
  }
  function setParams(next, d, velocity = forceVelocity) {
    params = next; derived = d; compiled = compile(params);
    sequenceGeometryChanged = true;
    forceVelocity = [...velocity];
    buildCoils(); buildBeams(); buildSource(); buildZero();
    if (mode === 'field') buildField();
    if (mode === 'force') buildForce();
    updateVisibility(); draw();
  }
  function setForceVelocity(v) {
    if (v.every((component, axis) => component === forceVelocity[axis])) return;
    forceVelocity = [...v];
    if (compiled && mode === 'force') { buildForce(); draw(); }
  }
  function setSequenceFrame(next) {
    if (!params) throw new Error('三维时序需要先设置光束几何。');
    const previous = sequenceFrame;
    sequenceFrame = next;
    if (!next) {
      if (!previous) return;
      groups.zero.visible = true;
      buildZero(); buildCoils(); updateVisibility();
      applyFade(0); scheduleFade(); updateFluorescence(); draw();
      return;
    }
    // 游标经过装载等待段时，每个通道及原子云都保持静止，保留上次绘图。
    if (previous && !sequenceGeometryChanged && previous.gradientGCM === next.gradientGCM &&
      previous.greenWaistMM === next.greenWaistMM && previous.positionsM?.buffer === next.positionsM?.buffer &&
      previous.positionsM?.byteOffset === next.positionsM?.byteOffset &&
      Boolean(previous.previousPositionsM) === Boolean(next.previousPositionsM) &&
      next.bluePowersMW.every((p, i) => p === previous.bluePowersMW[i]) &&
      next.greenPowersMW.every((p, i) => p === previous.greenPowersMW[i])) return;
    sequenceGeometryChanged = false;
    if (!sequenceRender) {
      sequenceRender = createSequenceRender(groups.sequenceBeams, groups.sequenceAtoms, groups.sequenceTrails, label);
      line([[-.5, -.8, -.8], [.5, -.8, -.8]], 0xc8d8e6, groups.sequenceScale);
      label('1 mm', [0, -.8, -.92], groups.sequenceScale);
      updateSequenceViewport();
    }
    if (!previous) buildZero();
    if (!previous || Math.sign(previous.gradientGCM) !== Math.sign(next.gradientGCM)) buildCoils();
    mainCoilLabel.el.textContent = `主线圈 · ${params.mainAxis.toUpperCase()} · ${Number(next.gradientGCM.toFixed(2))} G/cm`;
    moveSequenceZero();
    if (next.centroidMM) groups.sequenceScale.position.set(...next.centroidMM);
    if (sequenceRender.setFrame(next, params.waistMM)) {
      motionSince = performance.now();
      applyFade(1);
    }
    updateVisibility();
    if (activeView === 'cloud' && next.centroidMM) {
      const center = vector(next.centroidMM), shift = center.clone().sub(cloudFocus);
      if (shift.lengthSq() > 1e-12) {
        controls.target.add(shift); camera.position.add(shift); cloudFocus.copy(center);
        controls.update();
      }
    }
    scheduleFade(); draw();
  }
  function updateSequenceViewport() {
    if (!sequenceRender) return;
    const u = sequenceRender.cloud.material.uniforms;
    u.pixelRatio.value = renderer.getPixelRatio();
    u.viewportHeight.value = Math.max(1, container.clientHeight) * renderer.getPixelRatio();
  }
  function draw() {
    if (disposed) return;
    camera.updateMatrixWorld();
    const width = container.clientWidth, height = container.clientHeight;
    for (const l of labels) {
      const p = l.p.clone().add(l.group.position).project(camera);
      const compactAxisLabel = width < 500 && l.group === groups.fixed && l.el.textContent.includes('·');
      const shown = l.group.visible && !compactAxisLabel && p.z > -1 && p.z < 1;
      l.el.style.display = shown ? '' : 'none';
      const offset = l.group === groups.zero ? 'translate(12px,calc(-100% - 8px))' : 'translate(-50%,-50%)';
      l.el.style.transform = `translate(${(p.x + 1) * width / 2}px,${(1 - p.y) * height / 2}px) ${offset}`;
    }
    renderer.render(scene, camera);
  }
  function setView(view) {
    activeView = view;
    const center = view === 'cloud' ? vector(sequenceFrame?.centroidMM ?? result?.summary.centroidMM ?? [0, 0, 0]) : new THREE.Vector3(-4, 0, 0);
    if (view === 'cloud') cloudFocus.copy(center);
    const offsets = { iso: [61, -79, 55], xy: [0, 0, 110], xz: [0, -110, 0], yz: [110, 0, 0], cloud: [3, -4.3, 3] };
    camera.up.set(0, 0, 1); if (view === 'xy') camera.up.set(0, 1, 0);
    if (mode === 'force') center.set(0, 0, 0);
    controls.target.copy(center); camera.position.copy(center).add(vector(offsets[view] || offsets.iso).multiplyScalar(mode === 'force' ? .62 : 1));
    if (compiled) {
      if (mode === 'force') buildForce();
      buildZero();
    }
    updateVisibility();
    controls.update(); draw();
  }
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h;
    for (const obj of [cloudLight, flybyLight]) obj.material.uniforms.viewportHeight.value = h * renderer.getPixelRatio();
    updateSequenceViewport();
    camera.fov = 2 * Math.atan(Math.tan(18 * Math.PI / 180) * Math.max(1, 1.45 / camera.aspect)) * 180 / Math.PI;
    camera.updateProjectionMatrix(); draw();
  }
  const observer = new ResizeObserver(resize); observer.observe(container);
  controls.addEventListener('change', draw); setView('iso'); resize();
  return { setParams, setResult, setTime, setView, setMode, setForceVelocity, setFluorescenceFlux, setSequenceFrame,
    setLayers(v) {
      layers = { ...layers, ...v };
      if (motionFade) applyFade(screenFade(performance.now() - motionSince));
      updateVisibility(); updateFluorescence(); scheduleFade(); draw();
    }, resize,
    destroy() { disposed = true; clearTimeout(fadeTimer); cancelAnimationFrame(fadeAnimation);
      observer.disconnect(); controls.dispose(); Object.values(groups).forEach(clear);
      disposables.forEach(o => o.dispose()); renderer.dispose(); renderer.domElement.remove(); overlay.remove(); } };
}
