# 📝 Nhật Ký Thay Đổi (CHANGELOG) — Cờ Caro Vở Ô Ly Việt Nam

Mọi thay đổi quan trọng, tính năng mới, cải tiến giao diện và bản vá lỗi của dự án **Cờ Caro Vở Ô Ly Việt Nam (`caro-vo-o-ly-vn`)** đều được ghi chép đầy đủ tại đây theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.0.0/) và [Semantic Versioning](https://semver.org/).

---

## [1.4.0] - 2026-10-17 — Tối ưu Luồng Chơi PvE, Gộp PvP Local vào Co-op, Khung Chat Trực Tiếp & Khắc Phục Tạo Bàn Dev Server

### Thêm mới & Cải tiến (Added & Changed)
- **Luồng chơi Đấu Với Máy (PvE) trong `#view-game`:**
  - Dọn sạch khối `.quick-setup-box` và nút chọn Local khỏi `#view-menu`. Menu chính nay được tinh giản tối đa chỉ còn 2 lối vào trực quan: **Đấu Với Máy Cùng Bàn (PvE)** và **Chơi Cùng Bạn Bè (Co-op & Chung Tờ Giấy)**.
  - Tích hợp thanh công cụ `#game-mode-toolbar` trực tiếp ngay dưới thước kẻ của màn hình `#view-game`: cho phép người chơi chọn cấp độ AI (1–10) và màu bút (`X` / `O`) ngay trong giao diện bàn cờ.
  - **Không tự động bắt đầu ván mới:** Khi người chơi vào bàn, lật trang, đổi sang cầm `O` (máy đi trước) hoặc khi vừa kết thúc 1 ván cờ, máy **tuyệt đối không tự động đánh** cho tới khi người chơi chủ động bấm nút `▶️ Bắt đầu ván mới` hoặc tự tay chấm nước cờ đầu tiên.
- **Gộp Chế độ Chơi Chung 1 Tờ Giấy (PvP Local) vào Sảnh Co-op:**
  - Đưa thể thức **Chơi Chung 1 Tờ Giấy (2–4 bạn chung màn hình)** vào thẳng sảnh Co-op (`#view-coop-lobby`).
  - Khi chọn thể thức này, hệ thống **không cần tạo phòng online** mà chuyển thẳng vào màn hình bàn cờ `#view-game` với thanh điều khiển `#local-game-controls` (hỗ trợ chọn nhanh 2, 3 hoặc 4 bạn chơi chung tờ giấy).
- **Quy tắc Bắt đầu Bàn Co-op & Khung Chat Trực tiếp Trong Game:**
  - Bàn Co-op bắt buộc phải có ít nhất **2 người chơi thuộc 2 phe khác nhau** (`heldActiveSymbols.size >= 2`) mới mở khóa nút bắt đầu ván đấu. Khi chưa đủ, nút `#btn-enter-coop-board` hiển thị `⏳ Đợi đủ 2 phe khác nhau để bắt đầu...`.
  - Khi bắt đầu ván cờ, gói tin `coop_game_started` được phát thanh tới toàn phòng, giúp **tất cả người chơi tự động được chuyển từ sảnh chờ vào màn hình bàn cờ `#view-game` cùng một lúc**.
  - Tích hợp khung chat trực tiếp `#game-coop-chat-panel` ngay trong màn hình bàn cờ `#view-game`: đồng bộ thời gian thực với phòng chờ, hỗ trợ chip chat nhanh, có nút thu gọn/mở rộng và nút quay lại phòng chờ.

### Đã sửa (Fixed)
- **Khắc phục lỗi không tạo được bàn Co-op khi chạy qua VS Code Live Server / Dev Server (`public/js/multiplayer.js`):**
  - Bổ sung cơ chế **Xác thực bắt tay hai chiều (`serverHandshakeVerified`)** với timeout `1.2s`: không còn tin tưởng mù quáng vào `socket.onopen` khi gặp phải cổng WebSocket nội bộ của Live Server (cổng 5500) hoặc Vite. Nếu không nhận được bản tin `{ type: 'welcome' }` từ Game Server Caro thực sự, client tự động ngắt kết nối giả và chuyển sang cơ chế Fallback 3 lớp (`BroadcastChannel` + `localStorage` + `Cloud MQTT Relay`).
  - Bổ sung định tuyến tự động khi chạy dev trên máy cá nhân: ưu tiên kết nối tới cổng Game Server `3000` nếu khả dụng, giúp việc tạo bàn, tham gia phòng và thi đấu diễn ra mượt mà trong mọi môi trường chạy thử.

---

## [1.3.1] - 2026-10-17 — Kiểm thử Đa Tác Tử (4 Subagents) & Hoàn thiện Chế độ Co-op Online
> **Commit:** `d5f18f0` — *fix(coop): resolve multi-player edge cases found by 4 player subagents*

### Đã sửa (Fixed)
- **Bảo vệ Vở Cá Nhân & Chuyển quyền Chủ phòng (`app.js`, `server/index.js`, `multiplayer.js`):**
  - Bổ sung `pageOwnerClientId` và `pageOwnerName` tách biệt với `hostClientId` / `hostName`. Khi Chủ phòng cũ ngắt kết nối đột ngột và Khách được đôn lên làm Chủ phòng mới, dữ liệu trang vở của Chủ phòng cũ **không** ghi đè vào IndexedDB trang cùng số của Chủ phòng mới.
  - Bảo toàn nguyên vẹn ván cờ offline (`activeGame`) đang đánh dở của Chủ phòng trên trang được chọn mở phòng Co-op, và không lưu rác các nước đi `pvp-online` chưa kết thúc vào vở cá nhân.
  - Bổ sung `personalPageNumber` và hàm `_exitCoopRoomAndRestorePersonalPage()`: khi người chơi bấm **Về Chỗ Ngồi (`#btn-leave-room`)** hoặc **Gấp vở về Menu (`.btn-back`)**, hệ thống tự động rời phòng Co-op, đưa `mode` về `'pve'` và khôi phục đúng trang vở cá nhân của người chơi.
- **Chặn Lỗ hổng Đổi Phe Giữa Ván & Tự Đánh Một Mình (`server/index.js`, `multiplayer.js`, `app.js`):**
  - Chặn người chơi đang cầm bút đổi màu bút hoặc chuyển sang `SPECTATOR` khi ván cờ đang diễn ra (`room.moves.length > 0`).
  - Chặn chọn trùng ký hiệu cờ trong cả chế độ **Đấu 1v1 (`1v1`)** và **Hỗn Chiến (`ffa`)** trên cả Server lẫn Fallback.
  - Yêu cầu tối thiểu **2 phe cầm bút** trong bàn (`heldActiveSymbols.size >= 2`) mới cho phép đánh nước cờ đầu tiên hoặc tiếp tục ván đấu.
- **Sửa lỗi Nhảy cóc Lượt đi trong Hỗn Chiến FFA (`server/index.js`, `multiplayer.js`):**
  - Thay thế công thức tính lượt tĩnh `activeSymbols[turnIndex % activeSymbols.length]` bằng hàm `recomputeRoomTurnState(room)` lưu tường minh `room.currentTurnSymbol`. Khi một người chơi (ví dụ `O`) rời phòng đúng lúc đang tới lượt của `Δ`, lượt của `Δ` được giữ nguyên chứ không bị nhảy cóc về `X`.
- **Sửa lỗi Tự hủy Phòng khi Tự Join lại / Bấm Ghép Bàn Nhanh (`server/index.js`, `multiplayer.js`):**
  - Kiểm tra `ws.roomId === cleanId` trong `joinExistingRoom()` trước khi gọi `removeClientFromCurrentRoom(ws)`.
  - Bỏ qua phòng hiện tại của chính mình khi tìm bàn trong `quick_match`, và tính `isRoomJoinable` theo số người chơi thực sự cầm bút (`symbol !== 'SPECTATOR'`) thay vì tổng số kết nối.
- **Đồng bộ Chế độ Serverless Fallback & Giao diện Co-op (`multiplayer.js`, `app.js`):**
  - Bổ sung kiểm tra **Hòa cờ (`countPlayableCells === 0`)**, sinh `activeGameId` mới sau mỗi ván, thêm timeout `1.5s` báo lỗi khi nhập sai Mã Phòng, và tự động chuyển quyền Chủ phòng khi đóng tab (`beforeunload`) trong chế độ Fallback.
  - Cập nhật thống kê `profile.stats` (`wins`, `draws`, `losses`) khi hoàn thành ván Co-op.
  - Tự động ẩn `#game-end-banner` khi Chủ phòng lật sang trang vở mới.
  - Hiển thị rõ phe cầm bút của người chơi trên thanh Topbar `#view-game` (`✍️ Lượt bạn (X)`, `Lượt: O (Bạn cầm: X)`, `👀 Khán giả`), ẩn nút `✒️ Khoanh ván` đối với Khách, và hiển thị thông báo kèm bộ đếm tin nhắn chưa đọc trên nút `💬 Bàn học (N)`.

---

## [1.3.0] - 2026-10-17 — Sửa lỗi Khoanh vùng Đa ván & Tìm bàn Co-op Xuyên Thiết Bị
> **Commit:** `6e57ee2` — *fix(core,coop): prevent adjacent moves from being fenced into old games and fix Co-op room discovery*

### Đã sửa (Fixed)
- **Thuật toán Khoanh vùng Điểm chết Đa ván (`public/js/rules.js`, `public/js/board-renderer.js`, `public/js/ai-engine.js`, `public/js/app.js`):**
  - Loại bỏ việc giãn nở `dilation (r±1, c±1)` quanh các quân cờ khi khoanh ván kết thúc — chỉ những ô thực sự thuộc thế cờ vừa đánh (và các ô trống bị vây kín hoàn toàn ở bên trong thế cờ đó) mới trở thành Điểm chết.
  - Khắc phục triệt để lỗi gộp `existingDeadSet` vào tập đánh dấu của ván mới khiến đường khoanh của ván cũ phình to hoặc nuốt nhầm các quân cờ tiếp theo.
  - Vẽ đường viền bút bi bo sát từng ô theo lưới ô ly kèm số thứ tự nước đi giúp phân biệt rõ ván đã khoanh và ván đang đánh.
  - Thêm cơ chế chống click nhầm theo quán tính (`350ms`) ngay sau khi ván cờ kết thúc và tăng `aiRequestSeq` để hủy mọi nước đi AI tồn đọng của ván cũ.
- **Khám phá Phòng Co-op Xuyên Trình Duyệt & Xuyên Thiết Bị (`public/js/multiplayer.js`, `server/index.js`):**
  - Bổ sung hàng đợi `pendingPayloads` đảm bảo không rơi gói tin khi người chơi bấm tạo/tìm bàn ngay lúc WebSocket đang kết nối.
  - Tích hợp kiến trúc **3 tầng đồng bộ Serverless** (Global Cloud MQTT-over-WSS + `BroadcastChannel` + `localStorage` Registry) giúp tìm thấy bàn của nhau ngay cả trên GitHub Pages tĩnh.
  - Bổ sung tính năng **Ghép Bàn Nhanh (`quick_match`)** và tự động chuyển quyền Chủ phòng khi Chủ phòng thoát.

---

## [1.2.1] - 2026-10-17 — Kiểm thử & Vá lỗi Hiển thị Giao diện Học Trò 9x trên Desktop & Mobile
> **Commit:** `e9930e2` — *fix(ui): resolve notebook cover clipping, font bullet glyph, canvas spine & mobile layout bugs*

### Đã sửa (Fixed)
- **Bìa vở Menu chính (`public/css/styles.css`):** Sửa lỗi cắt mép ngang `overflow: hidden` trên `.notebook-cover-card` và hỗ trợ tự động co giãn chiều cao trên màn hình thấp.
- **Lỗi ký tự Bullet `•` của Font `"Mali"` (`public/index.html`, `public/js/app.js`, `public/js/board-renderer.js`):** Thay thế toàn bộ ký tự `•` (`U+2022` bị font Mali vẽ thành hình bông hoa) bằng dấu gạch ngang `-` hoặc `|`.
- **Gáy vở Canvas & Con dấu điểm 10 (`public/js/board-renderer.js`):** Tăng `leftMarginX` từ `46` lên `56`, dịch ghim bấm sát mép trái (`x = 4..18`) và đặt con dấu `10đ` vào góc phải tiêu đề để không đè lên cột cờ `0, 1`.
- **Mục lục 200 Trang & Thống kê % Giấy trống (`public/js/notebook-store.js`, `public/js/app.js`):** Hiển thị tối thiểu `1%` đã dùng (tối đa `99%` trống) ngay khi trang vở đã có ít nhất 1 ván khoanh vùng.
- **Responsive Mobile (`public/css/styles.css`):** Tối ưu thanh Topbar 2 hàng gọn gàng trên màn hình điện thoại (`390×844`), mở rộng diện tích tờ giấy vở lên `> 72%` chiều cao màn hình.

---

## [1.2.0] - 2026-10-17 — Thiết kế lại Giao diện Phong cách Học Trò Việt Nam Thập niên 9x
> **Commit:** `73b8652` — *style: redesign UI with nostalgic 9x Vietnamese school notebook theme*

### Thay đổi (Changed)
- Thiết kế lại toàn bộ giao diện theo phong cách **Học Trò 9x**: mặt bàn gỗ trường học ấm áp, bìa vở xanh Hải Tiến / Hồng Hà, nhãn vở khung đôi in hoa văn góc, thẻ học sinh, sổ đầu bài / giấy nháp vàng, thước kẻ gỗ và con dấu lời phê giáo viên màu đỏ tươi.
- Nâng cấp `board-renderer.js` vẽ gáy vở có ghim sắt, hiệu ứng chồng giấy nhiều trang, lời phê cô giáo và điểm `10đ` gạch chân kép khi có ván thắng.

---

## [1.1.0] - 2026-10-17 — Tối giản Giao diện 5 Màn hình, Đồng bộ Trang vở Chủ phòng & Responsive
> **Commit:** `99a1a06` — *feat(ui): minimalist multi-screen layout, host notebook page coop sync, and mobile responsive zoom*

### Thêm mới & Thay đổi (Added & Changed)
- Tách giao diện thành **5 màn hình độc lập**:
  1. **Menu Chính (`#view-menu`)**
  2. **Sảnh Co-op (`#view-coop-lobby`)**
  3. **Mục Lục & Lịch Sử 200 Trang (`#view-history`)**
  4. **Cài Đặt & Thẻ Học Sinh (`#view-settings`)**
  5. **Trang Vở Đánh Cờ (`#view-game`)**
- Trong chế độ **Co-op Online**, tất cả người chơi cùng đại chiến trên trang vở của Chủ phòng; Chủ phòng có thể chọn bất kỳ trang nào (`1 -> 200`) từ quyển vở của mình trước khi bắt đầu ván.
- Bổ sung nút Thu phóng (`Zoom - / +`) và hỗ trợ cảm ứng (Touch) trên thiết bị di động.

---

## [1.0.0] - 2026-10-17 — Phát hành Phiên bản Đầu tiên & Triển khai GitHub
> **Commit:** `a1468d9` — *feat: initial release of Caro Vo O Ly Viet Nam webgame*

### Thêm mới (Added)
- Engine Cờ Caro Việt Nam trên trang vở ô ly `32×24` với luật chặn 2 đầu tùy chọn và thuật toán khoanh vùng Điểm chết (`Polygonal Contour Dead-Zone`) cho phép đánh nhiều ván độc lập trên cùng một trang vở.
- Quyển vở ô ly **200 trang** lưu trữ bằng **IndexedDB** (`NotebookStore`), hỗ trợ Xuất/Nhập `.json`.
- Hệ thống **PvE 10 cấp độ AI** từ *Tập Sự* đến *Cờ Thánh* chạy trên Web Worker.
- Chế độ **PvP Local** (2–4 người chung màn hình) và **PvP Co-op Online** (1v1, Chia Phe Team, Hỗn Chiến FFA).
- Kiến trúc Node.js WebSocket Server & Cluster chịu tải **10,000 CCU** (`< 30ms` latency), kèm giấy phép bản quyền kép [`LICENSE`](file:///d:/99.Repo/caro-vn/LICENSE) và workflow CI/CD GitHub Pages.
