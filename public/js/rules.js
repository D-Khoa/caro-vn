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

  const regionSet = new Set();
  for (const m of moves) {
    regionSet.add(cellKey(m.r, m.c));
  }

  // Bước 1: Nối các quân cờ đứng cách nhau 1 ô trống (cầu nối chéo hoặc thẳng trong phạm vi thế cờ)
  // giúp đường khoanh bút bi liền mạch giống học sinh khoanh 1 cụm cờ, nhưng vẫn tiết kiệm tối đa diện tích trang.
  const moveCoords = moves.map(m => ({ r: m.r, c: m.c }));
  for (let i = 0; i < moveCoords.length; i++) {
    for (let j = i + 1; j < moveCoords.length; j++) {
      const a = moveCoords[i];
      const b = moveCoords[j];
      const dr = Math.abs(a.r - b.r);
      const dc = Math.abs(a.c - b.c);
      // Nếu 2 quân trong cùng ván cách nhau đúng 1 ô trung gian (Chebyshev <= 2)
      if (Math.max(dr, dc) <= 2) {
        const midR = Math.round((a.r + b.r) / 2);
        const midC = Math.round((a.c + b.c) / 2);
        const midKey = cellKey(midR, midC);
        if (!existingDeadSet.has(midKey)) {
          regionSet.add(midKey);
        }
        // Nếu chéo (dr===1 && dc===1) thì bổ sung 1 ô kề để đa giác không bị thắt nút cổ chai
        if (dr === 1 && dc === 1) {
          const k1 = cellKey(a.r, b.c);
          const k2 = cellKey(b.r, a.c);
          if (!existingDeadSet.has(k1)) regionSet.add(k1);
          else if (!existingDeadSet.has(k2)) regionSet.add(k2);
        }
      }
    }
  }

  // Bước 2: Lấp các lỗ hổng nhỏ (<= 8 ô) bị bao vây kín 4 hướng bởi regionSet
  const visitedOutside = new Set();
  const queue = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        const k = cellKey(r, c);
        if (!regionSet.has(k)) {
          visitedOutside.add(k);
          queue.push({ r, c });
        }
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    const neighbors = [
      { r: curr.r - 1, c: curr.c },
      { r: curr.r + 1, c: curr.c },
      { r: curr.r, c: curr.c - 1 },
      { r: curr.r, c: curr.c + 1 }
    ];
    for (const nb of neighbors) {
      if (isValidCell(nb.r, nb.c, rows, cols)) {
        const nk = cellKey(nb.r, nb.c);
        if (!regionSet.has(nk) && !visitedOutside.has(nk)) {
          visitedOutside.add(nk);
          queue.push(nb);
        }
      }
    }
  }

  // Các ô không thuộc visitedOutside và không thuộc existingDeadSet nằm lọt thỏm bên trong vùng khoanh
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = cellKey(r, c);
      if (!regionSet.has(k) && !visitedOutside.has(k) && !existingDeadSet.has(k)) {
        regionSet.add(k);
      }
    }
  }

  // Bước 3: Khử nút thắt chéo (Pinch vertices) để đường viền đa giác mượt mà
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = regionSet.has(cellKey(r, c));
        const tr = regionSet.has(cellKey(r, c + 1));
        const bl = regionSet.has(cellKey(r + 1, c));
        const br = regionSet.has(cellKey(r + 1, c + 1));
        if (tl && br && !tr && !bl) {
          const k = cellKey(r, c + 1);
          if (!existingDeadSet.has(k)) {
            regionSet.add(k);
            changed = true;
          }
        } else if (!tl && !br && tr && bl) {
          const k = cellKey(r, c);
          if (!existingDeadSet.has(k)) {
            regionSet.add(k);
            changed = true;
          }
        }
      }
    }
  }

  // Bước 4: Truy vết các cạnh biên định hướng (Directed Boundary Edges)
  // Mỗi ô (r, c) chiếm góc từ (r, c) đến (r+1, c+1) trên hệ tọa độ đỉnh lưới.
  // Chiều kim đồng hồ quanh ô (r, c):
  // Top: (r, c) -> (r, c+1)
  // Right: (r, c+1) -> (r+1, c+1)
  // Bottom: (r+1, c+1) -> (r+1, c)
  // Left: (r+1, c) -> (r, c)
  const outgoingEdges = new Map();

  function addDirectedEdge(r1, c1, r2, c2) {
    const startKey = `${r1},${c1}`;
    if (!outgoingEdges.has(startKey)) {
      outgoingEdges.set(startKey, []);
    }
    outgoingEdges.get(startKey).push({ r1, c1, r2, c2, used: false });
  }

  for (const key of regionSet) {
    const { r, c } = parseCellKey(key);
    // Top
    if (!regionSet.has(cellKey(r - 1, c))) {
      addDirectedEdge(r, c, r, c + 1);
    }
    // Right
    if (!regionSet.has(cellKey(r, c + 1))) {
      addDirectedEdge(r, c + 1, r + 1, c + 1);
    }
    // Bottom
    if (!regionSet.has(cellKey(r + 1, c))) {
      addDirectedEdge(r + 1, c + 1, r + 1, c);
    }
    // Left
    if (!regionSet.has(cellKey(r, c - 1))) {
      addDirectedEdge(r + 1, c, r, c);
    }
  }

  const contours = [];
  for (const [, edgeList] of outgoingEdges) {
    for (const startEdge of edgeList) {
      if (startEdge.used) continue;

      const loop = [];
      let currEdge = startEdge;
      while (currEdge && !currEdge.used) {
        currEdge.used = true;
        loop.push({ r: currEdge.r1, c: currEdge.c1 });
        const nextKey = `${currEdge.r2},${currEdge.c2}`;
        const candidates = outgoingEdges.get(nextKey) || [];
        currEdge = candidates.find(e => !e.used) || null;
      }

      if (loop.length >= 4) {
        contours.push(loop);
      }
    }
  }

  return {
    deadCells: Array.from(regionSet),
    contours
  };
}
