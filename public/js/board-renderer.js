/**
 * Engine vẽ Trang Vở Ô Ly Việt Nam trên HTML5 Canvas
 * - Tái hiện chân thực trang giấy vở học sinh Việt Nam (lề đỏ đôi, dòng kẻ xanh đậm/nhạt 4 ô ly)
 * - Vẽ nét mực bút bi tự nhiên (hand-drawn ballpoint pen strokes) cho X, O, Δ, □
 * - Vẽ đường viền bút bi bo sát (Polygonal Contour) khoanh vùng các ván cờ cũ (Điểm chết)
 */

import { BOARD_ROWS, BOARD_COLS, SYMBOL_CONFIG, cellKey, parseCellKey } from './rules.js';

export class NotebookBoardRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rows = options.rows || BOARD_ROWS;
    this.cols = options.cols || BOARD_COLS;

    this.cellSize = 26;
    this.marginLeft = 44; // Lề đỏ bên trái trang vở
    this.marginTop = 54;  // Phần tiêu đề Thứ... ngày... tháng... năm...
    this.marginRight = 20;
    this.marginBottom = 22;

    this.hoverCell = null;
    this.pageData = null;
    this.activeBoard = this._createEmptyMatrix();
    this.deadSet = new Set();
    this.currentTurnSymbol = 'X';
    this.onCellClick = options.onCellClick || null;

    this._initEvents();
    this.resize();
  }

  _createEmptyMatrix() {
    return Array.from({ length: this.rows }, () => Array(this.cols).fill(null));
  }

  _initEvents() {
    this.canvas.addEventListener('mousemove', (e) => {
      const cell = this._getCellFromEvent(e);
      if (
        (!cell && this.hoverCell) ||
        (cell && (!this.hoverCell || cell.r !== this.hoverCell.r || cell.c !== this.hoverCell.c))
      ) {
        this.hoverCell = cell;
        this.render();
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (this.hoverCell) {
        this.hoverCell = null;
        this.render();
      }
    });

    this.canvas.addEventListener('click', (e) => {
      const cell = this._getCellFromEvent(e);
      if (cell && this.onCellClick) {
        this.onCellClick(cell.r, cell.c);
      }
    });
  }

  _getCellFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = (this.canvas.width / (window.devicePixelRatio || 1)) / rect.width;
    const scaleY = (this.canvas.height / (window.devicePixelRatio || 1)) / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const c = Math.floor((x - this.marginLeft) / this.cellSize);
    const r = Math.floor((y - this.marginTop) / this.cellSize);

    if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
      return { r, c };
    }
    return null;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const container = this.canvas.parentElement;
    const availW = container ? Math.max(360, container.clientWidth - 16) : 980;
    const availH = container ? Math.max(420, container.clientHeight - 16) : 720;

    // Tính kích thước ô ly vừa khít khung nhìn nhưng vẫn rõ nét
    const maxCellW = Math.floor((availW - this.marginLeft - this.marginRight) / this.cols);
    const maxCellH = Math.floor((availH - this.marginTop - this.marginBottom) / this.rows);
    this.cellSize = Math.max(20, Math.min(30, Math.min(maxCellW, maxCellH) || 25));

    const logicalW = this.marginLeft + this.cols * this.cellSize + this.marginRight;
    const logicalH = this.marginTop + this.rows * this.cellSize + this.marginBottom;

    this.canvas.width = logicalW * dpr;
    this.canvas.height = logicalH * dpr;
    this.canvas.style.width = `${logicalW}px`;
    this.canvas.style.height = `${logicalH}px`;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.logicalWidth = logicalW;
    this.logicalHeight = logicalH;

    this.render();
  }

  setState({ pageData, activeBoard, deadSet, currentTurnSymbol }) {
    if (pageData !== undefined) this.pageData = pageData;
    if (activeBoard !== undefined) this.activeBoard = activeBoard;
    if (deadSet !== undefined) this.deadSet = deadSet;
    if (currentTurnSymbol !== undefined) this.currentTurnSymbol = currentTurnSymbol;
    this.render();
  }

  /**
   * Hàm sinh số giả ngẫu nhiên cố định theo tọa độ để nét vẽ tay tự nhiên nhưng không bị rung khi vẽ lại
   */
  _seededJitter(seedA, seedB, amplitude = 1.2) {
    const s = Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453;
    return ((s - Math.floor(s)) * 2 - 1) * amplitude;
  }

  render() {
    const ctx = this.ctx;
    if (!ctx) return;

    const w = this.logicalWidth;
    const h = this.logicalHeight;

    // 1. Nền giấy vở ô ly trắng ngà ấm áp
    ctx.fillStyle = '#fcf9f2';
    ctx.fillRect(0, 0, w, h);

    // Hiệu ứng bóng gáy vở bên trái
    const spineGrad = ctx.createLinearGradient(0, 0, 18, 0);
    spineGrad.addColorStop(0, 'rgba(15, 23, 42, 0.12)');
    spineGrad.addColorStop(0.5, 'rgba(15, 23, 42, 0.03)');
    spineGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = spineGrad;
    ctx.fillRect(0, 0, 18, h);

    // 2. Vẽ phần đầu trang vở (Thứ ... ngày ... tháng ... năm ... & Số trang)
    this._drawNotebookHeader(ctx, w);

    // 3. Vẽ các vùng điểm chết (Dead Zones) của các ván cờ cũ trên trang này
    this._drawArchivedDeadZonesBackground(ctx);

    // 4. Vẽ hệ thống đường kẻ ô ly chuẩn vở học sinh Việt Nam
    this._drawNotebookGrid(ctx, w, h);

    // 5. Vẽ quân cờ và đường khoanh vùng (Polygonal Contour) của các ván cờ cũ
    this._drawArchivedGames(ctx);

    // 6. Vẽ các quân cờ của ván đang chơi hiện tại
    this._drawActiveGame(ctx);

    // 7. Vẽ hiệu ứng rê chuột (Hover preview hoặc báo vùng điểm chết)
    this._drawHoverEffect(ctx);
  }

  _drawNotebookHeader(ctx, w) {
    const gridRight = this.marginLeft + this.cols * this.cellSize;

    // Đường kẻ ngang đôi dưới phần tiêu đề trang vở
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, this.marginTop - 6);
    ctx.lineTo(w, this.marginTop - 6);
    ctx.stroke();

    // Dòng chữ nghiêng "Thứ ... ngày ... tháng ... năm ..."
    const dateStr = this.pageData?.dateHeader || 'Thứ Bảy, ngày 17 tháng 10 năm 2026';
    const pageNum = this.pageData?.pageNumber || 1;
    const archivedCount = this.pageData?.archivedGames?.length || 0;

    ctx.save();
    ctx.font = 'italic 600 14px "Segoe UI", "Times New Roman", serif';
    ctx.fillStyle = '#1e3a8a';
    ctx.fillText(dateStr, this.marginLeft + 10, 32);

    // Đường chấm chấm dưới dòng ngày tháng
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = '#93c5fd';
    ctx.beginPath();
    ctx.moveTo(this.marginLeft + 8, 37);
    ctx.lineTo(this.marginLeft + 310, 37);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghi chú số ván đã khoanh trên trang
    if (archivedCount > 0) {
      ctx.font = '600 12px "Segoe UI", sans-serif';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(`Đã khoanh ${archivedCount} ván cờ trên trang này`, this.marginLeft + 340, 32);
    }

    // Số trang góc phải trên
    ctx.font = 'bold 13px "Segoe UI", sans-serif';
    ctx.fillStyle = '#1e40af';
    ctx.textAlign = 'right';
    ctx.fillText(`Trang ${pageNum} / 200`, gridRight - 4, 32);
    ctx.restore();
  }

  _drawNotebookGrid(ctx, w, h) {
    const startX = this.marginLeft;
    const startY = this.marginTop;
    const endX = startX + this.cols * this.cellSize;
    const endY = startY + this.rows * this.cellSize;

    // Đường kẻ ô ly dọc
    for (let c = 0; c <= this.cols; c++) {
      const x = startX + c * this.cellSize;
      const isMajor = c % 4 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(59, 130, 246, 0.42)' : 'rgba(147, 197, 253, 0.38)';
      ctx.lineWidth = isMajor ? 1.05 : 0.65;
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      ctx.stroke();
    }

    // Đường kẻ ô ly ngang
    for (let r = 0; r <= this.rows; r++) {
      const y = startY + r * this.cellSize;
      const isMajor = r % 4 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(59, 130, 246, 0.44)' : 'rgba(147, 197, 253, 0.38)';
      ctx.lineWidth = isMajor ? 1.05 : 0.65;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      ctx.stroke();
    }

    // Đường lề đỏ đôi bên trái truyền thống của vở học sinh Việt Nam
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.68)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(this.marginLeft - 6, 0);
    ctx.lineTo(this.marginLeft - 6, h);
    ctx.moveTo(this.marginLeft - 9, 0);
    ctx.lineTo(this.marginLeft - 9, h);
    ctx.stroke();

    // Đánh số thứ tự dòng nhỏ bên lề trái để dễ nhìn tọa độ
    ctx.save();
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(100, 116, 139, 0.65)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < this.rows; r += 2) {
      const y = startY + (r + 0.5) * this.cellSize;
      ctx.fillText(String(r + 1), this.marginLeft - 14, y);
    }
    ctx.restore();
  }

  _drawArchivedDeadZonesBackground(ctx) {
    if (!this.pageData || !this.pageData.archivedGames?.length) return;

    ctx.save();
    for (const game of this.pageData.archivedGames) {
      if (!game.deadCells) continue;

      for (const key of game.deadCells) {
        const { r, c } = parseCellKey(key);
        const x = this.marginLeft + c * this.cellSize;
        const y = this.marginTop + r * this.cellSize;

        // Nền vùng đã khoanh (hơi ngả màu chì/mực nhạt để phân biệt điểm chết)
        ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
        ctx.fillRect(x, y, this.cellSize, this.cellSize);

        // Đường gạch chéo mảnh bằng bút chì báo hiệu ô điểm chết
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.18)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x + 3, y + this.cellSize - 3);
        ctx.lineTo(x + this.cellSize - 3, y + 3);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawArchivedGames(ctx) {
    if (!this.pageData || !this.pageData.archivedGames?.length) return;

    this.pageData.archivedGames.forEach((game, idx) => {
      // 1. Vẽ các quân cờ của ván cũ (độ đậm 0.58 để nhìn rõ lịch sử nhưng nhường sự nổi bật cho ván mới)
      ctx.save();
      ctx.globalAlpha = 0.58;
      for (const m of game.moves || []) {
        this._drawSymbolInCell(ctx, m.r, m.c, m.symbol, false);
      }

      // 2. Vẽ đường gạch 5 quân thắng của ván cũ (nếu có)
      if (game.winLine && game.winLine.length >= 2) {
        this._drawWinStrikeLine(ctx, game.winLine, game.winnerSymbol);
      }
      ctx.restore();

      // 3. Vẽ đường viền bút bi bo sát (Polygonal Contour) bao quanh thế cờ ván cũ
      const fenceColor = game.winnerSymbol && SYMBOL_CONFIG[game.winnerSymbol]
        ? SYMBOL_CONFIG[game.winnerSymbol].borderColor
        : '#334155';

      if (game.contours && game.contours.length > 0) {
        for (const contour of game.contours) {
          this._drawHandDrawnContour(ctx, contour, fenceColor, idx + 1);
        }
      }

      // 4. Vẽ nhãn nhỏ ghi chú kết quả ván cờ ngay trên đường viền
      this._drawArchivedGameBadge(ctx, game, idx + 1, fenceColor);
    });
  }

  /**
   * Vẽ đường viền bút bi bo góc tự nhiên quanh đa giác điểm chết của ván cờ cũ
   */
  _drawHandDrawnContour(ctx, contour, strokeColor, seedIndex) {
    if (!contour || contour.length < 3) return;

    // Chuyển từ tọa độ đỉnh lưới (r, c) sang tọa độ pixel trên trang vở
    const pts = contour.map((pt, idx) => {
      const baseX = this.marginLeft + pt.c * this.cellSize;
      const baseY = this.marginTop + pt.r * this.cellSize;
      const jx = this._seededJitter(pt.r + seedIndex, pt.c + idx, 1.35);
      const jy = this._seededJitter(pt.c + seedIndex, pt.r + idx, 1.35);
      return { x: baseX + jx, y: baseY + jy };
    });

    ctx.save();
    // Vẽ 2 nét bút bi chồng nhẹ lên nhau giống học sinh tô viền khoanh vùng
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = pass === 0 ? 2.2 : 1.1;
      ctx.globalAlpha = pass === 0 ? 0.85 : 0.45;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      const n = pts.length;
      const firstMid = {
        x: (pts[n - 1].x + pts[0].x) / 2,
        y: (pts[n - 1].y + pts[0].y) / 2
      };
      ctx.moveTo(firstMid.x, firstMid.y);

      for (let i = 0; i < n; i++) {
        const curr = pts[i];
        const next = pts[(i + 1) % n];
        const midX = (curr.x + next.x) / 2 + (pass * 0.6);
        const midY = (curr.y + next.y) / 2 - (pass * 0.6);
        ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
      }

      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawArchivedGameBadge(ctx, game, gameNumber, badgeColor) {
    if (!game.moves || game.moves.length === 0) return;

    // Tìm ô trên cùng - bên trái nhất của ván cờ để gắn nhãn
    let topMove = game.moves[0];
    for (const m of game.moves) {
      if (m.r < topMove.r || (m.r === topMove.r && m.c < topMove.c)) {
        topMove = m;
      }
    }

    const x = this.marginLeft + topMove.c * this.cellSize + 2;
    const y = Math.max(this.marginTop + 10, this.marginTop + topMove.r * this.cellSize - 3);
    const resultLabel = game.winnerSymbol === 'DRAW'
      ? `Ván #${gameNumber}: Hòa`
      : `Ván #${gameNumber}: ${game.winnerSymbol || '?'} thắng`;

    ctx.save();
    ctx.font = 'bold 10px "Segoe UI", sans-serif';
    const textW = ctx.measureText(resultLabel).width;
    const padX = 5;
    const boxH = 15;

    ctx.fillStyle = '#fef9c3';
    ctx.strokeStyle = badgeColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y - boxH + 3, textW + padX * 2, boxH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = badgeColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(resultLabel, x + padX, y - boxH / 2 + 3.5);
    ctx.restore();
  }

  _drawActiveGame(ctx) {
    const activeGame = this.pageData?.activeGame;
    const moves = activeGame?.moves || [];
    const lastMove = moves.length > 0 ? moves[moves.length - 1] : null;

    // Vẽ từng nước đi trên bàn cờ hiện tại
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const sym = this.activeBoard[r][c];
        if (!sym) continue;
        const isLast = Boolean(lastMove && lastMove.r === r && lastMove.c === c);
        this._drawSymbolInCell(ctx, r, c, sym, isLast);
      }
    }

    // Nếu ván hiện tại vừa có đường thắng nhưng chưa đóng khung
    if (activeGame?.winLine && activeGame.winLine.length >= 2) {
      this._drawWinStrikeLine(ctx, activeGame.winLine, activeGame.winnerSymbol);
    }
  }

  /**
   * Vẽ ký hiệu X, O, Δ, □ bằng nét mực bút bi tự nhiên
   */
  _drawSymbolInCell(ctx, r, c, symbol, isLastMove = false) {
    const x = this.marginLeft + c * this.cellSize;
    const y = this.marginTop + r * this.cellSize;
    const s = this.cellSize;
    const cfg = SYMBOL_CONFIG[symbol] || SYMBOL_CONFIG.X;

    ctx.save();

    // Đánh dấu ô vừa mới đi bằng nền mực sáng nhẹ
    if (isLastMove) {
      ctx.fillStyle = cfg.lightColor;
      ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
    }

    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = Math.max(2.1, s * 0.095);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pad = s * 0.21;
    const j1 = this._seededJitter(r, c, 0.9);
    const j2 = this._seededJitter(c, r, 0.9);

    if (symbol === 'X') {
      // Nét chéo 1
      ctx.beginPath();
      ctx.moveTo(x + pad + j1, y + pad + j2);
      ctx.quadraticCurveTo(x + s * 0.5, y + s * 0.5 + j1 * 0.5, x + s - pad + j2, y + s - pad + j1);
      ctx.stroke();

      // Nét chéo 2
      ctx.beginPath();
      ctx.moveTo(x + s - pad + j1, y + pad - j2);
      ctx.quadraticCurveTo(x + s * 0.5, y + s * 0.5 - j2 * 0.5, x + pad - j2, y + s - pad + j1);
      ctx.stroke();
    } else if (symbol === 'O') {
      const cx = x + s / 2 + j1 * 0.4;
      const cy = y + s / 2 + j2 * 0.4;
      const rx = (s / 2 - pad) * (1 + j1 * 0.03);
      const ry = (s / 2 - pad) * (1 - j2 * 0.03);

      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(3, rx), Math.max(3, ry), j1 * 0.15, 0, Math.PI * 2 + 0.25);
      ctx.stroke();
    } else if (symbol === 'Δ') {
      ctx.beginPath();
      ctx.moveTo(x + s / 2 + j1, y + pad);
      ctx.lineTo(x + s - pad + j2, y + s - pad);
      ctx.lineTo(x + pad - j1, y + s - pad + j2 * 0.5);
      ctx.closePath();
      ctx.stroke();
    } else if (symbol === '□') {
      ctx.beginPath();
      ctx.rect(x + pad + j1 * 0.4, y + pad + j2 * 0.4, s - pad * 2, s - pad * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawWinStrikeLine(ctx, winLine, winnerSymbol) {
    const first = winLine[0];
    const last = winLine[winLine.length - 1];
    const x1 = this.marginLeft + (first.c + 0.5) * this.cellSize;
    const y1 = this.marginTop + (first.r + 0.5) * this.cellSize;
    const x2 = this.marginLeft + (last.c + 0.5) * this.cellSize;
    const y2 = this.marginTop + (last.r + 0.5) * this.cellSize;

    const cfg = SYMBOL_CONFIG[winnerSymbol] || SYMBOL_CONFIG.O;

    ctx.save();
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  _drawHoverEffect(ctx) {
    if (!this.hoverCell) return;
    const { r, c } = this.hoverCell;
    const x = this.marginLeft + c * this.cellSize;
    const y = this.marginTop + r * this.cellSize;
    const k = cellKey(r, c);

    ctx.save();
    if (this.deadSet.has(k)) {
      // Báo hiệu ô nằm trong vùng khoanh điểm chết của ván cờ cũ
      ctx.fillStyle = 'rgba(220, 38, 38, 0.22)';
      ctx.fillRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
    } else if (this.activeBoard[r][c] === null) {
      // Hiển thị bóng mờ của quân cờ sắp đánh
      ctx.globalAlpha = 0.35;
      this._drawSymbolInCell(ctx, r, c, this.currentTurnSymbol, false);
    }
    ctx.restore();
  }
}
