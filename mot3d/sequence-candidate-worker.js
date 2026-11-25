import { createCandidateScorer } from './sequence-candidate-score.js';

let scorer;
self.onmessage = async ({data}) => {
  try {
    if (data.close) {
      scorer?.destroy();
      self.close();
      return;
    }
    if (!scorer) scorer = await createCandidateScorer(data.settings);
    self.postMessage({score:await scorer.evaluate(data.config)});
  } catch (error) {
    scorer?.destroy();
    self.postMessage({error:error.message});
    self.close();
  }
};
