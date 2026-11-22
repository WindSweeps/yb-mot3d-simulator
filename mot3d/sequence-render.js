import * as THREE from '../anatomy-demo/vendor/three-r160.module.js';
import { BEAM_DIRECTIONS, BEAM_LABELS } from './physics.js';

const colors = [0x989afa, 0x88df7c];
const up = new THREE.Vector3(0, 1, 0);

export function createSequenceRender(beamGroup, atomGroup, trailGroup, addLabel) {
  const shafts = colors.map((color, channel) => BEAM_DIRECTIONS.map((direction, index) => {
    const d = new THREE.Vector3(...direction);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 31, 32, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending }));
    beam.name = `sequence-${[399, 556][channel]}-${BEAM_LABELS[index]}`;
    beam.position.copy(d).multiplyScalar(-16.5);
    beam.quaternion.setFromUnitVectors(up, d);
    beamGroup.add(beam);
    // 入射端的两个环标示同轴传播的两种波长，其半径沿用各自光束腰斑。
    const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 64 }, (_, j) => {
        const angle = 2 * Math.PI * j / 64;
        return new THREE.Vector3(Math.cos(angle), channel === 0 ? -15.45 : -14.5, Math.sin(angle));
      })), new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false }));
    beam.add(rim);
    return beam;
  }));
  const beamLabels = BEAM_DIRECTIONS.map((d, i) =>
    addLabel(BEAM_LABELS[i], d.map(v => -35 * v), beamGroup));
  const arrows = BEAM_DIRECTIONS.map(direction => {
    const d = new THREE.Vector3(...direction);
    const arrow = new THREE.ArrowHelper(d, d.clone().multiplyScalar(-28), 9, 0xffffff, 1.6, .75);
    beamGroup.add(arrow);
    return arrow;
  });
  const tones = colors.map(c => new THREE.Color(c)), arrowColor = new THREE.Color();

  const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: { viewportHeight: {value: 1}, pixelRatio: {value: 1}, fluorescence: {value: true},
      blueOn: {value: true}, greenOn: {value: true}, sampleWeight: {value: 1}, sampleDiameter: {value: 1} },
    vertexShader: `
      attribute vec2 scattering;
      uniform float viewportHeight, pixelRatio, sampleWeight, sampleDiameter;
      uniform bool fluorescence, blueOn, greenOn;
      varying vec3 light;
      varying float alpha;
      void main() {
        vec2 rates = scattering * vec2(blueOn ? 1.0 : 0.0, greenOn ? 1.0 : 0.0);
        float total = rates.x + rates.y;
        light = fluorescence
          ? (rates.x * vec3(0.66,0.59,1.0) + rates.y * vec3(0.40,1.0,0.39)) / max(total, 0.000001)
          : vec3(0.58,0.82,0.93);
        alpha = fluorescence ? min(1.0, log(1.0 + total/1500.0) / 7.0) * sampleWeight : 0.65;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(0.30 * projectionMatrix[1][1] * viewportHeight * 0.5 / max(-mv.z,0.01),
                             (fluorescence ? 6.0 : 4.0) * pixelRatio, 50.0 * pixelRatio);
        if (fluorescence) gl_PointSize *= sampleDiameter;
      }`,
    fragmentShader: `
      varying vec3 light;
      varying float alpha;
      void main() {
        vec2 d = 2.0 * gl_PointCoord - 1.0;
        float r2 = dot(d,d);
        if (r2 >= 1.0 || alpha <= 0.0) discard;
        gl_FragColor = vec4(light, alpha * exp(-3.0*r2) * (1.0-r2));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  cloud.name = 'sequence-atoms';
  cloud.renderOrder = 2;
  cloud.frustumCulled = false;
  atomGroup.add(cloud);
  const tails = new THREE.LineSegments(new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x86b5c7, transparent: true, opacity: .48, depthWrite: false }));
  tails.name = 'sequence-flight-segments';
  tails.frustumCulled = false;
  trailGroup.add(tails);
  const maxTrails = 18;
  tails.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6 * maxTrails), 3)
    .setUsage(THREE.DynamicDrawUsage));
  tails.geometry.setDrawRange(0, 0);
  let buffer, offset, length;
  function setFrame(sample, blueWaistMM) {
    const powers = [sample.bluePowersMW, sample.greenPowersMW];
    const waists = [blueWaistMM, sample.greenWaistMM ?? blueWaistMM];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 6; i++) {
      const beam = shafts[j][i], power = powers[j][i];
      beam.visible = power > 0;
      beam.scale.set(waists[j], 1, waists[j]);
      const level = Math.min(1, Math.log1p(power) / Math.log(32));
      beam.material.opacity = .018 + .058 * level;
      beam.children[0].material.opacity = .22 + .53 * level;
    }
    for (let i = 0; i < 6; i++) {
      const total = powers[0][i] + powers[1][i];
      beamLabels[i].el.hidden = total === 0;
      arrows[i].visible = total > 0;
      if (total > 0) arrows[i].setColor(arrowColor.lerpColors(tones[0], tones[1], powers[1][i] / total));
    }
    const uniforms = cloud.material.uniforms;
    uniforms.blueOn.value = powers[0].some(p => p > 0);
    uniforms.greenOn.value = powers[1].some(p => p > 0);
    const { positionsM, alive, blueRates, greenRates } = sample;
    if (!positionsM) {
      cloud.geometry.setDrawRange(0, 0);
      tails.geometry.setDrawRange(0, 0);
      buffer = undefined;
      return false;
    }
    const n = alive.length;
    if (positionsM.length !== 3*n || blueRates.length !== n || greenRates.length !== n)
      throw new RangeError('时序场景的粒子位置与散射率数量不一致。');
    // 固定入射系综下，每个标记的总亮度按 1/n 归一。分配给透明度与面积，可避免高采样时单个像素的贡献低于显示精度。
    const referenceCount = 192, referenceAlpha = Math.sqrt(32/referenceCount);
    const opacity = Math.min(1, Math.sqrt(32/n));
    uniforms.sampleWeight.value = sample.incidentFlux === 0 ? 0 : opacity;
    uniforms.sampleDiameter.value = Math.sqrt(referenceCount*referenceAlpha/(n*opacity));
    if (positionsM.buffer === buffer && positionsM.byteOffset === offset && positionsM.length === length) {
      if (!sample.previousPositionsM) tails.geometry.setDrawRange(0, 0);
      return false;
    }
    buffer = positionsM.buffer;
    offset = positionsM.byteOffset;
    length = positionsM.length;
    if (cloud.geometry.attributes.position?.count !== n) {
      cloud.geometry.dispose();
      cloud.geometry = new THREE.BufferGeometry();
      cloud.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3*n), 3).setUsage(THREE.DynamicDrawUsage));
      cloud.geometry.setAttribute('scattering', new THREE.BufferAttribute(new Float32Array(2*n), 2).setUsage(THREE.DynamicDrawUsage));
    }
    const {position, scattering} = cloud.geometry.attributes;
    const trailPositions = tails.geometry.attributes.position;
    const previous = sample.previousPositionsM;
    const recent = previous && sample.previousDtMS > 0 && sample.previousDtMS <= .5;
    let visible = 0, vertices = 0;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const k = 3*i, x = 1000*positionsM[k], y = 1000*positionsM[k+1], z = 1000*positionsM[k+2];
      position.setXYZ(visible, x, y, z);
      scattering.setXY(visible++, blueRates[i], greenRates[i]);
      if (recent && i < maxTrails && sample.previousAlive?.[i]) {
        trailPositions.setXYZ(vertices++, 1000*previous[k], 1000*previous[k+1], 1000*previous[k+2]);
        trailPositions.setXYZ(vertices++, x, y, z);
      }
    }
    position.needsUpdate = scattering.needsUpdate = true;
    trailPositions.needsUpdate = vertices > 0;
    cloud.geometry.setDrawRange(0, visible);
    tails.geometry.setDrawRange(0, vertices);
    return true;
  }
  return { setFrame, cloud, tails };
}
