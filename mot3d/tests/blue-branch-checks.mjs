// 当原子静止于平衡光束中心时，散射率恒定，暗态存活率和两条损失通道可解析求得。
export async function checkBlueBranches(run, engine = 'lightweight') {
  const n = 2048, durationMS = 100;
  const params = {n, engine, durationMS, dtUS:100, detuningMHz:0, gravity:false, recoil:false, mainCurrentA:0,
    waistMM:6, powersMW:Array(6).fill(15), seed:7217};
  const result = await run(params, {initialStates:new Float64Array(6*n), frameCount:32});
  const gamma = 2 * Math.PI * 29.13e6;
  const saturationIntensity = Math.PI * 6.62607015e-34 * 299792458 * gamma / (3 * (399e-9)**3);
  const saturation = 6 * 2 * .015 / (Math.PI * .006**2 * saturationIntensity);
  // 六束等强光的三个激发子能级具有相等布居，各自的 Wq/Γ 为总饱和参数的 1/6。
  const excitedFraction = .5 * saturation / (1 + (engine === 'rate-equations' ? 2/3 : 1) * saturation);
  const lossProbability = -Math.expm1(-excitedFraction * (6.18 + .37) * durationMS / 1000);
  const {darkP0, darkP2, retained, escaped} = result.summary;
  for (const [observed, partialRate] of [[darkP0, 6.18], [darkP2, .37]]) {
    const probability = lossProbability * partialRate / (6.18 + .37);
    if (Math.abs(observed - n * probability) > 4 * Math.sqrt(n * probability * (1 - probability)))
      throw new Error('暗态轨迹数与恒散射率解析解相差超过四个标准差。');
  }
  if (darkP0 + darkP2 + retained !== n || escaped !== 0 || !darkP0 || !darkP2)
    throw new Error('末态计数与入射轨迹数不符。');
  for (let i = 0; i < n; i++) {
    let darkPhotons;
    for (let frame = 0; frame < result.frameCount; frame++) {
      const k = frame*n + i;
      if (!result.frameAlive[k] && darkPhotons === undefined) darkPhotons = result.framePhotons[k];
      if (darkPhotons !== undefined && (result.frameAlive[k] || result.framePhotons[k] !== darkPhotons))
        throw new Error('进入暗态后仍有蓝光荧光或重新出现亮态轨迹。');
    }
    if ((darkPhotons !== undefined) !== (result.darkState[i] !== 0))
      throw new Error('回放可见性与末态不符。');
  }
  return {darkP0, darkP2, retained, escaped, expectedLost:n * lossProbability};
}
