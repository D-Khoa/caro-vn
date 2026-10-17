/**
 * Main Application Controller - Cờ Caro Vở Ô Ly Việt Nam (Phiên bản Giao diện Tối Giản Đa Màn Hình)
 * - Tách riêng 5 màn hình: Menu Chính | Sảnh Co-op | Lịch Sử 200 Trang | Cài Đặt | Trang Vở Gameplay
 * - Chế độ Co-op Online: Tất cả người chơi cùng đại chiến trên trang vở của Chủ Phòng;
 *   Chủ Phòng có thể chọn bất kỳ trang nào (1 -> 200) từ quyển vở của mình trước khi bắt đầu ván cờ.
 * - Hỗ trợ Responsive & Thu phóng (Zoom) mượt mà trên PC, Tablet và Điện thoại.
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

    this.currentView = 'view-menu';

    // Trang vở cá nhân hiện tại (1 -> 200) tách biệt với trang phòng Co-op
    this.personalPageNumber = 1;
    this.currentPageNumber = 1;
    this.currentPageData = null;
    this.deadSet = new Set();
    this.activeBoard = this._createEmptyBoard();

    // Trạng thái xem trong màn hình Lịch Sử
    this.historyFilter = 'all';
    this.historySelectedPage = 1;

    // Cấu hình chế độ chơi
    this.mode = 'pve'; // 'pve' | 'pvp-local' | 'pvp-online'
    this.blockTwoEnds = true;
    this.showCoordinates = true;
    this.zoomLevel = 1.0;

    // Cấu hình PvE
    this.aiLevel = 5;
    this.humanSymbol = 'X';
    this.aiSymbol = 'O';
    this.aiThinking = false;
    this.aiWorker = null;
    this.aiRequestSeq = 0;

    // Cấu hình PvP Local
    this.localPlayerCount = 2;

    // Cấu hình PvP Co-op Online
    this.onlineSubMode = '1v1';
    this.mp = null;
    this.countedOnlineGameIds = new Set();
    this.unreadChatCount = 0;

    this.turnIndex = 0;
  }

  _createEmptyBoard() {
    return Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
  }

  async init() {
    await this.store.init();
    this.profile = this.store.getPlayerProfile();
    this.personalPageNumber = this.profile.currentPage || 1;
    this.currentPageNumber = this.personalPageNumber;
    this.historySelectedPage = this.personalPageNumber;

    this._initAIWorker();
    this._initCanvas();
    this._initMultiplayer();
    this._populateAISelect();
    this._bindUIEvents();
    this._syncProfileAndSettingsUI();

    await this.loadPage(this.personalPageNumber);

    window.addEventListener('resize', () => {
      if (this.currentView === 'view-game' && this.renderer) {
        this.renderer.resize();
      }
    });
  }

  /**
   * Chuyển đổi giữa 5 màn hình riêng biệt
   */
  showScreen(viewId) {
    this.currentView = viewId;
    document.querySelectorAll('.screen-view').forEach(sec => {
      sec.classList.toggle('active', sec.id === viewId);
    });

    if (viewId === 'view-menu') {
      this._syncProfileAndSettingsUI();
    } else if (viewId === 'view-history') {
      this._renderHistoryView();
    } else if (viewId === 'view-settings') {
      this._syncProfileAndSettingsUI();
    } else if (viewId === 'view-coop-lobby') {
      this.unreadChatCount = 0;
      const coopDrawerBtn = document.getElementById('btn-toggle-coop-drawer');
      if (coopDrawerBtn) coopDrawerBtn.textContent = '💬 Bàn học';

      if (!this.mp?.roomState) {
        const coopCreatePageInput = document.getElementById('coop-create-page-select');
        if (coopCreatePageInput) {
          coopCreatePageInput.value = this.personalPageNumber || this.currentPageNumber || 1;
        }
      }
      this.mp.connect();
      this.mp.requestRoomList();
      this._updateCoopCreatePageBadge();
      this._renderOnlineRoomPanel(this.mp.roomState);
    } else if (viewId === 'view-game') {
      setTimeout(() => {
        this.renderer.resize();
        this._updateGameplayUI();
      }, 20);
    }
  }

  _initAIWorker() {
    try {
      this.aiWorker = new Worker('./js/ai-worker.js', { type: 'module' });
      this.aiWorker.onmessage = (e) => {
        const { requestId, move } = e.data;
        if (requestId !== this.aiRequestSeq) return;
        this.aiThinking = false;
        this._updateGameplayUI();
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
      onConnectionChange: (connected, modeType) => {
        const badge = document.getElementById('online-conn-badge');
        if (badge) {
          badge.textContent = connected
            ? modeType === 'local-channel'
              ? 'Đã kết nối (Đa Tab)'
              : 'Đã kết nối Server'
            : 'Mất kết nối';
          badge.className = `conn-badge ${connected ? 'connected' : 'disconnected'}`;
        }
      },
      onLatencyUpdate: (ms) => {
        const pingEl = document.getElementById('ping-value');
        if (pingEl) pingEl.textContent = `${ms} ms`;
      },
      onRoomList: (rooms, stats) => {
        const countEl = document.getElementById('server-room-count');
        if (countEl && stats) countEl.textContent = stats.roomCount || rooms.length;
        this._renderPublicRoomList(rooms);
      },
      onRoomState: (room, notice) => {
        if (notice) {
          this._showToast(notice, 'info');
        }
        this._syncFromOnlineRoom(room);
      },
      onHostPageChanged: (msg) => {
        this._hideEndBanner();
        this.sound.playPageFlip();
        this._showToast(`Chủ phòng (${msg.hostName}) đã chọn Trang ${msg.pageNumber} làm chiến trường!`, 'info');
      },
      onMoveMade: (move, room) => {
        this._hideEndBanner();
        this.sound.playPenStroke(move.symbol);
        this._syncFromOnlineRoom(room);
        if (this.currentView === 'view-coop-lobby' && (room?.moves?.length || 0) === 1) {
          this._showToast(
            `⚔️ ${move.playerName} (${move.symbol}) vừa khai cuộc trên tờ giấy vở! Bấm "Mở Tờ Giấy Vở Ra Đánh!" ngay!`,
            'info'
          );
        }
      },
      onGameOver: (result, room) => {
        this.sound.playFenceDraw();
        this._syncFromOnlineRoom(room, result);
      },
      onChat: (chatMsg) => {
        this._appendChatMessage(chatMsg);
        if (this.currentView === 'view-game' && chatMsg.clientId !== this.mp?.clientId) {
          this.unreadChatCount = (this.unreadChatCount || 0) + 1;
          const coopDrawerBtn = document.getElementById('btn-toggle-coop-drawer');
          if (coopDrawerBtn) {
            coopDrawerBtn.textContent = `💬 Bàn học (${this.unreadChatCount})`;
          }
          this._showToast(`💬 ${chatMsg.sender}: ${chatMsg.text}`, 'info');
        }
      },
      onError: (errMsg) => {
        this._showToast(errMsg, 'error');
      }
    });
  }

  _populateAISelect() {
    const sel = document.getElementById('select-ai-level');
    if (!sel) return;
    sel.innerHTML = AI_LEVELS.map(
      item => `<option value="${item.level}" ${item.level === this.aiLevel ? 'selected' : ''}>${item.title} — ${item.subtitle}</option>`
    ).join('');
  }

  async loadPage(pageNumber) {
    const target = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(pageNumber) || 1));
    this.personalPageNumber = target;
    this.currentPageNumber = target;
    this.profile.currentPage = target;
    this.store.savePlayerProfile(this.profile);

    this.currentPageData = await this.store.getPage(target);
    this.aiRequestSeq++;
    this.aiThinking = false;
    this._hideEndBanner();

    this._rebuildBoardStateFromPage();
    this._updateGameplayUI();
    this._syncProfileAndSettingsUI();
  }

  _rebuildBoardStateFromPage() {
    this.deadSet = new Set();
    for (const archived of this.currentPageData.archivedGames || []) {
      if (archived.moves && archived.moves.length > 0) {
        const recomputed = computeGameFenceAndDeadZone(
          archived.moves,
          this.deadSet,
          BOARD_ROWS,
          BOARD_COLS
        );
        archived.deadCells = recomputed.deadCells;
        archived.contours = recomputed.contours;
      }
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

    const ownerName = this.mode === 'pvp-online' && this.mp?.roomState
      ? (this.mp.roomState.pageOwnerName || this.mp.roomState.hostName)
      : this.profile.name;
    const ownerTitle = `Vở của ${ownerName}`;

    this.renderer.setState({
      pageData: this.currentPageData,
      activeBoard: this.activeBoard,
      deadSet: this.deadSet,
      currentTurnSymbol: this.getCurrentTurnSymbol(),
      ownerTitle,
      showCoordinates: this.showCoordinates
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
    if (this.mode === 'pve') return ['X', 'O'];
    if (this.mode === 'pvp-local') return SYMBOLS.slice(0, this.localPlayerCount);
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
   * Xử lý khi chấm bút lên ô (r, c) của trang vở ô ly
   */
  async handleBoardClick(r, c) {
    // Ngăn click nhầm theo quán tính ngay khoảnh khắc ván trước vừa kết thúc (< 350ms)
    if (this.lastGameFinishedAt && Date.now() - this.lastGameFinishedAt < 350) {
      return;
    }

    const key = cellKey(r, c);

    if (this.deadSet.has(key)) {
      this._showToast('Ô này thuộc vùng khoanh Điểm Chết của ván cờ cũ, không thể đánh đè lên!', 'warn');
      return;
    }

    if (this.activeBoard[r][c] !== null) return;

    if (this.mode === 'pvp-online') {
      if (!this.mp.roomState) {
        this._showToast('Bạn chưa ở trong phòng Co-op!', 'warn');
        return;
      }
      this.mp.sendMove(r, c);
      return;
    }

    if (this.mode === 'pve') {
      if (this.aiThinking) return;
      if (this.getCurrentTurnSymbol() !== this.humanSymbol) return;

      const ended = await this._applyLocalOrPvEMove(r, c, this.humanSymbol, this.profile.name);
      if (!ended) {
        this._triggerAIMove();
      }
      return;
    }

    if (this.mode === 'pvp-local') {
      const sym = this.getCurrentTurnSymbol();
      await this._applyLocalOrPvEMove(r, c, sym, `Người chơi ${sym}`);
    }
  }

  async _applyLocalOrPvEMove(r, c, symbol, playerName) {
    if (this.deadSet.has(cellKey(r, c)) || this.activeBoard[r][c] !== null) return false;

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

    const remainingCells = countPlayableCells(this.activeBoard, this.deadSet, BOARD_ROWS, BOARD_COLS);
    if (remainingCells === 0) {
      await this._finalizeAndFenceCurrentGame({
        winnerSymbol: 'DRAW',
        winnerName: 'Hòa cờ (Kín trang vở)',
        winLine: null
      });
      return true;
    }

    this.renderer.setState({
      pageData: this.currentPageData,
      activeBoard: this.activeBoard,
      deadSet: this.deadSet,
      currentTurnSymbol: this.getCurrentTurnSymbol()
    });
    this._updateGameplayUI();
    await this.store.savePage(this.currentPageData);
    return false;
  }

  async _finalizeAndFenceCurrentGame({ winnerSymbol, winnerName, winLine }) {
    const activeGame = this.currentPageData.activeGame;
    if (!activeGame || !activeGame.moves || activeGame.moves.length === 0) return;

    // Hủy mọi yêu cầu AI còn tồn đọng của ván cũ để tuyệt đối không đánh nhầm sang ván mới
    this.aiRequestSeq++;
    this.aiThinking = false;
    this.lastGameFinishedAt = Date.now();

    const finishedMoves = [...activeGame.moves];
    const { deadCells, contours } = computeGameFenceAndDeadZone(
      finishedMoves,
      this.deadSet,
      BOARD_ROWS,
      BOARD_COLS
    );

    const gameNumber = (this.currentPageData.archivedGames?.length || 0) + 1;
    const modeLabel = this.mode === 'pve'
      ? `PvE (${this._getAILevelTitle(this.aiLevel)})`
      : `PvP Chung màn (${this.localPlayerCount} người)`;

    this.currentPageData.archivedGames.push({
      id: activeGame.id || `archived_${Date.now()}`,
      gameIndexOnPage: gameNumber,
      mode: this.mode,
      modeLabel,
      blockTwoEnds: this.blockTwoEnds,
      winnerSymbol,
      winnerName,
      winLine: winLine || null,
      moves: finishedMoves,
      deadCells,
      contours,
      finishedAt: Date.now()
    });

    this.currentPageData.activeGame = this._createNewActiveGameObj();

    // Cập nhật ngay lập tức trạng thái bàn cờ & vùng điểm chết trước khi await lưu IndexedDB
    this._rebuildBoardStateFromPage();
    this._updateGameplayUI();
    this.sound.playFenceDraw();

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
    }

    await this.store.savePage(this.currentPageData);

    const bannerTitle = winnerSymbol === 'DRAW'
      ? `Ván #${gameNumber} Hòa Cờ!`
      : `Ván #${gameNumber}: ${winnerName} (${winnerSymbol}) Thắng!`;

    this._showEndBanner(
      bannerTitle,
      `Đã khoanh viền điểm chết (${deadCells.length} ô). Chấm vào phần giấy trống còn lại để đánh tiếp ván mới!`
    );

    // Nếu người chơi cầm O (Đi sau) trong chế độ PvE, máy tự động khai cuộc ván tiếp theo ở vùng giấy trống
    if (this.mode === 'pve' && this.humanSymbol === 'O') {
      this._triggerAIMove();
    }
  }

  _triggerAIMove() {
    if (this.mode !== 'pve') return;
    if (this.getCurrentTurnSymbol() !== this.aiSymbol) return;

    this.aiThinking = true;
    this._updateGameplayUI();
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
        this._updateGameplayUI();
        if (move) {
          this._applyLocalOrPvEMove(move.r, move.c, this.aiSymbol, this._getAILevelTitle(this.aiLevel));
        }
      }, 120);
    }
  }

  /**
   * Thoát khỏi phòng Co-op và khôi phục nguyên vẹn trang vở cá nhân của người chơi
   */
  async _exitCoopRoomAndRestorePersonalPage(showLeaveToast = false) {
    if (this.mp?.roomState) {
      this.mp.leaveRoom();
    }
    this.unreadChatCount = 0;
    const coopDrawerBtn = document.getElementById('btn-toggle-coop-drawer');
    if (coopDrawerBtn) coopDrawerBtn.textContent = '💬 Bàn học';
    const chatLog = document.getElementById('online-chat-log');
    if (chatLog) chatLog.innerHTML = '';

    this._renderOnlineRoomPanel(null);
    this.mode = 'pve';
    await this.loadPage(this.personalPageNumber || this.profile?.currentPage || 1);

    if (showLeaveToast) {
      this._showToast('Đã rời phòng Co-op và quay về vở cá nhân.', 'info');
    }
  }

  /**
   * Đồng bộ trạng thái khi đánh trên Trang Vở Ô Ly của Chủ Phòng (Co-op Mode)
   */
  async _syncFromOnlineRoom(room, gameOverResult = null) {
    if (!room) return;

    this.mode = 'pvp-online';
    this.blockTwoEnds = room.blockTwoEnds;

    const hostPageNum = room.hostPageNumber || 1;
    const isPageOwner = this.mp.isPageOwner();
    const pageOwnerName = room.pageOwnerName || room.hostName;

    // Dựng đối tượng trang vở của Chủ Phòng để hiển thị giống hệt trên máy mọi người chơi
    this.currentPageNumber = hostPageNum;
    this.currentPageData = {
      pageNumber: hostPageNum,
      dateHeader: room.hostDateHeader || this.store.formatVietnameseDate(),
      archivedGames: room.archivedGames || [],
      activeGame: {
        id: room.activeGameId || 'online_game',
        mode: 'pvp-online',
        blockTwoEnds: room.blockTwoEnds,
        moves: room.moves || []
      }
    };

    // Chỉ lưu vào IndexedDB nếu người chơi chính là Chủ sở hữu thực sự của trang vở đang mở
    // (Tránh ghi đè mất dữ liệu vở của Khách khi Chủ phòng cũ thoát và Khách được đôn lên làm Chủ phòng mới,
    // đồng thời bảo toàn ván cờ offline đang đánh dở của Chủ phòng trên trang đó!)
    if (isPageOwner) {
      const savedPersonalPage = await this.store.getPage(hostPageNum);
      const preservedOfflineActiveGame =
        savedPersonalPage.activeGame &&
        savedPersonalPage.activeGame.mode !== 'pvp-online' &&
        Array.isArray(savedPersonalPage.activeGame.moves) &&
        savedPersonalPage.activeGame.moves.length > 0
          ? savedPersonalPage.activeGame
          : {
              id: `game_${Date.now()}`,
              mode: 'pve',
              blockTwoEnds: room.blockTwoEnds,
              moves: [],
              startedAt: Date.now()
            };

      await this.store.savePage({
        pageNumber: hostPageNum,
        dateHeader: room.hostDateHeader || savedPersonalPage.dateHeader || this.store.formatVietnameseDate(),
        archivedGames: room.archivedGames || [],
        activeGame: preservedOfflineActiveGame
      });

      this.personalPageNumber = hostPageNum;
      this.profile.currentPage = hostPageNum;
      this.store.savePlayerProfile(this.profile);
    }

    this._rebuildBoardStateFromPage();
    this._renderOnlineRoomPanel(room);
    this._updateGameplayUI();

    if (gameOverResult) {
      this.lastGameFinishedAt = Date.now();

      // Cập nhật thống kê Thắng / Hòa / Thua cho người chơi tham gia ván Co-op
      const finishedGameId =
        gameOverResult.id ||
        room.archivedGames?.[room.archivedGames.length - 1]?.id ||
        null;
      if (!finishedGameId || !this.countedOnlineGameIds.has(finishedGameId)) {
        if (finishedGameId) this.countedOnlineGameIds.add(finishedGameId);
        const myPlayer = (room.players || []).find(p => p.clientId === this.mp.clientId);
        if (myPlayer && myPlayer.symbol && myPlayer.symbol !== 'SPECTATOR') {
          if (!this.profile.stats) {
            this.profile.stats = { wins: 0, losses: 0, draws: 0, highestAiBeaten: 0 };
          }
          if (gameOverResult.winnerSymbol === 'DRAW') {
            this.profile.stats.draws = (this.profile.stats.draws || 0) + 1;
          } else if (gameOverResult.winnerSymbol === myPlayer.symbol) {
            this.profile.stats.wins = (this.profile.stats.wins || 0) + 1;
          } else {
            this.profile.stats.losses = (this.profile.stats.losses || 0) + 1;
          }
          this.store.savePlayerProfile(this.profile);
        }
      }

      const title = gameOverResult.winnerSymbol === 'DRAW'
        ? 'Ván Co-op Hòa Cờ!'
        : `Phe ${gameOverResult.winnerSymbol} (${gameOverResult.winnerName}) Thắng!`;
      this._showEndBanner(
        title,
        `Thế cờ đã được khoanh vào Trang ${hostPageNum} trong vở của ${pageOwnerName}. Chấm vào ô trống để đánh tiếp!`
      );
    }
  }

  /**
   * Chủ phòng chọn 1 trang từ quyển vở 200 trang của mình để tất cả người chơi cùng đại chiến
   */
  async hostApplyPageForRoom(pageNumber) {
    if (!this.mp.isHost()) {
      this._showToast('Chỉ Chủ Phòng mới có thể đổi trang vở đại chiến!', 'warn');
      return;
    }
    if ((this.mp.roomState?.moves?.length || 0) > 0) {
      this._showToast('Đang có ván đánh dở! Hãy bấm "Khoanh ván" trước khi lật sang trang vở khác.', 'warn');
      return;
    }

    const safePage = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(pageNumber) || 1));
    const hostPageData = await this.store.getPage(safePage);

    this.mp.selectHostPage({
      pageNumber: safePage,
      dateHeader: hostPageData.dateHeader,
      archivedGames: hostPageData.archivedGames || []
    });
  }

  async manualFenceCurrentGame() {
    if (this.mode === 'pvp-online') {
      if (!this.mp.isHost()) {
        this._showToast('Trong phòng Co-op, chỉ Chủ Phòng mới có quyền khoanh sớm ván cờ!', 'warn');
        return;
      }
      if ((this.mp.roomState?.moves?.length || 0) === 0) {
        this._showToast('Chưa có nước cờ nào để khoanh vùng!', 'warn');
        return;
      }
      this.mp.sendNewGameOnSamePage();
      return;
    }

    const moves = this.currentPageData?.activeGame?.moves || [];
    if (moves.length === 0) {
      this._showToast('Chưa có nước cờ nào để khoanh vùng!', 'warn');
      return;
    }

    await this._finalizeAndFenceCurrentGame({
      winnerSymbol: 'DRAW',
      winnerName: 'Khoanh vùng sớm',
      winLine: null
    });
  }

  async undoLastMove() {
    if (this.mode === 'pvp-online') {
      this._showToast('Chế độ Co-op Online không cho phép tự ý tẩy nước đi!', 'warn');
      return;
    }

    const moves = this.currentPageData?.activeGame?.moves || [];
    if (moves.length === 0) return;

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
    this._updateGameplayUI();
  }

  _getAILevelTitle(level) {
    const found = AI_LEVELS.find(l => l.level === Number(level));
    return found ? found.title : `Cấp ${level}`;
  }

  _bindUIEvents() {
    // Các nút quay lại
    document.querySelectorAll('.btn-back').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (this.currentView === 'view-coop-lobby' && (this.mp?.roomState || this.mode === 'pvp-online')) {
          await this._exitCoopRoomAndRestorePersonalPage(false);
        }
        this.showScreen(btn.dataset.target || 'view-menu');
      });
    });

    // Menu chính: Chọn cấp độ AI và màu bút
    document.getElementById('select-ai-level')?.addEventListener('change', (e) => {
      this.aiLevel = Number(e.target.value) || 5;
    });

    document.querySelectorAll('input[name="pve-side"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.humanSymbol = e.target.value;
        this.aiSymbol = this.humanSymbol === 'X' ? 'O' : 'X';
      });
    });

    // Menu chính: Vào chơi PvE
    document.getElementById('btn-start-pve')?.addEventListener('click', async () => {
      if (this.mp?.roomState) {
        this.mp.leaveRoom();
      }
      this.mode = 'pve';
      await this.loadPage(this.personalPageNumber || this.currentPageNumber);
      this.showScreen('view-game');
      if (this.getCurrentTurnSymbol() === this.aiSymbol) {
        this._triggerAIMove();
      }
    });

    // Menu chính: Vào chơi PvP Local
    document.getElementById('btn-start-local')?.addEventListener('click', async () => {
      if (this.mp?.roomState) {
        this.mp.leaveRoom();
      }
      this.mode = 'pvp-local';
      await this.loadPage(this.personalPageNumber || this.currentPageNumber);
      this.showScreen('view-game');
    });

    // Menu chính: Mở Sảnh Co-op, Lịch Sử 200 Trang, Cài Đặt
    document.getElementById('btn-open-coop')?.addEventListener('click', () => {
      this.showScreen('view-coop-lobby');
    });
    document.getElementById('btn-goto-history')?.addEventListener('click', () => {
      this.historySelectedPage = this.personalPageNumber || this.currentPageNumber;
      this.showScreen('view-history');
    });
    document.getElementById('btn-goto-settings')?.addEventListener('click', () => {
      this.showScreen('view-settings');
    });

    // Gameplay Topbar: Nút quay lại
    document.getElementById('btn-game-back')?.addEventListener('click', () => {
      if (this.mode === 'pvp-online' && this.mp?.roomState) {
        this.showScreen('view-coop-lobby');
      } else {
        this.showScreen('view-menu');
      }
    });

    // Gameplay Topbar: Điều hướng trang vở (hoặc Chủ Phòng đổi trang trước ván)
    document.getElementById('btn-prev-page')?.addEventListener('click', () => {
      this._stepNotebookPage(-1);
    });
    document.getElementById('btn-next-page')?.addEventListener('click', () => {
      this._stepNotebookPage(1);
    });
    document.getElementById('page-jump-input')?.addEventListener('change', (e) => {
      const target = Number(e.target.value);
      if (this.mode === 'pvp-online') {
        this.hostApplyPageForRoom(target);
      } else if (target >= 1 && target <= TOTAL_NOTEBOOK_PAGES) {
        this.sound.playPageFlip();
        this.loadPage(target);
      }
    });

    // Gameplay Topbar: Thu phóng (Zoom) cho đa thiết bị
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      this.zoomLevel = Math.min(1.75, +(this.zoomLevel + 0.15).toFixed(2));
      this.renderer.setZoom(this.zoomLevel);
    });
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      this.zoomLevel = Math.max(0.75, +(this.zoomLevel - 0.15).toFixed(2));
      this.renderer.setZoom(this.zoomLevel);
    });

    document.getElementById('btn-fence-now')?.addEventListener('click', () => {
      this.manualFenceCurrentGame();
    });
    document.getElementById('btn-undo-move')?.addEventListener('click', () => {
      this.undoLastMove();
    });
    document.getElementById('btn-toggle-coop-drawer')?.addEventListener('click', () => {
      this.showScreen('view-coop-lobby');
    });
    document.getElementById('btn-dismiss-banner')?.addEventListener('click', () => {
      this._hideEndBanner();
    });

    // Sảnh Co-op Online
    document.querySelectorAll('.online-submode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.online-submode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.onlineSubMode = btn.dataset.submode;
      });
    });

    const coopCreatePageInput = document.getElementById('coop-create-page-select');
    if (coopCreatePageInput) {
      coopCreatePageInput.value = this.personalPageNumber || this.currentPageNumber;
      coopCreatePageInput.addEventListener('change', () => {
        this._updateCoopCreatePageBadge();
      });
    }

    document.getElementById('btn-create-room')?.addEventListener('click', async () => {
      const pageNum = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(coopCreatePageInput?.value) || this.personalPageNumber));
      const hostPage = await this.store.getPage(pageNum);
      this.mp.createRoom({
        playerName: this.profile.name,
        subMode: this.onlineSubMode,
        blockTwoEnds: this.blockTwoEnds,
        pageNumber: pageNum,
        dateHeader: hostPage.dateHeader,
        archivedGames: hostPage.archivedGames || []
      });
    });

    document.getElementById('btn-quick-match')?.addEventListener('click', async () => {
      const pageNum = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(coopCreatePageInput?.value) || this.personalPageNumber));
      const hostPage = await this.store.getPage(pageNum);
      this.mp.quickMatch({
        playerName: this.profile.name,
        subMode: this.onlineSubMode,
        blockTwoEnds: this.blockTwoEnds,
        pageNumber: pageNum,
        dateHeader: hostPage.dateHeader,
        archivedGames: hostPage.archivedGames || []
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

    document.getElementById('btn-enter-coop-board')?.addEventListener('click', () => {
      this.mode = 'pvp-online';
      this.showScreen('view-game');
    });

    document.getElementById('btn-leave-room')?.addEventListener('click', async () => {
      await this._exitCoopRoomAndRestorePersonalPage(true);
    });

    // Quyền Chủ Phòng chọn trang vở trong Phòng Chờ Co-op
    const hostRoomPageInput = document.getElementById('input-host-room-page');
    document.getElementById('btn-host-prev-page')?.addEventListener('click', () => {
      if (!hostRoomPageInput) return;
      if ((this.mp.roomState?.moves?.length || 0) > 0) {
        this._showToast('Đang có ván đánh dở! Hãy bấm "Khoanh ván" trước khi lật sang trang vở khác.', 'warn');
        return;
      }
      const nextVal = Math.max(1, (Number(hostRoomPageInput.value) || 1) - 1);
      hostRoomPageInput.value = nextVal;
      this.hostApplyPageForRoom(nextVal);
    });
    document.getElementById('btn-host-next-page')?.addEventListener('click', () => {
      if (!hostRoomPageInput) return;
      if ((this.mp.roomState?.moves?.length || 0) > 0) {
        this._showToast('Đang có ván đánh dở! Hãy bấm "Khoanh ván" trước khi lật sang trang vở khác.', 'warn');
        return;
      }
      const nextVal = Math.min(TOTAL_NOTEBOOK_PAGES, (Number(hostRoomPageInput.value) || 1) + 1);
      hostRoomPageInput.value = nextVal;
      this.hostApplyPageForRoom(nextVal);
    });
    document.getElementById('btn-host-apply-page')?.addEventListener('click', () => {
      if (!hostRoomPageInput) return;
      if ((this.mp.roomState?.moves?.length || 0) > 0) {
        this._showToast('Đang có ván đánh dở! Hãy bấm "Khoanh ván" trước khi lật sang trang vở khác.', 'warn');
        return;
      }
      this.hostApplyPageForRoom(Number(hostRoomPageInput.value) || 1);
    });

    document.getElementById('coop-host-block-toggle')?.addEventListener('change', (e) => {
      if (this.mp.isHost()) {
        this.mp.updateRoomSettings({ blockTwoEnds: e.target.checked });
      }
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

    // Trang Lịch Sử 200 Trang
    document.querySelectorAll('.history-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.historyFilter = btn.dataset.filter || 'all';
        this._renderHistoryView();
      });
    });

    document.getElementById('btn-history-play-page')?.addEventListener('click', async () => {
      if (this.mp?.roomState) {
        this.mp.leaveRoom();
      }
      this.sound.playPageFlip();
      this.mode = 'pve';
      await this.loadPage(this.historySelectedPage);
      this.showScreen('view-game');
    });

    document.getElementById('btn-history-clear-page')?.addEventListener('click', async () => {
      if (confirm(`Bạn có chắc muốn dùng tẩy xóa sạch toàn bộ các ván cờ trên Trang ${this.historySelectedPage} không?`)) {
        await this.store.clearPage(this.historySelectedPage);
        if (this.personalPageNumber === this.historySelectedPage) {
          await this.loadPage(this.historySelectedPage);
        }
        await this._renderHistoryView();
        this._showToast(`Đã tẩy trắng Trang ${this.historySelectedPage}!`, 'info');
      }
    });

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
        await this.loadPage(this.personalPageNumber);
        await this._renderHistoryView();
        this._showToast('Đã nhập quyển vở 200 trang thành công!', 'info');
      } catch (err) {
        this._showToast(err.message || 'File không hợp lệ!', 'error');
      }
    });

    // Trang Cài Đặt
    document.getElementById('btn-save-settings')?.addEventListener('click', () => {
      const nameVal = document.getElementById('student-name-input')?.value?.trim();
      const schoolVal = document.getElementById('student-school-input')?.value?.trim();
      const classVal = document.getElementById('student-class-input')?.value?.trim();
      const localCountVal = Number(document.getElementById('setting-local-count')?.value) || 2;
      const blockVal = Boolean(document.getElementById('toggle-block-two-ends')?.checked);
      const soundVal = Boolean(document.getElementById('toggle-sound-setting')?.checked);
      const coordsVal = Boolean(document.getElementById('toggle-coords-setting')?.checked);
      const wsUrlVal = document.getElementById('input-custom-ws')?.value?.trim() || '';

      if (nameVal) this.profile.name = nameVal;
      if (schoolVal) this.profile.school = schoolVal;
      if (classVal) this.profile.className = classVal;
      this.store.savePlayerProfile(this.profile);

      this.localPlayerCount = localCountVal;
      this.blockTwoEnds = blockVal;
      this.sound.enabled = soundVal;
      this.showCoordinates = coordsVal;
      this.mp.setCustomWsUrl(wsUrlVal);

      this._syncProfileAndSettingsUI();
      this._rebuildBoardStateFromPage();
      this._showToast('Đã lưu cài đặt thành công!', 'info');
      this.showScreen('view-menu');
    });
  }

  _stepNotebookPage(delta) {
    if (this.mode === 'pvp-online') {
      const curr = this.mp?.roomState?.hostPageNumber || this.currentPageNumber;
      this.hostApplyPageForRoom(curr + delta);
      return;
    }

    const next = this.currentPageNumber + delta;
    if (next >= 1 && next <= TOTAL_NOTEBOOK_PAGES) {
      this.sound.playPageFlip();
      this.loadPage(next);
    }
  }

  async _updateCoopCreatePageBadge() {
    const input = document.getElementById('coop-create-page-select');
    const badge = document.getElementById('coop-create-page-info');
    if (!input || !badge) return;

    const pNum = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(input.value) || 1));
    const page = await this.store.getPage(pNum);
    const deadSet = new Set();
    for (const g of page.archivedGames || []) {
      for (const k of g.deadCells || []) deadSet.add(k);
    }
    const rawFree = Math.round(((BOARD_ROWS * BOARD_COLS - deadSet.size) / (BOARD_ROWS * BOARD_COLS)) * 100);
    const freePct = deadSet.size > 0 ? Math.min(99, Math.max(0, rawFree)) : 100;
    badge.textContent = page.archivedGames.length > 0
      ? `Đã khoanh ${page.archivedGames.length} ván | Trống ${freePct}%`
      : 'Giấy trắng tinh (100% trống)';
  }

  _syncProfileAndSettingsUI() {
    if (!this.profile) return;

    // Menu chính luôn hiển thị trang vở cá nhân của học sinh
    const mSchool = document.getElementById('menu-label-school');
    const mClass = document.getElementById('menu-label-class');
    const mName = document.getElementById('menu-label-name');
    const mPage = document.getElementById('menu-current-page');
    const mRule = document.getElementById('menu-rule-indicator');

    if (mSchool) mSchool.textContent = this.profile.school || 'THPT Chuyên Caro Việt Nam';
    if (mClass) mClass.textContent = this.profile.className || '12A1';
    if (mName) mName.textContent = this.profile.name || 'Học Sinh';
    if (mPage) mPage.textContent = `Trang ${this.personalPageNumber || this.currentPageNumber} / 200`;
    if (mRule) mRule.textContent = `Chặn 2 đầu: ${this.blockTwoEnds ? 'BẬT' : 'TẮT'}`;

    // Trang cài đặt
    const sName = document.getElementById('student-name-input');
    const sSchool = document.getElementById('student-school-input');
    const sClass = document.getElementById('student-class-input');
    const sLocal = document.getElementById('setting-local-count');
    const sBlock = document.getElementById('toggle-block-two-ends');
    const sSound = document.getElementById('toggle-sound-setting');
    const sCoords = document.getElementById('toggle-coords-setting');
    const sWs = document.getElementById('input-custom-ws');

    if (sName) sName.value = this.profile.name || '';
    if (sSchool) sSchool.value = this.profile.school || '';
    if (sClass) sClass.value = this.profile.className || '';
    if (sLocal) sLocal.value = String(this.localPlayerCount);
    if (sBlock) sBlock.checked = this.blockTwoEnds;
    if (sSound) sSound.checked = this.sound.enabled;
    if (sCoords) sCoords.checked = this.showCoordinates;
    if (sWs && this.mp) sWs.value = this.mp.customWsUrl || '';
  }

  _updateGameplayUI() {
    const turnBadge = document.getElementById('current-turn-badge');
    const modeDesc = document.getElementById('current-mode-desc');
    const moveCountEl = document.getElementById('current-move-count');
    const pageInput = document.getElementById('page-jump-input');
    const ownerPrefix = document.getElementById('topbar-owner-prefix');
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    const fenceBtn = document.getElementById('btn-fence-now');
    const undoBtn = document.getElementById('btn-undo-move');
    const coopDrawerBtn = document.getElementById('btn-toggle-coop-drawer');

    const sym = this.getCurrentTurnSymbol();
    const cfg = SYMBOL_CONFIG[sym] || SYMBOL_CONFIG.X;
    const activeCount = this.currentPageData?.activeGame?.moves?.length || 0;

    if (turnBadge) {
      if (this.aiThinking) {
        turnBadge.textContent = `✍️ Máy đang nghĩ...`;
        turnBadge.style.color = '#b45309';
      } else if (this.mode === 'pvp-online' && this.mp?.roomState) {
        const myPlayer = (this.mp.roomState.players || []).find(p => p.clientId === this.mp.clientId);
        const mySym = myPlayer?.symbol || 'SPECTATOR';
        if (mySym === 'SPECTATOR') {
          turnBadge.textContent = `👀 Khán giả | Lượt: ${cfg.name}`;
        } else if (mySym === sym) {
          turnBadge.textContent = `✍️ Lượt bạn (${mySym}) — ${cfg.name}`;
        } else {
          turnBadge.textContent = `Lượt: ${sym} (Bạn cầm: ${mySym})`;
        }
        turnBadge.style.color = cfg.color;
      } else {
        turnBadge.textContent = `Lượt: ${cfg.name}`;
        turnBadge.style.color = cfg.color;
      }
    }

    if (modeDesc) {
      if (this.mode === 'pve') {
        modeDesc.textContent = `${this._getAILevelTitle(this.aiLevel)}`;
      } else if (this.mode === 'pvp-local') {
        modeDesc.textContent = `Chung màn (${this.localPlayerCount} người)`;
      } else if (this.mp?.roomState) {
        modeDesc.textContent = `Bàn #${this.mp.roomState.roomId}`;
      }
    }

    if (this.mode === 'pvp-online' && this.mp?.roomState) {
      const room = this.mp.roomState;
      const isHost = this.mp.isHost();
      const canChangePage = isHost && (room.moves?.length || 0) === 0;
      const pageOwnerName = room.pageOwnerName || room.hostName;

      if (ownerPrefix) ownerPrefix.textContent = `Vở ${pageOwnerName} | Trang`;
      if (pageInput) {
        pageInput.value = room.hostPageNumber || 1;
        pageInput.disabled = !canChangePage;
      }
      if (prevBtn) prevBtn.disabled = !canChangePage;
      if (nextBtn) nextBtn.disabled = !canChangePage;
      if (fenceBtn) {
        fenceBtn.classList.toggle('hidden', !isHost);
        fenceBtn.disabled = (room.moves?.length || 0) === 0;
      }
      if (undoBtn) undoBtn.classList.add('hidden');
      if (coopDrawerBtn) coopDrawerBtn.classList.remove('hidden');
    } else {
      if (ownerPrefix) ownerPrefix.textContent = 'Trang';
      if (pageInput) {
        pageInput.value = this.currentPageNumber;
        pageInput.disabled = false;
      }
      if (prevBtn) prevBtn.disabled = false;
      if (nextBtn) nextBtn.disabled = false;
      if (fenceBtn) {
        fenceBtn.classList.remove('hidden');
        fenceBtn.disabled = activeCount === 0;
      }
      if (undoBtn) {
        undoBtn.classList.remove('hidden');
        undoBtn.disabled = activeCount === 0;
      }
      if (coopDrawerBtn) coopDrawerBtn.classList.add('hidden');
    }

    const totalCells = BOARD_ROWS * BOARD_COLS;
    const deadCount = this.deadSet.size;
    const usedTotal = deadCount + activeCount;
    const rawFree = Math.round(((totalCells - usedTotal) / totalCells) * 100);
    const freePercent = usedTotal > 0 ? Math.min(99, Math.max(0, rawFree)) : 100;

    const pageStatsEl = document.getElementById('current-page-stats');
    if (pageStatsEl) {
      const archivedCount = this.currentPageData?.archivedGames?.length || 0;
      pageStatsEl.textContent = `Đã khoanh: ${archivedCount} ván | Điểm chết: ${deadCount} ô | Trống: ${freePercent}%`;
    }

    if (moveCountEl) {
      moveCountEl.textContent = `Nước thứ: ${activeCount}`;
    }

    if (this.renderer) {
      this.renderer.setState({ currentTurnSymbol: sym });
    }
  }

  /**
   * Render Trang Lịch Sử & Quyển Vở 200 Trang
   */
  async _renderHistoryView() {
    const overview = this.store.getNotebookOverview();

    document.getElementById('stat-wins').textContent = this.profile.stats?.wins || 0;
    document.getElementById('stat-draws').textContent = this.profile.stats?.draws || 0;
    const bestAi = this.profile.stats?.highestAiBeaten || 0;
    document.getElementById('stat-best-ai').textContent = bestAi > 0 ? `Cấp ${bestAi}` : 'Chưa';
    document.getElementById('stat-used-pages').textContent = `${overview.usedPagesCount} / 200`;

    const summaryEl = document.getElementById('notebook-index-summary');
    if (summaryEl) {
      summaryEl.textContent = `Đã viết trên ${overview.usedPagesCount} / 200 trang — Tổng cộng ${overview.totalFinishedGames} ván cờ đã được khoanh vùng điểm chết.`;
    }

    const grid = document.getElementById('notebook-pages-grid');
    if (grid) {
      grid.innerHTML = '';
      const filtered = overview.pages.filter(p => {
        if (this.historyFilter === 'used') return p.gamesCount > 0 || p.hasActiveGame;
        if (this.historyFilter === 'empty') return p.gamesCount === 0 && !p.hasActiveGame;
        return true;
      });

      for (const p of filtered) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `page-cell-btn status-${p.status} ${p.pageNumber === this.historySelectedPage ? 'selected' : ''}`;
        btn.innerHTML = `
          <span class="page-cell-num">Trang ${p.pageNumber}</span>
          <span class="page-cell-meta">${p.gamesCount > 0 ? `${p.gamesCount} ván (${p.usedRatio}%)` : p.hasActiveGame ? 'Đang đánh' : 'Giấy trắng'}</span>
        `;
        btn.addEventListener('click', () => {
          this.historySelectedPage = p.pageNumber;
          this._renderHistoryView();
        });
        grid.appendChild(btn);
      }
    }

    // Chi tiết trang đang chọn bên cột phải
    const selectedPageData = await this.store.getPage(this.historySelectedPage);
    const deadSet = new Set();
    for (const g of selectedPageData.archivedGames || []) {
      for (const dc of g.deadCells || []) deadSet.add(dc);
    }
    const rawFree = Math.round(((BOARD_ROWS * BOARD_COLS - deadSet.size) / (BOARD_ROWS * BOARD_COLS)) * 100);
    const freePct = deadSet.size > 0 ? Math.min(99, Math.max(0, rawFree)) : 100;

    document.getElementById('history-selected-page-title').textContent = `Trang ${this.historySelectedPage} / 200`;
    document.getElementById('history-selected-page-meta').textContent =
      `Đã khoanh ${selectedPageData.archivedGames.length} ván | Trống ${freePct}%`;

    const listEl = document.getElementById('history-page-games-list');
    if (listEl) {
      if (selectedPageData.archivedGames.length === 0) {
        listEl.innerHTML = `<div class="hint-text">Trang ${this.historySelectedPage} hiện chưa có ván cờ nào bị khoanh vùng điểm chết.</div>`;
      } else {
        listEl.innerHTML = selectedPageData.archivedGames
          .map((g, idx) => {
            const timeStr = new Date(g.finishedAt).toLocaleString('vi-VN', {
              hour: '2-digit',
              minute: '2-digit',
              day: '2-digit',
              month: '2-digit'
            });
            const resText = g.winnerSymbol === 'DRAW' ? 'Hòa cờ' : `${g.winnerSymbol} thắng (${g.winnerName})`;
            return `
              <div class="archived-item">
                <div class="archived-item-head">
                  <strong>Ván #${idx + 1}: ${resText}</strong>
                  <span>${timeStr}</span>
                </div>
                <div class="archived-item-sub">
                  ${g.modeLabel} | ${g.moves?.length || 0} nước đi | Khoanh ${g.deadCells?.length || 0} ô điểm chết
                </div>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  _renderPublicRoomList(rooms) {
    const listEl = document.getElementById('public-rooms-list');
    if (!listEl) return;

    if (!rooms || rooms.length === 0) {
      listEl.innerHTML = `<div class="hint-text">Chưa có bàn nào đang mở. Hãy chọn trang vở của bạn và bấm "Mở Bàn Mới"!</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const r of rooms) {
      const row = document.createElement('div');
      row.className = 'room-list-item';
      const subLabel = r.subMode === 'team' ? 'Chia Phe X/O' : r.subMode === 'ffa' ? 'Hỗn Chiến 2–4' : 'Đấu 1v1';
      const ownerLabel = r.pageOwnerName || r.hostName;
      row.innerHTML = `
        <div>
          <strong>Bàn #${r.roomId}</strong> — <span>${subLabel}</span>
          <div class="hint-text">Vở của ${ownerLabel} (Trang ${r.hostPageNumber || 1}/200) | ${r.playerCount} bạn | Đã khoanh ${r.archivedCount} ván</div>
        </div>
        <button type="button" class="btn-primary">Vào</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        this.mp.joinRoom({ roomId: r.roomId, playerName: this.profile.name });
      });
      listEl.appendChild(row);
    }
  }

  _renderOnlineRoomPanel(room) {
    const outsideBox = document.getElementById('coop-outside-room');
    const insideBox = document.getElementById('coop-inside-room');
    if (!outsideBox || !insideBox) return;

    if (!room) {
      outsideBox.classList.remove('hidden');
      insideBox.classList.add('hidden');
      return;
    }

    outsideBox.classList.add('hidden');
    insideBox.classList.remove('hidden');

    const pageOwnerName = room.pageOwnerName || room.hostName;
    const hostSuffix = room.pageOwnerClientId && room.pageOwnerClientId !== room.hostClientId
      ? ` (Chủ bàn: ${room.hostName})`
      : '';

    document.getElementById('active-room-code').textContent = room.roomId;
    document.getElementById('active-room-title').textContent =
      `Vở của ${pageOwnerName}${hostSuffix} — Trang ${room.hostPageNumber || 1} / 200 (Đã khoanh ${room.archivedGames?.length || 0} ván)`;

    const subModeLabel = room.subMode === 'team'
      ? 'Co-op Chia Phe (Đội X vs Đội O luân phiên)'
      : room.subMode === 'ffa'
        ? 'Hỗn Chiến Nhiều Người (X, O, Δ, □)'
        : 'Đấu 1v1 Cổ Điển (+Khán giả)';
    document.getElementById('active-room-submode').textContent =
      `${subModeLabel} | Luật chặn 2 đầu: ${room.blockTwoEnds ? 'BẬT' : 'TẮT'}`;

    const isHost = this.mp.isHost();
    const inProgress = (room.moves?.length || 0) > 0;
    const hostControls = document.getElementById('host-room-controls');
    const hostPageInput = document.getElementById('input-host-room-page');
    const hostPrevBtn = document.getElementById('btn-host-prev-page');
    const hostNextBtn = document.getElementById('btn-host-next-page');
    const hostApplyBtn = document.getElementById('btn-host-apply-page');
    const hostBlockToggle = document.getElementById('coop-host-block-toggle');
    const lockNote = document.getElementById('host-control-lock-note');

    if (hostControls) {
      hostControls.classList.toggle('hidden', !isHost);
    }
    if (hostPageInput) {
      hostPageInput.value = room.hostPageNumber || 1;
      hostPageInput.disabled = inProgress;
    }
    if (hostPrevBtn) hostPrevBtn.disabled = inProgress;
    if (hostNextBtn) hostNextBtn.disabled = inProgress;
    if (hostApplyBtn) hostApplyBtn.disabled = inProgress;
    if (hostBlockToggle) {
      hostBlockToggle.checked = room.blockTwoEnds;
      hostBlockToggle.disabled = inProgress;
    }
    if (lockNote) {
      lockNote.textContent = inProgress
        ? 'Đang trong ván đấu (Khoanh ván hiện tại nếu muốn đổi trang)'
        : 'Chưa đánh nước đầu tiên — Chủ phòng có thể chọn trang vở bất kỳ (1–200)';
    }

    const playersContainer = document.getElementById('active-room-players');
    if (playersContainer) {
      playersContainer.innerHTML = room.players
        .map(p => {
          const isMe = p.clientId === this.mp.clientId;
          const roleBadge = p.symbol === 'SPECTATOR' ? '👀 Khán giả' : `Bút ${p.symbol}`;
          return `
            <div class="room-player-row ${isMe ? 'me' : ''}">
              <span>${p.isHost ? '👑 ' : ''}${p.name} ${isMe ? '(Bạn)' : ''}</span>
              <strong>${roleBadge}</strong>
            </div>
          `;
        })
        .join('');
    }

    const switchBox = document.getElementById('room-symbol-Readiness');
    if (switchBox) {
      const myPlayer = (room.players || []).find(p => p.clientId === this.mp.clientId);
      const mySym = myPlayer?.symbol || 'SPECTATOR';
      const allowedSymbols = room.subMode === 'ffa' ? ['X', 'O', 'Δ', '□', 'SPECTATOR'] : ['X', 'O', 'SPECTATOR'];

      switchBox.innerHTML = allowedSymbols
        .map(sym => {
          const isCurrent = sym === mySym;
          const occupiedByOther =
            (room.subMode === '1v1' || room.subMode === 'ffa') &&
            sym !== 'SPECTATOR' &&
            (room.players || []).some(p => p.clientId !== this.mp.clientId && p.symbol === sym);
          const lockedMidGame = inProgress && mySym !== 'SPECTATOR' && !isCurrent;
          const disabledAttr = (occupiedByOther || lockedMidGame) ? 'disabled' : '';
          const activeClass = isCurrent ? 'active' : '';
          const label = sym === 'SPECTATOR'
            ? (isCurrent ? '👀 Đang Xem' : '👀 Xem')
            : (isCurrent ? `✓ Bút ${sym}` : `Chọn Bút ${sym}`);
          return `<button type="button" class="btn-switch-sym ${activeClass}" data-sym="${sym}" ${disabledAttr}>${label}</button>`;
        })
        .join('');

      switchBox.querySelectorAll('.btn-switch-sym').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          this.mp.switchTeamOrSymbol(btn.dataset.sym);
        });
      });
    }
  }

  _sendCurrentChatInput() {
    const input = document.getElementById('input-chat-msg');
    if (!input || !input.value.trim()) return;
    this.mp.sendChat(input.value.trim());
    input.value = '';
  }

  _appendChatMessage({ sender, symbol, text }) {
    const log = document.getElementById('online-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.innerHTML = `<strong>[${symbol || '-'}] ${sender}:</strong> <span></span>`;
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
    if (this.currentView === 'view-game' && this.renderer) {
      this.renderer.resize();
    }
  }

  _hideEndBanner() {
    const banner = document.getElementById('game-end-banner');
    if (banner && !banner.classList.contains('hidden')) {
      banner.classList.add('hidden');
      if (this.currentView === 'view-game' && this.renderer) {
        this.renderer.resize();
      }
    }
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
      setTimeout(() => item.remove(), 260);
    }, 3000);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new CaroNotebookApp();
  window.caroApp = app;
  app.init();
});
