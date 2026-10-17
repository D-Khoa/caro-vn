/**
 * Client WebSocket thời gian thực siêu nhẹ cho chế độ PvP Co-op Online
 * - Tất cả người chơi cùng đại chiến trên Trang Vở Ô Ly của Chủ Phòng (Host's Notebook Page)
 * - Chủ phòng có thể chọn bất kỳ trang nào (1 -> 200) từ quyển vở của mình trước khi bắt đầu ván
 * - Hỗ trợ tự động chuyển sang BroadcastChannel Relay khi chạy trên GitHub Pages tĩnh
 */

import {
  BOARD_ROWS,
  BOARD_COLS,
  SYMBOLS,
  cellKey,
  isValidCell,
  checkWinAt,
  countPlayableCells,
  computeGameFenceAndDeadZone
} from './rules.js';

export class MultiplayerClient {
  constructor(handlers = {}) {
    this.ws = null;
    this.bc = null; // BroadcastChannel fallback cho GitHub Pages
    this.usingFallback = false;
    this.handlers = handlers;
    this.connected = false;
    this.clientId = `u_${Math.random().toString(36).slice(2, 8)}`;
    this.roomState = null;
    this.latencyMs = 0;
    this.pingTimer = null;
    this.pendingPingAt = 0;
    this.customWsUrl = localStorage.getItem('caro_vn_custom_ws_url') || '';
    this.localFallbackRooms = new Map();
  }

  setCustomWsUrl(url) {
    this.customWsUrl = (url || '').trim();
    try {
      if (this.customWsUrl) {
        localStorage.setItem('caro_vn_custom_ws_url', this.customWsUrl);
      } else {
        localStorage.removeItem('caro_vn_custom_ws_url');
      }
    } catch (_) {}
  }

  connect() {
    if (this.connected && (this.ws?.readyState === WebSocket.OPEN || this.usingFallback)) {
      return;
    }

    const isStaticGithubPages = window.location.hostname.endsWith('github.io') && !this.customWsUrl;
    if (isStaticGithubPages) {
      this._enableBroadcastChannelFallback();
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = this.customWsUrl || `${proto}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch (_) {
      this._enableBroadcastChannelFallback();
      return;
    }

    this.ws.onopen = () => {
      this.usingFallback = false;
      this.connected = true;
      this._startPingLoop();
      if (this.handlers.onConnectionChange) {
        this.handlers.onConnectionChange(true, 'server');
      }
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      this._handleMessage(msg);
    };

    this.ws.onclose = () => {
      if (!this.usingFallback) {
        this.connected = false;
        this._stopPingLoop();
        // Nếu không kết nối được WebSocket (VD trên static host), bật chế độ đồng bộ đa tab
        this._enableBroadcastChannelFallback();
      }
    };

    this.ws.onerror = () => {};
  }

  _enableBroadcastChannelFallback() {
    if (this.usingFallback && this.connected) return;
    if (typeof BroadcastChannel === 'undefined') {
      if (this.handlers.onConnectionChange) {
        this.handlers.onConnectionChange(false, 'offline');
      }
      return;
    }

    this.usingFallback = true;
    this.connected = true;
    this.latencyMs = 2;
    this.bc = new BroadcastChannel('caro_vn_coop_channel');
    this.bc.onmessage = (e) => {
      this._handleFallbackChannelMessage(e.data);
    };

    if (this.handlers.onConnectionChange) {
      this.handlers.onConnectionChange(true, 'local-channel');
    }
    if (this.handlers.onLatencyUpdate) {
      this.handlers.onLatencyUpdate(2, { onlineCount: 1, roomCount: this.localFallbackRooms.size });
    }
  }

  disconnect() {
    this._stopPingLoop();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.bc) {
      this.bc.close();
      this.bc = null;
    }
    this.connected = false;
    this.usingFallback = false;
    this.roomState = null;
  }

  _startPingLoop() {
    this._stopPingLoop();
    this.sendPing();
    this.pingTimer = setInterval(() => this.sendPing(), 3000);
  }

  _stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendPing() {
    this.pendingPingAt = performance.now();
    this.send({ type: 'ping', t: Date.now() });
  }

  send(payload) {
    if (this.usingFallback) {
      this._processFallbackAction(payload);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  createRoom({ playerName, subMode = '1v1', blockTwoEnds = true, pageNumber = 1, dateHeader = '', archivedGames = [] }) {
    this.connect();
    this._sendWhenReady({
      type: 'create_room',
      playerName,
      subMode,
      blockTwoEnds,
      pageNumber,
      dateHeader,
      archivedGames
    });
  }

  joinRoom({ roomId, playerName }) {
    this.connect();
    this._sendWhenReady({
      type: 'join_room',
      roomId: String(roomId).trim().toUpperCase(),
      playerName
    });
  }

  quickMatch({ playerName, subMode = '1v1', blockTwoEnds = true, pageNumber = 1, dateHeader = '', archivedGames = [] }) {
    this.connect();
    this._sendWhenReady({
      type: 'quick_match',
      playerName,
      subMode,
      blockTwoEnds,
      pageNumber,
      dateHeader,
      archivedGames
    });
  }

  selectHostPage({ pageNumber, dateHeader, archivedGames }) {
    this.send({
      type: 'host_select_page',
      pageNumber,
      dateHeader,
      archivedGames
    });
  }

  updateRoomSettings({ subMode, blockTwoEnds }) {
    this.send({
      type: 'host_update_settings',
      subMode,
      blockTwoEnds
    });
  }

  requestRoomList() {
    this.connect();
    this._sendWhenReady({ type: 'list_rooms' });
  }

  leaveRoom() {
    this.send({ type: 'leave_room' });
    this.roomState = null;
  }

  sendMove(r, c) {
    this.send({
      type: 'place_move',
      r,
      c,
      clientSentAt: Date.now()
    });
  }

  sendNewGameOnSamePage() {
    this.send({
      type: 'new_round_same_page'
    });
  }

  switchTeamOrSymbol(targetSymbol) {
    this.send({
      type: 'switch_symbol',
      symbol: targetSymbol
    });
  }

  sendChat(text) {
    this.send({
      type: 'chat',
      text: String(text).slice(0, 120)
    });
  }

  isHost() {
    return Boolean(this.roomState && this.roomState.hostClientId === this.clientId);
  }

  _sendWhenReady(payload) {
    if (this.usingFallback) {
      this._processFallbackAction(payload);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(payload);
    } else if (this.ws) {
      const onOpen = () => {
        this.ws?.removeEventListener('open', onOpen);
        this.send(payload);
      };
      this.ws.addEventListener('open', onOpen);
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.clientId = msg.clientId;
        if (this.handlers.onServerStats) {
          this.handlers.onServerStats(msg.stats);
        }
        break;

      case 'pong':
        if (this.pendingPingAt > 0) {
          this.latencyMs = Math.max(1, Math.round(performance.now() - this.pendingPingAt));
          if (this.handlers.onLatencyUpdate) {
            this.handlers.onLatencyUpdate(this.latencyMs, msg.stats);
          }
        }
        break;

      case 'room_list':
        if (this.handlers.onRoomList) {
          this.handlers.onRoomList(msg.rooms || [], msg.stats);
        }
        break;

      case 'room_state':
        this.roomState = msg.room;
        if (this.handlers.onRoomState) {
          this.handlers.onRoomState(msg.room);
        }
        break;

      case 'host_page_changed':
        this.roomState = msg.room;
        if (this.handlers.onHostPageChanged) {
          this.handlers.onHostPageChanged(msg);
        }
        if (this.handlers.onRoomState) {
          this.handlers.onRoomState(msg.room);
        }
        break;

      case 'move_made':
        this.roomState = msg.room;
        if (this.handlers.onMoveMade) {
          this.handlers.onMoveMade(msg.move, msg.room);
        }
        break;

      case 'game_over':
        this.roomState = msg.room;
        if (this.handlers.onGameOver) {
          this.handlers.onGameOver(msg.result, msg.room);
        }
        break;

      case 'chat_message':
        if (this.handlers.onChat) {
          this.handlers.onChat(msg);
        }
        break;

      case 'error_msg':
        if (this.handlers.onError) {
          this.handlers.onError(msg.message);
        }
        break;
    }
  }

  /* ============================================================================
   * Chế độ Đồng bộ Đa Tab (BroadcastChannel) khi chạy trên GitHub Pages tĩnh
   * ============================================================================ */
  _processFallbackAction(payload) {
    switch (payload.type) {
      case 'create_room':
      case 'quick_match': {
        const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
        const room = {
          roomId,
          hostClientId: this.clientId,
          hostName: payload.playerName || 'Chủ Phòng',
          hostPageNumber: payload.pageNumber || 1,
          hostDateHeader: payload.dateHeader || '',
          subMode: payload.subMode || '1v1',
          blockTwoEnds: Boolean(payload.blockTwoEnds),
          activeSymbols: ['X', 'O'],
          currentTurnSymbol: 'X',
          turnIndex: 0,
          moves: [],
          archivedGames: payload.archivedGames || [],
          activeGameId: `local_online_${Date.now()}`,
          players: [
            {
              clientId: this.clientId,
              name: payload.playerName || 'Chủ Phòng',
              symbol: 'X',
              isHost: true
            }
          ]
        };
        this.localFallbackRooms.set(roomId, room);
        this.roomState = room;
        this._broadcastFallback({ type: 'sync_room', room });
        this._handleMessage({ type: 'room_state', room });
        break;
      }

      case 'list_rooms': {
        this._broadcastFallback({ type: 'query_rooms', requester: this.clientId });
        const list = Array.from(this.localFallbackRooms.values()).map(r => ({
          roomId: r.roomId,
          hostName: r.hostName,
          hostPageNumber: r.hostPageNumber,
          subMode: r.subMode,
          playerCount: r.players.length,
          archivedCount: r.archivedGames.length,
          inProgress: r.moves.length > 0
        }));
        this._handleMessage({ type: 'room_list', rooms: list, stats: { onlineCount: list.length + 1, roomCount: list.length } });
        break;
      }

      case 'join_room': {
        const r = this.localFallbackRooms.get(payload.roomId);
        if (!r) {
          this._broadcastFallback({
            type: 'request_join',
            roomId: payload.roomId,
            clientId: this.clientId,
            playerName: payload.playerName || 'Người chơi'
          });
          return;
        }
        this._addPlayerToFallbackRoom(r, this.clientId, payload.playerName || 'Người chơi');
        break;
      }

      case 'host_select_page': {
        if (!this.roomState || this.roomState.hostClientId !== this.clientId) return;
        if (this.roomState.moves.length > 0) {
          this._handleMessage({ type: 'error_msg', message: 'Hãy khoanh ván đang đánh trước khi đổi trang vở!' });
          return;
        }
        this.roomState.hostPageNumber = payload.pageNumber;
        this.roomState.hostDateHeader = payload.dateHeader || '';
        this.roomState.archivedGames = payload.archivedGames || [];
        this.roomState.moves = [];
        this.roomState.turnIndex = 0;
        const msg = {
          type: 'host_page_changed',
          pageNumber: payload.pageNumber,
          hostName: this.roomState.hostName,
          room: this.roomState
        };
        this._broadcastFallback(msg);
        this._handleMessage(msg);
        break;
      }

      case 'host_update_settings': {
        if (!this.roomState || this.roomState.hostClientId !== this.clientId) return;
        if (payload.blockTwoEnds !== undefined) this.roomState.blockTwoEnds = Boolean(payload.blockTwoEnds);
        if (payload.subMode) this.roomState.subMode = payload.subMode;
        this._broadcastFallback({ type: 'sync_room', room: this.roomState });
        this._handleMessage({ type: 'room_state', room: this.roomState });
        break;
      }

      case 'switch_symbol': {
        if (!this.roomState) return;
        const me = this.roomState.players.find(p => p.clientId === this.clientId);
        if (me) {
          me.symbol = payload.symbol;
          this._recomputeFallbackActiveSymbols(this.roomState);
          this._broadcastFallback({ type: 'sync_room', room: this.roomState });
          this._handleMessage({ type: 'room_state', room: this.roomState });
        }
        break;
      }

      case 'place_move': {
        if (!this.roomState) return;
        const me = this.roomState.players.find(p => p.clientId === this.clientId);
        if (!me || me.symbol === 'SPECTATOR') {
          this._handleMessage({ type: 'error_msg', message: 'Bạn đang là Khán giả!' });
          return;
        }
        if (me.symbol !== this.roomState.currentTurnSymbol) {
          this._handleMessage({ type: 'error_msg', message: `Đang là lượt của phe ${this.roomState.currentTurnSymbol}!` });
          return;
        }

        const r = Number(payload.r);
        const c = Number(payload.c);
        if (!isValidCell(r, c, BOARD_ROWS, BOARD_COLS)) return;

        const deadSet = new Set();
        for (const g of this.roomState.archivedGames || []) {
          for (const dc of g.deadCells || []) deadSet.add(dc);
        }
        if (deadSet.has(cellKey(r, c))) return;
        if (this.roomState.moves.some(m => m.r === r && m.c === c)) return;

        const moveObj = {
          r,
          c,
          symbol: me.symbol,
          playerName: me.name,
          moveNumber: this.roomState.moves.length + 1
        };
        this.roomState.moves.push(moveObj);

        const board = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
        for (const m of this.roomState.moves) board[m.r][m.c] = m.symbol;

        this.roomState.turnIndex = (this.roomState.turnIndex + 1) % this.roomState.activeSymbols.length;
        this.roomState.currentTurnSymbol = this.roomState.activeSymbols[this.roomState.turnIndex];

        const winCheck = checkWinAt(board, r, c, {
          blockTwoEnds: this.roomState.blockTwoEnds,
          deadSet,
          rows: BOARD_ROWS,
          cols: BOARD_COLS
        });

        if (winCheck.won) {
          const { deadCells, contours } = computeGameFenceAndDeadZone(this.roomState.moves, deadSet, BOARD_ROWS, BOARD_COLS);
          this.roomState.archivedGames.push({
            id: this.roomState.activeGameId,
            gameIndexOnPage: this.roomState.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${this.roomState.roomId} (Vở ${this.roomState.hostName})`,
            blockTwoEnds: this.roomState.blockTwoEnds,
            winnerSymbol: me.symbol,
            winnerName: me.name,
            winLine: winCheck.line,
            moves: [...this.roomState.moves],
            deadCells,
            contours,
            finishedAt: Date.now()
          });
          this.roomState.moves = [];
          this.roomState.turnIndex = 0;
          this.roomState.currentTurnSymbol = this.roomState.activeSymbols[0];
          const overMsg = {
            type: 'game_over',
            result: { winnerSymbol: me.symbol, winnerName: me.name, winLine: winCheck.line },
            room: this.roomState
          };
          this._broadcastFallback(overMsg);
          this._handleMessage(overMsg);
          return;
        }

        const moveMsg = { type: 'move_made', move: moveObj, room: this.roomState };
        this._broadcastFallback(moveMsg);
        this._handleMessage(moveMsg);
        break;
      }

      case 'new_round_same_page': {
        if (!this.roomState || this.roomState.hostClientId !== this.clientId || this.roomState.moves.length === 0) return;
        const deadSet = new Set();
        for (const g of this.roomState.archivedGames || []) {
          for (const dc of g.deadCells || []) deadSet.add(dc);
        }
        const { deadCells, contours } = computeGameFenceAndDeadZone(this.roomState.moves, deadSet, BOARD_ROWS, BOARD_COLS);
        this.roomState.archivedGames.push({
          id: this.roomState.activeGameId,
          gameIndexOnPage: this.roomState.archivedGames.length + 1,
          mode: 'pvp-online',
          modeLabel: `Co-op Phòng #${this.roomState.roomId} (Vở ${this.roomState.hostName})`,
          blockTwoEnds: this.roomState.blockTwoEnds,
          winnerSymbol: 'DRAW',
          winnerName: 'Chủ phòng khoanh sớm',
          winLine: null,
          moves: [...this.roomState.moves],
          deadCells,
          contours,
          finishedAt: Date.now()
        });
        this.roomState.moves = [];
        this.roomState.turnIndex = 0;
        this.roomState.currentTurnSymbol = this.roomState.activeSymbols[0];
        const overMsg = {
          type: 'game_over',
          result: { winnerSymbol: 'DRAW', winnerName: 'Chủ phòng đã khoanh vùng ván cờ' },
          room: this.roomState
        };
        this._broadcastFallback(overMsg);
        this._handleMessage(overMsg);
        break;
      }

      case 'chat': {
        if (!this.roomState) return;
        const me = this.roomState.players.find(p => p.clientId === this.clientId);
        const chatMsg = {
          type: 'chat_message',
          roomId: this.roomState.roomId,
          sender: me ? me.name : 'Người chơi',
          symbol: me ? me.symbol : '•',
          text: payload.text
        };
        this._broadcastFallback(chatMsg);
        this._handleMessage(chatMsg);
        break;
      }
    }
  }

  _recomputeFallbackActiveSymbols(room) {
    if (room.subMode === 'ffa') {
      const present = SYMBOLS.filter(s => room.players.some(p => p.symbol === s));
      room.activeSymbols = present.length >= 2 ? present : ['X', 'O'];
    } else {
      room.activeSymbols = ['X', 'O'];
    }
    room.currentTurnSymbol = room.activeSymbols[room.turnIndex % room.activeSymbols.length] || 'X';
  }

  _addPlayerToFallbackRoom(room, clientId, playerName) {
    if (!room.players.some(p => p.clientId === clientId)) {
      let sym = 'O';
      if (room.subMode === '1v1') {
        const hasX = room.players.some(p => p.symbol === 'X');
        const hasO = room.players.some(p => p.symbol === 'O');
        sym = !hasX ? 'X' : !hasO ? 'O' : 'SPECTATOR';
      } else if (room.subMode === 'ffa') {
        sym = SYMBOLS.find(s => !room.players.some(p => p.symbol === s)) || 'SPECTATOR';
      } else {
        const countX = room.players.filter(p => p.symbol === 'X').length;
        const countO = room.players.filter(p => p.symbol === 'O').length;
        sym = countX <= countO ? 'X' : 'O';
      }
      room.players.push({ clientId, name: playerName, symbol: sym, isHost: false });
    }
    this._recomputeFallbackActiveSymbols(room);
    this.roomState = room;
    this._broadcastFallback({ type: 'sync_room', room });
    this._handleMessage({ type: 'room_state', room });
  }

  _broadcastFallback(msg) {
    if (this.bc) {
      this.bc.postMessage(msg);
    }
  }

  _handleFallbackChannelMessage(msg) {
    if (!msg) return;
    if (msg.type === 'query_rooms' && this.roomState && this.roomState.hostClientId === this.clientId) {
      this._broadcastFallback({ type: 'advertise_room', room: this.roomState });
    } else if (msg.type === 'advertise_room' && msg.room) {
      this.localFallbackRooms.set(msg.room.roomId, msg.room);
      const list = Array.from(this.localFallbackRooms.values()).map(r => ({
        roomId: r.roomId,
        hostName: r.hostName,
        hostPageNumber: r.hostPageNumber,
        subMode: r.subMode,
        playerCount: r.players.length,
        archivedCount: r.archivedGames.length,
        inProgress: r.moves.length > 0
      }));
      this._handleMessage({ type: 'room_list', rooms: list, stats: { onlineCount: list.length + 1, roomCount: list.length } });
    } else if (msg.type === 'request_join' && this.roomState && this.roomState.roomId === msg.roomId && this.roomState.hostClientId === this.clientId) {
      this._addPlayerToFallbackRoom(this.roomState, msg.clientId, msg.playerName);
    } else if (msg.type === 'sync_room' && msg.room) {
      this.localFallbackRooms.set(msg.room.roomId, msg.room);
      if (this.roomState && this.roomState.roomId === msg.room.roomId) {
        this._handleMessage({ type: 'room_state', room: msg.room });
      } else if (msg.room.players.some(p => p.clientId === this.clientId)) {
        this._handleMessage({ type: 'room_state', room: msg.room });
      }
    } else if (['host_page_changed', 'move_made', 'game_over'].includes(msg.type) && msg.room && this.roomState?.roomId === msg.room.roomId) {
      this._handleMessage(msg);
    } else if (msg.type === 'chat_message' && this.roomState && msg.roomId === this.roomState.roomId) {
      this._handleMessage(msg);
    }
  }
}
