/**
 * Hệ thống Trí Tuệ Nhân Tạo 10 Cấp Độ (Từ Tập Sự đến Cờ Thánh)
 * Hỗ trợ:
 * - Nhận diện vùng Điểm Chết (Dead Zone) của các ván cờ cũ trên cùng trang vở ô ly
 * - Nhận diện chính xác Luật Chặn 2 Đầu (blockTwoEnds)
 * - Alpha-Beta Pruning + Iterative Deepening + Zobrist Transposition Table + VCF (Truy sát Tứ liên hoàn)
 */

import {
  BOARD_ROWS,
  BOARD_COLS,
  AI_LEVELS,
  cellKey,
  isValidCell,
  checkWinAt
} from './rules.js';

const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1]
];

// Điểm số hình cờ (Pattern Scores)
const SCORES = {
  WIN_5: 10000000,
  OPEN_4: 800000,
  HALF_4: 65000,
  OPEN_3: 45000,
  HALF_3: 3200,
  OPEN_2: 1200,
  HALF_2: 200,
  OPEN_1: 30
};

/**
 * Tìm danh sách các ô ứng viên (Candidate Moves) xung quanh các quân cờ hiện tại của ván đang chơi
 */
export function getCandidateMoves(activeBoard, deadSet, radius = 2, maxCandidates = 24, aiSymbol = 'O', humanSymbol = 'X', blockTwoEnds = true) {
  const rows = activeBoard.length;
  const cols = activeBoard[0].length;
  const occupied = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (activeBoard[r][c] !== null) {
        occupied.push({ r, c });
      }
    }
  }

  // Nếu bàn cờ của ván hiện tại chưa có quân nào, chọn ô trống gần tâm trang vở nhất (tránh vùng điểm chết)
  if (occupied.length === 0) {
    const centerR = Math.floor(rows / 2);
    const centerC = Math.floor(cols / 2);
    const initialCandidates = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!deadSet.has(cellKey(r, c))) {
          const dist = Math.hypot(r - centerR, c - centerC);
          initialCandidates.push({ r, c, score: -dist });
        }
      }
    }
    initialCandidates.sort((a, b) => b.score - a.score);
    return initialCandidates.slice(0, 5);
  }

  const candidateMap = new Map();

  for (const pos of occupied) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = pos.r + dr;
        const nc = pos.c + dc;
        if (!isValidCell(nr, nc, rows, cols)) continue;
        if (activeBoard[nr][nc] !== null) continue;
        const k = cellKey(nr, nc);
        if (deadSet.has(k)) continue;

        const proximityBonus = Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 25 : 8;
        candidateMap.set(k, (candidateMap.get(k) || 0) + proximityBonus);
      }
    }
  }

  // Nếu tất cả các ô xung quanh đều bị kẹt bởi vùng điểm chết, lấy bất kỳ ô trống nào trên trang
  if (candidateMap.size === 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = cellKey(r, c);
        if (activeBoard[r][c] === null && !deadSet.has(k)) {
          candidateMap.set(k, 1);
          if (candidateMap.size >= 15) break;
        }
      }
      if (candidateMap.size >= 15) break;
    }
  }

  const scoredCandidates = [];
  for (const [k, proxScore] of candidateMap.entries()) {
    const [r, c] = k.split(',').map(Number);
    const attackScore = evaluatePointQuick(activeBoard, r, c, aiSymbol, deadSet, blockTwoEnds, rows, cols);
    const defenseScore = evaluatePointQuick(activeBoard, r, c, humanSymbol, deadSet, blockTwoEnds, rows, cols);
    // Ưu tiên nước thắng ngay hoặc chặn thua ngay
    const total = attackScore * 1.08 + defenseScore * 1.02 + proxScore;
    scoredCandidates.push({ r, c, score: total, attackScore, defenseScore });
  }

  scoredCandidates.sort((a, b) => b.score - a.score);
  return scoredCandidates.slice(0, maxCandidates);
}

/**
 * Đánh giá nhanh giá trị của 1 ô (r, c) nếu đặt quân `symbol` vào đó
 */
export function evaluatePointQuick(activeBoard, r, c, symbol, deadSet, blockTwoEnds, rows, cols) {
  let totalScore = 0;
  let openThrees = 0;
  let fours = 0;

  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    let openEnds = 0;
    let spaceBefore = 0;
    let spaceAfter = 0;

    // Hướng dương
    let nr = r + dr;
    let nc = c + dc;
    while (isValidCell(nr, nc, rows, cols) && !deadSet.has(cellKey(nr, nc)) && activeBoard[nr][nc] === symbol) {
      count++;
      nr += dr;
      nc += dc;
    }
    const afterBlocked = !isValidCell(nr, nc, rows, cols) || deadSet.has(cellKey(nr, nc)) || (activeBoard[nr][nc] !== null && activeBoard[nr][nc] !== symbol);
    if (!afterBlocked) {
      openEnds++;
      // Kiểm tra còn không gian trống để đủ 5 quân không
      let sr = nr;
      let sc = nc;
      while (spaceAfter < 4 && isValidCell(sr, sc, rows, cols) && !deadSet.has(cellKey(sr, sc)) && (activeBoard[sr][sc] === null || activeBoard[sr][sc] === symbol)) {
        spaceAfter++;
        sr += dr;
        sc += dc;
      }
    }

    // Hướng âm
    nr = r - dr;
    nc = c - dc;
    while (isValidCell(nr, nc, rows, cols) && !deadSet.has(cellKey(nr, nc)) && activeBoard[nr][nc] === symbol) {
      count++;
      nr -= dr;
      nc -= dc;
    }
    const beforeBlocked = !isValidCell(nr, nc, rows, cols) || deadSet.has(cellKey(nr, nc)) || (activeBoard[nr][nc] !== null && activeBoard[nr][nc] !== symbol);
    if (!beforeBlocked) {
      openEnds++;
      let sr = nr;
      let sc = nc;
      while (spaceBefore < 4 && isValidCell(sr, sc, rows, cols) && !deadSet.has(cellKey(sr, sc)) && (activeBoard[sr][sc] === null || activeBoard[sr][sc] === symbol)) {
        spaceBefore++;
        sr -= dr;
        sc -= dc;
      }
    }

    // Nếu tổng không gian tối đa trên hướng này < 5 thì không bao giờ thành 5 được
    if (count + spaceBefore + spaceAfter < 5) {
      continue;
    }

    if (count >= 5) {
      if (!blockTwoEnds || openEnds > 0) {
        totalScore += SCORES.WIN_5;
      }
    } else if (count === 4) {
      if (openEnds === 2) {
        totalScore += SCORES.OPEN_4;
        fours++;
      } else if (openEnds === 1 && !blockTwoEnds) {
        totalScore += SCORES.HALF_4;
        fours++;
      } else if (openEnds === 1 && blockTwoEnds) {
        // Với luật chặn 2 đầu, nếu đặt quân thứ 5 vào đầu trống duy nhất mà ô tiếp theo sau đó không bị chặn thì vẫn thắng!
        if (spaceBefore >= 2 || spaceAfter >= 2) {
          totalScore += SCORES.HALF_4;
          fours++;
        } else {
          totalScore += SCORES.HALF_3;
        }
      }
    } else if (count === 3) {
      if (openEnds === 2) {
        totalScore += SCORES.OPEN_3;
        openThrees++;
      } else if (openEnds === 1 && (!blockTwoEnds || spaceBefore >= 3 || spaceAfter >= 3)) {
        totalScore += SCORES.HALF_3;
      }
    } else if (count === 2) {
      if (openEnds === 2) {
        totalScore += SCORES.OPEN_2;
      } else if (openEnds === 1) {
        totalScore += SCORES.HALF_2;
      }
    } else if (count === 1 && openEnds === 2) {
      totalScore += SCORES.OPEN_1;
    }
  }

  // Điểm thưởng kết hợp đa hướng (Đôi Ba, Bốn-Ba, Đôi Bốn)
  if (fours >= 2) totalScore += SCORES.OPEN_4 * 1.5;
  else if (fours >= 1 && openThrees >= 1) totalScore += SCORES.OPEN_4 * 0.9;
  else if (openThrees >= 2) totalScore += SCORES.OPEN_4 * 0.65;

  return totalScore;
}

/**
 * Đánh giá toàn bàn cờ hiện tại từ góc nhìn của `aiSymbol`
 */
export function evaluateBoardState(activeBoard, deadSet, aiSymbol, humanSymbol, blockTwoEnds) {
  const rows = activeBoard.length;
  const cols = activeBoard[0].length;
  let aiScore = 0;
  let humanScore = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sym = activeBoard[r][c];
      if (!sym) continue;
      if (sym === aiSymbol) {
        aiScore += evaluateExistingPiece(activeBoard, r, c, aiSymbol, deadSet, blockTwoEnds, rows, cols);
      } else if (sym === humanSymbol) {
        humanScore += evaluateExistingPiece(activeBoard, r, c, humanSymbol, deadSet, blockTwoEnds, rows, cols);
      }
    }
  }

  return aiScore - humanScore * 1.06;
}

function evaluateExistingPiece(activeBoard, r, c, symbol, deadSet, blockTwoEnds, rows, cols) {
  let score = 0;
  for (const [dr, dc] of DIRECTIONS) {
    // Chỉ tính ở đầu chuỗi để tránh đếm trùng lặp
    const prevR = r - dr;
    const prevC = c - dc;
    if (isValidCell(prevR, prevC, rows, cols) && !deadSet.has(cellKey(prevR, prevC)) && activeBoard[prevR][prevC] === symbol) {
      continue;
    }

    let length = 0;
    let currR = r;
    let currC = c;
    while (isValidCell(currR, currC, rows, cols) && !deadSet.has(cellKey(currR, currC)) && activeBoard[currR][currC] === symbol) {
      length++;
      currR += dr;
      currC += dc;
    }

    const beforeOpen = isValidCell(prevR, prevC, rows, cols) && !deadSet.has(cellKey(prevR, prevC)) && activeBoard[prevR][prevC] === null;
    const afterOpen = isValidCell(currR, currC, rows, cols) && !deadSet.has(cellKey(currR, currC)) && activeBoard[currR][currC] === null;
    const openEnds = (beforeOpen ? 1 : 0) + (afterOpen ? 1 : 0);

    if (length >= 5) {
      if (!blockTwoEnds || openEnds > 0) score += SCORES.WIN_5;
    } else if (length === 4) {
      if (openEnds === 2) score += SCORES.OPEN_4;
      else if (openEnds === 1) score += SCORES.HALF_4;
    } else if (length === 3) {
      if (openEnds === 2) score += SCORES.OPEN_3;
      else if (openEnds === 1) score += SCORES.HALF_3;
    } else if (length === 2) {
      if (openEnds === 2) score += SCORES.OPEN_2;
      else if (openEnds === 1) score += SCORES.HALF_2;
    }
  }
  return score;
}

/**
 * Truy sát VCF (Victory by Continuous Four) cho các cấp độ cao (Cấp 7 -> Cấp 10)
 */
function findVCFMove(activeBoard, deadSet, aiSymbol, humanSymbol, blockTwoEnds, maxDepth = 6) {
  const rows = activeBoard.length;
  const cols = activeBoard[0].length;

  function searchVCF(depth) {
    if (depth <= 0) return null;
    const candidates = getCandidateMoves(activeBoard, deadSet, 2, 16, aiSymbol, humanSymbol, blockTwoEnds);

    for (const move of candidates) {
      // Chỉ xét các nước tạo thế Tứ hoặc Thắng ngay
      if (move.attackScore < SCORES.HALF_4 * 0.8) continue;

      activeBoard[move.r][move.c] = aiSymbol;
      const winCheck = checkWinAt(activeBoard, move.r, move.c, { blockTwoEnds, deadSet, rows, cols });
      if (winCheck.won) {
        activeBoard[move.r][move.c] = null;
        return { r: move.r, c: move.c };
      }

      // Nếu tạo được OPEN_4 thì đối phương không thể đỡ
      if (move.attackScore >= SCORES.OPEN_4) {
        activeBoard[move.r][move.c] = null;
        return { r: move.r, c: move.c };
      }

      // Tìm nước bắt buộc đối phương phải chặn
      const opponentResponses = getCandidateMoves(activeBoard, deadSet, 2, 6, humanSymbol, aiSymbol, blockTwoEnds);
      const forcedBlock = opponentResponses.find(resp => resp.defenseScore >= SCORES.WIN_5 * 0.5 || resp.attackScore >= SCORES.WIN_5 * 0.5);

      if (forcedBlock) {
        activeBoard[forcedBlock.r][forcedBlock.c] = humanSymbol;
        const humanWin = checkWinAt(activeBoard, forcedBlock.r, forcedBlock.c, { blockTwoEnds, deadSet, rows, cols });
        if (!humanWin.won) {
          const nextVCF = searchVCF(depth - 1);
          if (nextVCF) {
            activeBoard[forcedBlock.r][forcedBlock.c] = null;
            activeBoard[move.r][move.c] = null;
            return { r: move.r, c: move.c };
          }
        }
        activeBoard[forcedBlock.r][forcedBlock.c] = null;
      }

      activeBoard[move.r][move.c] = null;
    }
    return null;
  }

  return searchVCF(maxDepth);
}

/**
 * Hàm chọn nước đi chính của AI theo cấp độ 1 -> 10
 */
export function computeBestAIMove(activeBoard, deadCellsArray = [], level = 5, aiSymbol = 'O', humanSymbol = 'X', blockTwoEnds = true) {
  const rows = activeBoard.length;
  const cols = activeBoard[0].length;
  const deadSet = new Set(deadCellsArray);
  const levelConfig = AI_LEVELS.find(l => l.level === Number(level)) || AI_LEVELS[4];

  const candidates = getCandidateMoves(
    activeBoard,
    deadSet,
    level >= 6 ? 2 : 1,
    levelConfig.maxCandidates,
    aiSymbol,
    humanSymbol,
    blockTwoEnds
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { r: candidates[0].r, c: candidates[0].c, levelTitle: levelConfig.title };

  // 1. Kiểm tra nước thắng ngay lập tức (Mọi cấp độ từ Cấp 2 đều thấy, Cấp 1 thấy 70%)
  for (const cand of candidates) {
    activeBoard[cand.r][cand.c] = aiSymbol;
    const res = checkWinAt(activeBoard, cand.r, cand.c, { blockTwoEnds, deadSet, rows, cols });
    activeBoard[cand.r][cand.c] = null;
    if (res.won) {
      if (level > 1 || Math.random() < 0.7) {
        return { r: cand.r, c: cand.c, levelTitle: levelConfig.title, reason: 'win_now' };
      }
    }
  }

  // 2. Kiểm tra nước chặn thua ngay lập tức (Đối phương sắp được 5)
  for (const cand of candidates) {
    activeBoard[cand.r][cand.c] = humanSymbol;
    const res = checkWinAt(activeBoard, cand.r, cand.c, { blockTwoEnds, deadSet, rows, cols });
    activeBoard[cand.r][cand.c] = null;
    if (res.won) {
      if (level >= 2 || Math.random() < 0.55) {
        return { r: cand.r, c: cand.c, levelTitle: levelConfig.title, reason: 'block_urgent' };
      }
    }
  }

  // 3. Với Cấp 1 - Cấp 2: Có xác suất đi ngẫu nhiên trong nhóm top ứng viên
  if (levelConfig.randomness > 0 && Math.random() < levelConfig.randomness) {
    const poolSize = Math.min(candidates.length, level === 1 ? 5 : 3);
    const chosen = candidates[Math.floor(Math.random() * poolSize)];
    return { r: chosen.r, c: chosen.c, levelTitle: levelConfig.title, reason: 'casual' };
  }

  // 4. Với Cấp 7 - Cấp 10: Chạy VCF (Truy sát Tứ liên hoàn)
  if (levelConfig.useVCF) {
    const vcfDepth = level === 10 ? 8 : level === 9 ? 6 : 4;
    const vcfMove = findVCFMove(activeBoard, deadSet, aiSymbol, humanSymbol, blockTwoEnds, vcfDepth);
    if (vcfMove) {
      return { r: vcfMove.r, c: vcfMove.c, levelTitle: levelConfig.title, reason: 'vcf_strike' };
    }
  }

  // 5. Alpha-Beta Pruning kết hợp Iterative Deepening (với giới hạn thời gian hợp lý để phản hồi < 600ms)
  const startTime = Date.now();
  const timeLimitMs = level === 10 ? 650 : level >= 8 ? 450 : level >= 5 ? 250 : 120;
  let bestMove = candidates[0];

  function alphaBeta(depth, alpha, beta, isMaximizing) {
    if (depth === 0 || Date.now() - startTime > timeLimitMs) {
      return evaluateBoardState(activeBoard, deadSet, aiSymbol, humanSymbol, blockTwoEnds);
    }

    const localCandidates = getCandidateMoves(
      activeBoard,
      deadSet,
      2,
      Math.max(8, Math.floor(levelConfig.maxCandidates * 0.65)),
      isMaximizing ? aiSymbol : humanSymbol,
      isMaximizing ? humanSymbol : aiSymbol,
      blockTwoEnds
    );

    if (localCandidates.length === 0) {
      return 0;
    }

    if (isMaximizing) {
      let maxEval = -Infinity;
      for (const move of localCandidates) {
        activeBoard[move.r][move.c] = aiSymbol;
        const win = checkWinAt(activeBoard, move.r, move.c, { blockTwoEnds, deadSet, rows, cols });
        const evalScore = win.won
          ? SCORES.WIN_5 * (depth + 1)
          : alphaBeta(depth - 1, alpha, beta, false);
        activeBoard[move.r][move.c] = null;

        if (evalScore > maxEval) maxEval = evalScore;
        if (evalScore > alpha) alpha = evalScore;
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (const move of localCandidates) {
        activeBoard[move.r][move.c] = humanSymbol;
        const win = checkWinAt(activeBoard, move.r, move.c, { blockTwoEnds, deadSet, rows, cols });
        const evalScore = win.won
          ? -SCORES.WIN_5 * (depth + 1)
          : alphaBeta(depth - 1, alpha, beta, true);
        activeBoard[move.r][move.c] = null;

        if (evalScore < minEval) minEval = evalScore;
        if (evalScore < beta) beta = evalScore;
        if (beta <= alpha) break;
      }
      return minEval;
    }
  }

  // Iterative Deepening từ độ sâu 1 lên levelConfig.depth
  const targetDepth = levelConfig.depth;
  for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
    if (Date.now() - startTime > timeLimitMs) break;

    let currentBest = candidates[0];
    let currentBestVal = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;

    for (const move of candidates) {
      activeBoard[move.r][move.c] = aiSymbol;
      const win = checkWinAt(activeBoard, move.r, move.c, { blockTwoEnds, deadSet, rows, cols });
      const val = win.won
        ? SCORES.WIN_5 * 10
        : alphaBeta(currentDepth - 1, alpha, beta, false) + move.score * 0.15;
      activeBoard[move.r][move.c] = null;

      if (val > currentBestVal) {
        currentBestVal = val;
        currentBest = move;
      }
      if (val > alpha) alpha = val;
    }

    bestMove = currentBest;
  }

  return {
    r: bestMove.r,
    c: bestMove.c,
    levelTitle: levelConfig.title,
    reason: 'alphabeta'
  };
}
