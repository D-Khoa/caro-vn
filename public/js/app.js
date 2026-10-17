/**
 * Main Application Controller - Cờ Caro Vở Ô Ly Việt Nam
 * Kết nối:
 * - Giao diện Trang Vở Ô Ly 200 Trang (NotebookBoardRenderer + NotebookStore)
 * - Chế độ PvE (10 cấp độ khó từ Tập Sự đến Cờ Thánh qua Web Worker)
 * - Chế độ PvP Local (2-4 người chung màn hình)
 * - Chế độ PvP Co-op Online (1v1, Chia Phe Đội X/O, Hỗn Chiến 2-4 người qua WebSocket)
 */

import {
  BOARD_ROWS,
  BOARD_COLS,
  TOTAL_NOTEBOOK_PAGES,
  SYMBOLS,
  SYMBOL_CONFIG,
  AI_LEVELS,
  cellKey,
  checkWinAt,
  countPlayableCells,
  computeGameFenceAndDeadZone
} from './rules.js';
import { NotebookStore } from './notebook-store.js';
import { NotebookBoardRenderer } from './board-renderer.js';
import { SoundEffectManager } from './sound.js';
import { MultiplayerClient } from './multiplayer.js';
import { computeBestAIMove } from './ai-engine.js';

class CaroNotebookApp {
  constructor() {
    this.store = new NotebookStore();
    this.sound = new SoundEffectManager();
    this.profile = null;

    // Trạng thái trang vở hiện tại (1 -> 200)
    this.currentPageNumber = 1;
    this.currentPageData = null;
    this.deadSet = new Set();
    this.activeBoard = this._createEmptyBoard();

    // Cấu hình chế độ chơi
    this.mode = 'pve'; // 'pve' | 'pvp-local' | 'pvp-online'
    this.blockTwoEnds = true; // Luật chặn 2 đầu truyền thống VN

    // Cấu hình PvE
    this.aiLevel = 5; // Mặc định Cấp 5: Cờ Thủ Xóm
    this.humanSymbol = 'X';
    this.aiSymbol = 'O';
    this.aiThinking = false;
    this.aiWorker = null;
    this.aiRequestSeq = 0;

    // Cấu hình PvP Local
    this.localPlayerCount = 2; // 2, 3, hoặc 4 người

    // Cấu hình PvP Co-op Online
    this.onlineSubMode = '1v1'; // '1v1' | 'team' | 'ffa'
    this.mp = null;

    // Trạng thái ván cờ đang diễn ra trên trang hiện tại
    this.turnIndex = 0;
    this.gameEndedBanner = null;
  }

  _createEmptyBoard() {
    return Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
  }

  async init() {
    await this.store.init();
    this.profile = this.store.getPlayerProfile();
    this.currentPageNumber = this.profile.currentPage || 1;

    this._initAIWorker();
    this._initCanvas();
    this._initMultiplayer();
    this._bindUIEvents();
    this._renderAILevelSelect();
    this._updateProfileUI();

    await this.loadPage(this.currentPageNumber);

    window.addEventListener('resize', () => {
      if (this.renderer) this.renderer.resize();
    });
  }

  _initAIWorker() {
    try {
      this.aiWorker = new Worker('./js/ai-worker.js', { type: 'module' });
      this.aiWorker.onmessage = (e) => {
        const { requestId, move } = e.data;
        if (requestId !== this.aiRequestSeq) return;
        this.aiThinking = false;
        this._updateStatusUI();
        if (move && this.mode === 'pve') {
          this._applyLocalOrPvEMove(move.r, move.c, this.aiSymbol, this._getAILevelTitle(this.aiLevel));
        }
      };
      this.aiWorker.onerror = () => {
        this.aiWorker = null;
      };
    } catch (_) {
      this.aiWorker = null;
    }
  }

  _initCanvas() {
    const canvas = document.getElementById('notebook-canvas');
    this.renderer = new NotebookBoardRenderer(canvas, {
      rows: BOARD_ROWS,
      cols: BOARD_COLS,
      onCellClick: (r, c) => this.handleBoardClick(r, c)
    });
  }

  _initMultiplayer() {
    this.mp = new MultiplayerClient({
      onConnectionChange: (connected) => {
        const badge = document.getElementById('online-conn-badge');
        if (badge) {
          badge.textContent = connected ? 'Đã kết nối máy chủ' : 'Mất kết nối';
          badge.className = `conn-badge ${connected ? 'connected' : 'disconnected'}`;
        }
      },
      onLatencyUpdate: (ms, stats) => {
        const pingEl = document.getElementById('ping-value');
        if (pingEl) {
          pingEl.textContent = `${ms} ms`;
          pingEl.className = ms < 150 ? 'ping-good' : ms < 500 ? 'ping-warn' : 'ping-bad';
        }
        if (stats) this._updateServerStatsUI(stats);
      },
      onServerStats: (stats) => {
        if (stats) this._updateServerStatsUI(stats);
      },
      onRoomList: (rooms, stats) => {
        if (stats) this._updateServerStatsUI(stats);
        this._renderPublicRoomList(rooms);
      },
      onRoomState: (room) => {
        this._syncFromOnlineRoom(room);
      },
      onMoveMade: (move, room) => {
        this.sound.playPenStroke(move.symbol);
        this._syncFromOnlineRoom(room);
      },
      onGameOver: (result, room) => {
        this.sound.playFenceDraw();
        this._syncFromOnlineRoom(room, result);
      },
      onChat: (chatMsg) => {
        this._appendChatMessage(chatMsg);
      },
      onError: (errMsg) => {
        this._showToast(errMsg, 'error');
      }
    });
  }

  _updateServerStatsUI(stats) {
    const ccuEl = document.getElementById('server-ccu-count');
    if (ccuEl && stats.onlineCount !== undefined) {
      ccuEl.textContent = `${stats.onlineCount.toLocaleString('vi-VN')} / 10,000`;
    }
    const roomsEl = document.getElementById('server-room-count');
    if (roomsEl && stats.roomCount !== undefined) {
      roomsEl.textContent = stats.roomCount;
    }
  }

  async loadPage(pageNumber) {
    const target = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(pageNumber) || 1));
    this.currentPageNumber = target;
    this.profile.currentPage = target;
    this.store.savePlayerProfile(this.profile);

    this.currentPageData = await this.store.getPage(target);
    this.aiRequestSeq++;
    this.aiThinking = false;
    this.gameEndedBanner = null;
    this._hideEndBanner();

    this._rebuildBoardStateFromPage();
    this._updateNotebookNavigationUI();
    this._updateStatusUI();
    this._renderArchivedListOnPage();
  }

  _rebuildBoardStateFromPage() {
    this.deadSet = new Set();
    for (const archived of this.currentPageData.archivedGames || []) {
      for (const k of archived.deadCells || []) {
        this.deadSet.add(k);
      }
    }

    this.activeBoard = this._createEmptyBoard();
    if (!this.currentPageData.activeGame) {
      this.currentPageData.activeGame = this._createNewActiveGameObj();
    }

    const moves = this.currentPageData.activeGame.moves || [];
    for (const m of moves) {
      if (!this.deadSet.has(cellKey(m.r, m.c))) {
        this.activeBoard[m.r][m.c] = m.symbol;
      }
    }

    const activeSymbols = this._getActiveSymbolsForCurrentMode();
    this.turnIndex = moves.length % activeSymbols.length;

    this.renderer.setState({
      pageData: this.currentPageData,
      activeBoard: this.activeBoard,
      deadSet: this.deadSet,
      currentTurnSymbol: this.getCurrentTurnSymbol()
    });
  }

  _createNewActiveGameObj() {
    return {
      id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      mode: this.mode,
      blockTwoEnds: this.blockTwoEnds,
      moves: [],
      startedAt: Date.now()
    };
  }

  _getActiveSymbolsForCurrentMode() {
    if (this.mode === 'pve') {
      return ['X', 'O'];
    }
    if (this.mode === 'pvp-local') {
      return SYMBOLS.slice(0, this.localPlayerCount);
    }
    if (this.mode === 'pvp-online' && this.mp?.roomState) {
      return this.mp.roomState.activeSymbols || ['X', 'O'];
    }
    return ['X', 'O'];
  }

  getCurrentTurnSymbol() {
    if (this.mode === 'pvp-online' && this.mp?.roomState) {
      return this.mp.roomState.currentTurnSymbol || 'X';
    }
    const symbols = this._getActiveSymbolsForCurrentMode();
    return symbols[this.turnIndex % symbols.length];
  }

  /**
   * Xử lý khi người chơi click vào ô (r, c) trên trang vở ô ly
   */
  async handleBoardClick(r, c) {
    const key = cellKey(r, c);

    // 1. Kiểm tra ô có nằm trong vùng khoanh "Điểm chết" của các ván cờ cũ không
    if (this.deadSet.has(key)) {
      this._showToast('Ô này nằm trong vùng khoanh của ván cờ cũ (Điểm chết), không thể đánh đè lên!', 'warn');
      return;
    }

    // 2. Kiểm tra ô đã có quân trong ván hiện tại chưa
    if (this.activeBoard[r][c] !== null) {
      return;
    }

    // 3. Nếu đang ở chế độ PvP Co-op Online
    if (this.mode === 'pvp-online') {
      if (!this.mp.roomState) {
        this._showToast('Hãy Tạo Phòng hoặc Ghép Trận Nhanh ở bảng bên phải để bắt đầu!', 'warn');
        return;
      }
      this.mp.sendMove(r, c);
      return;
    }

    // 4. Nếu đang ở chế độ PvE
    if (this.mode === 'pve') {
      if (this.aiThinking) return;
      const currentSym = this.getCurrentTurnSymbol();
      if (currentSym !== this.humanSymbol) return;

      const gameEnded = await this._applyLocalOrPvEMove(r, c, this.humanSymbol, this.profile.name);
      if (!gameEnded) {
        this._triggerAIMove();
      }
      return;
    }

    // 5. Nếu đang ở chế độ PvP Local (Chung màn hình)
    if (this.mode === 'pvp-local') {
      const sym = this.getCurrentTurnSymbol();
      await this._applyLocalOrPvEMove(r, c, sym, `Người chơi ${sym}`);
    }
  }

  async _applyLocalOrPvEMove(r, c, symbol, playerName) {
    if (this.deadSet.has(cellKey(r, c)) || this.activeBoard[r][c] !== null) {
      return false;
    }

    this._hideEndBanner();
    this.activeBoard[r][c] = symbol;
    this.sound.playPenStroke(symbol);

    if (!this.currentPageData.activeGame) {
      this.currentPageData.activeGame = this._createNewActiveGameObj();
    }

    const moves = this.currentPageData.activeGame.moves;
    moves.push({
      r,
      c,
      symbol,
      playerName,
      moveNumber: moves.length + 1
    });

    const symbols = this._getActiveSymbolsForCurrentMode();
    this.turnIndex = moves.length % symbols.length;

    // Kiểm tra chiến thắng
    const winCheck = checkWinAt(this.activeBoard, r, c, {
      blockTwoEnds: this.blockTwoEnds,
      deadSet: this.deadSet,
      rows: BOARD_ROWS,
      cols: BOARD_COLS
    });

    if (winCheck.won) {
      await this._finalizeAndFenceCurrentGame({
        winnerSymbol: symbol,
        winnerName: playerName,
        winLine: winCheck.line
      });
      return true;
    }

    // Kiểm tra Hòa (Hết ô trống ngoài vùng điểm chết)
    const remainingCells = countPlayableCells(this.activeBoard, this.deadSet, BOARD_ROWS, BOARD_COLS);
    if (remainingCells === 0) {
      await this._finalizeAndFenceCurrentGame({
        winnerSymbol: 'DRAW',
        winnerName: 'Hòa cờ (Kín trang vở)',
        winLine: null
      });
      return true;
    }

    await this.store.savePage(this.currentPageData);
    this.renderer.setState({
      pageData: this.currentPageData,
      activeBoard: this.activeBoard,
      deadSet: this.deadSet,
      currentTurnSymbol: this.getCurrentTurnSymbol()
    });
    this._updateStatusUI();
    this._updateNotebookNavigationUI();
    return false;
  }

  /**
   * Khoanh vùng thế cờ vừa kết thúc bằng đường viền bút bi bo sát (Polygonal Contour)
   * và biến toàn bộ vùng đó thành Điểm Chết trên trang vở hiện tại.
   */
  async _finalizeAndFenceCurrentGame({ winnerSymbol, winnerName, winLine }) {
    const activeGame = this.currentPageData.activeGame;
    if (!activeGame || !activeGame.moves || activeGame.moves.length === 0) return;

    const { deadCells, contours } = computeGameFenceAndDeadZone(
      activeGame.moves,
      this.deadSet,
      BOARD_ROWS,
      BOARD_COLS
    );

    const gameNumber = (this.currentPageData.archivedGames?.length || 0) + 1;
    const modeLabel = this.mode === 'pve'
      ? `PvE (${this._getAILevelTitle(this.aiLevel)})`
      : this.mode === 'pvp-local'
        ? `PvP Chung màn hình (${this.localPlayerCount} người)`
        : `PvP Co-op Online`;

    const archivedRecord = {
      id: activeGame.id || `archived_${Date.now()}`,
      gameIndexOnPage: gameNumber,
      mode: this.mode,
      modeLabel,
      blockTwoEnds: this.blockTwoEnds,
      winnerSymbol,
      winnerName,
      winLine: winLine || null,
      moves: activeGame.moves,
      deadCells,
      contours,
      finishedAt: Date.now()
    };

    this.currentPageData.archivedGames.push(archivedRecord);
    this.currentPageData.activeGame = this._createNewActiveGameObj();

    // Cập nhật thống kê học sinh
    if (this.mode === 'pve') {
      if (winnerSymbol === this.humanSymbol) {
        this.profile.stats.wins = (this.profile.stats.wins || 0) + 1;
        if (this.aiLevel > (this.profile.stats.highestAiBeaten || 0)) {
          this.profile.stats.highestAiBeaten = this.aiLevel;
        }
      } else if (winnerSymbol === this.aiSymbol) {
        this.profile.stats.losses = (this.profile.stats.losses || 0) + 1;
      } else {
        this.profile.stats.draws = (this.profile.stats.draws || 0) + 1;
      }
      this.store.savePlayerProfile(this.profile);
      this._updateProfileUI();
    }

    await this.store.savePage(this.currentPageData);
    this.sound.playFenceDraw();

    this._rebuildBoardStateFromPage();
    this._updateNotebookNavigationUI();
    this._updateStatusUI();
    this._renderArchivedListOnPage();

    const bannerTitle = winnerSymbol === 'DRAW'
      ? `Ván #${gameNumber} Hòa Cờ!`
      : `Ván #${gameNumber}: ${winnerName} (${winnerSymbol}) Chiến Thắng!`;

    this._showEndBanner(
      bannerTitle,
      `Thế cờ vừa được khoanh viền bút bi (${deadCells.length} ô đã thành điểm chết). Bạn có thể đánh tiếp ván mới ngay trên phần trống của Trang ${this.currentPageNumber}!`
    );
  }

  _triggerAIMove() {
    if (this.mode !== 'pve') return;
    const currentSym = this.getCurrentTurnSymbol();
    if (currentSym !== this.aiSymbol) return;

    this.aiThinking = true;
    this._updateStatusUI();
    const reqId = ++this.aiRequestSeq;
    const deadCellsArr = Array.from(this.deadSet);

    if (this.aiWorker) {
      this.aiWorker.postMessage({
        requestId: reqId,
        activeBoard: this.activeBoard,
        deadCells: deadCellsArr,
        level: this.aiLevel,
        aiSymbol: this.aiSymbol,
        humanSymbol: this.humanSymbol,
        blockTwoEnds: this.blockTwoEnds
      });
    } else {
      setTimeout(() => {
        if (reqId !== this.aiRequestSeq) return;
        const move = computeBestAIMove(
          this.activeBoard,
          deadCellsArr,
          this.aiLevel,
          this.aiSymbol,
          this.humanSymbol,
          this.blockTwoEnds
        );
        this.aiThinking = false;
        this._updateStatusUI();
        if (move) {
          this._applyLocalOrPvEMove(move.r, move.c, this.aiSymbol, this._getAILevelTitle(this.aiLevel));
        }
      }, 120);
    }
  }

  /**
   * Đồng bộ trạng thái trang vở từ Phòng Chơi Online
   */
  async _syncFromOnlineRoom(room, gameOverResult = null) {
    if (!room) return;

    this.blockTwoEnds = room.blockTwoEnds;
    const blockCheckbox = document.getElementById('toggle-block-two-ends');
    if (blockCheckbox) blockCheckbox.checked = this.blockTwoEnds;

    // Đồng bộ danh sách các ván đã khoanh vùng (Điểm chết) trên trang của phòng
    this.currentPageData.archivedGames = room.archivedGames || [];
    this.currentPageData.activeGame = {
      id: room.activeGameId || 'online_game',
      mode: 'pvp-online',
      blockTwoEnds: room.blockTwoEnds,
      moves: room.moves || [],
      winLine: room.winLine || null,
      winnerSymbol: room.winnerSymbol || null
    };

    await this.store.savePage(this.currentPageData);
    this._rebuildBoardStateFromPage();
    this._renderOnlineRoomPanel(room);
    this._renderArchivedListOnPage();
    this._updateNotebookNavigationUI();
    this._updateStatusUI();

    if (gameOverResult) {
      const title = gameOverResult.winnerSymbol === 'DRAW'
        ? 'Ván Online Hòa Cờ!'
        : `Phe ${gameOverResult.winnerSymbol} (${gameOverResult.winnerName}) Chiến Thắng!`;
      this._showEndBanner(
        title,
        'Thế cờ đã được tự động khoanh vùng điểm chết trên trang vở của tất cả người chơi trong phòng. Bấm vào ô trống bất kỳ để đánh tiếp ván mới!'
      );
    }
  }

  /**
   * Khoanh vùng ván đang đánh dở theo yêu cầu của người chơi (nếu có ít nhất 1 nước đi)
   */
  async manualFenceCurrentGame() {
    if (this.mode === 'pvp-online') {
      if (this.mp?.roomState) {
        this.mp.sendNewGameOnSamePage(this.currentPageData.archivedGames);
      }
      return;
    }

    const moves = this.currentPageData?.activeGame?.moves || [];
    if (moves.length === 0) {
      this._showToast('Chưa có nước cờ nào trong ván hiện tại để khoanh vùng!', 'warn');
      return;
    }

    await this._finalizeAndFenceCurrentGame({
      winnerSymbol: 'DRAW',
      winnerName: 'Khoanh vùng sớm',
      winLine: null
    });
  }

  /**
   * Đi lại 1 lượt (Undo) cho chế độ PvE hoặc PvP Local
   */
  async undoLastMove() {
    if (this.mode === 'pvp-online') {
      this._showToast('Chế độ Online không hỗ trợ tự ý tẩy nước đi!', 'warn');
      return;
    }
    const moves = this.currentPageData?.activeGame?.moves || [];
    if (moves.length === 0) {
      this._showToast('Không có nước đi nào để quay lại!', 'warn');
      return;
    }

    this.aiRequestSeq++;
    this.aiThinking = false;

    if (this.mode === 'pve' && moves.length >= 2) {
      moves.pop();
      moves.pop();
    } else {
      moves.pop();
    }

    await this.store.savePage(this.currentPageData);
    this._rebuildBoardStateFromPage();
    this._updateStatusUI();
  }

  _getAILevelTitle(level) {
    const found = AI_LEVELS.find(l => l.level === Number(level));
    return found ? found.title : `Cấp ${level}`;
  }

  _bindUIEvents() {
    // Chuyển chế độ chơi (PvE / PvP Local / PvP Online)
    document.querySelectorAll('.mode-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const selectedMode = btn.dataset.mode;
        this.switchMode(selectedMode);
      });
    });

    // Luật chặn 2 đầu
    const blockToggle = document.getElementById('toggle-block-two-ends');
    if (blockToggle) {
      blockToggle.addEventListener('change', (e) => {
        this.blockTwoEnds = e.target.checked;
        this._updateStatusUI();
      });
    }

    // Chọn quân đi trước trong PvE
    document.querySelectorAll('input[name="pve-side"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.humanSymbol = e.target.value;
        this.aiSymbol = this.humanSymbol === 'X' ? 'O' : 'X';
        if (this.mode === 'pve' && (this.currentPageData?.activeGame?.moves?.length || 0) === 0) {
          this.turnIndex = 0;
          if (this.humanSymbol === 'O') {
            this._triggerAIMove();
          }
        }
        this._updateStatusUI();
      });
    });

    // Chọn số người chơi PvP Local
    document.querySelectorAll('.local-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.local-count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.localPlayerCount = Number(btn.dataset.count) || 2;
        this._rebuildBoardStateFromPage();
        this._updateStatusUI();
      });
    });

    // Điều hướng trang vở 1 -> 200
    document.getElementById('btn-prev-page')?.addEventListener('click', () => {
      if (this.currentPageNumber > 1) {
        this.sound.playPageFlip();
        this.loadPage(this.currentPageNumber - 1);
      }
    });

    document.getElementById('btn-next-page')?.addEventListener('click', () => {
      if (this.currentPageNumber < TOTAL_NOTEBOOK_PAGES) {
        this.sound.playPageFlip();
        this.loadPage(this.currentPageNumber + 1);
      }
    });

    const pageInput = document.getElementById('page-jump-input');
    if (pageInput) {
      pageInput.addEventListener('change', (e) => {
        const val = Number(e.target.value);
        if (val >= 1 && val <= TOTAL_NOTEBOOK_PAGES) {
          this.sound.playPageFlip();
          this.loadPage(val);
        } else {
          e.target.value = this.currentPageNumber;
        }
      });
    }

    // Mở Modal Mục lục 200 trang
    document.getElementById('btn-open-index')?.addEventListener('click', () => {
      this._openNotebookIndexModal();
    });
    document.getElementById('btn-close-index-modal')?.addEventListener('click', () => {
      document.getElementById('notebook-index-modal')?.classList.add('hidden');
    });

    // Các nút thao tác trên trang vở
    document.getElementById('btn-fence-now')?.addEventListener('click', () => {
      this.manualFenceCurrentGame();
    });

    document.getElementById('btn-undo-move')?.addEventListener('click', () => {
      this.undoLastMove();
    });

    document.getElementById('btn-clear-page')?.addEventListener('click', async () => {
      if (this.mode === 'pvp-online' && this.mp?.roomState) {
        this._showToast('Hãy rời phòng Online trước khi tẩy trắng trang vở!', 'warn');
        return;
      }
      if (confirm(`Bạn có chắc muốn lấy tẩy xóa sạch toàn bộ các ván cờ trên Trang ${this.currentPageNumber} không?`)) {
        await this.store.clearPage(this.currentPageNumber);
        await this.loadPage(this.currentPageNumber);
        this._showToast(`Đã tẩy trắng Trang ${this.currentPageNumber}!`, 'info');
      }
    });

    // Âm thanh
    const soundBtn = document.getElementById('btn-toggle-sound');
    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        const enabled = this.sound.toggle();
        soundBtn.textContent = enabled ? '🔊 Âm thanh: Bật' : '🔇 Âm thanh: Tắt';
      });
    }

    // Lưu tên học sinh trên nhãn vở
    const nameInput = document.getElementById('student-name-input');
    if (nameInput) {
      nameInput.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        if (val) {
          this.profile.name = val;
          this.store.savePlayerProfile(this.profile);
          this._showToast(`Đã ghi tên "${val}" lên nhãn vở!`, 'info');
        }
      });
    }

    // Xuất / Nhập quyển vở 200 trang
    document.getElementById('btn-export-notebook')?.addEventListener('click', () => {
      const json = this.store.exportNotebookJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vo-o-ly-caro-200-trang-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const importFile = document.getElementById('input-import-notebook');
    document.getElementById('btn-import-notebook')?.addEventListener('click', () => {
      importFile?.click();
    });
    importFile?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        await this.store.importNotebookJSON(text);
        this.profile = this.store.getPlayerProfile();
        this._updateProfileUI();
        await this.loadPage(this.currentPageNumber);
        this._showToast('Đã nạp quyển vở 200 trang thành công!', 'info');
      } catch (err) {
        this._showToast(err.message || 'Lỗi đọc file quyển vở!', 'error');
      }
    });

    // Sự kiện PvP Co-op Online
    document.querySelectorAll('.online-submode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.online-submode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.onlineSubMode = btn.dataset.submode;
      });
    });

    document.getElementById('btn-create-room')?.addEventListener('click', () => {
      this.mp.createRoom({
        playerName: this.profile.name,
        subMode: this.onlineSubMode,
        blockTwoEnds: this.blockTwoEnds,
        archivedGames: this.currentPageData.archivedGames || []
      });
    });

    document.getElementById('btn-quick-match')?.addEventListener('click', () => {
      this.mp.quickMatch({
        playerName: this.profile.name,
        subMode: this.onlineSubMode,
        blockTwoEnds: this.blockTwoEnds,
        archivedGames: this.currentPageData.archivedGames || []
      });
    });

    document.getElementById('btn-join-room')?.addEventListener('click', () => {
      const code = document.getElementById('input-room-code')?.value?.trim();
      if (!code) {
        this._showToast('Vui lòng nhập Mã Phòng!', 'warn');
        return;
      }
      this.mp.joinRoom({
        roomId: code,
        playerName: this.profile.name
      });
    });

    document.getElementById('btn-refresh-rooms')?.addEventListener('click', () => {
      this.mp.requestRoomList();
    });

    document.getElementById('btn-leave-room')?.addEventListener('click', () => {
      this.mp.leaveRoom();
      this._renderOnlineRoomPanel(null);
      this._showToast('Đã rời phòng đấu Online.', 'info');
    });

    document.getElementById('btn-send-chat')?.addEventListener('click', () => {
      this._sendCurrentChatInput();
    });

    document.getElementById('input-chat-msg')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._sendCurrentChatInput();
    });

    document.querySelectorAll('.quick-chat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.mp.sendChat(chip.dataset.msg);
      });
    });

    document.getElementById('btn-dismiss-banner')?.addEventListener('click', () => {
      this._hideEndBanner();
    });
  }

  _sendCurrentChatInput() {
    const input = document.getElementById('input-chat-msg');
    if (!input || !input.value.trim()) return;
    this.mp.sendChat(input.value.trim());
    input.value = '';
  }

  switchMode(newMode) {
    if (this.mode === 'pvp-online' && newMode !== 'pvp-online' && this.mp?.roomState) {
      this.mp.leaveRoom();
      this._renderOnlineRoomPanel(null);
    }

    this.mode = newMode;
    document.querySelectorAll('.mode-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });

    document.getElementById('panel-pve')?.classList.toggle('hidden', newMode !== 'pve');
    document.getElementById('panel-pvp-local')?.classList.toggle('hidden', newMode !== 'pvp-local');
    document.getElementById('panel-pvp-online')?.classList.toggle('hidden', newMode !== 'pvp-online');

    if (newMode === 'pvp-online') {
      this.mp.connect();
      this.mp.requestRoomList();
    } else {
      this._rebuildBoardStateFromPage();
      if (newMode === 'pve' && this.getCurrentTurnSymbol() === this.aiSymbol) {
        this._triggerAIMove();
      }
    }

    this._updateStatusUI();
  }

  _renderAILevelSelect() {
    const container = document.getElementById('ai-levels-grid');
    if (!container) return;

    container.innerHTML = '';
    for (const item of AI_LEVELS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `ai-level-card ${item.level === this.aiLevel ? 'active' : ''}`;
      card.innerHTML = `
        <div class="ai-level-top">
          <span class="ai-level-num">${item.title}</span>
          ${item.level === 10 ? '<span class="ai-crown">👑</span>' : ''}
        </div>
        <div class="ai-level-sub">${item.subtitle}</div>
      `;
      card.addEventListener('click', () => {
        this.aiLevel = item.level;
        container.querySelectorAll('.ai-level-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        this._updateStatusUI();
      });
      container.appendChild(card);
    }
  }

  _updateProfileUI() {
    const nameInput = document.getElementById('student-name-input');
    if (nameInput) nameInput.value = this.profile.name || '';

    const statWins = document.getElementById('stat-wins');
    const statDraws = document.getElementById('stat-draws');
    const statBestAi = document.getElementById('stat-best-ai');

    if (statWins) statWins.textContent = this.profile.stats?.wins || 0;
    if (statDraws) statDraws.textContent = this.profile.stats?.draws || 0;
    if (statBestAi) {
      const lv = this.profile.stats?.highestAiBeaten || 0;
      statBestAi.textContent = lv > 0 ? `Cấp ${lv}` : 'Chưa';
    }
  }

  _updateNotebookNavigationUI() {
    const pageInput = document.getElementById('page-jump-input');
    if (pageInput) pageInput.value = this.currentPageNumber;

    const totalCells = BOARD_ROWS * BOARD_COLS;
    const activeCount = this.currentPageData?.activeGame?.moves?.length || 0;
    const deadCount = this.deadSet.size;
    const freePercent = Math.max(0, Math.round(((totalCells - deadCount - activeCount) / totalCells) * 100));

    const pageStatsEl = document.getElementById('current-page-stats');
    if (pageStatsEl) {
      const archivedCount = this.currentPageData?.archivedGames?.length || 0;
      pageStatsEl.textContent = `Đã khoanh: ${archivedCount} ván • Điểm chết: ${deadCount} ô • Trống: ${freePercent}%`;
    }
  }

  _updateStatusUI() {
    const turnBadge = document.getElementById('current-turn-badge');
    const modeDesc = document.getElementById('current-mode-desc');
    const moveCountEl = document.getElementById('current-move-count');

    const sym = this.getCurrentTurnSymbol();
    const cfg = SYMBOL_CONFIG[sym] || SYMBOL_CONFIG.X;

    if (turnBadge) {
      if (this.aiThinking) {
        turnBadge.textContent = `✍️ ${this._getAILevelTitle(this.aiLevel)} đang suy nghĩ...`;
        turnBadge.style.borderColor = '#d97706';
        turnBadge.style.color = '#b45309';
      } else {
        turnBadge.textContent = `Lượt đi: ${cfg.name}`;
        turnBadge.style.borderColor = cfg.color;
        turnBadge.style.color = cfg.color;
      }
    }

    if (modeDesc) {
      const ruleText = this.blockTwoEnds ? 'Chặn 2 đầu: BẬT' : 'Chặn 2 đầu: TẮT';
      if (this.mode === 'pve') {
        modeDesc.textContent = `Đấu với Máy • ${this._getAILevelTitle(this.aiLevel)} • ${ruleText}`;
      } else if (this.mode === 'pvp-local') {
        modeDesc.textContent = `PvP Chung Màn Hình (${this.localPlayerCount} người) • ${ruleText}`;
      } else {
        const roomCode = this.mp?.roomState?.roomId ? `Phòng #${this.mp.roomState.roomId}` : 'Chưa vào phòng';
        modeDesc.textContent = `PvP Co-op Online (${roomCode}) • ${ruleText}`;
      }
    }

    if (moveCountEl) {
      const count = this.currentPageData?.activeGame?.moves?.length || 0;
      moveCountEl.textContent = `Nước thứ: ${count}`;
    }

    if (this.renderer) {
      this.renderer.setState({
        currentTurnSymbol: sym
      });
    }
  }

  _renderArchivedListOnPage() {
    const listEl = document.getElementById('page-archived-games-list');
    if (!listEl) return;

    const archived = this.currentPageData?.archivedGames || [];
    if (archived.length === 0) {
      listEl.innerHTML = `<div class="empty-archived-note">Trang ${this.currentPageNumber} hiện chưa có ván cờ nào bị khoanh vùng điểm chết.</div>`;
      return;
    }

    listEl.innerHTML = archived
      .map((g, idx) => {
        const timeStr = new Date(g.finishedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const resText = g.winnerSymbol === 'DRAW' ? 'Hòa cờ' : `${g.winnerSymbol} thắng (${g.winnerName})`;
        return `
          <div class="archived-item">
            <div class="archived-item-head">
              <strong>Ván #${idx + 1}: ${resText}</strong>
              <span>${timeStr}</span>
            </div>
            <div class="archived-item-sub">
              ${g.modeLabel} • ${g.moves?.length || 0} nước • Khoanh ${g.deadCells?.length || 0} ô chết
            </div>
          </div>
        `;
      })
      .join('');
  }

  _openNotebookIndexModal() {
    const modal = document.getElementById('notebook-index-modal');
    const grid = document.getElementById('notebook-pages-grid');
    const summaryEl = document.getElementById('notebook-index-summary');
    if (!modal || !grid) return;

    const overview = this.store.getNotebookOverview();
    if (summaryEl) {
      summaryEl.textContent = `Đã viết trên ${overview.usedPagesCount} / 200 trang • Tổng cộng ${overview.totalFinishedGames} ván cờ đã được lưu và khoanh vùng.`;
    }

    grid.innerHTML = '';
    for (const p of overview.pages) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `page-cell-btn status-${p.status} ${p.pageNumber === this.currentPageNumber ? 'current' : ''}`;
      btn.innerHTML = `
        <span class="page-cell-num">Trang ${p.pageNumber}</span>
        <span class="page-cell-meta">${p.gamesCount > 0 ? `${p.gamesCount} ván (${p.usedRatio}%)` : p.hasActiveGame ? 'Đang chơi' : 'Giấy trắng'}</span>
      `;
      btn.addEventListener('click', () => {
        modal.classList.add('hidden');
        this.sound.playPageFlip();
        this.loadPage(p.pageNumber);
      });
      grid.appendChild(btn);
    }

    modal.classList.remove('hidden');
  }

  _renderPublicRoomList(rooms) {
    const listEl = document.getElementById('public-rooms-list');
    if (!listEl) return;

    if (!rooms || rooms.length === 0) {
      listEl.innerHTML = `<div class="empty-rooms-note">Chưa có phòng chờ nào. Hãy bấm "Tạo Phòng Mới" hoặc "Ghép Trận Nhanh"!</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const r of rooms) {
      const row = document.createElement('div');
      row.className = 'room-list-item';
      const subLabel = r.subMode === 'team' ? 'Chia Phe X/O' : r.subMode === 'ffa' ? 'Hỗn Chiến 2-4' : 'Đấu 1v1';
      row.innerHTML = `
        <div>
          <strong>Phòng #${r.roomId}</strong> • <span class="room-tag">${subLabel}</span>
          <div class="room-sub">Chủ phòng: ${r.hostName} • ${r.playerCount} người • Đã khoanh ${r.archivedCount} ván</div>
        </div>
        <button type="button" class="btn-small-primary">Vào Phòng</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        this.mp.joinRoom({ roomId: r.roomId, playerName: this.profile.name });
      });
      listEl.appendChild(row);
    }
  }

  _renderOnlineRoomPanel(room) {
    const lobbyBox = document.getElementById('online-lobby-box');
    const activeRoomBox = document.getElementById('online-active-room-box');
    if (!lobbyBox || !activeRoomBox) return;

    if (!room) {
      lobbyBox.classList.remove('hidden');
      activeRoomBox.classList.add('hidden');
      return;
    }

    lobbyBox.classList.add('hidden');
    activeRoomBox.classList.remove('hidden');

    document.getElementById('active-room-code').textContent = room.roomId;
    const subModeLabel = room.subMode === 'team'
      ? 'Co-op Chia Phe (Đội X vs Đội O luân phiên)'
      : room.subMode === 'ffa'
        ? 'Hỗn Chiến Nhiều Người (X, O, Δ, □)'
        : 'Đấu 1v1 Cổ Điển (Có khán giả)';
    document.getElementById('active-room-submode').textContent = subModeLabel;

    // Hiển thị danh sách người chơi và nút đổi Phe/Ký hiệu
    const playersContainer = document.getElementById('active-room-players');
    if (playersContainer) {
      playersContainer.innerHTML = room.players
        .map(p => {
          const isMe = p.clientId === this.mp.clientId;
          const roleBadge = p.symbol === 'SPECTATOR' ? '👀 Khán giả' : `Bút ${p.symbol}`;
          return `
            <div class="room-player-row ${isMe ? 'me' : ''}">
              <span>${p.name} ${isMe ? '(Bạn)' : ''}</span>
              <span class="player-symbol-pill sym-${p.symbol}">${roleBadge}</span>
            </div>
          `;
        })
        .join('');
    }

    // Các nút chọn phe trong phòng
    const switchBox = document.getElementById('room-symbol-Readiness');
    if (switchBox) {
      const allowedSymbols = room.subMode === 'ffa' ? ['X', 'O', 'Δ', '□', 'SPECTATOR'] : ['X', 'O', 'SPECTATOR'];
      switchBox.innerHTML = allowedSymbols
        .map(sym => {
          const label = sym === 'SPECTATOR' ? '👀 Xem' : `Phe ${sym}`;
          return `<button type="button" class="btn-switch-sym" data-sym="${sym}">${label}</button>`;
        })
        .join('');
      switchBox.querySelectorAll('.btn-switch-sym').forEach(btn => {
        btn.addEventListener('click', () => {
          this.mp.switchTeamOrSymbol(btn.dataset.sym);
        });
      });
    }
  }

  _appendChatMessage({ sender, symbol, text }) {
    const log = document.getElementById('online-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'chat-line';
    div.innerHTML = `<strong>[${symbol || '•'}] ${sender}:</strong> <span></span>`;
    div.querySelector('span').textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  _showEndBanner(title, subtitle) {
    const banner = document.getElementById('game-end-banner');
    const titleEl = document.getElementById('banner-title');
    const subEl = document.getElementById('banner-subtitle');
    if (!banner || !titleEl || !subEl) return;

    titleEl.textContent = title;
    subEl.textContent = subtitle;
    banner.classList.remove('hidden');
  }

  _hideEndBanner() {
    document.getElementById('game-end-banner')?.classList.add('hidden');
  }

  _showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const item = document.createElement('div');
    item.className = `toast-item toast-${type}`;
    item.textContent = message;
    container.appendChild(item);

    setTimeout(() => {
      item.classList.add('fade-out');
      setTimeout(() => item.remove(), 300);
    }, 3200);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new CaroNotebookApp();
  app.init();
});
