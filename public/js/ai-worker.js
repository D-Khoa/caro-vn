/**
 * Web Worker chạy thuật toán AI 10 cấp độ không gây giật giao diện (Zero UI Blocking)
 */
import { computeBestAIMove } from './ai-engine.js';

self.onmessage = function (e) {
  const { requestId, activeBoard, deadCells, level, aiSymbol, humanSymbol, blockTwoEnds } = e.data;
  const start = performance.now();
  try {
    const move = computeBestAIMove(activeBoard, deadCells, level, aiSymbol, humanSymbol, blockTwoEnds);
    const elapsed = Math.round(performance.now() - start);
    self.postMessage({
      requestId,
      move,
      elapsed
    });
  } catch (err) {
    self.postMessage({
      requestId,
      error: err.message || 'AI error'
    });
  }
};
