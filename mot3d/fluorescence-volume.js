// 与 Three 场景使用同一实验室坐标系。原点位于中心体素的中心。
export const VOXEL_SIZE_MM = .2;

function voxelKey(x, y, z) {
  if (x >= -512 && x < 512 && y >= -512 && y < 512 && z >= -512 && z < 512)
    return ((x + 512) * 1024 + y + 512) * 1024 + z + 512;
  return `${x},${y},${z}`;
}

// 假设相邻两个保存位置之间的发射率均匀，按线段在各体素内的时间比例分配光子。
function depositSegment(frames, start, end, photons, scale, deposit) {
  const x0 = frames[start] * scale + .5, y0 = frames[start + 1] * scale + .5, z0 = frames[start + 2] * scale + .5;
  const dx = (frames[end] - frames[start]) * scale;
  const dy = (frames[end + 1] - frames[start + 1]) * scale;
  const dz = (frames[end + 2] - frames[start + 2]) * scale;
  let x = Math.floor(x0), y = Math.floor(y0), z = Math.floor(z0);
  if (x === Math.floor(x0 + dx) && y === Math.floor(y0 + dy) && z === Math.floor(z0 + dz)) {
    deposit(x, y, z, photons);
    return;
  }
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  let t = 0;
  while (t < 1) {
    const tx = sx ? (x + Number(sx > 0) - x0) / dx : Infinity;
    const ty = sy ? (y + Number(sy > 0) - y0) / dy : Infinity;
    const tz = sz ? (z + Number(sz > 0) - z0) / dz : Infinity;
    const endT = Math.min(1, tx, ty, tz);
    if (endT > t) deposit(x, y, z, photons * (endT - t));
    if (endT === 1) break;
    if (tx === endT) x += sx;
    if (ty === endT) y += sy;
    if (tz === endT) z += sz;
    t = Math.max(t, endT);
  }
}

export function createFluorescenceVolume({ n, frameCount, frames, framePhotons }, voxelSizeMM = VOXEL_SIZE_MM) {
  if (!Number.isFinite(voxelSizeMM) || voxelSizeMM <= 0) throw new RangeError('体素边长必须为正数。');
  if (framePhotons?.length !== n * frameCount || frames.length !== 3 * n * frameCount)
    throw new RangeError('三维荧光的光子数与轨迹尺寸不符。');

  const voxelIndices = new Map(), coordinates = [], sums = [], lastChange = [];
  const indices = [], previous = [], next = [];
  const offsets = new Uint32Array(frameCount + 1), counts = new Uint32Array(frameCount);
  const scale = 1000 / voxelSizeMM;
  let frame = 0;
  function deposit(x, y, z, increment) {
    const key = voxelKey(x, y, z);
    let index = voxelIndices.get(key);
    if (index === undefined) {
      index = sums.length;
      voxelIndices.set(key, index);
      coordinates.push(x * voxelSizeMM, y * voxelSizeMM, z * voxelSizeMM);
      sums.push(0);
      lastChange.push(0);
    }
    if (lastChange[index] !== frame) {
      lastChange[index] = frame;
      indices.push(index);
      previous.push(sums[index]);
    }
    sums[index] += increment;
  }
  for (frame = 1; frame < frameCount; frame++) {
    for (let i = frame * n; i < (frame + 1) * n; i++) {
      const increment = framePhotons[i] - framePhotons[i - n];
      if (increment > 0) depositSegment(frames, 3 * (i - n), 3 * i, increment, scale, deposit);
    }
    counts[frame] = sums.length;
    offsets[frame + 1] = indices.length;
    for (let u = offsets[frame]; u < indices.length; u++) next.push(sums[indices[u]]);
  }
  return createPlayback(new Float32Array(coordinates), counts, offsets, new Uint32Array(indices),
    new Float32Array(previous), new Float32Array(next));
}

// 连续入射从空阱开始。各年龄区间的发射量已经累计，乘以 Φ/n 后得到每个体素的 photons/s。
// 双向保存每次更改前后的绝对值，回放和拖动仅更新涉及的体素，重复来回拖动不会积累舍入误差。
function createPlayback(positions, counts, offsets, indices, previous, next) {
  const photons = new Float32Array(positions.length / 3);
  let current = 0;
  return {
    positions, photons,
    at(frame) {
      if (!Number.isInteger(frame) || frame < 0 || frame >= counts.length)
        throw new RangeError('三维荧光帧超出观测时间。');
      if (frame < current) {
        for (let u = offsets[current + 1] - 1; u >= offsets[frame + 1]; u--)
          photons[indices[u]] = previous[u];
      } else {
        for (let u = offsets[current + 1]; u < offsets[frame + 1]; u++)
          photons[indices[u]] = next[u];
      }
      current = frame;
      return counts[frame];
    },
  };
}
