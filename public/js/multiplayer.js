/**
 * Client WebSocket thời gian thực siêu nhẹ cho chế độ PvP Co-op Online
 * Hỗ trợ:
 * - Đấu 1v1 Online (có khán giả)
 * - Co-op Chia Phe (Đội X vs Đội O nhiều người luân phiên đánh)
 * - Hỗn Chiến Nhiều Người (2 - 4 người chơi độc lập: X, O, Δ, □)
 * - Đồng bộ vùng khoanh Điểm Chết trên trang vở ô ly & Đo độ trễ (Ping < 3s)
 */

export class MultiplayerClient {
  constructor(handlers = {}) {
    this.ws = null;
    this.handlers = handlers;
    this.connected = false;
    this.clientId = null;
    this.roomState = null;
    this.latencyMs = 0;
    this.pingTimer = null;
    this.pendingPingAt = 0;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this._startPingLoop();
      if (this.handlers.onConnectionChange) {
        this.handlers.onConnectionChange(true);
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
      this.connected = false;
      this._stopPingLoop();
      if (this.handlers.onConnectionChange) {
        this.handlers.onConnectionChange(false);
      }
    };

    this.ws.onerror = () => {
      // Handled by onclose
    };
  }

  disconnect() {
    this._stopPingLoop();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  createRoom({ playerName, subMode = '1v1', blockTwoEnds = true, archivedGames = [] }) {
    this.connect();
    this._sendWhenReady({
      type: 'create_room',
      playerName,
      subMode,
      blockTwoEnds,
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

  quickMatch({ playerName, subMode = '1v1', blockTwoEnds = true, archivedGames = [] }) {
    this.connect();
    this._sendWhenReady({
      type: 'quick_match',
      playerName,
      subMode,
      blockTwoEnds,
      archivedGames
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

  sendNewGameOnSamePage(archivedGames = []) {
    this.send({
      type: 'new_round_same_page',
      archivedGames
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

  _sendWhenReady(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(payload);
    } else if (this.ws) {
      const onOpen = () => {
        this.ws.removeEventListener('open', onOpen);
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

      case 'move_made':
        if (this.roomState) {
          this.roomState = msg.room;
        }
        if (this.handlers.onMoveMade) {
          this.handlers.onMoveMade(msg.move, msg.room);
        }
        break;

      case 'game_over':
        if (this.roomState) {
          this.roomState = msg.room;
        }
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
}
