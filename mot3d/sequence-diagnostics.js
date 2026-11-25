// r3 的轨迹账本统计。内置冷束独立抽样，每条入射轨迹的统计权重为 1。
// 对二值捕获指标，r3 的加权比例 MCSE 化简为 sqrt(p(1−p)/n)。
function captureRatio(captured, entrants) {
  if (entrants === 0) return {entrants, fraction:null, mcse:null};
  const fraction = captured / entrants;
  return {entrants, fraction, mcse:Math.sqrt(fraction * (1 - fraction) / entrants)};
}

export function sequenceSamplingDiagnostics(incident, summary) {
  if (!Number.isSafeInteger(incident) || incident < 1)
    throw new RangeError('轨迹诊断需要正整数入射轨迹数。');
  const stages = {};
  let entrants = incident;
  for (const id of ['N0', 'N1', 'N2']) {
    const captured = summary[id];
    if (!Number.isSafeInteger(captured) || captured < 0 || captured > entrants)
      throw new RangeError('阶段留存数超出进入该阶段的轨迹数。');
    // 全部入射轨迹都记入分母，前一阶段已逃逸的轨迹在当前阶段记为未捕获。
    const maxWeightShare = 1 / incident;
    stages[id] = {
      captured,
      fromSource:captureRatio(captured, incident),
      fromPrevious:captureRatio(captured, entrants),
      sumWeights:incident,
      statusWeightBreakdown:{captured, notCaptured:incident - captured},
      effectiveSampleSize:incident,
      capturedEffectiveSampleSize:captured,
      maxWeightShare,
      lowCapturedSampleSize:captured < 200,
      highMaxWeightShare:maxWeightShare > .05,
    };
    entrants = captured;
  }
  return {
    method:'cold-atom-mc-optimizer 2026-11-23.3',
    weightBasis:'每条入射轨迹的抽样权重为 1。计入单体和双体损失后的物理原子数见 estimatedAtoms。',
    mcseDefinition:'独立等权轨迹的比例标准误 sqrt(p(1−p)/n)，n 为对应 entrants。零分母记为 null。',
    stages,
  };
}
