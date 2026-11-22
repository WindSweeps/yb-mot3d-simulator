import assert from 'node:assert/strict';
import { IMAGING_DEFAULTS, simulateImagingFrame, validateImagingSettings } from './sequence-imaging.js';
import { simulateSequence } from './sequence-physics.js';
import { songSequence } from './sequence.js';

function close(actual, expected, tol = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
    `expected ${expected}, received ${actual}`);
}
const sum = pixels => pixels.reduce((a,b) => a+b, 0);
const settings = { ...IMAGING_DEFAULTS, fovMM:4, exposureUS:20, psfSigmaUM:0, sampleSigmaUM:0 };
const N = 128, pitch = 4e-3 / N;
// 粒子位于探测器指定像素中心，沿观察轴的位置不影响投影。
const sample = { positionsM:[.5*pitch, 7.5*pitch, 2.5*pitch], alive:[1], blueRates:[2e5], greenRates:[4e5], weight:12 };
const center = (63-2)*N + 64;
const flu = simulateImagingFrame(sample, settings);
assert.equal(flu.horizontalAxis, 'X');
assert.equal(flu.verticalAxis, 'Z');
close(flu.images.emission[center], 12 * 6e5 * 20e-6);
close(flu.totalSignal, 12 * 6e5 * 20e-6 * .01);
assert.equal(flu.weightedAtoms, 12);
const origin = [.5,7.5,2.5].map(x => x * pitch * 1000);
const centered = simulateImagingFrame({ ...sample, centerMM:origin }, settings);
close(centered.images.signal[63*N+63], flu.totalSignal/4);
const yz = simulateImagingFrame(sample, { ...settings, axis:'x' });
assert.equal(yz.horizontalAxis, 'Y');
close(yz.images.emission[(63-2)*N+71], flu.images.emission[center]);
const xy = simulateImagingFrame(sample, { ...settings, axis:'z' });
assert.equal(xy.verticalAxis, 'Y');
close(xy.images.emission[(63-7)*N+64], flu.images.emission[center]);

for (const [band, fraction] of [['399',1/3],['556',2/3]]) {
  const image = simulateImagingFrame(sample, { ...settings, band, sampleSigmaUM:40, psfSigmaUM:35 });
  close(image.totalSignal, flu.totalSignal * fraction);
  close(sum(image.images.emission), image.totalSignal / .01);
}
const weighted = { positionsM:[...sample.positionsM,...sample.positionsM,0,0,0], alive:[1,1,0],
  blueRates:[1e5,3e5,1e9], greenRates:[0,0,1e9], weights:[.25,.75,9e9] };
close(simulateImagingFrame(weighted,settings).totalSignal, (.25e5+.75*3e5)*20e-6*.01);
const edge = simulateImagingFrame({ ...sample, positionsM:[.002+pitch,0,0] }, { ...settings, psfSigmaUM:40 });
assert.equal(edge.weightedAtoms, 0);
assert.ok(edge.totalSignal > 0 && edge.totalSignal < flu.totalSignal / 2);
assert.equal(sum(edge.images.emission), 0);
assert.equal(simulateImagingFrame(sample,{...settings,detectionEfficiency:0}).totalSignal,0);
assert.equal(simulateImagingFrame({...sample,weight:0},settings).totalSignal,0);

const abs = {...settings, mode:'absorption'};
// 令某一个像素的理想光学深度恰好为 2，独立计算暗场扣除和弱探针透射。
const wavelength = 399e-9, sigma = 3 * wavelength ** 2 / (2*Math.PI);
const slab = { ...sample, blueRates:[0], greenRates:[0], weight:2*pitch**2/sigma };
const probe = simulateImagingFrame(slab, abs);
const dark = probe.images.dark[center], ref = probe.images.reference[center]-dark;
close(ref, Math.PI * (2*Math.PI*29.13e6) / (3*wavelength**2) * .01 * pitch**2 * 20e-6 * .5);
close((probe.images.atoms[center]-dark)/ref, Math.exp(-2));
close(probe.images.od[center], 2);
close(probe.totalSignal, ref * -Math.expm1(-2));
assert.equal(probe.clippedPixels, 0);
const brighter = simulateImagingFrame(slab, {...abs,exposureUS:40});
close(brighter.referenceSignal, 2*ref);
close(brighter.images.od[center], 2);
const black = simulateImagingFrame({...slab,weight:slab.weight*500},abs);
assert.equal(black.clippedPixels, 1);
close(black.images.od[center], Math.log(ref));
close(black.images.atoms[center], dark);
const blurred = simulateImagingFrame(slab,{...abs,psfSigmaUM:pitch*1e6});
const kernel = Array.from({length:9}, (_,i)=>Math.exp(-.5*(i-4)**2));
const centralMass = 1 / sum(kernel)**2;
close(blurred.images.od[center], -Math.log1p(-centralMass * -Math.expm1(-2)));
close(blurred.totalSignal, probe.totalSignal);
const empty = simulateImagingFrame({...sample,alive:[0]}, {...abs,psfSigmaUM:95,sampleSigmaUM:100});
assert.deepEqual(empty.images.atoms, empty.images.reference);
assert.equal(empty.peaks.od, 0);
assert.equal(empty.totalSignal, 0);

assert.throws(() => validateImagingSettings({axis:'u'}));
assert.throws(() => validateImagingSettings({exposureUS:NaN}));
assert.throws(() => simulateImagingFrame({...sample, weights:[-1]},settings));
assert.throws(() => simulateImagingFrame({...sample, positionsM:[NaN,0,0]},settings));
assert.throws(() => simulateImagingFrame({...sample, blueRates:[NaN]},settings));
const trajectory = simulateSequence({ n:32 }, songSequence());
const start = (trajectory.frameCount - 1) * trajectory.n;
const finalCloud = {
  positionsM:trajectory.positionsM.subarray(3 * start),
  alive:trajectory.alive.subarray(start), blueRates:trajectory.blueRates.subarray(start),
  greenRates:trajectory.greenRates.subarray(start),
};
assert.equal(simulateImagingFrame(finalCloud, {...settings,band:'399'}).totalSignal, 0);
assert.ok(simulateImagingFrame(finalCloud, {...settings,band:'556'}).totalSignal > 0);
assert.ok(simulateImagingFrame(finalCloud, abs).peaks.od > 0);
console.log('通过逐轴物方投影、光子守恒、波段筛选、曝光权重、视野边缘、弱探针三帧、探测下限与光强卷积检查。');
