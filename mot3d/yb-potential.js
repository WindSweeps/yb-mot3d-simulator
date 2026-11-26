import { CONSTANTS as C } from './physics.js';

const atomicPolarizability = 1.64877727436e-41;
const vacuumPermittivity = 8.8541878188e-12;
const tensorFieldSquared = 1e-14; // (1 mG)²，连续接过磁场零点处的量子化轴。
export const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

export function localMagneticField(position, field, out) {
  for (let axis=0; axis<3; axis++) out[axis] = field.slope[axis]*position[axis]+field.bias[axis];
  return Math.sqrt(dot(out,out));
}

export function configureDipoleTrap(pulse) {
  if (!pulse) return null;
  const {waistM, powerW, wavelengthM, polarization, coefficients} = pulse;
  const k = 2*Math.PI/wavelengthM, inverseWaist2 = 1/waistM**2;
  return {
    lattice:pulse.mode === 'lattice', k, inverseWaist2, rayleighInverse2:1/(Math.PI*waistM**2/wavelengthM)**2,
    u0:atomicPolarizability*powerW*inverseWaist2/(Math.PI*vacuumPermittivity*C.c),
    maxAlpha:Math.max(...Object.values(coefficients).map(([a,t]) => Math.abs(a)+Math.abs(t))),
    polarization:[0,Math.sin(polarization),Math.cos(polarization)], coefficients,
  };
}

// 返回每原子单位极化率的光势尺度及其梯度，另保存线偏振的张量角度因子。
export function dipoleProfile(p, b, field, profile) {
  const {trap} = field, [x,y,z] = p;
  const axial = 1+x*x*trap.rayleighInverse2, rho2 = (y*y+z*z)*trap.inverseWaist2/axial;
  const envelope = trap.u0*Math.exp(-2*rho2)/axial;
  const phase = trap.k*x;
  const standing = trap.lattice ? Math.cos(phase)**2 : 1;
  const scale = profile.scale = envelope*standing;
  profile.scaleX = scale*2*x*trap.rayleighInverse2*(2*rho2-1)/axial -
    (trap.lattice ? envelope*trap.k*Math.sin(2*phase) : 0);
  profile.scaleY = -4*y*trap.inverseWaist2*scale/axial;
  profile.scaleZ = -4*z*trap.inverseWaist2*scale/axial;
  const projection = dot(b,trap.polarization), norm2 = dot(b,b);
  const denominator = norm2 + tensorFieldSquared;
  profile.angle = (3*projection*projection-norm2)/(2*denominator);
  for (let i=0; i<3; i++) {
    profile.angleGradient[i] = field.slope[i]*(3*projection*trap.polarization[i] -
      b[i]*(1+2*profile.angle))/denominator;
  }
}

export function potentialWorkspace() {
  return {b:new Float64Array(3), profile:{angleGradient:new Float64Array(3)}};
}

// state = null 指 ¹S₀，state.kind 为 p0 或 p2 时取相应长寿命态的势能。
export function conservativeAcceleration(p, field, atom, state, output, workspace) {
  const {b,profile} = workspace;
  output[0] = output[1] = 0;
  output[2] = field.gravityZ;
  const moment = state?.level?.moment ?? 0;
  if (moment || field.trap) {
    const norm = localMagneticField(p,field,b);
    if (moment && norm > 0) {
      const factor = -C.muB*moment/(atom.mass*norm);
      for (let i=0; i<3; i++) output[i] += factor*field.slope[i]*b[i];
    }
    if (field.trap) {
      dipoleProfile(p,b,field,profile);
      const [scalar,tensor] = field.trap.coefficients[state?.kind ?? 'ground'];
      const angular = tensor*(state?.level?.tensor ?? 0);
      const alpha = scalar + angular*profile.angle;
      const directional = angular*profile.scale;
      output[0] += (alpha*profile.scaleX + directional*profile.angleGradient[0])/atom.mass;
      output[1] += (alpha*profile.scaleY + directional*profile.angleGradient[1])/atom.mass;
      output[2] += (alpha*profile.scaleZ + directional*profile.angleGradient[2])/atom.mass;
    }
  }
}

export function conservativeEnergy(p, v, field, atom, state, workspace) {
  const {b,profile} = workspace;
  const norm = localMagneticField(p,field,b);
  let energy = atom.mass*(dot(v,v)/2 - field.gravityZ*p[2]) + C.muB*(state?.level?.moment ?? 0)*norm;
  if (field.trap) {
    dipoleProfile(p,b,field,profile);
    const [scalar,tensor] = field.trap.coefficients[state?.kind ?? 'ground'];
    energy -= profile.scale * (scalar+tensor*(state?.level?.tensor ?? 0)*profile.angle);
  }
  return energy;
}

export function magneticallyBound(p,v,field,atom,state,domain,workspace) {
  const moment = C.muB * (state?.level?.moment ?? 0), gz = Math.abs(field.slope[2]);
  const minimumSlope = Math.min(Math.abs(field.slope[0]),Math.abs(field.slope[1]),gz);
  if (!(minimumSlope > 0 && moment*gz > atom.mass*Math.abs(field.gravityZ))) return false;
  const cx = -field.bias[0]/field.slope[0], cy = -field.bias[1]/field.slope[1], cz = -field.bias[2]/field.slope[2];
  const minimumBarrier = (domain-Math.hypot(cx,cy,cz))*minimumSlope*
    (moment-atom.mass*Math.abs(field.gravityZ)/gz);
  const norm = localMagneticField(p,field,workspace.b);
  return atom.mass*(dot(v,v)/2-field.gravityZ*(p[2]-cz)) + moment*norm < minimumBarrier;
}
