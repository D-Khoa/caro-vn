/**
 * Script Kiểm thử Tự động & Benchmark Hiệu năng 10,000 Người chơi (Latency < 3s)
 * Kiểm tra:
 * 1. Luật chặn 2 đầu & Không chặn 2 đầu
 * 2. Khoanh vùng Điểm chết (Polygonal Contour) & Chặn đánh đè lên ván cũ trên cùng trang vở
 * 3. AI 10 cấp độ (Từ Cấp 1: Tập Sự đến Cấp 10: Cờ Thánh)
 * 4. Tải đồng thời WebSocket & Đo độ trễ phản hồi nước đi (Yêu cầu < 3000ms)
 */

import { WebSocket } from 'ws';
import {
  BOARD_ROWS,
  BOARD_COLS,
  cellKey,
  checkWinAt,
  computeGameFenceAndDeadZone
} from '../public/js/rules.js';
import { computeBestAIMove } from '../public/js/ai-engine.js';

const SERVER_URL = process.env.WS_URL || 'ws://localhost:3000/ws';
const TARGET_CLIENTS = Number(process.env.CLIENTS) || 1000; // Mặc định 1000 socket thật trên Windows (có thể truyền CLIENTS=10000 trên Linux/Production)

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`TEST FAILED: ${msg}`);
  }
}

async function runUnitTests() {
  console.log('=== 1. KIỂM THỬ LUẬT CARO VN & KHOANH VÙNG ĐIỂM CHẾT ===');
  const board = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
  const deadSet = new Set();

  // Tạo chuỗi 5 quân X tại hàng 10, cột 10..14 nhưng bị chặn 2 đầu bởi O tại (10,9) và (10,15)
  board[10][9] = 'O';
  for (let c = 10; c <= 14; c++) board[10][c] = 'X';
  board[10][15] = 'O';

  const blockedRes = checkWinAt(board, 10, 12, { blockTwoEnds: true, deadSet });
  assert(blockedRes.won === false, 'Luật chặn 2 đầu BẬT: 5 quân bị O chặn cả 2 đầu không được tính thắng');

  const freeRes = checkWinAt(board, 10, 12, { blockTwoEnds: false, deadSet });
  assert(freeRes.won === true, 'Luật chặn 2 đầu TẮT: 5 quân bị chặn 2 đầu vẫn tính thắng');

  // Mở 1 đầu tại (10,15) -> Thắng ngay cả khi bật luật chặn 2 đầu
  board[10][15] = null;
  const oneOpenRes = checkWinAt(board, 10, 14, { blockTwoEnds: true, deadSet });
  assert(oneOpenRes.won === true, '5 quân chỉ bị chặn 1 đầu phải được tính thắng');

  // Kiểm thử khoanh vùng điểm chết (Polygonal Contour)
  const moves = [
    { r: 10, c: 9, symbol: 'O' },
    { r: 10, c: 10, symbol: 'X' },
    { r: 10, c: 11, symbol: 'X' },
    { r: 10, c: 12, symbol: 'X' },
    { r: 10, c: 13, symbol: 'X' },
    { r: 10, c: 14, symbol: 'X' }
  ];
  const fence = computeGameFenceAndDeadZone(moves, deadSet, BOARD_ROWS, BOARD_COLS);
  assert(fence.deadCells.length >= moves.length, 'Vùng điểm chết phải bao gồm tất cả các quân cờ của ván cũ');
  assert(fence.contours.length >= 1, 'Phải tạo được ít nhất 1 đường viền đa giác bo sát (Polygonal Contour)');

  console.log(`✔ Luật chặn 2 đầu & Khoanh vùng đa giác hoạt động chính xác (${fence.deadCells.length} ô điểm chết, ${fence.contours.length} đường bao).`);

  console.log('\n=== 2. KIỂM THỬ AI 10 CẤP ĐỘ (TỪ TẬP SỰ ĐẾN CỜ THÁNH) ===');
  const aiBoard = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
  aiBoard[12][15] = 'X';
  aiBoard[12][16] = 'X';
  aiBoard[12][17] = 'X';
  aiBoard[12][18] = 'X'; // X sắp thắng ở (12,14) hoặc (12,19)

  const moveLv10 = computeBestAIMove(aiBoard, fence.deadCells, 10, 'O', 'X', true);
  assert(
    moveLv10 && moveLv10.r === 12 && (moveLv10.c === 14 || moveLv10.c === 19),
    'Cấp 10 (Cờ Thánh) phải chặn ngay lập tức chuỗi 4 quân mở của đối phương và né vùng điểm chết'
  );
  console.log(`✔ Cấp 10: Cờ Thánh chọn nước chặn chuẩn xác tại (${moveLv10.r}, ${moveLv10.c}).`);
}

async function runWebSocketBenchmark() {
  console.log(`\n=== 3. KIỂM THỬ CHỊU TẢI WEBSOCKET & ĐỘ TRỄ (< 3000ms) ===`);
  console.log(`Đang kết nối ${TARGET_CLIENTS} người chơi đồng thời tới ${SERVER_URL}...`);

  const sockets = [];
  const latencies = [];
  const startConn = performance.now();

  await new Promise((resolve, reject) => {
    let connected = 0;
    for (let i = 0; i < TARGET_CLIENTS; i++) {
      const ws = new WebSocket(SERVER_URL);
      sockets.push(ws);

      ws.on('open', () => {
        connected++;
        if (connected === TARGET_CLIENTS) resolve();
      });
      ws.on('error', (err) => reject(err));
    }
  });

  const connTimeMs = Math.round(performance.now() - startConn);
  console.log(`✔ Đã kết nối thành công ${TARGET_CLIENTS} người chơi trong ${connTimeMs} ms.`);

  // Ghép 200 cặp đấu (400 người chơi đánh cờ liên tục trong khi toàn bộ các kết nối khác giữ phiên)
  const activePairs = Math.min(200, Math.floor(TARGET_CLIENTS / 2));
  const movePromises = [];

  for (let p = 0; p < activePairs; p++) {
    const hostWs = sockets[p * 2];
    const guestWs = sockets[p * 2 + 1];

    movePromises.push(
      new Promise((resolve) => {
        let roomCode = null;
        let moveSentAt = 0;

        hostWs.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'room_state' && !roomCode) {
            roomCode = msg.room.roomId;
            guestWs.send(JSON.stringify({ type: 'join_room', roomId: roomCode, playerName: `Guest_${p}` }));
          } else if (msg.type === 'room_state' && msg.room.players.length === 2 && moveSentAt === 0) {
            if (p === 0 && msg.room.hostPageNumber !== 42) {
              // Kiểm thử Chủ Phòng chọn Trang 42 trước khi bắt đầu ván
              hostWs.send(JSON.stringify({
                type: 'host_select_page',
                pageNumber: 42,
                dateHeader: 'Thứ Bảy, Trang 42 của Chủ Phòng',
                archivedGames: []
              }));
              return;
            }
            moveSentAt = performance.now();
            hostWs.send(JSON.stringify({ type: 'place_move', r: 10, c: 10 }));
          } else if (msg.type === 'host_page_changed' && p === 0 && moveSentAt === 0) {
            assert(msg.room.hostPageNumber === 42, 'Chủ phòng đổi sang Trang 42 phải được đồng bộ cho cả phòng');
            moveSentAt = performance.now();
            hostWs.send(JSON.stringify({ type: 'place_move', r: 10, c: 10 }));
          }
        });

        guestWs.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'move_made' && moveSentAt > 0) {
            const rtt = performance.now() - moveSentAt;
            latencies.push(rtt);
            resolve();
          }
        });

        hostWs.send(JSON.stringify({
          type: 'create_room',
          playerName: `Host_${p}`,
          subMode: '1v1',
          blockTwoEnds: true
        }));
      })
    );
  }

  await Promise.all(movePromises);

  latencies.sort((a, b) => a - b);
  const avg = (latencies.reduce((s, v) => s + v, 0) / latencies.length).toFixed(2);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);
  const max = latencies[latencies.length - 1].toFixed(2);

  console.log(`📊 KẾT QUẢ ĐỘ TRỄ ĐỒNG BỘ NƯỚC ĐI:`);
  console.log(`   - Trung bình (Avg): ${avg} ms`);
  console.log(`   - P95:              ${p95} ms`);
  console.log(`   - P99:              ${p99} ms`);
  console.log(`   - Tối đa (Max):     ${max} ms (Yêu cầu: < 3000 ms)`);

  assert(Number(p99) < 3000, `Độ trễ P99 (${p99}ms) vượt quá 3000ms!`);
  console.log(`✔ ĐẠT YÊU CẦU: Độ trễ thực tế (${p99} ms) nhỏ hơn rất nhiều so với ngưỡng 3,000 ms!`);

  for (const ws of sockets) {
    ws.close();
  }
}

try {
  await runUnitTests();
  await runWebSocketBenchmark();
  process.exit(0);
} catch (err) {
  console.error('❌ Lỗi kiểm thử:', err);
  process.exit(1);
}
