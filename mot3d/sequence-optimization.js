import { optimizeSequence } from './sequence-gradient.js';
import { createCandidateEvaluator } from './sequence-candidates.js';
import { mountGradientPanel } from './sequence-gradient-panel.js';

// 每次搜索固定一份装置、损失、时钟和随机种子，候选计算独立于网页回放。
export function mountSequenceOptimization(section, {getCursor, getInputs, apply}) {
  let active = null, best = null;
  const panel = mountGradientPanel(section, {getCursor, onStart:start, onStop:stop,
    onInvalidate:invalidate, onApply() { if (!active && best) apply(best.config, best.timeMS); }});

  function invalidate() {
    if (active) {
      active.controller.abort();
      active.evaluator.destroy();
      active = null;
    }
    best = null;
    panel.setState({});
  }

  function stop() {
    if (!active) return;
    const run = active;
    active = null;
    run.controller.abort();
    run.evaluator.destroy();
    display(run, run.progress, false, '已停止');
  }

  function display(run, progress, running, message) {
    const improved = Number.isFinite(progress.bestValue) && Number.isFinite(progress.baseline) &&
      (run.direction === 'max' ? progress.bestValue > progress.baseline : progress.bestValue < progress.baseline);
    if (improved) best = {config:progress.bestConfig, timeMS:run.timeMS};
    panel.setState({running, message, iteration:progress.iteration, evaluations:progress.evaluations,
      initialValue:progress.baseline, bestValue:progress.bestValue, bestConfig:progress.bestConfig,
      canApply:!running && Boolean(best)});
  }

  async function start({variables, objective, direction, timeMS, maxEvaluations}) {
    if (active) return;
    best = null;
    const inputs = getInputs();
    let run;
    try {
      const evaluator = createCandidateEvaluator({...inputs, timeMS, metric:objective});
      run = {controller:new AbortController(), evaluator, direction, timeMS, progress:{}};
      active = run;
      display(run, {}, true, '正在计算起始时序');
      const outcome = await optimizeSequence({config:inputs.config, variables, direction, maxEvaluations, timeMS,
        signal:run.controller.signal,
        evaluate:async config => {
          const sample = await evaluator.evaluate(config);
          return sample.value;
        },
        onProgress(progress) {
          if (active !== run) return;
          run.progress = progress;
          display(run, progress, true, '正在试算候选时序');
        },
      });
      if (active !== run) return;
      const messages = {budget:'已达到试算次数', stationary:'当前步长下未找到进一步改善',
        stopped:'已停止', unavailable:objective === 'psd'
          ? '该时刻无法估计起始 PSD。至少需要 7 条阱内轨迹，且六维协方差须满秩。'
          : '该时刻的阱内轨迹不足，无法计算起始目标值。'};
      display(run, outcome, false, messages[outcome.reason]);
    } catch (error) {
      if (!run || active === run) display(run ?? {direction,timeMS}, run?.progress ?? {}, false, '计算未完成 · ' + error.message);
    } finally {
      if (run && active === run) {
        active = null;
        run.evaluator.destroy();
      }
    }
  }

  return {invalidate, setContext:panel.setContext, setTargetTime:panel.setTargetTime, destroy:invalidate};
}
