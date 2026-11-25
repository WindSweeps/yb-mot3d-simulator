export function createCandidateEvaluator(settings) {
  const worker = new Worker(new URL('./sequence-candidate-worker.js', import.meta.url), {type:'module'});
  let pending = null, closed = false, first = true;
  function fail(error) {
    closed = true;
    worker.terminate();
    pending?.reject(error);
    pending = null;
  }
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message)); };
  worker.onmessageerror = () => fail(new Error('无法读取优化求解器的输出。'));
  worker.onmessage = ({data}) => {
    if (!pending) return;
    if (data.error) { fail(new Error(data.error)); return; }
    pending.resolve(data.score);
    pending = null;
  };
  return {
    evaluate(config) {
      if (closed) return Promise.reject(new DOMException('优化已停止。', 'AbortError'));
      if (pending) return Promise.reject(new Error('同一优化任务须顺序评估时序。'));
      return new Promise((resolve, reject) => {
        pending = {resolve, reject};
        try { worker.postMessage(first ? {settings, config} : {config}); }
        catch (error) { fail(error); return; }
        first = false;
      });
    },
    destroy() {
      if (closed) return;
      if (pending) { fail(new DOMException('优化已停止。', 'AbortError')); return; }
      closed = true;
      worker.postMessage({close:true});
    },
  };
}
