# 📓 Cờ Caro Vở Ô Ly Việt Nam (`caro-vo-o-ly-vn`)

Webgame **Cờ Caro Việt Nam** tái hiện chân thực trang vở ô ly học sinh **200 trang**, hỗ trợ khoanh vùng thế cờ cũ bằng đường viền bút bi bo sát (Polygonal Contour Dead-Zone) để chơi nhiều ván độc lập trên cùng một trang vở, kèm hệ thống AI 10 cấp độ từ **Tập Sự** đến **Cờ Thánh** và kiến trúc Multiplayer WebSocket chịu tải **10,000 người chơi cùng lúc (10k CCU)** với độ trễ `< 30ms` (yêu cầu `< 3s`).

---

## ✨ Tính năng nổi bật

1. **Giao diện Trang Vở Ô Ly Học Sinh Việt Nam & Quyển Vở 200 Trang**:
   - Trang giấy trắng ngà kẻ 4 ô ly xanh đậm/nhạt chuẩn vở học sinh Việt Nam, lề đỏ đôi bên trái, dòng ghi ngày tháng `Thứ ... ngày ... tháng ... năm ...` và nhãn vở học sinh truyền thống.
   - Mỗi người chơi sở hữu **1 quyển vở 200 trang** lưu trực tiếp trên trình duyệt qua **IndexedDB** (có mục lục 200 trang, thống kê % diện tích giấy còn trống, hỗ trợ Xuất/Nhập quyển vở `.json`).

2. **Khoanh vùng "Điểm chết" bằng đường viền bút bi bo sát (Polygonal Contour)**:
   - Khi một ván cờ kết thúc, thế cờ vừa đánh sẽ được vẽ đường viền bút bi bo sát theo cụm quân cờ kèm nhãn kết quả (`Ván #1: X thắng`, `Ván #2: O thắng`...).
   - Vùng đã khoanh trở thành **Điểm chết (Dead Zone)**: người chơi có thể tiếp tục đánh nhiều ván cờ mới ngay trên phần giấy trống còn lại của cùng trang vở đó; cờ mới không thể đánh đè lên vùng đã khoanh và không liên kết với quân cờ của ván cũ.

3. **Chuẩn Luật Cờ Caro Việt Nam**:
   - Cho phép bật/tắt tùy chọn **Luật chặn 2 đầu** (5 quân liên tiếp bị chặn cả 2 đầu bởi quân đối phương hoặc vùng điểm chết sẽ không tính thắng).

4. **2 Chế độ chơi chính (PvP & PvE)**:
   - **PvE (10 Cấp độ khó từ Tập Sự đến Cờ Thánh)**:
     - Cấp 1: Tập Sự → Cấp 2: Học Trò → Cấp 3: Tổ Trưởng → Cấp 4: Lớp Trưởng → Cấp 5: Cờ Thủ Xóm → Cấp 6: Cao Thủ Trường → Cấp 7: Kiện Tướng → Cấp 8: Đại Sư → Cấp 9: Kỳ Tiên → **Cấp 10: Cờ Thánh** (Iterative Deepening Alpha-Beta + Truy sát VCF liên hoàn chạy trên Web Worker riêng biệt).
   - **PvP Local (Chung màn hình)**: Hỗ trợ 2–4 người chơi (`X`, `O`, `Δ`, `□`) trên cùng một thiết bị.
   - **PvP Co-op Online (Nhiều người chơi qua WebSocket)**:
     - **Đấu 1v1 Cổ điển** (có khán giả xem trực tiếp).
     - **Co-op Chia Phe (Đội X vs Đội O)** nhiều người cùng vào 2 phe luân phiên đánh trên cùng trang vở.
     - **Hỗn Chiến 2–4 Người (`X`, `O`, `Δ`, `□`)** mỗi người một màu mực bút bi.

---

## 🚀 Cài đặt & Khởi chạy

```bash
# Cài đặt dependency duy nhất (ws)
npm install

# Chạy server (http://localhost:3000)
npm start

# Chạy chế độ đa nhân (Cluster) cho môi trường Production 10,000+ CCU
npm run start:cluster

# Chạy kiểm thử tự động & Benchmark chịu tải WebSocket
npm run benchmark
```

## 📚 Tài liệu Kỹ thuật & Phát triển (SDLC & Changelog)

Để phát triển thêm tính năng mới, bảo trì hoặc tìm hiểu sâu về kiến trúc hệ thống, vui lòng tham khảo bộ tài liệu chuẩn hóa của dự án:

- 📘 **[Tài liệu Vòng đời Phát triển Phần mềm (SDLC.md)](./SDLC.md)**: Phân tích yêu cầu nghiệp vụ, sơ đồ kiến trúc hệ thống, cấu trúc dữ liệu IndexedDB, đặc tả giao thức Co-op WebSocket/MQTT Relay, **5 Bất biến kỹ thuật bắt buộc (Core Invariants)** và Playbook hướng dẫn mở rộng tính năng mới.
- 📝 **[Nhật ký Thay đổi (CHANGELOG.md)](./CHANGELOG.md)**: Lịch sử chi tiết các phiên bản (`v1.0.0` → `v1.3.1`), các bản vá lỗi khoanh vùng đa ván, giao diện Học Trò 9x và kiểm thử đa tác tử Co-op.

---

## 📜 Bản quyền & Sở hữu trí tuệ

Dự án được bảo hộ theo **Mô hình Bản quyền Kép (Dual-Layer Intellectual Property License)** quy định chi tiết tại tệp [LICENSE](./LICENSE):
- **Miễn phí 100%** cho người chơi cá nhân, học sinh, sinh viên và mục đích giáo dục / phi thương mại (PolyForm Noncommercial 1.0.0).
- **Bảo lưu toàn bộ quyền sở hữu trí tuệ, thương hiệu, thiết kế giao diện và quyền khai thác thương mại độc quyền** cho Tác giả gốc (CC BY-NC-ND 4.0 & All Rights Reserved).
