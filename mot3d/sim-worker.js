import { simulate } from './physics.js';
self.onmessage = ({ data }) => {
  const { id, params } = data;
  try {
    const result = simulate(params);
    const transfer = ['frames','frameAlive','times','finalPositions','finalVelocities','alive','retained','initialLongitudinalVelocities']
      .map(key => result[key].buffer);
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
