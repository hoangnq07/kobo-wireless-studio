# Kobo Wireless Studio & Multi-Thread E-Ink Converter

> **Trạm quản lý thư viện không dây (HTTP `:8080` + FTP `:1021`) tích hợp Bộ chuyển đổi sách Đa luồng (`Web Workers + OffscreenCanvas`) chạy 100% trên trình duyệt dành cho máy đọc sách Kobo (256 MB RAM).**
>
> *Zero-RAM-overhead LuaJIT HTTP streaming server & BusyBox FTP hub for Kobo e-readers, paired with a client-side Multi-Threaded Web Worker Pool that converts `.DOCX` / `.EPUB` / `.TXT` / `.PDF` → `.KEPUB.EPUB` and flattens heavy scanned PDFs for crisp E-Ink rendering before transferring over LAN.*

---

## Điểm nổi bật | Key Features

- **Xử lý Đa luồng trên Trình duyệt (`0% CPU / 0 MB RAM` gánh nặng trên Kobo):**
  - **`PdfWorkerPool` + `OffscreenCanvas`:** Huy động đồng thời `2–14` nhân CPU trên máy tính/điện thoại để render, cắt viền trắng tự động, ánh xạ bảng tra độ tương phản E-Ink 32-bit (`EINK_RGBA32_LUT`) và phẳng hóa PDF Scan nặng hàng trăm trang về đúng 1 lớp ảnh/trang (`758×1024`), chống triệt để giật lag & lỗi tràn RAM (`Exit Code 137`) trên Kobo 256 MB RAM (~`108 trang/giây` trên PC đa nhân).
  - **`SpanWorkerPool` + `ZipWorker`:** Tự động chuyển `.DOCX`, `.EPUB`, `.TXT`, `.MD` hoặc PDF văn bản sang chuẩn **`.kepub.epub`**, chèn thẻ `koboSpan` song song trên nhiều luồng CPU và đóng gói ZIP không nén `mimetype` chuẩn EPUB ngoài luồng giao diện chính.
  - **100% Offline trong mạng LAN:** Toàn bộ thư viện (`PDF.js`, `JSZip`, `Mammoth`) được phục vụ trực tiếp từ `/mnt/onboard/.adds/tools/vendor/` ngay trên Kobo — không cần kết nối Internet bên ngoài, nạp đúng 1 lần duy nhất mỗi phiên qua `Blob` Worker nội bộ.
- **Máy chủ HTTP Streaming (`:8080`) & FTP (`:1021`) siêu nhẹ, an toàn USB:**
  - Viết bằng **LuaJIT + LuaSocket + LFS** tận dụng môi trường sẵn có của **KOReader**, truyền luồng theo khối `64 KB` (tải sách `100–500 MB+` không tốn RAM).
  - Tự động chuyển thư mục làm việc (`cwd`) sang `/tmp` và lưu log runtime trên RAM để **không bao giờ giữ khóa phân vùng `/mnt/onboard`** khi cắm cáp USB vào máy tính.
  - Hỗ trợ cổng nạp nóng `POST /api/reload` cập nhật giao diện ngay trong RAM không cần khởi động lại dịch vụ.
  - Tự động đồng bộ ảnh nghỉ màn hình hai chiều giữa Kobo gốc (`/.kobo/screensaver`) và KOReader (`/.adds/koreader/screensavers`).
- **Giao diện Web Studio tối giản, chuẩn xác trên cả PC & Điện thoại:**
  - Giao diện Sáng / Tối (`Light / Dark`), thanh dung lượng bộ nhớ trực quan, bảng quản lý tệp khóa cứng cột (`table-layout: fixed`) tự động ngắt dòng mượt mà với cả những tên sách dài hàng trăm ký tự.
  - Tích hợp nút **Tối ưu** ngay trên từng tệp đang nằm sẵn trong Kobo (tải về trình duyệt → tối ưu đa luồng → chép trả lại Kobo chỉ với 1 cú nhấp).

---

## Cấu trúc dự án | Project Structure

```text
kobo-wireless-studio/
├── src/
│   ├── studio_base.html          # Giao diện Web Studio gốc (HTML5 + CSS Grid/Fixed-Table + SVG Sprite)
│   ├── converter_engine.js       # Nhân chuyển đổi Đa luồng v2.0 (PdfWorkerPool, SpanWorkerPool, ZipWorker)
│   ├── server_base.lua           # Máy chủ HTTP :8080 bằng LuaJIT (Zero-RAM streaming + /api/reload)
│   └── wifi_files.sh             # Trình bật/tắt song song HTTP :8080 + FTP :1021 + giữ kết nối LAN
├── scripts/
│   ├── build.py                  # Trình đóng gói từ src/ -> dist/ (kiểm tra cú pháp JS, SVG & không dùng emoji)
│   └── deploy_wifi.py            # Đẩy bản cập nhật qua Wi-Fi + kiểm chứng SHA-256 + nạp nóng vào RAM
├── tests/
│   └── test_multithread_e2e.py   # Bộ kiểm thử tự động trên Headless Chromium (PDF Scan 200 trang, KEPUB)
└── dist/
    ├── studio_standalone.html    # Bản HTML độc lập để xem trước giao diện ngay trên trình duyệt
    └── kobo_overlay/             # Thư mục chép đè trực tiếp vào ổ USB gốc của Kobo (/mnt/onboard/)
        └── .adds/
            ├── nm/wifi_studio.nm
            └── tools/
                ├── webfiles.lua
                ├── wifi_files.sh
                └── vendor/       # Thư viện JS nội bộ chạy offline 100% qua mạng LAN
```

---

## Hướng dẫn cài đặt lên Kobo | Installation

### Yêu cầu trước khi cài
1. Máy đọc sách Kobo đã cài **[KOReader](https://github.com/koreader/koreader)** (tại `/.adds/koreader` — cung cấp `luajit` và `libkoreader-lfs.so`).
2. Đã cài **[NickelMenu](https://pgaskin.net/NickelMenu/)** (tại `/.adds/nm`).

### Các bước cài đặt (qua cáp USB)
1. Cắm Kobo vào máy tính qua cáp USB.
2. Sao chép toàn bộ thư mục `.adds` bên trong [`dist/kobo_overlay/`](dist/kobo_overlay/) đè vào thư mục gốc của ổ đĩa Kobo.
3. *(Khuyên dùng)* Để Kobo không tự động cúp ngầm Wi-Fi sau 60 giây khi đang truyền sách, mở tệp `.kobo/Kobo/Kobo eReader.conf` trên Kobo và đảm bảo có dòng sau dưới mục `[DeveloperSettings]`:
   ```ini
   [DeveloperSettings]
   ForceWifiOn=true
   ```
   > **Lưu ý về Pin:** `ForceWifiOn=true` **chỉ** giữ kết nối khi bạn đang bật công tắc Wi-Fi (`Wi-Fi: On`). Khi dùng xong và bạn chủ động bấm **Tắt Wi-Fi (`Wi-Fi: Off`)** trên thanh trạng thái Kobo, máy vẫn cắt nguồn phần cứng chip Wi-Fi hoàn toàn — **không hao thêm bất kỳ % pin nào**.
4. Ngắt kết nối USB an toàn (`Eject`).

### Cách sử dụng hằng ngày
1. Bật **Wi-Fi** trên Kobo để kết nối mạng gia đình.
2. Bấm menu **`Tiện ích` (NickelMenu) → `Chép sách Wi-Fi (Bật/Tắt)`**. Màn hình sẽ hiện địa chỉ:
   - **Web Studio:** `http://<IP-của-Kobo>:8080` (mở trên trình duyệt máy tính hoặc điện thoại để kéo thả & tự động chuyển đổi sách).
   - **FTP Server:** `ftp://root:kobo@<IP-của-Kobo>:1021` (dán thẳng vào thanh địa chỉ Windows File Explorer hoặc FileZilla).
3. Sau khi chép sách xong:
   - Bấm lại **`Chép sách Wi-Fi (Bật/Tắt)`** để tắt dịch vụ và **tắt Wi-Fi** trên Kobo để tiết kiệm pin tối đa.
   - **KOReader** nhận sách mới tức thì; nếu đọc trên giao diện Kobo gốc (Nickel), bấm **`Tiện ích` → `Quét lại sách mới`**.

---

## Tự đóng gói & Cập nhật từ mã nguồn | Build & Live Wi-Fi Deploy

```bash
# 1. Đóng gói lại dist/studio_standalone.html và dist/kobo_overlay/.adds/tools/webfiles.lua
python -X utf8 scripts/build.py

# 2. Chạy bộ kiểm thử tự động E2E đa luồng (yêu cầu Google Chrome / Edge trên máy)
python -X utf8 tests/test_multithread_e2e.py

# 3. Đẩy bản cập nhật không dây thẳng vào Kobo đang bật Web Studio & nạp nóng vào RAM
python -X utf8 scripts/deploy_wifi.py --host 192.168.1.188
```

---

## Giấy phép | License

Phát hành theo giấy phép [MIT License](LICENSE). Các thư viện trình duyệt đi kèm trong `vendor/` (`PDF.js` — Apache-2.0, `JSZip` — MIT, `Mammoth.js` — BSD-2-Clause) thuộc bản quyền của các tác giả tương ứng.
