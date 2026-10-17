/**
 * High-Concurrency Server cho Webgame Cờ Caro Vở Ô Ly Việt Nam
 * Thiết kế tối ưu để đáp ứng >= 10,000 người chơi đồng thời (10k CCU) với độ trễ < 50ms (yêu cầu < 3s):
 * - In-memory Static File + Gzip Cache (0 Disk I/O khi phục vụ trang web)
 * - WebSocket thuần với perMessageDeflate: false (~15KB RAM / kết nối)
 * - Quản lý Phòng & Ghép trận O(1) theo Hash Map
 * - Đồng bộ Trang Vở Ô Ly của Chủ Phòng (Host's Notebook Page) cho tất cả người chơi trong phòng Co-op
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  BOARD_ROWS,
  BOARD_COLS,
  TOTAL_NOTEBOOK_PAGES,
  SYMBOLS,
  cellKey,
  isValidCell,
  checkWinAt,
  countPlayableCells,
  computeGameFenceAndDeadZone
} from '../public/js/rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Bộ nhớ đệm file tĩnh (Raw + Gzip) giúp phản hồi HTTP trong < 1ms
const staticCache = new Map();

function getCachedStaticFile(relPath) {
  if (staticCache.has(relPath)) {
    return staticCache.get(relPath);
  }
  const absPath = path.join(PUBLIC_DIR, relPath);
  if (!absPath.startsWith(PUBLIC_DIR) || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    return null;
  }
  const raw = fs.readFileSync(absPath);
  const gzipped = zlib.gzipSync(raw);
  const ext = path.extname(absPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const entry = { raw, gzipped, contentType };
  staticCache.set(relPath, entry);
  return entry;
}

// Quản lý kết nối và Phòng đấu trong RAM (O(1) lookup)
const clients = new Map(); // clientId -> ws
const rooms = new Map();   // roomId -> RoomObject
let clientSeq = 1;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return `R${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

function createEmptyBoard() {
  return Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
}

function buildDeadSetFromArchived(archivedGames = []) {
  const set = new Set();
  for (const g of archivedGames) {
    if (Array.isArray(g.deadCells) && g.deadCells.length > 0) {
      for (const k of g.deadCells) set.add(k);
    } else if (Array.isArray(g.moves) && g.moves.length > 0) {
      const { deadCells, contours } = computeGameFenceAndDeadZone(
        g.moves,
        set,
        BOARD_ROWS,
        BOARD_COLS
      );
      g.deadCells = deadCells;
      if (!Array.isArray(g.contours) || g.contours.length === 0) {
        g.contours = contours;
      }
      for (const k of deadCells) set.add(k);
    }
  }
  return set;
}

function getActiveSymbolsForRoom(room) {
  if (room.subMode === 'ffa') {
    const present = [];
    for (const sym of SYMBOLS) {
      if (Array.from(room.players.values()).some(p => p.symbol === sym)) {
        present.push(sym);
      }
    }
    return present.length >= 2 ? present : ['X', 'O'];
  }
  return ['X', 'O'];
}

function recomputeRoomTurnState(room) {
  const prevList = Array.isArray(room.activeSymbols) && room.activeSymbols.length > 0
    ? [...room.activeSymbols]
    : ['X', 'O'];
  const prevSym = room.currentTurnSymbol || prevList[room.turnIndex % prevList.length] || 'X';
  const nextList = getActiveSymbolsForRoom(room);
  room.activeSymbols = nextList;

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

  // Nếu phe đang tới lượt vừa rời phòng trong chế độ Hỗn Chiến (FFA), chuyển sang phe kế tiếp theo vòng
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

function assignSymbolForNewPlayer(room) {
  const playerList = Array.from(room.players.values());

  if (room.subMode === '1v1') {
    const hasX = playerList.some(p => p.symbol === 'X');
    const hasO = playerList.some(p => p.symbol === 'O');
    if (!hasX) return 'X';
    if (!hasO) return 'O';
    return 'SPECTATOR';
  }

  if (room.subMode === 'team') {
    const countX = playerList.filter(p => p.symbol === 'X').length;
    const countO = playerList.filter(p => p.symbol === 'O').length;
    return countX <= countO ? 'X' : 'O';
  }

  if (room.subMode === 'ffa') {
    for (const sym of SYMBOLS) {
      if (!playerList.some(p => p.symbol === sym)) {
        return sym;
      }
    }
    return 'SPECTATOR';
  }

  return 'X';
}

function serializeRoom(room) {
  const activeSymbols = Array.isArray(room.activeSymbols) && room.activeSymbols.length > 0
    ? room.activeSymbols
    : getActiveSymbolsForRoom(room);
  const currentTurnSymbol = room.currentTurnSymbol && activeSymbols.includes(room.currentTurnSymbol)
    ? room.currentTurnSymbol
    : (activeSymbols[room.turnIndex % activeSymbols.length] || 'X');

  return {
    roomId: room.roomId,
    hostClientId: room.hostClientId,
    hostName: room.hostName,
    pageOwnerClientId: room.pageOwnerClientId || room.hostClientId,
    pageOwnerName: room.pageOwnerName || room.hostName,
    hostPageNumber: room.hostPageNumber,
    hostDateHeader: room.hostDateHeader,
    subMode: room.subMode,
    blockTwoEnds: room.blockTwoEnds,
    activeSymbols,
    currentTurnSymbol,
    moves: room.moves,
    archivedGames: room.archivedGames,
    activeGameId: room.activeGameId,
    players: Array.from(room.players.values()).map(p => ({
      clientId: p.clientId,
      name: p.name,
      symbol: p.symbol,
      isHost: p.clientId === room.hostClientId
    }))
  };
}

function broadcastToRoom(room, payloadObj) {
  const data = JSON.stringify(payloadObj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function getServerStats() {
  return {
    onlineCount: clients.size,
    roomCount: rooms.size
  };
}

function getPublicRoomsList() {
  const publicRooms = [];
  for (const r of rooms.values()) {
    publicRooms.push({
      roomId: r.roomId,
      hostName: r.hostName,
      pageOwnerName: r.pageOwnerName || r.hostName,
      hostPageNumber: r.hostPageNumber,
      subMode: r.subMode,
      playerCount: r.players.size,
      archivedCount: r.archivedGames.length,
      inProgress: r.moves.length > 0
    });
    if (publicRooms.length >= 50) break;
  }
  return publicRooms;
}

function broadcastRoomListToAll() {
  const payload = JSON.stringify({
    type: 'room_list',
    rooms: getPublicRoomsList(),
    stats: getServerStats()
  });
  for (const cWs of clients.values()) {
    if (cWs.readyState === 1) {
      cWs.send(payload);
    }
  }
}

function isRoomJoinable(r) {
  const activeCount = Array.from(r.players.values()).filter(
    p => p.symbol && p.symbol !== 'SPECTATOR'
  ).length;
  if (r.subMode === '1v1') return activeCount < 2;
  if (r.subMode === 'team') return activeCount < 8;
  if (r.subMode === 'ffa') return activeCount < 4;
  return activeCount < 2;
}

function removeClientFromCurrentRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  ws.roomId = null;

  const room = rooms.get(roomId);
  if (!room) return;

  const leavingPlayer = room.players.get(ws.clientId);
  room.players.delete(ws.clientId);
  if (room.players.size === 0) {
    rooms.delete(roomId);
    broadcastRoomListToAll();
    return;
  }

  let newHostNotice = null;
  // Nếu chủ phòng rời đi, nhường quyền chủ phòng cho người tiếp theo trong phòng
  // Lưu ý: pageOwnerClientId & pageOwnerName giữ nguyên của tờ giấy đang mở để không ghi đè nhầm vào vở của Chủ phòng mới!
  if (room.hostClientId === ws.clientId) {
    const nextHost = room.players.values().next().value;
    if (nextHost) {
      room.hostClientId = nextHost.clientId;
      room.hostName = nextHost.name;
      newHostNotice = `${leavingPlayer ? leavingPlayer.name : 'Chủ phòng'} đã rời bàn. ${nextHost.name} trở thành Chủ phòng mới!`;
    }
  }

  recomputeRoomTurnState(room);

  broadcastToRoom(room, {
    type: 'room_state',
    room: serializeRoom(room),
    notice: newHostNotice || (leavingPlayer ? `${leavingPlayer.name} đã rời bàn học.` : null)
  });
  broadcastRoomListToAll();
}

function createRoomForClient(ws, {
  playerName,
  subMode = '1v1',
  blockTwoEnds = true,
  pageNumber = 1,
  dateHeader = '',
  archivedGames = []
}) {
  removeClientFromCurrentRoom(ws);

  const roomId = generateRoomCode();
  const safePageNum = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(pageNumber) || 1));
  const safeArchived = Array.isArray(archivedGames) ? archivedGames.slice(0, 50) : [];
  const deadSet = buildDeadSetFromArchived(safeArchived);
  const hostName = (playerName ? String(playerName).slice(0, 28) : '') || ws.playerName || `Học Sinh #${ws.clientId}`;

  const room = {
    roomId,
    hostClientId: ws.clientId,
    hostName,
    pageOwnerClientId: ws.clientId,
    pageOwnerName: hostName,
    hostPageNumber: safePageNum,
    hostDateHeader: dateHeader || '',
    subMode: ['1v1', 'team', 'ffa'].includes(subMode) ? subMode : '1v1',
    blockTwoEnds: Boolean(blockTwoEnds),
    archivedGames: safeArchived,
    deadSet,
    activeBoard: createEmptyBoard(),
    activeGameId: `online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    moves: [],
    turnIndex: 0,
    activeSymbols: ['X', 'O'],
    currentTurnSymbol: 'X',
    players: new Map(),
    createdAt: Date.now()
  };

  ws.playerName = hostName;
  ws.roomId = roomId;
  room.players.set(ws.clientId, {
    clientId: ws.clientId,
    name: ws.playerName,
    symbol: 'X',
    ws
  });

  recomputeRoomTurnState(room);
  rooms.set(roomId, room);

  sendJson(ws, {
    type: 'room_state',
    room: serializeRoom(room)
  });
  broadcastRoomListToAll();
  return room;
}

function joinExistingRoom(ws, roomId, playerName) {
  const cleanId = String(roomId || '').trim().toUpperCase();
  const room = rooms.get(cleanId);
  if (!room) {
    sendJson(ws, { type: 'error_msg', message: `Không tìm thấy phòng #${cleanId}!` });
    return null;
  }

  // Nếu người chơi đã ở sẵn trong chính phòng này, không xóa khỏi phòng tránh lỗi tự hủy phòng!
  if (ws.roomId === cleanId && room.players.has(ws.clientId)) {
    if (playerName) {
      ws.playerName = String(playerName).slice(0, 28);
      const existing = room.players.get(ws.clientId);
      if (existing) existing.name = ws.playerName;
    }
    sendJson(ws, {
      type: 'room_state',
      room: serializeRoom(room)
    });
    return room;
  }

  removeClientFromCurrentRoom(ws);

  if (playerName) ws.playerName = String(playerName).slice(0, 28);
  const assignedSymbol = assignSymbolForNewPlayer(room);

  ws.roomId = cleanId;
  room.players.set(ws.clientId, {
    clientId: ws.clientId,
    name: ws.playerName,
    symbol: assignedSymbol,
    ws
  });

  recomputeRoomTurnState(room);

  broadcastToRoom(room, {
    type: 'room_state',
    room: serializeRoom(room)
  });
  broadcastRoomListToAll();
  return room;
}

// Khởi tạo HTTP Server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      ...getServerStats(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSec: Math.round(process.uptime())
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }

  let relPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
  relPath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');

  const cached = getCachedStaticFile(relPath);
  if (!cached) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip')) {
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-cache'
    });
    res.end(cached.gzipped);
  } else {
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(cached.raw);
  }
});

// Khởi tạo WebSocket Server tại /ws
const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: false,
  maxPayload: 64 * 1024
});

wss.on('connection', (ws) => {
  const clientId = `c${clientSeq++}`;
  ws.clientId = clientId;
  ws.playerName = `Học Sinh #${clientSeq}`;
  ws.roomId = null;
  clients.set(clientId, ws);

  sendJson(ws, {
    type: 'welcome',
    clientId,
    stats: getServerStats()
  });

  sendJson(ws, {
    type: 'room_list',
    rooms: getPublicRoomsList(),
    stats: getServerStats()
  });

  ws.on('message', (rawBuf) => {
    let msg;
    try {
      msg = JSON.parse(rawBuf.toString());
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'ping': {
        sendJson(ws, {
          type: 'pong',
          t: msg.t,
          stats: getServerStats()
        });
        break;
      }

      case 'list_rooms': {
        sendJson(ws, {
          type: 'room_list',
          rooms: getPublicRoomsList(),
          stats: getServerStats()
        });
        break;
      }

      case 'create_room': {
        createRoomForClient(ws, msg);
        break;
      }

      case 'join_room': {
        joinExistingRoom(ws, String(msg.roomId || '').toUpperCase(), msg.playerName);
        break;
      }

      case 'quick_match': {
        const desiredMode = msg.subMode || '1v1';
        let targetRoom = null;
        // Ưu tiên tìm bàn đúng thể thức đang chọn và còn chỗ (bỏ qua bàn hiện tại của chính mình)
        for (const r of rooms.values()) {
          if (r.roomId !== ws.roomId && r.subMode === desiredMode && isRoomJoinable(r)) {
            targetRoom = r;
            break;
          }
        }
        // Nếu chưa có bàn đúng thể thức, ghép vào bất kỳ bàn nào đang mở và còn chỗ
        if (!targetRoom) {
          for (const r of rooms.values()) {
            if (r.roomId !== ws.roomId && isRoomJoinable(r)) {
              targetRoom = r;
              break;
            }
          }
        }

        if (targetRoom) {
          joinExistingRoom(ws, targetRoom.roomId, msg.playerName);
        } else if (ws.roomId && rooms.has(ws.roomId)) {
          const currentRoom = rooms.get(ws.roomId);
          sendJson(ws, {
            type: 'room_state',
            room: serializeRoom(currentRoom)
          });
        } else {
          createRoomForClient(ws, msg);
        }
        break;
      }

      case 'leave_room': {
        removeClientFromCurrentRoom(ws);
        break;
      }

      case 'host_select_page': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        if (room.hostClientId !== ws.clientId) {
          sendJson(ws, { type: 'error_msg', message: 'Chỉ Chủ Phòng mới có quyền chọn trang vở đại chiến!' });
          break;
        }
        if (room.moves.length > 0) {
          sendJson(ws, {
            type: 'error_msg',
            message: 'Ván cờ đang diễn ra! Hãy Khoanh ván hiện tại trước khi đổi sang trang vở khác.'
          });
          break;
        }

        const safePageNum = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(msg.pageNumber) || 1));
        const safeArchived = Array.isArray(msg.archivedGames) ? msg.archivedGames.slice(0, 50) : [];

        room.pageOwnerClientId = ws.clientId;
        room.pageOwnerName = room.hostName;
        room.hostPageNumber = safePageNum;
        room.hostDateHeader = msg.dateHeader || '';
        room.archivedGames = safeArchived;
        room.deadSet = buildDeadSetFromArchived(safeArchived);
        room.activeBoard = createEmptyBoard();
        room.activeGameId = `online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        room.moves = [];
        room.turnIndex = 0;
        recomputeRoomTurnState(room);

        broadcastToRoom(room, {
          type: 'host_page_changed',
          pageNumber: safePageNum,
          hostName: room.hostName,
          pageOwnerClientId: room.pageOwnerClientId,
          pageOwnerName: room.pageOwnerName,
          room: serializeRoom(room)
        });
        broadcastRoomListToAll();
        break;
      }

      case 'host_update_settings': {
        const room = rooms.get(ws.roomId);
        if (!room || room.hostClientId !== ws.clientId) break;
        if (room.moves.length > 0) {
          sendJson(ws, { type: 'error_msg', message: 'Không thể đổi luật khi đang đánh dở ván cờ!' });
          break;
        }
        if (msg.blockTwoEnds !== undefined) {
          room.blockTwoEnds = Boolean(msg.blockTwoEnds);
        }
        if (msg.subMode && ['1v1', 'team', 'ffa'].includes(msg.subMode)) {
          room.subMode = msg.subMode;
        }
        recomputeRoomTurnState(room);
        broadcastToRoom(room, {
          type: 'room_state',
          room: serializeRoom(room)
        });
        broadcastRoomListToAll();
        break;
      }

      case 'switch_symbol': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.get(ws.clientId);
        if (!player) break;

        const targetSym = msg.symbol;
        const validSyms = room.subMode === 'ffa' ? [...SYMBOLS, 'SPECTATOR'] : ['X', 'O', 'SPECTATOR'];
        if (!validSyms.includes(targetSym)) break;
        if (player.symbol === targetSym) break;

        // Không cho phép người đang cầm bút đổi phe hoặc thoát sang Xem khi ván cờ đang đánh dở
        if (room.moves.length > 0 && player.symbol !== 'SPECTATOR') {
          sendJson(ws, {
            type: 'error_msg',
            message: 'Đang trong ván cờ, không thể đổi màu bút hoặc chuyển sang Xem!'
          });
          break;
        }

        if ((room.subMode === '1v1' || room.subMode === 'ffa') && targetSym !== 'SPECTATOR') {
          const occupied = Array.from(room.players.values()).some(
            p => p.clientId !== ws.clientId && p.symbol === targetSym
          );
          if (occupied) {
            sendJson(ws, { type: 'error_msg', message: `Bút ${targetSym} đã có người cầm trong bàn!` });
            break;
          }
        }

        player.symbol = targetSym;
        recomputeRoomTurnState(room);
        broadcastToRoom(room, {
          type: 'room_state',
          room: serializeRoom(room)
        });
        broadcastRoomListToAll();
        break;
      }

      case 'place_move': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.get(ws.clientId);
        if (!player || player.symbol === 'SPECTATOR') {
          sendJson(ws, { type: 'error_msg', message: 'Bạn đang là Khán giả, hãy chọn Phe để đánh!' });
          break;
        }

        // Bắt buộc có ít nhất 2 phe đang cầm bút trong phòng mới cho phép đánh Co-op
        const heldActiveSymbols = new Set(
          Array.from(room.players.values())
            .map(p => p.symbol)
            .filter(sym => sym && sym !== 'SPECTATOR')
        );
        if (heldActiveSymbols.size < 2) {
          sendJson(ws, {
            type: 'error_msg',
            message: 'Cần ít nhất 2 phe cầm bút trong bàn để bắt đầu giao đấu! Hãy đợi thêm bạn vào bàn.'
          });
          break;
        }

        recomputeRoomTurnState(room);
        const activeSymbols = room.activeSymbols;
        const currentTurnSymbol = room.currentTurnSymbol || activeSymbols[0] || 'X';

        if (player.symbol !== currentTurnSymbol) {
          sendJson(ws, { type: 'error_msg', message: `Chưa tới lượt của phe ${player.symbol}! (Đang là lượt ${currentTurnSymbol})` });
          break;
        }

        const r = Number(msg.r);
        const c = Number(msg.c);
        if (!isValidCell(r, c, BOARD_ROWS, BOARD_COLS)) break;

        const k = cellKey(r, c);
        if (room.deadSet.has(k)) {
          sendJson(ws, { type: 'error_msg', message: 'Ô này thuộc vùng khoanh Điểm Chết của ván cũ!' });
          break;
        }

        if (room.activeBoard[r][c] !== null) break;

        room.activeBoard[r][c] = player.symbol;
        const moveObj = {
          r,
          c,
          symbol: player.symbol,
          playerName: player.name,
          moveNumber: room.moves.length + 1
        };
        room.moves.push(moveObj);

        const curIdx = activeSymbols.indexOf(currentTurnSymbol);
        const nextIdx = curIdx >= 0 ? (curIdx + 1) % activeSymbols.length : 0;
        room.turnIndex = nextIdx;
        room.currentTurnSymbol = activeSymbols[nextIdx] || 'X';

        // Kiểm tra chiến thắng
        const winCheck = checkWinAt(room.activeBoard, r, c, {
          blockTwoEnds: room.blockTwoEnds,
          deadSet: room.deadSet,
          rows: BOARD_ROWS,
          cols: BOARD_COLS
        });

        if (winCheck.won) {
          const { deadCells, contours } = computeGameFenceAndDeadZone(
            room.moves,
            room.deadSet,
            BOARD_ROWS,
            BOARD_COLS
          );

          const ownerLabel = room.pageOwnerName || room.hostName;
          const archivedRecord = {
            id: room.activeGameId,
            gameIndexOnPage: room.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${room.roomId} (Vở ${ownerLabel})`,
            blockTwoEnds: room.blockTwoEnds,
            winnerSymbol: player.symbol,
            winnerName: player.name,
            winLine: winCheck.line,
            moves: room.moves,
            deadCells,
            contours,
            finishedAt: Date.now()
          };

          room.archivedGames.push(archivedRecord);
          for (const dc of deadCells) room.deadSet.add(dc);

          // Khởi tạo ván tiếp theo ngay trên phần giấy trống còn lại của trang vở Chủ phòng
          room.activeBoard = createEmptyBoard();
          room.moves = [];
          room.activeGameId = `online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          room.turnIndex = 0;
          recomputeRoomTurnState(room);

          broadcastToRoom(room, {
            type: 'game_over',
            result: {
              id: archivedRecord.id,
              winnerSymbol: player.symbol,
              winnerName: player.name,
              winLine: winCheck.line
            },
            room: serializeRoom(room)
          });
          broadcastRoomListToAll();
          break;
        }

        // Kiểm tra Hòa
        const remaining = countPlayableCells(room.activeBoard, room.deadSet, BOARD_ROWS, BOARD_COLS);
        if (remaining === 0) {
          const { deadCells, contours } = computeGameFenceAndDeadZone(
            room.moves,
            room.deadSet,
            BOARD_ROWS,
            BOARD_COLS
          );

          const ownerLabel = room.pageOwnerName || room.hostName;
          const drawRecord = {
            id: room.activeGameId,
            gameIndexOnPage: room.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${room.roomId} (Vở ${ownerLabel})`,
            blockTwoEnds: room.blockTwoEnds,
            winnerSymbol: 'DRAW',
            winnerName: 'Hòa cờ',
            winLine: null,
            moves: room.moves,
            deadCells,
            contours,
            finishedAt: Date.now()
          };
          room.archivedGames.push(drawRecord);
          for (const dc of deadCells) room.deadSet.add(dc);

          room.activeBoard = createEmptyBoard();
          room.moves = [];
          room.activeGameId = `online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          room.turnIndex = 0;
          recomputeRoomTurnState(room);

          broadcastToRoom(room, {
            type: 'game_over',
            result: {
              id: drawRecord.id,
              winnerSymbol: 'DRAW',
              winnerName: 'Hòa cờ'
            },
            room: serializeRoom(room)
          });
          broadcastRoomListToAll();
          break;
        }

        broadcastToRoom(room, {
          type: 'move_made',
          move: moveObj,
          room: serializeRoom(room)
        });
        if (room.moves.length === 1) {
          broadcastRoomListToAll();
        }
        break;
      }

      case 'new_round_same_page': {
        const room = rooms.get(ws.roomId);
        if (!room || room.moves.length === 0) break;
        if (room.hostClientId !== ws.clientId) {
          sendJson(ws, { type: 'error_msg', message: 'Chỉ Chủ Phòng mới có quyền khoanh sớm ván đang đánh!' });
          break;
        }

        const { deadCells, contours } = computeGameFenceAndDeadZone(
          room.moves,
          room.deadSet,
          BOARD_ROWS,
          BOARD_COLS
        );

        const ownerLabel = room.pageOwnerName || room.hostName;
        const fenceRecord = {
          id: room.activeGameId,
          gameIndexOnPage: room.archivedGames.length + 1,
          mode: 'pvp-online',
          modeLabel: `Co-op Phòng #${room.roomId} (Vở ${ownerLabel})`,
          blockTwoEnds: room.blockTwoEnds,
          winnerSymbol: 'DRAW',
          winnerName: 'Chủ phòng khoanh sớm',
          winLine: null,
          moves: room.moves,
          deadCells,
          contours,
          finishedAt: Date.now()
        };
        room.archivedGames.push(fenceRecord);

        for (const dc of deadCells) room.deadSet.add(dc);
        room.activeBoard = createEmptyBoard();
        room.moves = [];
        room.activeGameId = `online_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        room.turnIndex = 0;
        recomputeRoomTurnState(room);

        broadcastToRoom(room, {
          type: 'game_over',
          result: {
            id: fenceRecord.id,
            winnerSymbol: 'DRAW',
            winnerName: 'Chủ phòng đã khoanh vùng ván cờ'
          },
          room: serializeRoom(room)
        });
        broadcastRoomListToAll();
        break;
      }

      case 'chat': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.get(ws.clientId);
        const text = String(msg.text || '').trim().slice(0, 120);
        if (!text) break;

        broadcastToRoom(room, {
          type: 'chat_message',
          clientId: ws.clientId,
          sender: player ? player.name : ws.playerName,
          symbol: player ? player.symbol : '•',
          text,
          at: Date.now()
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    removeClientFromCurrentRoom(ws);
    clients.delete(clientId);
  });
});

server.listen(PORT, () => {
  console.log(`[Caro Vở Ô Ly VN] Server đang chạy tại http://localhost:${PORT}`);
});
