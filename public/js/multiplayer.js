/**
 * Client WebSocket & Cloud Relay thời gian thực cho chế độ PvP Co-op Online
 * - Tất cả người chơi cùng đại chiến trên Trang Vở Ô Ly của Chủ Phòng (Host's Notebook Page)
 * - Chủ phòng có thể chọn bất kỳ trang nào (1 -> 200) từ quyển vở của mình trước khi bắt đầu ván
 * - Hỗ trợ 2 chế độ kết nối tự động:
 *   1. Dedicated Node.js WebSocket Server (/ws) khi chạy local hoặc server riêng (< 25ms)
 *   2. Serverless Multi-Relay (Global WSS MQTT Relay + BroadcastChannel + LocalStorage Registry)
 *      giúp tìm thấy bàn của nhau xuyên trình duyệt, xuyên tab và xuyên thiết bị ngay cả trên GitHub Pages tĩnh!
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

const SHARED_STORAGE_KEY = 'caro_vn_shared_rooms_v2';
const CLOUD_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];
const CLOUD_TOPIC = 'carovn/v2/coop_bus';

export class MultiplayerClient {
  constructor(handlers = {}) {
    this.ws = null;
    this.bc = null;
    this.mqttWs = null;
    this.mqttConnected = false;
    this.mqttBrokerIdx = 0;
    this.mqttPingTimer = null;
    this.hostAdvertiseTimer = null;

    this.usingFallback = false;
    this.serverHandshakeVerified = false;
    this.welcomeTimer = null;
    this.handlers = handlers;
    this.connected = false;
    this.clientId = `u_${Math.random().toString(36).slice(2, 9)}`;
    this.roomState = null;
    this.latencyMs = 0;
    this.pingTimer = null;
    this.pendingPingAt = 0;
    this.customWsUrl = localStorage.getItem('caro_vn_custom_ws_url') || '';

    this.pendingPayloads = [];
    this.localFallbackRooms = new Map();
    this.seenRelayMsgIds = new Set();

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        if (this.roomState) {
          this.leaveRoom();
        }
      });
    }
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
    if (this.usingFallback && this.connected) {
      this._flushPendingPayloads();
      return;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      if (this.ws.readyState === WebSocket.OPEN && this.serverHandshakeVerified) {
        this._flushPendingPayloads();
      }
      return;
    }

    const isStaticGithubPages =
      window.location.hostname.endsWith('github.io') && !this.customWsUrl;
    if (isStaticGithubPages) {
      this._enableBroadcastChannelFallback();
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = this.customWsUrl;
    if (!url) {
      const isLocalHost =
        window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      // Nếu người chơi đang mở webgame qua VS Code Live Server hoặc static dev server (port khác 3000):
      // Ưu tiên trỏ tới WebSocket Game Server tại cổng 3000. Nếu cổng 3000 không chạy,
      // socket sẽ đóng ngay lập tức và tự động chuyển sang cơ chế Fallback (BroadcastChannel + Cloud MQTT)
      if (isLocalHost && window.location.port && window.location.port !== '3000') {
        url = `${proto}//${window.location.hostname}:3000/ws`;
      } else {
        url = `${proto}//${window.location.host}/ws`;
      }
    }

    let socket;
    try {
      socket = new WebSocket(url);
      this.ws = socket;
    } catch (_) {
      this._enableBroadcastChannelFallback();
      return;
    }

    // Đặt bộ đếm thời gian kiểm tra bắt tay (handshake timeout):
    // Nếu trong vòng 1200ms socket không nhận được bản tin 'welcome' từ Game Server thực sự
    // (ví dụ cổng WebSocket live-reload của VS Code Live Server/Vite), tự động ngắt và kích hoạt Fallback
    if (this.welcomeTimer) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
    this.welcomeTimer = setTimeout(() => {
      if (this.ws === socket && !this.serverHandshakeVerified) {
        try {
          socket.close();
        } catch (_) {}
        this.ws = null;
        this.serverHandshakeVerified = false;
        this._enableBroadcastChannelFallback();
      }
    }, 1200);

    socket.onopen = () => {
      if (this.ws !== socket) return;
      // Chờ gói tin 'welcome' từ Caro Game Server để xác thực server trước khi flush payloads
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (msg.type === 'welcome') {
        if (this.welcomeTimer) {
          clearTimeout(this.welcomeTimer);
          this.welcomeTimer = null;
        }
        this.serverHandshakeVerified = true;
        this.usingFallback = false;
        this.connected = true;
        this._startPingLoop();
        if (this.handlers.onConnectionChange) {
          this.handlers.onConnectionChange(true, 'server');
        }
        this._flushPendingPayloads();
      }

      this._handleMessage(msg);
    };

    socket.onclose = () => {
      if (this.welcomeTimer) {
        clearTimeout(this.welcomeTimer);
        this.welcomeTimer = null;
      }
      if (this.ws !== socket) return;
      this.ws = null;
      this.serverHandshakeVerified = false;
      if (!this.usingFallback) {
        this.connected = false;
        this._stopPingLoop();
        this._enableBroadcastChannelFallback();
      }
    };

    socket.onerror = () => {};
  }

  _flushPendingPayloads() {
    if (!this.pendingPayloads.length) return;
    const queue = this.pendingPayloads.splice(0, this.pendingPayloads.length);
    for (const payload of queue) {
      this.send(payload);
    }
  }

  _enableBroadcastChannelFallback() {
    if (this.usingFallback && this.connected) {
      this._flushPendingPayloads();
      return;
    }

    this.usingFallback = true;
    this.connected = true;
    this.latencyMs = 12;

    // 1. Kênh đồng bộ giữa các Tab cùng trình duyệt
    if (typeof BroadcastChannel !== 'undefined' && !this.bc) {
      this.bc = new BroadcastChannel('caro_vn_coop_channel');
      this.bc.onmessage = (e) => {
        this._handleFallbackChannelMessage(e.data);
      };
    }

    // 2. Kênh đồng bộ qua LocalStorage (giúp tab mở sau nhìn thấy ngay bàn đã tạo trước đó)
    this._loadRoomsFromLocalStorage();
    if (!this._storageListenerBound) {
      this._storageListenerBound = true;
      window.addEventListener('storage', (e) => {
        if (e.key === SHARED_STORAGE_KEY) {
          this._loadRoomsFromLocalStorage();
          this._emitFallbackRoomList();
        } else if (e.key === 'caro_vn_coop_event' && e.newValue) {
          try {
            const evt = JSON.parse(e.newValue);
            this._handleFallbackChannelMessage(evt);
          } catch (_) {}
        }
      });
    }

    // 3. Kênh Cloud Relay (MQTT over WSS) giúp tìm thấy bàn giữa các trình duyệt/thiết bị khác nhau trên GitHub Pages
    this._connectCloudMqttRelay();

    // Định kỳ Chủ Phòng phát tín hiệu quảng bá bàn để người mới vào sảnh luôn thấy bàn
    if (!this.hostAdvertiseTimer) {
      this.hostAdvertiseTimer = setInterval(() => {
        this._pruneStaleFallbackRooms();
        if (this.usingFallback && this.roomState && this.roomState.hostClientId === this.clientId) {
          this.roomState.updatedAt = Date.now();
          this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
          this._saveRoomsToLocalStorage();
          this._broadcastFallback({ type: 'advertise_room', room: this.roomState });
        }
      }, 3500);
    }

    if (this.handlers.onConnectionChange) {
      this.handlers.onConnectionChange(true, 'local-channel');
    }
    if (this.handlers.onLatencyUpdate) {
      this.handlers.onLatencyUpdate(this.latencyMs, {
        onlineCount: Math.max(1, this.localFallbackRooms.size + 1),
        roomCount: this.localFallbackRooms.size
      });
    }

    this._flushPendingPayloads();
    this._emitFallbackRoomList();
  }

  /* ============================================================================
   * Cloud MQTT-over-WebSocket Relay (0 dependencies, hỗ trợ GitHub Pages & Xuyên thiết bị)
   * ============================================================================ */
  _connectCloudMqttRelay() {
    if (this.mqttWs && (this.mqttWs.readyState === WebSocket.OPEN || this.mqttWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const brokerUrl = CLOUD_BROKERS[this.mqttBrokerIdx % CLOUD_BROKERS.length];
    let ws;
    try {
      ws = new WebSocket(brokerUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.mqttWs = ws;
    } catch (_) {
      return;
    }

    ws.onopen = () => {
      if (this.mqttWs !== ws) return;
      // Gửi gói MQTT CONNECT (Protocol MQTT 3.1.1)
      const clientIdStr = `carovn_${this.clientId}_${Math.random().toString(36).slice(2, 6)}`;
      const connectPkt = this._buildMqttConnectPacket(clientIdStr);
      ws.send(connectPkt);
    };

    ws.onmessage = (evt) => {
      if (this.mqttWs !== ws) return;
      const bytes = new Uint8Array(evt.data);
      if (bytes.length < 2) return;
      const pktType = bytes[0] & 0xf0;

      // CONNACK (0x20)
      if (pktType === 0x20) {
        this.mqttConnected = true;
        this.latencyMs = 35;
        if (this.handlers.onConnectionChange) {
          this.handlers.onConnectionChange(true, 'server');
        }
        ws.send(this._buildMqttSubscribePacket(CLOUD_TOPIC));
        // Hỏi danh sách phòng ngay khi lên mây
        this._broadcastFallback({ type: 'query_rooms', requester: this.clientId });
        if (this.roomState && this.roomState.hostClientId === this.clientId) {
          this._broadcastFallback({ type: 'advertise_room', room: this.roomState });
        }

        if (this.mqttPingTimer) clearInterval(this.mqttPingTimer);
        this.mqttPingTimer = setInterval(() => {
          if (this.mqttWs && this.mqttWs.readyState === WebSocket.OPEN) {
            this.mqttWs.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
          }
        }, 25000);
      } else if (pktType === 0x30) {
        // PUBLISH (0x30)
        const parsed = this._parseMqttPublishPacket(bytes);
        if (parsed) {
          try {
            const msgObj = JSON.parse(parsed.payload);
            this._handleFallbackChannelMessage(msgObj);
          } catch (_) {}
        }
      }
    };

    ws.onclose = () => {
      if (this.mqttWs !== ws) return;
      this.mqttConnected = false;
      this.mqttWs = null;
      if (this.mqttPingTimer) {
        clearInterval(this.mqttPingTimer);
        this.mqttPingTimer = null;
      }
      if (this.usingFallback) {
        this.mqttBrokerIdx = (this.mqttBrokerIdx + 1) % CLOUD_BROKERS.length;
        setTimeout(() => {
          if (this.usingFallback) this._connectCloudMqttRelay();
        }, 3000);
      }
    };

    ws.onerror = () => {};
  }

  _encodeMqttLength(len) {
    const out = [];
    do {
      let digit = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) digit |= 0x80;
      out.push(digit);
    } while (len > 0);
    return out;
  }

  _encodeUtf8(str) {
    return new TextEncoder().encode(str);
  }

  _buildMqttConnectPacket(clientId) {
    const idBytes = this._encodeUtf8(clientId);
    const varHeader = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c];
    const payload = [idBytes.length >> 8, idBytes.length & 0xff, ...idBytes];
    const remLen = varHeader.length + payload.length;
    return new Uint8Array([0x10, ...this._encodeMqttLength(remLen), ...varHeader, ...payload]);
  }

  _buildMqttSubscribePacket(topic) {
    const topicBytes = this._encodeUtf8(topic);
    const payload = [0x00, 0x01, topicBytes.length >> 8, topicBytes.length & 0xff, ...topicBytes, 0x00];
    return new Uint8Array([0x82, ...this._encodeMqttLength(payload.length), ...payload]);
  }

  _buildMqttPublishPacket(topic, jsonStr) {
    const topicBytes = this._encodeUtf8(topic);
    const msgBytes = this._encodeUtf8(jsonStr);
    const remLen = 2 + topicBytes.length + msgBytes.length;
    const header = [0x30, ...this._encodeMqttLength(remLen), topicBytes.length >> 8, topicBytes.length & 0xff];
    const pkt = new Uint8Array(header.length + topicBytes.length + msgBytes.length);
    pkt.set(header, 0);
    pkt.set(topicBytes, header.length);
    pkt.set(msgBytes, header.length + topicBytes.length);
    return pkt;
  }

  _parseMqttPublishPacket(bytes) {
    let idx = 1;
    let multiplier = 1;
    let remLen = 0;
    while (idx < bytes.length) {
      const b = bytes[idx++];
      remLen += (b & 0x7f) * multiplier;
      if ((b & 0x80) === 0) break;
      multiplier *= 128;
    }
    if (idx + 2 > bytes.length) return null;
    const topicLen = (bytes[idx] << 8) | bytes[idx + 1];
    idx += 2;
    const qos = (bytes[0] >> 1) & 0x03;
    const payloadStart = idx + topicLen + (qos > 0 ? 2 : 0);
    if (payloadStart > bytes.length) return null;
    const payload = new TextDecoder().decode(bytes.subarray(payloadStart));
    return { payload };
  }

  _loadRoomsFromLocalStorage() {
    try {
      const raw = localStorage.getItem(SHARED_STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      for (const [roomId, room] of Object.entries(obj)) {
        if (room && room.roomId && now - (room.updatedAt || 0) < 30000) {
          if (!this.localFallbackRooms.has(roomId) || (room.updatedAt || 0) >= (this.localFallbackRooms.get(roomId)?.updatedAt || 0)) {
            this.localFallbackRooms.set(roomId, room);
          }
        }
      }
    } catch (_) {}
  }

  _saveRoomsToLocalStorage() {
    try {
      this._pruneStaleFallbackRooms();
      const obj = {};
      for (const [roomId, room] of this.localFallbackRooms.entries()) {
        obj[roomId] = room;
      }
      localStorage.setItem(SHARED_STORAGE_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  _pruneStaleFallbackRooms() {
    const now = Date.now();
    for (const [roomId, room] of this.localFallbackRooms.entries()) {
      if (this.roomState && this.roomState.roomId === roomId) continue;
      if (now - (room.updatedAt || now) > 25000) {
        this.localFallbackRooms.delete(roomId);
      }
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
    if (this.mqttWs) {
      this.mqttWs.close();
      this.mqttWs = null;
    }
    if (this.mqttPingTimer) {
      clearInterval(this.mqttPingTimer);
      this.mqttPingTimer = null;
    }
    if (this.hostAdvertiseTimer) {
      clearInterval(this.hostAdvertiseTimer);
      this.hostAdvertiseTimer = null;
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.serverHandshakeVerified) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.pendingPayloads.push(payload);
      this.connect();
    }
  }

  createRoom({ playerName, subMode = '1v1', blockTwoEnds = true, pageNumber = 1, dateHeader = '', archivedGames = [] }) {
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
    this._sendWhenReady({
      type: 'join_room',
      roomId: String(roomId).trim().toUpperCase(),
      playerName
    });
  }

  quickMatch({ playerName, subMode = '1v1', blockTwoEnds = true, pageNumber = 1, dateHeader = '', archivedGames = [] }) {
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

  startCoopGame() {
    this.send({
      type: 'start_coop_game'
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

  isPageOwner() {
    if (!this.roomState) return false;
    const ownerId = this.roomState.pageOwnerClientId || this.roomState.hostClientId;
    return ownerId === this.clientId;
  }

  _sendWhenReady(payload) {
    if (this.usingFallback) {
      this._processFallbackAction(payload);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.serverHandshakeVerified) {
      this.send(payload);
      return;
    }
    this.pendingPayloads.push(payload);
    this.connect();
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
          this.handlers.onRoomState(msg.room, msg.notice || null);
        }
        break;

      case 'coop_game_started':
        this.roomState = msg.room;
        if (this.handlers.onGameStarted) {
          this.handlers.onGameStarted(msg);
        }
        break;

      case 'host_page_changed':
        this.roomState = msg.room;
        if (this.handlers.onHostPageChanged) {
          this.handlers.onHostPageChanged(msg);
        }
        if (this.handlers.onRoomState) {
          this.handlers.onRoomState(msg.room, null);
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
   * Chế độ Đồng bộ Đa Kênh (Cloud MQTT + BroadcastChannel + LocalStorage)
   * ============================================================================ */
  _isFallbackRoomJoinable(r) {
    const activeCount = (r.players || []).filter(p => p.symbol && p.symbol !== 'SPECTATOR').length;
    if (r.subMode === '1v1') return activeCount < 2;
    if (r.subMode === 'team') return activeCount < 8;
    if (r.subMode === 'ffa') return activeCount < 4;
    return activeCount < 2;
  }

  _emitFallbackRoomList() {
    this._pruneStaleFallbackRooms();
    const list = Array.from(this.localFallbackRooms.values()).map(r => ({
      roomId: r.roomId,
      hostName: r.hostName,
      pageOwnerName: r.pageOwnerName || r.hostName,
      hostPageNumber: r.hostPageNumber,
      subMode: r.subMode,
      playerCount: r.players?.length || 1,
      archivedCount: r.archivedGames?.length || 0,
      inProgress: (r.moves?.length || 0) > 0
    }));
    this._handleMessage({
      type: 'room_list',
      rooms: list,
      stats: { onlineCount: Math.max(1, list.length + 1), roomCount: list.length }
    });
  }

  _leaveFallbackRoomInternal() {
    if (!this.roomState) return;
    const leavingRoomId = this.roomState.roomId;
    const r = this.localFallbackRooms.get(leavingRoomId) || this.roomState;
    const leavingPlayer = (r.players || []).find(p => p.clientId === this.clientId);
    r.players = (r.players || []).filter(p => p.clientId !== this.clientId);

    if (r.players.length === 0) {
      this.localFallbackRooms.delete(leavingRoomId);
      this._saveRoomsToLocalStorage();
      this._broadcastFallback({ type: 'room_closed', roomId: leavingRoomId });
    } else {
      let notice = leavingPlayer ? `${leavingPlayer.name} đã rời bàn học.` : null;
      if (r.hostClientId === this.clientId) {
        r.hostClientId = r.players[0].clientId;
        r.hostName = r.players[0].name;
        r.players[0].isHost = true;
        notice = `${leavingPlayer ? leavingPlayer.name : 'Chủ phòng'} đã rời bàn. ${r.players[0].name} trở thành Chủ phòng mới!`;
      }
      const remainingActiveSymbols = new Set(
        (r.players || [])
          .map(p => p.symbol)
          .filter(sym => sym && sym !== 'SPECTATOR')
      );
      if (remainingActiveSymbols.size < 2 && (r.moves?.length || 0) === 0) {
        r.gameStarted = false;
      }
      this._recomputeFallbackActiveSymbols(r);
      r.updatedAt = Date.now();
      this.localFallbackRooms.set(leavingRoomId, r);
      this._saveRoomsToLocalStorage();
      this._broadcastFallback({ type: 'sync_room', room: r, notice });
    }
    this.roomState = null;
  }

  _createFallbackRoom(payload) {
    if (this.roomState) {
      this._leaveFallbackRoomInternal();
    }

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let roomId = '';
    for (let i = 0; i < 5; i++) {
      roomId += chars[Math.floor(Math.random() * chars.length)];
    }

    const hostName = payload.playerName || 'Chủ Phòng';
    const room = {
      roomId,
      hostClientId: this.clientId,
      hostName,
      pageOwnerClientId: this.clientId,
      pageOwnerName: hostName,
      hostPageNumber: payload.pageNumber || 1,
      hostDateHeader: payload.dateHeader || '',
      subMode: payload.subMode || '1v1',
      blockTwoEnds: Boolean(payload.blockTwoEnds),
      activeSymbols: ['X', 'O'],
      currentTurnSymbol: 'X',
      turnIndex: 0,
      moves: [],
      archivedGames: payload.archivedGames || [],
      activeGameId: `local_online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      gameStarted: false,
      updatedAt: Date.now(),
      players: [
        {
          clientId: this.clientId,
          name: hostName,
          symbol: 'X',
          isHost: true
        }
      ]
    };
    this.localFallbackRooms.set(roomId, room);
    this.roomState = room;
    this._saveRoomsToLocalStorage();
    this._broadcastFallback({ type: 'sync_room', room });
    this._handleMessage({ type: 'room_state', room });
    this._emitFallbackRoomList();
  }

  _processFallbackAction(payload) {
    switch (payload.type) {
      case 'create_room': {
        this._createFallbackRoom(payload);
        break;
      }

      case 'quick_match': {
        this._loadRoomsFromLocalStorage();
        const desiredMode = payload.subMode || '1v1';
        const myCurrentRoomId = this.roomState?.roomId || null;

        const findCandidate = () => {
          const allRooms = Array.from(this.localFallbackRooms.values()).filter(
            r => r.roomId !== myCurrentRoomId
          );
          return (
            allRooms.find(r => r.subMode === desiredMode && this._isFallbackRoomJoinable(r)) ||
            allRooms.find(r => this._isFallbackRoomJoinable(r))
          );
        };

        const immediateTarget = findCandidate();
        if (immediateTarget) {
          this._processFallbackAction({
            type: 'join_room',
            roomId: immediateTarget.roomId,
            playerName: payload.playerName
          });
          break;
        }

        // Hỏi các tab/máy khác qua BroadcastChannel + Cloud MQTT rồi đợi ngắn 250ms trước khi tự tạo phòng
        this._broadcastFallback({ type: 'query_rooms', requester: this.clientId });
        setTimeout(() => {
          this._loadRoomsFromLocalStorage();
          const delayedTarget = findCandidate();
          if (delayedTarget) {
            this._processFallbackAction({
              type: 'join_room',
              roomId: delayedTarget.roomId,
              playerName: payload.playerName
            });
          } else if (this.roomState) {
            this._handleMessage({ type: 'room_state', room: this.roomState });
          } else {
            this._createFallbackRoom(payload);
          }
        }, 250);
        break;
      }

      case 'list_rooms': {
        this._loadRoomsFromLocalStorage();
        this._broadcastFallback({ type: 'query_rooms', requester: this.clientId });
        this._emitFallbackRoomList();
        break;
      }

      case 'join_room': {
        this._loadRoomsFromLocalStorage();
        const cleanId = String(payload.roomId || '').trim().toUpperCase();
        if (!cleanId) return;

        // Nếu đang ở sẵn trong chính phòng đó thì không rời phòng
        if (this.roomState && this.roomState.roomId === cleanId) {
          this._handleMessage({ type: 'room_state', room: this.roomState });
          return;
        }

        if (this.roomState && this.roomState.roomId !== cleanId) {
          this._leaveFallbackRoomInternal();
        }

        const r = this.localFallbackRooms.get(cleanId);
        if (r) {
          this._addPlayerToFallbackRoom(r, this.clientId, payload.playerName || 'Người chơi');
          return;
        }

        // Gửi yêu cầu vào phòng tới Chủ phòng qua BroadcastChannel + Cloud MQTT Relay
        this._broadcastFallback({
          type: 'request_join',
          roomId: cleanId,
          clientId: this.clientId,
          playerName: payload.playerName || 'Người chơi'
        });

        setTimeout(() => {
          if (!this.roomState || this.roomState.roomId !== cleanId) {
            this._loadRoomsFromLocalStorage();
            const foundLate = this.localFallbackRooms.get(cleanId);
            if (foundLate) {
              this._addPlayerToFallbackRoom(foundLate, this.clientId, payload.playerName || 'Người chơi');
            } else {
              this._handleMessage({
                type: 'error_msg',
                message: `Không tìm thấy phòng #${cleanId}!`
              });
            }
          }
        }, 1500);
        break;
      }

      case 'leave_room': {
        this._leaveFallbackRoomInternal();
        this._emitFallbackRoomList();
        break;
      }

      case 'host_select_page': {
        if (!this.roomState || this.roomState.hostClientId !== this.clientId) return;
        if (this.roomState.moves.length > 0) {
          this._handleMessage({ type: 'error_msg', message: 'Hãy khoanh ván đang đánh trước khi đổi trang vở!' });
          return;
        }
        this.roomState.pageOwnerClientId = this.clientId;
        this.roomState.pageOwnerName = this.roomState.hostName;
        this.roomState.hostPageNumber = payload.pageNumber;
        this.roomState.hostDateHeader = payload.dateHeader || '';
        this.roomState.archivedGames = payload.archivedGames || [];
        this.roomState.moves = [];
        this.roomState.activeGameId = `local_online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        this.roomState.turnIndex = 0;
        this._recomputeFallbackActiveSymbols(this.roomState);
        this.roomState.updatedAt = Date.now();
        this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
        this._saveRoomsToLocalStorage();

        const msg = {
          type: 'host_page_changed',
          pageNumber: payload.pageNumber,
          hostName: this.roomState.hostName,
          pageOwnerClientId: this.roomState.pageOwnerClientId,
          pageOwnerName: this.roomState.pageOwnerName,
          room: this.roomState
        };
        this._broadcastFallback(msg);
        this._handleMessage(msg);
        this._emitFallbackRoomList();
        break;
      }

      case 'host_update_settings': {
        if (!this.roomState || this.roomState.hostClientId !== this.clientId) return;
        if (this.roomState.moves.length > 0) {
          this._handleMessage({ type: 'error_msg', message: 'Không thể đổi luật khi đang đánh dở ván cờ!' });
          return;
        }
        if (payload.blockTwoEnds !== undefined) this.roomState.blockTwoEnds = Boolean(payload.blockTwoEnds);
        if (payload.subMode) this.roomState.subMode = payload.subMode;
        this._recomputeFallbackActiveSymbols(this.roomState);
        this.roomState.updatedAt = Date.now();
        this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
        this._saveRoomsToLocalStorage();
        this._broadcastFallback({ type: 'sync_room', room: this.roomState });
        this._handleMessage({ type: 'room_state', room: this.roomState });
        this._emitFallbackRoomList();
        break;
      }

      case 'switch_symbol': {
        if (!this.roomState) return;
        const me = this.roomState.players.find(p => p.clientId === this.clientId);
        if (!me) return;

        const targetSym = payload.symbol;
        const validSyms = this.roomState.subMode === 'ffa' ? [...SYMBOLS, 'SPECTATOR'] : ['X', 'O', 'SPECTATOR'];
        if (!validSyms.includes(targetSym) || me.symbol === targetSym) return;

        if ((this.roomState.moves?.length || 0) > 0 && me.symbol !== 'SPECTATOR') {
          this._handleMessage({
            type: 'error_msg',
            message: 'Đang trong ván cờ, không thể đổi màu bút hoặc chuyển sang Xem!'
          });
          return;
        }

        if ((this.roomState.subMode === '1v1' || this.roomState.subMode === 'ffa') && targetSym !== 'SPECTATOR') {
          const occupied = this.roomState.players.some(
            p => p.clientId !== this.clientId && p.symbol === targetSym
          );
          if (occupied) {
            this._handleMessage({
              type: 'error_msg',
              message: `Bút ${targetSym} đã có người cầm trong bàn!`
            });
            return;
          }
        }

        me.symbol = targetSym;
        this._recomputeFallbackActiveSymbols(this.roomState);
        this.roomState.updatedAt = Date.now();
        this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
        this._saveRoomsToLocalStorage();
        this._broadcastFallback({ type: 'sync_room', room: this.roomState });
        this._handleMessage({ type: 'room_state', room: this.roomState });
        this._emitFallbackRoomList();
        break;
      }

      case 'start_coop_game': {
        if (!this.roomState) return;
        const me = (this.roomState.players || []).find(p => p.clientId === this.clientId);
        if (!me) return;

        const heldActiveSymbols = new Set(
          (this.roomState.players || [])
            .map(p => p.symbol)
            .filter(sym => sym && sym !== 'SPECTATOR')
        );
        if (heldActiveSymbols.size < 2) {
          this._handleMessage({
            type: 'error_msg',
            message: 'Cần ít nhất 2 người chơi thuộc 2 phe khác nhau để bắt đầu ván đấu!'
          });
          return;
        }

        this.roomState.gameStarted = true;
        this._recomputeFallbackActiveSymbols(this.roomState);
        this.roomState.updatedAt = Date.now();
        this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
        this._saveRoomsToLocalStorage();

        const startMsg = {
          type: 'coop_game_started',
          startedBy: me.name,
          room: this.roomState
        };
        this._broadcastFallback(startMsg);
        this._handleMessage(startMsg);
        this._emitFallbackRoomList();
        break;
      }

      case 'place_move': {
        if (!this.roomState) return;
        const me = this.roomState.players.find(p => p.clientId === this.clientId);
        if (!me || me.symbol === 'SPECTATOR') {
          this._handleMessage({ type: 'error_msg', message: 'Bạn đang là Khán giả, hãy chọn Phe để đánh!' });
          return;
        }

        const heldActiveSymbols = new Set(
          (this.roomState.players || [])
            .map(p => p.symbol)
            .filter(sym => sym && sym !== 'SPECTATOR')
        );
        if (heldActiveSymbols.size < 2) {
          this._handleMessage({
            type: 'error_msg',
            message: 'Cần ít nhất 2 phe cầm bút trong bàn để bắt đầu giao đấu! Hãy đợi thêm bạn vào bàn.'
          });
          return;
        }

        this._recomputeFallbackActiveSymbols(this.roomState);
        if (me.symbol !== this.roomState.currentTurnSymbol) {
          this._handleMessage({
            type: 'error_msg',
            message: `Chưa tới lượt của phe ${me.symbol}! (Đang là lượt ${this.roomState.currentTurnSymbol})`
          });
          return;
        }

        const r = Number(payload.r);
        const c = Number(payload.c);
        if (!isValidCell(r, c, BOARD_ROWS, BOARD_COLS)) return;

        const deadSet = new Set();
        for (const g of this.roomState.archivedGames || []) {
          if (Array.isArray(g.deadCells) && g.deadCells.length > 0) {
            for (const dc of g.deadCells) deadSet.add(dc);
          } else if (Array.isArray(g.moves) && g.moves.length > 0) {
            const { deadCells } = computeGameFenceAndDeadZone(g.moves, deadSet, BOARD_ROWS, BOARD_COLS);
            g.deadCells = deadCells;
            for (const dc of deadCells) deadSet.add(dc);
          }
        }
        if (deadSet.has(cellKey(r, c))) {
          this._handleMessage({ type: 'error_msg', message: 'Ô này thuộc vùng khoanh Điểm Chết của ván cũ!' });
          return;
        }
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

        const curIdx = this.roomState.activeSymbols.indexOf(this.roomState.currentTurnSymbol);
        const nextIdx = curIdx >= 0 ? (curIdx + 1) % this.roomState.activeSymbols.length : 0;
        this.roomState.turnIndex = nextIdx;
        this.roomState.currentTurnSymbol = this.roomState.activeSymbols[nextIdx] || 'X';
        this.roomState.updatedAt = Date.now();

        const winCheck = checkWinAt(board, r, c, {
          blockTwoEnds: this.roomState.blockTwoEnds,
          deadSet,
          rows: BOARD_ROWS,
          cols: BOARD_COLS
        });

        const ownerLabel = this.roomState.pageOwnerName || this.roomState.hostName;

        if (winCheck.won) {
          const { deadCells, contours } = computeGameFenceAndDeadZone(
            this.roomState.moves,
            deadSet,
            BOARD_ROWS,
            BOARD_COLS
          );
          const finishedId = this.roomState.activeGameId;
          this.roomState.archivedGames.push({
            id: finishedId,
            gameIndexOnPage: this.roomState.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${this.roomState.roomId} (Vở ${ownerLabel})`,
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
          this.roomState.activeGameId = `local_online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          this.roomState.turnIndex = 0;
          this._recomputeFallbackActiveSymbols(this.roomState);
          this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
          this._saveRoomsToLocalStorage();

          const overMsg = {
            type: 'game_over',
            result: {
              id: finishedId,
              winnerSymbol: me.symbol,
              winnerName: me.name,
              winLine: winCheck.line
            },
            room: this.roomState
          };
          this._broadcastFallback(overMsg);
          this._handleMessage(overMsg);
          this._emitFallbackRoomList();
          return;
        }

        // Kiểm tra Hòa cờ khi hết ô trống trên trang vở
        const remaining = countPlayableCells(board, deadSet, BOARD_ROWS, BOARD_COLS);
        if (remaining === 0) {
          const { deadCells, contours } = computeGameFenceAndDeadZone(
            this.roomState.moves,
            deadSet,
            BOARD_ROWS,
            BOARD_COLS
          );
          const finishedId = this.roomState.activeGameId;
          this.roomState.archivedGames.push({
            id: finishedId,
            gameIndexOnPage: this.roomState.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${this.roomState.roomId} (Vở ${ownerLabel})`,
            blockTwoEnds: this.roomState.blockTwoEnds,
            winnerSymbol: 'DRAW',
            winnerName: 'Hòa cờ',
            winLine: null,
            moves: [...this.roomState.moves],
            deadCells,
            contours,
            finishedAt: Date.now()
          });
          this.roomState.moves = [];
          this.roomState.activeGameId = `local_online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          this.roomState.turnIndex = 0;
          this._recomputeFallbackActiveSymbols(this.roomState);
          this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
          this._saveRoomsToLocalStorage();

          const overMsg = {
            type: 'game_over',
            result: {
              id: finishedId,
              winnerSymbol: 'DRAW',
              winnerName: 'Hòa cờ'
            },
            room: this.roomState
          };
          this._broadcastFallback(overMsg);
          this._handleMessage(overMsg);
          this._emitFallbackRoomList();
          return;
        }

        this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
        this._saveRoomsToLocalStorage();
        const moveMsg = { type: 'move_made', move: moveObj, room: this.roomState };
        this._broadcastFallback(moveMsg);
        this._handleMessage(moveMsg);
        if (this.roomState.moves.length === 1) {
          this._emitFallbackRoomList();
        }
        break;
      }

      case 'new_round_same_page': {
        if (!this.roomState || this.roomState.hostClientId !== this.clientId || this.roomState.moves.length === 0) return;
        const deadSet = new Set();
        for (const g of this.roomState.archivedGames || []) {
          for (const dc of g.deadCells || []) deadSet.add(dc);
        }
        const { deadCells, contours } = computeGameFenceAndDeadZone(this.roomState.moves, deadSet, BOARD_ROWS, BOARD_COLS);
        const finishedId = this.roomState.activeGameId;
        const ownerLabel = this.roomState.pageOwnerName || this.roomState.hostName;
        this.roomState.archivedGames.push({
          id: finishedId,
          gameIndexOnPage: this.roomState.archivedGames.length + 1,
          mode: 'pvp-online',
          modeLabel: `Co-op Phòng #${this.roomState.roomId} (Vở ${ownerLabel})`,
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
        this.roomState.activeGameId = `local_online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        this.roomState.turnIndex = 0;
        this._recomputeFallbackActiveSymbols(this.roomState);
        this.roomState.updatedAt = Date.now();
        this.localFallbackRooms.set(this.roomState.roomId, this.roomState);
        this._saveRoomsToLocalStorage();

        const overMsg = {
          type: 'game_over',
          result: {
            id: finishedId,
            winnerSymbol: 'DRAW',
            winnerName: 'Chủ phòng đã khoanh vùng ván cờ'
          },
          room: this.roomState
        };
        this._broadcastFallback(overMsg);
        this._handleMessage(overMsg);
        this._emitFallbackRoomList();
        break;
      }

      case 'chat': {
        if (!this.roomState) return;
        const me = this.roomState.players.find(p => p.clientId === this.clientId);
        const chatMsg = {
          type: 'chat_message',
          roomId: this.roomState.roomId,
          clientId: this.clientId,
          sender: me ? me.name : 'Người chơi',
          symbol: me ? me.symbol : '-',
          text: payload.text
        };
        this._broadcastFallback(chatMsg);
        this._handleMessage(chatMsg);
        break;
      }
    }
  }

  _recomputeFallbackActiveSymbols(room) {
    const prevList = Array.isArray(room.activeSymbols) && room.activeSymbols.length > 0
      ? [...room.activeSymbols]
      : ['X', 'O'];
    const prevSym = room.currentTurnSymbol || prevList[room.turnIndex % prevList.length] || 'X';

    if (room.subMode === 'ffa') {
      const present = SYMBOLS.filter(s => (room.players || []).some(p => p.symbol === s));
      room.activeSymbols = present.length >= 2 ? present : ['X', 'O'];
    } else {
      room.activeSymbols = ['X', 'O'];
    }

    const nextList = room.activeSymbols;
    if (!room.moves || room.moves.length === 0) {
      room.currentTurnSymbol = nextList[0] || 'X';
      room.turnIndex = 0;
      return;
    }

    if (nextList.includes(prevSym)) {
      room.currentTurnSymbol = prevSym;
      room.turnIndex = nextList.indexOf(prevSym);
      return;
    }

    const oldIdx = prevList.indexOf(prevSym);
    let chosen = nextList[0] || 'X';
    if (oldIdx >= 0) {
      for (let step = 1; step <= prevList.length; step++) {
        const candidate = prevList[(oldIdx + step) % prevList.length];
        if (nextList.includes(candidate)) {
          chosen = candidate;
          break;
        }
      }
    }
    room.currentTurnSymbol = chosen;
    room.turnIndex = Math.max(0, nextList.indexOf(chosen));
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
    room.updatedAt = Date.now();
    this._recomputeFallbackActiveSymbols(room);
    this.localFallbackRooms.set(room.roomId, room);
    this._saveRoomsToLocalStorage();
    if (room.players.some(p => p.clientId === this.clientId)) {
      this.roomState = room;
    }
    this._broadcastFallback({ type: 'sync_room', room });
    if (this.roomState && this.roomState.roomId === room.roomId) {
      this._handleMessage({ type: 'room_state', room });
    }
    this._emitFallbackRoomList();
  }

  _broadcastFallback(msg) {
    const envelope = {
      ...msg,
      _msgId: `${this.clientId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      _senderId: this.clientId
    };
    this.seenRelayMsgIds.add(envelope._msgId);

    if (this.bc) {
      try {
        this.bc.postMessage(envelope);
      } catch (_) {}
    }

    try {
      localStorage.setItem('caro_vn_coop_event', JSON.stringify(envelope));
    } catch (_) {}

    if (this.mqttWs && this.mqttConnected && this.mqttWs.readyState === WebSocket.OPEN) {
      try {
        const pkt = this._buildMqttPublishPacket(CLOUD_TOPIC, JSON.stringify(envelope));
        this.mqttWs.send(pkt);
      } catch (_) {}
    }
  }

  _handleFallbackChannelMessage(msg) {
    if (!msg) return;
    if (msg._msgId) {
      if (this.seenRelayMsgIds.has(msg._msgId)) return;
      this.seenRelayMsgIds.add(msg._msgId);
      if (this.seenRelayMsgIds.size > 600) {
        const first = this.seenRelayMsgIds.values().next().value;
        this.seenRelayMsgIds.delete(first);
      }
    }

    if (msg.type === 'query_rooms' && this.roomState && this.roomState.hostClientId === this.clientId) {
      this.roomState.updatedAt = Date.now();
      this._broadcastFallback({ type: 'advertise_room', room: this.roomState });
    } else if (msg.type === 'advertise_room' && msg.room) {
      msg.room.updatedAt = Date.now();
      this.localFallbackRooms.set(msg.room.roomId, msg.room);
      this._saveRoomsToLocalStorage();
      this._emitFallbackRoomList();
    } else if (msg.type === 'room_closed' && msg.roomId) {
      this.localFallbackRooms.delete(msg.roomId);
      this._saveRoomsToLocalStorage();
      this._emitFallbackRoomList();
    } else if (
      msg.type === 'request_join' &&
      this.roomState &&
      this.roomState.roomId === msg.roomId &&
      this.roomState.hostClientId === this.clientId
    ) {
      this._addPlayerToFallbackRoom(this.roomState, msg.clientId, msg.playerName);
    } else if (msg.type === 'sync_room' && msg.room) {
      msg.room.updatedAt = Date.now();
      this.localFallbackRooms.set(msg.room.roomId, msg.room);
      this._saveRoomsToLocalStorage();
      this._emitFallbackRoomList();

      if (this.roomState && this.roomState.roomId === msg.room.roomId) {
        this._handleMessage({ type: 'room_state', room: msg.room, notice: msg.notice || null });
      } else if (msg.room.players?.some(p => p.clientId === this.clientId)) {
        this._handleMessage({ type: 'room_state', room: msg.room, notice: msg.notice || null });
      }
    } else if (['host_page_changed', 'move_made', 'game_over', 'coop_game_started'].includes(msg.type) && msg.room) {
      msg.room.updatedAt = Date.now();
      this.localFallbackRooms.set(msg.room.roomId, msg.room);
      this._saveRoomsToLocalStorage();
      this._emitFallbackRoomList();
      if (this.roomState?.roomId === msg.room.roomId) {
        this._handleMessage(msg);
      }
    } else if (msg.type === 'chat_message' && this.roomState && msg.roomId === this.roomState.roomId) {
      this._handleMessage(msg);
    }
  }
}
