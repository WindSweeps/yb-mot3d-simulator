import { simulateSequence } from './sequence-physics.js';

self.onmessage = ({ data: {id, params, config} }) => {
  try {
    const result = simulateSequence(params, config);
    const transfer = ['timesMS','positionsM','alive','blueRates','greenRates'].map(key => result[key].buffer);
    self.postMessage({id, result}, transfer);
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
