import { optimizeSequence } from './sequence-gradient.js';
import { createCandidateEvaluator } from './sequence-candidates.js';
import { mountGradientPanel } from './sequence-gradient-panel.js';

// 每次搜索固定目标时刻与随机种子，候选模拟只调整选中的实验设置。
export function mountSequenceOptimization(section, {getCursor, getExperiment, shader, apply}) {
  let active = null, best = null;
  const panel = mountGradientPanel(section, {getCursor, onStart:start, onStop:stop,
    onInvalidate:invalidate, onApply() {
      if (active || !best) return;
      const {state, timeMS} = best;
      apply(state.bestExperiment, timeMS);
      panel.setState({...state, canApply:false, message:'已应用最佳时序'});
    }});

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
    const improved = Number.isFinite(progress.bestValue) && (!Number.isFinite(progress.baseline) ||
      (run.direction === 'max' ? progress.bestValue > progress.baseline : progress.bestValue < progress.baseline));
    const state = {running, message, iteration:progress.iteration, evaluations:progress.evaluations,
      initialValue:progress.baseline, bestValue:progress.bestValue, bestExperiment:progress.bestExperiment,
      canApply:!running && improved};
    if (improved) best = {state, timeMS:run.timeMS};
    panel.setState(state);
  }

  async function start({variables, objective, direction, timeMS, maxEvaluations}) {
    if (active) return;
    best = null;
    const experiment = structuredClone(getExperiment());
    let run;
    try {
      const evaluator = createCandidateEvaluator({...experiment, shader, timeMS, metric:objective});
      run = {controller:new AbortController(), evaluator, direction, timeMS, progress:{}};
      active = run;
      display(run, {}, true, '正在计算起始时序');
      const outcome = await optimizeSequence({experiment, variables, direction, maxEvaluations, timeMS,
        signal:run.controller.signal,
        evaluate:async candidate => {
          const sample = await evaluator.evaluate(candidate);
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
          ? '该时刻无法估计 PSD。至少需要 7 条阱内轨迹，且六维协方差须满秩。'
          : '已试算的设置在目标时刻均无有效读数。'};
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

  return {invalidate, setContext(program, ready) { panel.setContext(program, ready, getExperiment()); },
    setTargetTime:panel.setTargetTime, destroy:invalidate};
}
