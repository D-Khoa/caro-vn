/**
 * Engine vẽ Trang Vở Ô Ly Học Trò 9x Việt Nam trên HTML5 Canvas
 * - Giấy vở ngả màu kem hoài cổ (#f9f4e6), gáy vở dập ghim sắt, mép giấy 200 trang xếp lớp
 * - Đường kẻ ô ly xanh tím Hồng Hà thập niên 90, lề đỏ đôi, ô "Điểm / Lời phê" góc đầu trang
 * - Nét mực bút bi Thiên Long xanh / đỏ / tím / xanh lá vẽ tay nhiều lớp chân thực
 * - Đường khoanh vùng Điểm Chết (Polygonal Contour) bằng nét bút bi lượn tự nhiên
 */

import { BOARD_ROWS, BOARD_COLS, SYMBOL_CONFIG, cellKey, parseCellKey } from './rules.js';

export class NotebookBoardRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rows = options.rows || BOARD_ROWS;
    this.cols = options.cols || BOARD_COLS;

    this.cellSize = 26;
    this.zoomMultiplier = 1.0;
    this.marginLeft = 48;
    this.marginTop = 58;
    this.marginRight = 22;
    this.marginBottom = 22;

    this.hoverCell = null;
    this.pageData = null;
    this.ownerTitle = '';
    this.activeBoard = this._createEmptyMatrix();
    this.deadSet = new Set();
    this.currentTurnSymbol = 'X';
    this.showCoordinates = true;
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

  setZoom(multiplier) {
    this.zoomMultiplier = Math.max(0.75, Math.min(1.8, Number(multiplier) || 1.0));
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const container = this.canvas.parentElement;
    const availW = container ? Math.max(300, container.clientWidth - 16) : window.innerWidth - 24;
    const availH = container ? Math.max(300, container.clientHeight - 16) : window.innerHeight - 140;

    const isMobile = window.innerWidth < 768;
    this.marginLeft = isMobile ? 38 : 50;
    this.marginTop = isMobile ? 48 : 54;
    this.marginRight = isMobile ? 12 : 18;
    this.marginBottom = isMobile ? 14 : 18;

    const fitCellW = Math.floor((availW - this.marginLeft - this.marginRight) / this.cols);
    const fitCellH = Math.floor((availH - this.marginTop - this.marginBottom) / this.rows);

    const baseCell = isMobile
      ? Math.max(22, Math.min(30, Math.max(fitCellW, 22)))
      : Math.max(19, Math.min(32, Math.min(fitCellW, fitCellH) || 24));

    this.cellSize = Math.floor(baseCell * this.zoomMultiplier);

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

  setState({ pageData, activeBoard, deadSet, currentTurnSymbol, ownerTitle, showCoordinates }) {
    if (pageData !== undefined) this.pageData = pageData;
    if (activeBoard !== undefined) this.activeBoard = activeBoard;
    if (deadSet !== undefined) this.deadSet = deadSet;
    if (currentTurnSymbol !== undefined) this.currentTurnSymbol = currentTurnSymbol;
    if (ownerTitle !== undefined) this.ownerTitle = ownerTitle;
    if (showCoordinates !== undefined) this.showCoordinates = showCoordinates;
    this.render();
  }

  _seededJitter(seedA, seedB, amplitude = 1.2) {
    const s = Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453;
    return ((s - Math.floor(s)) * 2 - 1) * amplitude;
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.logicalWidth) return;

    const w = this.logicalWidth;
    const h = this.logicalHeight;

    // 1. Nền giấy vở 9x ngả kem vàng ấm áp
    const paperGrad = ctx.createLinearGradient(0, 0, w, h);
    paperGrad.addColorStop(0, '#faf5e6');
    paperGrad.addColorStop(0.5, '#f7f0dc');
    paperGrad.addColorStop(1, '#f3ead2');
    ctx.fillStyle = paperGrad;
    ctx.fillRect(0, 0, w, h);

    // Gáy vở bên trái (dải băng keo vải xanh đen + 2 ghim sắt đóng vở)
    ctx.fillStyle = '#133b4d';
    ctx.fillRect(0, 0, 7, h);

    const spineGrad = ctx.createLinearGradient(7, 0, 22, 0);
    spineGrad.addColorStop(0, 'rgba(62, 39, 35, 0.2)');
    spineGrad.addColorStop(1, 'rgba(62, 39, 35, 0)');
    ctx.fillStyle = spineGrad;
    ctx.fillRect(7, 0, 15, h);

    // 2 chiếc ghim sắt nằm đúng trên gáy vở
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(3.5, h * 0.25);
    ctx.lineTo(3.5, h * 0.30);
    ctx.moveTo(3.5, h * 0.70);
    ctx.lineTo(3.5, h * 0.75);
    ctx.stroke();

    // 2. Vẽ phần đầu trang vở 9x (Ô Điểm 10 đỏ + Thứ ngày tháng + Số trang)
    this._drawNotebookHeader9x(ctx, w);

    // 3. Vẽ nền vùng điểm chết của các ván cũ (gạch chì chéo học trò)
    this._drawArchivedDeadZonesBackground(ctx);

    // 4. Vẽ hệ thống đường kẻ ô ly chuẩn vở Hồng Hà 9x
    this._drawNotebookGrid9x(ctx, w, h);

    // 5. Vẽ các ván cờ cũ & đường khoanh vùng bút bi
    this._drawArchivedGames(ctx);

    // 6. Vẽ ván đang chơi hiện tại
    this._drawActiveGame(ctx);

    // 7. Vẽ hiệu ứng hover
    this._drawHoverEffect(ctx);
  }

  _drawNotebookHeader9x(ctx, w) {
    const gridRight = this.marginLeft + this.cols * this.cellSize;

    // Đường kẻ ngang đôi đậm dưới phần tiêu đề đầu trang
    ctx.strokeStyle = 'rgba(59, 108, 180, 0.65)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(7, this.marginTop - 7);
    ctx.lineTo(w, this.marginTop - 7);
    ctx.moveTo(7, this.marginTop - 4);
    ctx.lineTo(w, this.marginTop - 4);
    ctx.stroke();

    const dateStr = this.pageData?.dateHeader || 'Thứ Bảy, ngày 17 tháng 10 năm 2026';
    const pageNum = this.pageData?.pageNumber || 1;
    const archivedCount = this.pageData?.archivedGames?.length || 0;

    ctx.save();

    // Con dấu điểm 10 đỏ nhỏ gọn giữa gáy vở và lề đỏ
    if (archivedCount > 0) {
      ctx.save();
      ctx.translate(23, 25);
      ctx.rotate(-0.16);
      ctx.strokeStyle = 'rgba(200, 30, 30, 0.85)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(0, 0, 11.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = 'bold 11px "Patrick Hand", cursive, sans-serif';
      ctx.fillStyle = 'rgba(200, 30, 30, 0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('10đ', 0, 0);
      ctx.restore();
    }

    // Chữ viết tay mực tím/xanh dòng Thứ... ngày... tháng...
    ctx.font = '700 15.5px "Patrick Hand", "Mali", cursive, sans-serif';
    ctx.fillStyle = '#2e1065';
    ctx.fillText(dateStr, this.marginLeft + 10, 29);

    // Đường kẻ chấm dưới dòng ngày tháng
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(59, 108, 180, 0.5)';
    ctx.beginPath();
    ctx.moveTo(this.marginLeft + 8, 34);
    ctx.lineTo(Math.min(gridRight - 150, this.marginLeft + 275), 34);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghi chú bút đỏ của học trò khi đã khoanh ván cũ
    if (archivedCount > 0 && w > 640) {
      ctx.font = '700 13.5px "Patrick Hand", "Mali", cursive, sans-serif';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(`(Đã khoanh ${archivedCount} ván - ${this.deadSet.size} ô chết)`, this.marginLeft + 290, 29);
    }

    // Góc phải: Tên chủ vở & Số trang
    ctx.font = '700 14.5px "Patrick Hand", "Mali", cursive, sans-serif';
    ctx.fillStyle = '#1e3a8a';
    ctx.textAlign = 'right';
    const rightHeader = this.ownerTitle
      ? `${this.ownerTitle} | Trang ${pageNum}/200`
      : `Trang ${pageNum} / 200`;
    ctx.fillText(rightHeader, gridRight - 4, 29);
    ctx.restore();
  }

  _drawNotebookGrid9x(ctx, w, h) {
    const startX = this.marginLeft;
    const startY = this.marginTop;
    const endX = startX + this.cols * this.cellSize;
    const endY = startY + this.rows * this.cellSize;

    // Đường kẻ dọc vở ô ly 9x (cứ 4 ô ly nhỏ là 1 đường kẻ đậm)
    for (let c = 0; c <= this.cols; c++) {
      const x = startX + c * this.cellSize;
      const isMajor = c % 4 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(49, 98, 168, 0.52)' : 'rgba(92, 142, 209, 0.32)';
      ctx.lineWidth = isMajor ? 1.05 : 0.65;
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      ctx.stroke();
    }

    // Đường kẻ ngang vở ô ly 9x
    for (let r = 0; r <= this.rows; r++) {
      const y = startY + r * this.cellSize;
      const isMajor = r % 4 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(49, 98, 168, 0.55)' : 'rgba(92, 142, 209, 0.32)';
      ctx.lineWidth = isMajor ? 1.05 : 0.65;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      ctx.stroke();
    }

    // Đường lề đỏ đôi truyền thống bên trái trang vở
    ctx.strokeStyle = 'rgba(210, 45, 45, 0.72)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(this.marginLeft - 6, 0);
    ctx.lineTo(this.marginLeft - 6, h);
    ctx.moveTo(this.marginLeft - 9.5, 0);
    ctx.lineTo(this.marginLeft - 9.5, h);
    ctx.stroke();

    if (this.showCoordinates) {
      ctx.save();
      ctx.font = '700 11px "Patrick Hand", cursive, sans-serif';
      ctx.fillStyle = 'rgba(91, 33, 182, 0.55)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < this.rows; r += 2) {
        const y = startY + (r + 0.5) * this.cellSize;
        ctx.fillText(String(r + 1), this.marginLeft - 14, y);
      }
      ctx.restore();
    }
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
        const pad = 2.2;

        // Nền vùng đã khoanh thu gọn bên trong ô (không lem ra vạch kẻ ô ly xung quanh)
        ctx.fillStyle = 'rgba(120, 113, 108, 0.16)';
        ctx.fillRect(x + pad, y + pad, this.cellSize - pad * 2, this.cellSize - pad * 2);

        // Nét gạch chì chéo kiểu học sinh gạch bỏ ô cờ cũ
        ctx.strokeStyle = 'rgba(87, 83, 78, 0.25)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x + 4, y + this.cellSize - 4);
        ctx.lineTo(x + this.cellSize - 4, y + 4);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawArchivedGames(ctx) {
    if (!this.pageData || !this.pageData.archivedGames?.length) return;

    this.pageData.archivedGames.forEach((game, idx) => {
      ctx.save();
      ctx.globalAlpha = 0.42;
      for (const m of game.moves || []) {
        this._drawSymbolInCell(ctx, m.r, m.c, m.symbol, false, true);
      }

      if (game.winLine && game.winLine.length >= 2) {
        this._drawWinStrikeLine(ctx, game.winLine, game.winnerSymbol);
      }
      ctx.restore();

      const fenceColor = game.winnerSymbol && SYMBOL_CONFIG[game.winnerSymbol]
        ? SYMBOL_CONFIG[game.winnerSymbol].borderColor
        : '#3b0764';

      if (game.contours && game.contours.length > 0) {
        for (const contour of game.contours) {
          this._drawHandDrawnContour(ctx, contour, fenceColor, idx + 1);
        }
      }

      this._drawArchivedGameBadge(ctx, game, idx + 1, fenceColor);
    });
  }

  _drawHandDrawnContour(ctx, contour, strokeColor, seedIndex) {
    if (!contour || contour.length < 3) return;

    const pts = contour.map((pt, idx) => {
      const baseX = this.marginLeft + pt.c * this.cellSize;
      const baseY = this.marginTop + pt.r * this.cellSize;
      const jx = this._seededJitter(pt.r + seedIndex, pt.c + idx, 0.45);
      const jy = this._seededJitter(pt.c + seedIndex, pt.r + idx, 0.45);
      return { x: baseX + jx, y: baseY + jy };
    });

    ctx.save();
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = pass === 0 ? 2.1 : 1.0;
      ctx.globalAlpha = pass === 0 ? 0.88 : 0.45;
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
        const midX = (curr.x + next.x) / 2 + (pass * 0.4);
        const midY = (curr.y + next.y) / 2 - (pass * 0.4);
        ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
      }

      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawArchivedGameBadge(ctx, game, gameNumber, badgeColor) {
    if (!game.moves || game.moves.length === 0) return;

    let topMove = game.moves[0];
    for (const m of game.moves) {
      if (m.r < topMove.r || (m.r === topMove.r && m.c < topMove.c)) {
        topMove = m;
      }
    }

    // Đặt nhãn nhỏ gọn nằm BÊN TRONG ô đầu tiên của vùng khoanh (tuyệt đối không tràn sang ô trống bên ngoài)
    const x = this.marginLeft + topMove.c * this.cellSize + 2;
    const y = this.marginTop + topMove.r * this.cellSize + 2;
    const resultLabel = game.winnerSymbol === 'DRAW'
      ? `#${gameNumber}:Hòa`
      : `#${gameNumber}:${game.winnerSymbol || '?'}`;

    ctx.save();
    ctx.font = 'bold 10px "Patrick Hand", cursive, sans-serif';
    const textW = ctx.measureText(resultLabel).width;
    const padX = 3.5;
    const boxH = 12;

    ctx.fillStyle = 'rgba(254, 240, 138, 0.94)';
    ctx.strokeStyle = badgeColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, textW + padX * 2, boxH, 2.5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = badgeColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(resultLabel, x + padX, y + boxH / 2 + 0.5);
    ctx.restore();
  }

  _drawActiveGame(ctx) {
    const activeGame = this.pageData?.activeGame;
    const moves = activeGame?.moves || [];
    const lastMove = moves.length > 0 ? moves[moves.length - 1] : null;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const sym = this.activeBoard[r][c];
        if (!sym) continue;
        const isLast = Boolean(lastMove && lastMove.r === r && lastMove.c === c);
        this._drawSymbolInCell(ctx, r, c, sym, isLast, false);
      }
    }

    if (activeGame?.winLine && activeGame.winLine.length >= 2) {
      this._drawWinStrikeLine(ctx, activeGame.winLine, activeGame.winnerSymbol);
    }
  }

  _drawSymbolInCell(ctx, r, c, symbol, isLastMove = false, isArchived = false) {
    const x = this.marginLeft + c * this.cellSize;
    const y = this.marginTop + r * this.cellSize;
    const s = this.cellSize;
    const cfg = SYMBOL_CONFIG[symbol] || SYMBOL_CONFIG.X;

    ctx.save();

    if (!isArchived) {
      ctx.fillStyle = isLastMove ? 'rgba(250, 204, 21, 0.32)' : 'rgba(255, 253, 245, 0.65)';
      ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
    }

    if (isLastMove) {
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = isArchived ? Math.max(1.8, s * 0.08) : Math.max(2.4, s * 0.105);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pad = isArchived ? s * 0.25 : s * 0.19;
    const j1 = this._seededJitter(r, c, 0.75);
    const j2 = this._seededJitter(c, r, 0.75);

    if (symbol === 'X') {
      ctx.beginPath();
      ctx.moveTo(x + pad + j1, y + pad + j2);
      ctx.quadraticCurveTo(x + s * 0.5, y + s * 0.5 + j1 * 0.5, x + s - pad + j2, y + s - pad + j1);
      ctx.stroke();

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
      ctx.ellipse(cx, cy, Math.max(3, rx), Math.max(3, ry), j1 * 0.15, 0, Math.PI * 2 + 0.3);
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
    ctx.lineWidth = 3.5;
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
      ctx.fillStyle = 'rgba(200, 30, 30, 0.24)';
      ctx.fillRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
      ctx.strokeStyle = '#c81e1e';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
    } else if (this.activeBoard[r][c] === null) {
      ctx.globalAlpha = 0.38;
      this._drawSymbolInCell(ctx, r, c, this.currentTurnSymbol, false);
    }
    ctx.restore();
  }
}
