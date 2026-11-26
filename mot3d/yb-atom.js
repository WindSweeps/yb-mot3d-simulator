import { CONSTANTS as C } from './physics.js';
import { BLUE_CASCADE_RATES, BLUE_DECAY_RATE, DARK_BRANCHES, GREEN_DECAY_RATE } from './branching.js';

const atomicMass = 1.66053906892e-27;
const muNOverMuB = 1 / 1836.15267343;
const twoPi = 2 * Math.PI;

// Das 等表 I 与 Atkinson 等表 I。各组依 F′ 递增，频率零点为 ¹⁷⁴Yb。
const isotopes = {
  '174Yb': [173.93886755, 0, 0, [0], [0]],
  '171Yb': [170.93633152, .5, .4919, [1153.696, 832.436], [-2131.146, 3805.513]],
  '173Yb': [172.93821622, 2.5, -.6776, [515.972, -253.418, 587.986], [3808.192, 2311.823, -2386.126]],
  '172Yb': [171.93638666, 0, 0, [533.309], [1000.792]],
  '176Yb': [175.9425747, 0, 0, [-509.310], [-954.734]],
};
export const YB_ISOTOPES = Object.freeze(Object.keys(isotopes));
export const DEFAULT_ISOTOPE = '174Yb';
export const MU_B_PER_HBAR = C.muB / C.hbar;
export const YB_ENERGY = Object.freeze({ground:0, p0:17288.439, p1:17992.007, p2:19710.388,
  d1:24489.102, d2:24751.948, blue:25068.222, s1:32694.692});
const wavelength = (upper, lower) => 1e7 / (YB_ENERGY[upper] - YB_ENERGY[lower]);

export const YB_REPUMPS = Object.freeze([
  {key:'repump649', label:'649 nm', lower:'p0', upper:'s1'},
  {key:'repump770', label:'770 nm', lower:'p2', upper:'s1'},
  {key:'repump1389', label:'1389 nm', lower:'p0', upper:'d1'},
  {key:'repump2093', label:'2093 nm', lower:'p2', upper:'d1'},
].map(row => Object.freeze({...row, wavelengthNm:wavelength(row.upper, row.lower)})));

export const REPUMP_BRANCHES = Object.freeze({
  s1:Object.freeze([1/9, 3/9, 5/9]),
  d1:Object.freeze([.637, .354, .009]),
});
export const CASCADE_RATES = Object.freeze({
  ...BLUE_CASCADE_RATES,
  greenP0:GREEN_DECAY_RATE * DARK_BRANCHES.greenP0,
});
const triplet = ['p0','p1','p2'];
const bridges = [
  {name:'d1',j:1,entrance:.27,destinations:[2.61,2.26,.60]},
  {name:'d2',j:2,entrance:.32,destinations:[0,4.03,2.39]},
];

// Porsev 等，表 I。用 D 态矩阵元计算条件路径，级联的总速率沿用 Cho 等的有效速率。
const e1RateFactor = (amplitude,wavelengthNm) => amplitude**2 / wavelengthNm**3;
export const CASCADE_ROUTES = Object.freeze(triplet.map((terminal,outcome) => {
  const routes = bridges.map(({name,j,entrance,destinations},bridge) => {
    const entry = wavelength('blue',name);
    const exit = wavelength(name,terminal);
    const total = destinations.reduce((sum,a,i) => sum+e1RateFactor(a,wavelength(name,triplet[i])),0);
    const rate = e1RateFactor(entrance,entry)*e1RateFactor(destinations[outcome],exit)/total;
    return {j,bridge,rate,wavelengths:outcome === 1 ? [entry,exit,wavelength('p1','ground')] : [entry,exit]};
  });
  return Object.freeze(routes.filter(route => route.rate > 0));
}));
export const YB_CASCADE_RECOIL_NM = Object.freeze({
  greenP0:wavelength('p1','p0'),
  p0Ground:wavelength('p0','ground'),
  p2Ground:wavelength('p2','ground'),
  p2P1:wavelength('p2','p1'),
});
export const P2_FINE_DECAY = .067;
const metastableHyperfine = {
  '171Yb':{p0:.0442,p2:{1.5:.0918}},
  '173Yb':{p0:.0385,p2:{1.5:.0214,2.5:.0532,3.5:.0722}},
};
export function repumpEmission(upper, outcome) {
  return wavelength(upper, ['p0','p1','p2'][outcome]);
}

const factorial = [1];
for (let i = 1; i <= 20; i++) factorial.push(i * factorial[i-1]);
const fact = i => factorial[i];

// C(j₁m₁,j₂m₂|FM)²。构建能级时计算一次，光力循环复用矩阵元。
export function couplingSquared(j1, m1, j2, m2, f) {
  const m = m1 + m2;
  if (Math.abs(m1) > j1 || Math.abs(m2) > j2 || Math.abs(m) > f ||
      f > j1+j2 || f < Math.abs(j1-j2)) return 0;
  const lo = Math.max(0, j2-f-m1, j1+m2-f);
  const hi = Math.min(j1+j2-f, j1-m1, j2+m2);
  let sum = 0;
  for (let k = lo; k <= hi; k++) {
    const denominator = fact(k)*fact(j1+j2-f-k)*fact(j1-m1-k)*fact(j2+m2-k)*
      fact(f-j2+m1+k)*fact(f-j1-m2+k);
    sum += (k % 2 ? -1 : 1) / denominator;
  }
  const triangle = (2*f+1)*fact(f+j1-j2)*fact(f-j1+j2)*fact(j1+j2-f)/fact(j1+j2+f+1);
  return triangle * fact(f+m)*fact(f-m)*fact(j1-m1)*fact(j1+m1)*fact(j2-m2)*fact(j2+m2)*sum**2;
}

function magneticFactor(f, j, spin, electronicG, nuclearG) {
  if (f === 0) return 0;
  const electronic = (f*(f+1) + j*(j+1) - spin*(spin+1)) / (2*f*(f+1));
  return electronicG*electronic + nuclearG*(1-electronic);
}

const sublevels = f => Array.from({length:2*f+1}, (_, index) => index-f);
function manifoldSpins(j, spin) {
  const first = Math.abs(j-spin), last = j+spin;
  return Array.from({length:last-first+1}, (_, index) => first + index);
}
function tensorFactor(j, spin, f, m) {
  let result = 0;
  for (const mj of sublevels(j)) {
    const strength = couplingSquared(spin, m-mj, j, mj, f);
    result += strength * (3*mj*mj - j*(j+1)) / (j*(2*j-1));
  }
  return result;
}

function coolingLine(color, isotope, spin, nuclearG, mass, offsets, reference) {
  const blue = color === 'blue';
  const gamma = blue ? BLUE_DECAY_RATE : twoPi * 182e3;
  const k = twoPi / (blue ? 398.911e-9 : 555.802e-9);
  const lande = blue ? 1.035 : 1.49285;
  const fs = manifoldSpins(1, spin);
  const transition = {k, gamma, lande, recoil:C.hbar*k/mass};
  const levels = fs.flatMap((f, index) => {
    const g = magneticFactor(f, 1, spin, lande, nuclearG);
    return sublevels(f).map(m => {
      const links = [];
      for (const q of [-1,0,1]) {
        const mg = m-q, strength = couplingSquared(spin, mg, 1, q, f);
        if (strength > 1e-14) links.push({
          ground:mg+spin, q:q+1, strength, moment:g*m-nuclearG*mg,
        });
      }
      return {f, m, links, offset:twoPi*1e6*(offsets[index]-reference),
        tensor:tensorFactor(1, spin, f, m)};
    });
  });
  const centralF = fs.at(-1);
  return {...transition, levels, centralF, isotope, referenceMHz:reference, gammaMHz:gamma/(twoPi*1e6)};
}

// 先对两次 E1 辐射的 q 求和，再将 J=2 的电子态与不参与 E1 跃迁的核自旋耦合。
const electronicCascade = bridges.map(({j}) => [-1,0,1].map(m => sublevels(2).map(m2 => {
  let p = 0;
  for (const md of sublevels(j))
    p += couplingSquared(j,md,1,m-md,1)*couplingSquared(2,m2,1,md-m2,j);
  return p;
})));

function p2Distribution(spin,nuclearG,hyperfine) {
  const p2 = manifoldSpins(2,spin).flatMap(f => sublevels(f).map(m => ({
    f,m,g:magneticFactor(f,2,spin,1.5,nuclearG),tensor:tensorFactor(2,spin,f,m),directDecay:hyperfine?.p2[f] ?? 0,
  })));
  p2.forEach((level,index) => Object.assign(level,{index,moment:level.g*level.m}));
  const cascade = electronicCascade.map(rows => sublevels(spin).map(mi => rows.map(jWeights =>
    p2.map(({f,m}) => jWeights.reduce((p,w,i) => p + (i-2+mi === m ?
      w * couplingSquared(spin,mi,2,i-2,f) : 0),0)))));
  const repumped = p2.map(({f,m}) => p2.map(target => {
    let p = 0;
    for (const mi of sublevels(spin)) {
      const mj = m-mi, mj2 = target.m-mi;
      if (Math.abs(mj) > 2 || Math.abs(mj2) > 2) continue;
      let electronic = 0;
      for (const upper of [-1,0,1]) electronic +=
        couplingSquared(2,mj,1,upper-mj,1) * couplingSquared(2,mj2,1,upper-mj2,1);
      p += couplingSquared(spin,mi,2,mj,f) * electronic * (5/3) *
        couplingSquared(spin,mi,2,mj2,target.f);
    }
    return p;
  }));
  return {p2, cascade, repumped};
}

const atoms = new Map();
export function ybAtom(isotope = DEFAULT_ISOTOPE) {
  if (!Object.hasOwn(isotopes,isotope)) throw new RangeError('未知的镱同位素。');
  if (atoms.has(isotope)) return atoms.get(isotope);
  const [massDa, spin, moment, blue, green] = isotopes[isotope];
  const mass = massDa*atomicMass, nuclearG = spin === 0 ? 0 : -moment*muNOverMuB/spin;
  const greenLine = coolingLine('green',isotope,spin,nuclearG,mass,green,green.at(-1));
  const blueLine = coolingLine('blue',isotope,spin,nuclearG,mass,blue,blue.at(-1));
  const hyperfine = metastableHyperfine[isotope];
  const {p2,cascade,repumped} = p2Distribution(spin,nuclearG,hyperfine);
  const atom = {isotope,mass,massDa,spin,nuclearG, groundStates:2*spin+1,
    blue:blueLine, green:greenLine, p2, cascade,repumped,clockDecay:hyperfine?.p0 ?? 0};
  atoms.set(isotope,atom);
  return atom;
}
