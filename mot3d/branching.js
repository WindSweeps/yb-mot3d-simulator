// ¹⁷⁴Yb 无再泵浦时，每次自发衰变进入长寿命态的概率。文献与推导见 METHOD.md。
export const BLUE_DECAY_RATE = 2 * Math.PI * 29.13e6;
export const GREEN_DECAY_RATE = 2 * Math.PI * 180e3;
export const BLUE_CASCADE_RATES = Object.freeze({p0:6.18,p1:5.25,p2:.37});
const fineStructureWavelengthAngstrom = 1e8 / (17992.007 - 17288.439);
const greenMagneticDipoleRate = 2.69735e13 * 2 / (3 * fineStructureWavelengthAngstrom ** 3);
export const DARK_BRANCHES = Object.freeze({
  blueP0: BLUE_CASCADE_RATES.p0 / BLUE_DECAY_RATE,
  blueP2: BLUE_CASCADE_RATES.p2 / BLUE_DECAY_RATE,
  greenP0: greenMagneticDipoleRate / GREEN_DECAY_RATE,
});
const blueCascadeP1 = BLUE_CASCADE_RATES.p1 / BLUE_DECAY_RATE;
export const EMISSION_BRANCHES = Object.freeze({
  blue399: 1 - DARK_BRANCHES.blueP0 - DARK_BRANCHES.blueP2 - blueCascadeP1,
  blue556: blueCascadeP1,
  green556: 1 - DARK_BRANCHES.greenP0,
});

export function darkRate(blueRate, greenRate) {
  return blueRate * (DARK_BRANCHES.blueP0 + DARK_BRANCHES.blueP2) + greenRate * DARK_BRANCHES.greenP0;
}

// 使用独立的随机流产生光学深度阈值和末态；调整反冲采样不会移动这两个随机数。
function uniform(word) {
  word = Math.imul(word ^ (word >>> 16), 0x85ebca6b);
  word = Math.imul(word ^ (word >>> 13), 0xc2b2ae35);
  return (((word ^ (word >>> 16)) >>> 0) + 0.5) / 4294967296;
}

export function branchDraws(seed, index) {
  const key = seed ^ Math.imul(index + 1, 0x9e3779b1);
  return {threshold:-Math.log(uniform(key ^ 0x96a5b783)), choice:uniform(key ^ 0x54ec21df)};
}
