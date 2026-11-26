import { CONSTANTS } from './physics.js';

const coordinates = ['x','y','z','vx','vy','vz'];
const indexOfCovariance = (i,j) => i*(i+1)/2 + j;
const descriptors = [];
for (let i=0; i<3; i++) {
  const axis = ['X','Y','Z'][i];
  descriptors.push({id:'velocity.'+axis,label:'质心速度 '+axis,group:'原子云',unit:'m/s',
    read:({cloud}) => cloud.meanVelocityMS?.[i] ?? null});
  descriptors.push({id:'width.'+axis,label:'云团 RMS 宽度 '+axis,group:'原子云',unit:'mm',
    read:({cloud}) => cloud.count === 0 ? null : cloud.sampleCovariance ?
      1e3*Math.sqrt(Math.max(0,cloud.sampleCovariance[indexOfCovariance(i,i)])*
        (cloud.covarianceToPopulation ?? (cloud.count-1)/cloud.count)) : 0});
  descriptors.push({id:'temperature.'+axis,label:'动能温度 '+axis,group:'原子云',unit:'µK',
    read:({cloud,result}) => cloud.sampleCovariance
      ? (result?.mass ?? CONSTANTS.mass)*Math.max(0,cloud.sampleCovariance[indexOfCovariance(i+3,i+3)])*1e6/CONSTANTS.kB : null});
}
for (let i=0; i<6; i++) for (let j=0; j<=i; j++) {
  const unit = i<3 ? 'mm²' : j<3 ? 'mm·m/s' : '(m/s)²';
  const factor = i<3 ? 1e6 : j<3 ? 1e3 : 1;
  descriptors.push({id:'covariance.'+j+'.'+i,label:'协方差 '+coordinates[j]+'、'+coordinates[i],
    group:'六维相空间协方差',unit,read:({cloud}) => cloud.sampleCovariance
      ? cloud.sampleCovariance[indexOfCovariance(i,j)] * factor : null});
}
export const cloudObjectives = () => descriptors;
