export const defaultEngine = 'lightweight';

const engines = {
  blue: [
    {id: defaultEngine, label: '轻量散射模型（399 nm）'},
    {id: 'rate-equations', label: '四能级稳态速率方程'},
  ],
  'two-color': [
    {id: defaultEngine, label: '轻量双色散射模型'},
    {id: 'rate-equations', label: '七能级稳态速率方程'},
  ],
};

export function availableEngines(simulation) {
  if (!Object.hasOwn(engines, simulation)) throw new RangeError('未知的 MOT 模拟类型。');
  return engines[simulation];
}

export function validateEngine(id) {
  if (!engines.blue.some(engine => engine.id === id)) throw new RangeError('未知的 MOT 模拟引擎。');
  return id;
}
