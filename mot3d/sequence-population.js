// 把 ms 换算成 s 时先缩小较大的因子，保留极短装载时间的有效数字。
function rateTimesMS(rate, timeMS) {
  return rate >= timeMS ? (rate / 1000) * timeMS : rate * (timeMS / 1000);
}

// dN/dt = R − αN − βN²，N(0)=0。返回连续模型的原子数期望值。
export function loadPopulation(timeMS, flux, captureProbability, alpha, beta) {
  for (const [name, value] of Object.entries({ timeMS, flux, captureProbability, alpha, beta })) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} 必须是有限的非负数。`);
  }
  if (captureProbability > 1) throw new RangeError('捕获概率必须在 0 至 1 之间。');
  const rate = flux * captureProbability;
  if (rate === 0 || timeMS === 0) return 0;
  if (alpha === 0 && beta === 0) return rateTimesMS(rate, timeMS);

  // λ = √(α² + 4βR)。两项同时缩放，避免中间步骤出现平方溢出。
  const pairRate = Math.sqrt(beta) * Math.sqrt(rate);
  const scale = Math.max(alpha, pairRate);
  const a = alpha / scale;
  const lambda = Math.hypot(a, 2 * (pairRate / scale));
  const x = rateTimesMS(scale, timeMS) * lambda;
  const growth = -Math.expm1(-x);
  const denominator = lambda + a + (lambda - a) * Math.exp(-x);
  if (x <= 1) {
    // 短时间从 Rt 展开；即使稳态原子数超出浮点范围，也能求出初始装载量。
    const fraction = x === 0 ? 1 : Math.min(1, (growth / x) * (2 * lambda / denominator));
    const injected = rateTimesMS(rate, timeMS);
    return Number.isFinite(injected) ? injected * fraction : rateTimesMS(rate * fraction, timeMS);
  }
  const fraction = 2 * growth / denominator;
  const scaledPopulation = rate / scale;
  return Number.isFinite(scaledPopulation) ? scaledPopulation * fraction : (rate * fraction) / scale;
}
