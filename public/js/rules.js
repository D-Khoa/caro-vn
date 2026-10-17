/**
 * Luật Cờ Caro Việt Nam & Thuật toán Khoanh vùng Điểm Chết trên Trang Vở Ô Ly
 * Dùng chung cho cả Client UI, AI Web Worker và Server Validation.
 */

export const BOARD_ROWS = 26;
export const BOARD_COLS = 36;
export const TOTAL_NOTEBOOK_PAGES = 200;

export const SYMBOLS = ['X', 'O', 'Δ', '□'];

export const SYMBOL_CONFIG = {
  X: {
    symbol: 'X',
    name: 'Mực Xanh (X)',
    color: '#1d4ed8',
    lightColor: 'rgba(29, 78, 216, 0.14)',
    borderColor: '#1e40af'
  },
  O: {
    symbol: 'O',
    name: 'Mực Đỏ (O)',
    color: '#dc2626',
    lightColor: 'rgba(220, 38, 38, 0.14)',
    borderColor: '#b91c1c'
  },
  'Δ': {
    symbol: 'Δ',
    name: 'Mực Tím (Δ)',
    color: '#7c3aed',
    lightColor: 'rgba(124, 58, 237, 0.14)',
    borderColor: '#5b21b6'
  },
  '□': {
    symbol: '□',
    name: 'Mực Đen (□)',
    color: '#15803d',
    lightColor: 'rgba(21, 128, 61, 0.14)',
    borderColor: '#166534'
  }
};

export const AI_LEVELS = [
  { level: 1, title: 'Cấp 1: Tập Sự', subtitle: 'Mới tập cầm bút, hay nhìn sót nước', depth: 1, randomness: 0.45, maxCandidates: 10 },
  { level: 2, title: 'Cấp 2: Học Trò', subtitle: 'Biết nối 2-3 quân và chặn cơ bản', depth: 1, randomness: 0.2, maxCandidates: 12 },
  { level: 3, title: 'Cấp 3: Tổ Trưởng', subtitle: 'Biết chặn chuỗi 3 và tạo thế công', depth: 2, randomness: 0.08, maxCandidates: 14 },
  { level: 4, title: 'Cấp 4: Lớp Trưởng', subtitle: 'Tấn công & phòng thủ chắc tay', depth: 2, randomness: 0, maxCandidates: 16 },
  { level: 5, title: 'Cấp 5: Cờ Thủ Xóm', subtitle: 'Biết gài bẫy đôi ba, bốn mở', depth: 3, randomness: 0, maxCandidates: 16 },
  { level: 6, title: 'Cấp 6: Cao Thủ Trường', subtitle: 'Tính trước 3-4 nước, tận dụng điểm chết', depth: 3, randomness: 0, maxCandidates: 20, useVCF: false },
  { level: 7, title: 'Cấp 7: Kiện Tướng', subtitle: 'Alpha-Beta sâu + đọc thế chặn 2 đầu', depth: 4, randomness: 0, maxCandidates: 20, useVCF: true },
  { level: 8, title: 'Cấp 8: Đại Sư', subtitle: 'Truy sát VCF liên hoàn + Bảng băm Zobrist', depth: 4, randomness: 0, maxCandidates: 24, useVCF: true },
  { level: 9, title: 'Cấp 9: Kỳ Tiên', subtitle: 'Đọc vị sâu 5-6 bước, khóa chặt đường công', depth: 5, randomness: 0, maxCandidates: 26, useVCF: true },
  { level: 10, title: 'Cấp 10: Cờ Thánh', subtitle: 'Đỉnh cao trí tuệ: Iterative Deepening + VCF/VCT', depth: 6, randomness: 0, maxCandidates: 30, useVCF: true }
];

const DIRECTIONS = [
  [0, 1],  // Ngang
  [1, 0],  // Dọc
  [1, 1],  // Chéo chính
  [1, -1]  // Chéo phụ
];

export function cellKey(r, c) {
  return `${r},${c}`;
}

export function parseCellKey(key) {
  const [r, c] = key.split(',').map(Number);
  return { r, c };
}

export function isValidCell(r, c, rows = BOARD_ROWS, cols = BOARD_COLS) {
  return r >= 0 && r < rows && c >= 0 && c < cols;
}

/**
 * Kiểm tra ô có bị chặn (bởi biên, vùng điểm chết của ván cũ, hoặc quân của đối phương)
 */
export function isCellBlockedForSymbol(r, c, symbol, activeBoard, deadSet, rows = BOARD_ROWS, cols = BOARD_COLS) {
  if (!isValidCell(r, c, rows, cols)) return true;
  const key = cellKey(r, c);
  if (deadSet && deadSet.has(key)) return true;
  const val = activeBoard[r][c];
  if (val !== null && val !== symbol) return true;
  return false;
}

/**
 * Kiểm tra chiến thắng sau nước đi tại (lastR, lastC)
 * @param {Array<Array<string|null>>} activeBoard - Ma trận bàn cờ của ván HIỆN TẠI (không tính quân ván cũ)
 * @param {number} lastR
 * @param {number} lastC
 * @param {Object} options - { blockTwoEnds: boolean, deadSet: Set<string>, rows: number, cols: number }
 * @returns {{ won: boolean, symbol?: string, line?: Array<{r:number, c:number}> }}
 */
export function checkWinAt(activeBoard, lastR, lastC, options = {}) {
  const rows = options.rows || activeBoard.length;
  const cols = options.cols || activeBoard[0].length;
  const blockTwoEnds = options.blockTwoEnds !== undefined ? options.blockTwoEnds : true;
  const deadSet = options.deadSet || new Set();

  if (!isValidCell(lastR, lastC, rows, cols)) return { won: false };
  const symbol = activeBoard[lastR][lastC];
  if (!symbol) return { won: false };

  for (const [dr, dc] of DIRECTIONS) {
    const chain = [{ r: lastR, c: lastC }];

    // Mở rộng hướng dương
    let r = lastR + dr;
    let c = lastC + dc;
    while (isValidCell(r, c, rows, cols) && !deadSet.has(cellKey(r, c)) && activeBoard[r][c] === symbol) {
      chain.push({ r, c });
      r += dr;
      c += dc;
    }
    const afterCell = { r, c };

    // Mở rộng hướng âm
    r = lastR - dr;
    c = lastC - dc;
    while (isValidCell(r, c, rows, cols) && !deadSet.has(cellKey(r, c)) && activeBoard[r][c] === symbol) {
      chain.unshift({ r, c });
      r -= dr;
      c -= dc;
    }
    const beforeCell = { r, c };

    if (chain.length >= 5) {
      if (!blockTwoEnds) {
        return { won: true, symbol, line: chain };
      }

      // Luật chặn 2 đầu Việt Nam:
      // Nếu cả 2 đầu sát chuỗi đều bị chặn (bởi quân đối phương, vùng điểm chết ván cũ, hoặc mép vở) thì KHÔNG tính thắng.
      const blockedBefore = isCellBlockedForSymbol(beforeCell.r, beforeCell.c, symbol, activeBoard, deadSet, rows, cols);
      const blockedAfter = isCellBlockedForSymbol(afterCell.r, afterCell.c, symbol, activeBoard, deadSet, rows, cols);

      if (!(blockedBefore && blockedAfter)) {
        return { won: true, symbol, line: chain };
      }
    }
  }

  return { won: false };
}

/**
 * Kiểm tra còn ô trống hợp lệ nào trên trang vở không
 */
export function countPlayableCells(activeBoard, deadSet, rows = BOARD_ROWS, cols = BOARD_COLS) {
  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (activeBoard[r][c] === null && (!deadSet || !deadSet.has(cellKey(r, c)))) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Tạo vùng khoanh "Điểm Chết" (Dead Zone) và đường viền đa giác bo sát (Polygonal Contour)
 * cho một ván cờ vừa kết thúc.
 *
 * Cơ chế:
 * 1. Lấy tất cả các ô có quân cờ của ván vừa đánh.
 * 2. Thực hiện phép đóng hình thái học nhẹ (Morphological Closing bán kính 1 ô cho các quân cờ gần nhau <= 2 ô)
 *    để nối các quân cờ trong cùng 1 thế trận thành cụm liền mạch (không nuốt các ô của ván cũ).
 * 3. Lấp các lỗ hổng nhỏ hoàn toàn nằm lọt thỏm bên trong thế cờ (diện tích <= 6 ô).
 * 4. Truy vết biên định hướng (Directed Grid Boundary Tracing) quanh tập hợp ô vừa tìm được
 *    để tạo ra các đa giác khép kín (loops) bo sát theo thế cờ.
 *
 * @param {Array<{r:number, c:number, symbol:string}>} moves
 * @param {Set<string>} existingDeadSet - Các ô điểm chết của các ván trước đó trên cùng trang vở
 * @param {number} rows
 * @param {number} cols
 * @returns {{ deadCells: Array<string>, contours: Array<Array<{r:number, c:number}>> }}
 */
export function computeGameFenceAndDeadZone(moves, existingDeadSet = new Set(), rows = BOARD_ROWS, cols = BOARD_COLS) {
  if (!moves || moves.length === 0) {
    return { deadCells: [], contours: [] };
  }

  // Chỉ lấy đúng các ô thực sự có quân cờ của ván vừa kết thúc (không lấy tràn sang ô trống xung quanh)
  const regionSet = new Set();
  for (const m of moves) {
    const k = cellKey(m.r, m.c);
    if (!existingDeadSet.has(k)) {
      regionSet.add(k);
    }
  }

  if (regionSet.size === 0) {
    return { deadCells: [], contours: [] };
  }

  // Chỉ lấp ô trống đơn lẻ ( đúng 1 ô ) nếu cả 4 phía Trên - Dưới - Trái - Phải của nó
  // đều là quân cờ của CHÍNH ván này (tránh tạo lỗ thủng 1 ô giữa cụm cờ đặc).
  const singleHoles = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const k = cellKey(r, c);
      if (regionSet.has(k) || existingDeadSet.has(k)) continue;
      if (
        regionSet.has(cellKey(r - 1, c)) &&
        regionSet.has(cellKey(r + 1, c)) &&
        regionSet.has(cellKey(r, c - 1)) &&
        regionSet.has(cellKey(r, c + 1))
      ) {
        singleHoles.push(k);
      }
    }
  }
  for (const hk of singleHoles) {
    regionSet.add(hk);
  }

  // Truy vết các cạnh biên định hướng (Directed Boundary Edges)
  // Hướng cạnh (dir): 0 = Sang phải (Top), 1 = Xuống dưới (Right), 2 = Sang trái (Bottom), 3 = Lên trên (Left)
  // Pháp tuyến hướng vào tâm ô (inward normal):
  // dir 0 -> (+1, 0), dir 1 -> (0, -1), dir 2 -> (-1, 0), dir 3 -> (0, +1)
  const INWARD_NORMALS = [
    { nr: 1, nc: 0 },
    { nr: 0, nc: -1 },
    { nr: -1, nc: 0 },
    { nr: 0, nc: 1 }
  ];

  const outgoingEdges = new Map();

  function addDirectedEdge(r1, c1, r2, c2, dir) {
    const startKey = `${r1},${c1}`;
    if (!outgoingEdges.has(startKey)) {
      outgoingEdges.set(startKey, []);
    }
    outgoingEdges.get(startKey).push({ r1, c1, r2, c2, dir, used: false });
  }

  for (const key of regionSet) {
    const { r, c } = parseCellKey(key);
    if (!regionSet.has(cellKey(r - 1, c))) {
      addDirectedEdge(r, c, r, c + 1, 0);
    }
    if (!regionSet.has(cellKey(r, c + 1))) {
      addDirectedEdge(r, c + 1, r + 1, c + 1, 1);
    }
    if (!regionSet.has(cellKey(r + 1, c))) {
      addDirectedEdge(r + 1, c + 1, r + 1, c, 2);
    }
    if (!regionSet.has(cellKey(r, c - 1))) {
      addDirectedEdge(r + 1, c, r, c, 3);
    }
  }

  const rawLoops = [];
  for (const [, edgeList] of outgoingEdges) {
    for (const startEdge of edgeList) {
      if (startEdge.used) continue;

      const edgeLoop = [];
      let currEdge = startEdge;
      while (currEdge && !currEdge.used) {
        currEdge.used = true;
        edgeLoop.push(currEdge);
        const nextKey = `${currEdge.r2},${currEdge.c2}`;
        const allAtVertex = outgoingEdges.get(nextKey) || [];
        const candidates = allAtVertex.filter(e => !e.used);
        if (candidates.length === 0) {
          currEdge = null;
        } else if (candidates.length === 1) {
          currEdge = candidates[0];
        } else {
          // Đỉnh chạm chéo (saddle vertex) giữa 2 quân cờ chéo của CÙNG ván này:
          // Rẽ trái ((dir + 3) % 4) để tạo cổ nối chéo mảnh giữa 2 quân cờ mà không lấn vào 2 ô trống bên cạnh.
          const leftTurnDir = (currEdge.dir + 3) % 4;
          currEdge = candidates.find(e => e.dir === leftTurnDir) || candidates[0];
        }
      }

      if (edgeLoop.length >= 4) {
        rawLoops.push(edgeLoop);
      }
    }
  }

  // Thu nhỏ nhẹ (Inset) các đỉnh biên vào bên trong ô điểm chết (~0.12 ô)
  // giúp đường bút bi khoanh gọn trong các ô của ván cũ, không bao giờ đè lên ô trống của ván tiếp theo.
  const INSET = 0.12;
  const SADDLE_NECK = 0.09;
  const contours = rawLoops.map(edgeLoop => {
    const n = edgeLoop.length;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const prevEdge = edgeLoop[(i - 1 + n) % n];
      const currEdge = edgeLoop[i];
      const vR = currEdge.r1;
      const vC = currEdge.c1;
      const vKey = `${vR},${vC}`;
      const isSaddle = (outgoingEdges.get(vKey)?.length || 0) >= 2;

      const nPrev = INWARD_NORMALS[prevEdge.dir];
      const nCurr = INWARD_NORMALS[currEdge.dir];

      if (isSaddle && prevEdge.dir !== currEdge.dir) {
        pts.push({
          r: +(vR - (nPrev.nr + nCurr.nr) * SADDLE_NECK).toFixed(3),
          c: +(vC - (nPrev.nc + nCurr.nc) * SADDLE_NECK).toFixed(3)
        });
      } else {
        const sumNr = Math.max(-1, Math.min(1, nPrev.nr + nCurr.nr));
        const sumNc = Math.max(-1, Math.min(1, nPrev.nc + nCurr.nc));
        pts.push({
          r: +(vR + sumNr * INSET).toFixed(3),
          c: +(vC + sumNc * INSET).toFixed(3)
        });
      }
    }
    return pts;
  });

  return {
    deadCells: Array.from(regionSet),
    contours
  };
}
