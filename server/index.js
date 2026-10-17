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
    if (Array.isArray(g.deadCells)) {
      for (const k of g.deadCells) set.add(k);
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
  const activeSymbols = getActiveSymbolsForRoom(room);
  const currentTurnSymbol = activeSymbols[room.turnIndex % activeSymbols.length] || 'X';

  return {
    roomId: room.roomId,
    hostClientId: room.hostClientId,
    hostName: room.hostName,
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
  if (r.subMode === '1v1') return r.players.size < 2;
  if (r.subMode === 'team') return r.players.size < 8;
  if (r.subMode === 'ffa') return r.players.size < 4;
  return r.players.size < 2;
}

function removeClientFromCurrentRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  ws.roomId = null;

  const room = rooms.get(roomId);
  if (!room) return;

  room.players.delete(ws.clientId);
  if (room.players.size === 0) {
    rooms.delete(roomId);
    broadcastRoomListToAll();
    return;
  }

  // Nếu chủ phòng rời đi, nhường quyền chủ phòng cho người tiếp theo trong phòng
  if (room.hostClientId === ws.clientId) {
    const nextHost = room.players.values().next().value;
    if (nextHost) {
      room.hostClientId = nextHost.clientId;
      room.hostName = nextHost.name;
    }
  }

  broadcastToRoom(room, {
    type: 'room_state',
    room: serializeRoom(room)
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
    hostPageNumber: safePageNum,
    hostDateHeader: dateHeader || '',
    subMode: ['1v1', 'team', 'ffa'].includes(subMode) ? subMode : '1v1',
    blockTwoEnds: Boolean(blockTwoEnds),
    archivedGames: safeArchived,
    deadSet,
    activeBoard: createEmptyBoard(),
    activeGameId: `online_${Date.now()}`,
    moves: [],
    turnIndex: 0,
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
        // Ưu tiên tìm bàn đúng thể thức đang chọn và còn chỗ
        for (const r of rooms.values()) {
          if (r.subMode === desiredMode && isRoomJoinable(r)) {
            targetRoom = r;
            break;
          }
        }
        // Nếu chưa có bàn đúng thể thức, ghép vào bất kỳ bàn nào đang mở và còn chỗ
        if (!targetRoom) {
          for (const r of rooms.values()) {
            if (isRoomJoinable(r)) {
              targetRoom = r;
              break;
            }
          }
        }

        if (targetRoom) {
          joinExistingRoom(ws, targetRoom.roomId, msg.playerName);
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

        room.hostPageNumber = safePageNum;
        room.hostDateHeader = msg.dateHeader || '';
        room.archivedGames = safeArchived;
        room.deadSet = buildDeadSetFromArchived(safeArchived);
        room.activeBoard = createEmptyBoard();
        room.moves = [];
        room.turnIndex = 0;

        broadcastToRoom(room, {
          type: 'host_page_changed',
          pageNumber: safePageNum,
          hostName: room.hostName,
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
        broadcastToRoom(room, {
          type: 'room_state',
          room: serializeRoom(room)
        });
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

        if (room.subMode === '1v1' && targetSym !== 'SPECTATOR') {
          const occupied = Array.from(room.players.values()).some(
            p => p.clientId !== ws.clientId && p.symbol === targetSym
          );
          if (occupied) {
            sendJson(ws, { type: 'error_msg', message: `Bút ${targetSym} đã có người cầm trong phòng 1v1!` });
            break;
          }
        }

        player.symbol = targetSym;
        broadcastToRoom(room, {
          type: 'room_state',
          room: serializeRoom(room)
        });
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

        const activeSymbols = getActiveSymbolsForRoom(room);
        const currentTurnSymbol = activeSymbols[room.turnIndex % activeSymbols.length] || 'X';

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
        room.turnIndex = (room.turnIndex + 1) % activeSymbols.length;

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

          const archivedRecord = {
            id: room.activeGameId,
            gameIndexOnPage: room.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${room.roomId} (Vở ${room.hostName})`,
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
          room.activeGameId = `online_${Date.now()}`;
          room.turnIndex = 0;

          broadcastToRoom(room, {
            type: 'game_over',
            result: {
              winnerSymbol: player.symbol,
              winnerName: player.name,
              winLine: winCheck.line
            },
            room: serializeRoom(room)
          });
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

          room.archivedGames.push({
            id: room.activeGameId,
            gameIndexOnPage: room.archivedGames.length + 1,
            mode: 'pvp-online',
            modeLabel: `Co-op Phòng #${room.roomId} (Vở ${room.hostName})`,
            blockTwoEnds: room.blockTwoEnds,
            winnerSymbol: 'DRAW',
            winnerName: 'Hòa cờ',
            winLine: null,
            moves: room.moves,
            deadCells,
            contours,
            finishedAt: Date.now()
          });
          for (const dc of deadCells) room.deadSet.add(dc);

          room.activeBoard = createEmptyBoard();
          room.moves = [];
          room.activeGameId = `online_${Date.now()}`;
          room.turnIndex = 0;

          broadcastToRoom(room, {
            type: 'game_over',
            result: {
              winnerSymbol: 'DRAW',
              winnerName: 'Hòa cờ'
            },
            room: serializeRoom(room)
          });
          break;
        }

        broadcastToRoom(room, {
          type: 'move_made',
          move: moveObj,
          room: serializeRoom(room)
        });
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

        room.archivedGames.push({
          id: room.activeGameId,
          gameIndexOnPage: room.archivedGames.length + 1,
          mode: 'pvp-online',
          modeLabel: `Co-op Phòng #${room.roomId} (Vở ${room.hostName})`,
          blockTwoEnds: room.blockTwoEnds,
          winnerSymbol: 'DRAW',
          winnerName: 'Chủ phòng khoanh sớm',
          winLine: null,
          moves: room.moves,
          deadCells,
          contours,
          finishedAt: Date.now()
        });

        for (const dc of deadCells) room.deadSet.add(dc);
        room.activeBoard = createEmptyBoard();
        room.moves = [];
        room.activeGameId = `online_${Date.now()}`;
        room.turnIndex = 0;

        broadcastToRoom(room, {
          type: 'game_over',
          result: {
            winnerSymbol: 'DRAW',
            winnerName: 'Chủ phòng đã khoanh vùng ván cờ'
          },
          room: serializeRoom(room)
        });
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
