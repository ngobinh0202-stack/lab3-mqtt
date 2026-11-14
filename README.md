# Lab 3 · Đề 1 · Giám sát và cảnh báo người chạy

**Ngô Bình** · ESP32 DevKit V1 · BMP180 · FreeRTOS · Wi-Fi · MQTT

[Báo cáo Word](Report/Lab3_De1_NgoBinh.docx) · [Mã và mạch Wokwi](Wokwi/) · [Mở dự án ESP32 mới trên Wokwi](https://wokwi.com/projects/new/esp32)

ESP32 lấy nhiệt độ và áp suất từ BMP180 mỗi giây, tính độ cao so với mực nước biển chuẩn, in ba số đo qua Serial và phát lên MQTT. Dashboard hiển thị ba số đo dạng số, hai biểu đồ và hai nút điều khiển riêng LED, còi ở chế độ MANUAL.

## 1. Mở dashboard

Mở `index.html` bằng Chrome hoặc Edge. Chế độ **Mô phỏng** chạy trong trình duyệt và có bốn kịch bản để thử hai biểu đồ, các ngưỡng cảnh báo và nút điều khiển. Có thể chạy qua HTTP tại thư mục gốc bằng `python -m http.server 8000`, sau đó mở `http://localhost:8000/`.

Chế độ **ESP32 / MQTT** nhận số đo thật của hệ thống mô phỏng trên Wokwi. Khởi chạy Wokwi trước, sao chép phần sau `Base topic:` trong Serial Monitor và điền vào dashboard. Giữ WebSocket mặc định, bấm **Kết nối** rồi đợi trạng thái **ESP32 trực tuyến**.

## 2. Mạch Wokwi

| Linh kiện | Chân | Kết nối |
| --- | --- | --- |
| BMP180 | VCC | ESP32 3V3 |
| BMP180 | GND | ESP32 GND |
| BMP180 | SDA, SCL | GPIO21, GPIO22 |
| LED đỏ | A, C | GPIO26 qua điện trở 220 Ω, GND |
| Còi piezo thụ động | 2 (+), 1 (−) | GPIO27, GND |

1. Tạo [dự án ESP32 Arduino](https://wokwi.com/projects/new/esp32) mới. Chép nội dung `Wokwi/sketch.ino` vào `sketch.ino` và `Wokwi/diagram.json` vào `diagram.json`.
2. Tạo thêm tab `RunnerMonitor.h`, chép nội dung `Wokwi/RunnerMonitor.h` vào đó. Trong **Library Manager**, thêm **Adafruit BMP085 Library**, **Adafruit BusIO** và **PubSubClient**. Wokwi lưu danh sách thư viện trong `libraries.txt`.
3. Bấm **Start Simulation**. Serial Monitor ở **115200 baud** sẽ có dòng `Base topic:`, tên tác vụ kèm lõi và `[READ]` với `T`, `P`, `Alt`. Dòng `[MQTT] Connected` cho biết ESP32 đã kết nối broker.
4. Bấm vào BMP180 trong sơ đồ khi mô phỏng đang chạy. Điều chỉnh nhiệt độ và áp suất. Wokwi hiển thị áp suất bằng hPa, ví dụ `100825 Pa = 1008,25 hPa`. Giữ mỗi thiết lập ít nhất 1 giây để ESP32 lấy mẫu.
5. Nếu Wokwi báo lỗi **IoT Gateway**, bấm **Restart the simulation**. Chép Base topic mới vào dashboard sau khi Serial hiện `[MQTT] Connected`.

### Build từ VS Code

Mở thư mục `Wokwi/` trong VS Code có PlatformIO. Chạy `pio run` để biên dịch môi trường `esp32dev`. Khi dùng tiện ích Wokwi for VS Code, lệnh **Wokwi: Start Simulator** đọc mạch và firmware qua `wokwi.toml`.

## 3. FreeRTOS và cảnh báo

| Tác vụ | Lõi | Ưu tiên | Công việc |
| --- | ---: | ---: | --- |
| `Task_DocData` | 1 | 2 | Đọc BMP180 qua I²C `0x77`, tính độ cao, in Serial. Ghi đầy đủ vào `dataQueue` và ghi nhiệt độ, độ cao vào `dataAlert`. |
| `Task_CanhBao` | 1 | 3 | Đọc `dataAlert`, tính cảnh báo, nhận lệnh MANUAL và cập nhật LED, còi 1500 Hz. |
| `Task_TruyenData` | 0 | 1 | Kết nối lại Wi-Fi/MQTT khi cần. Đọc `dataQueue`, ghép trạng thái cùng số thứ tự mẫu và phát JSON. Đưa lệnh MQTT vào `commandQueue`. |

`dataQueue` và `dataAlert` giữ mẫu mới nhất bằng `xQueueOverwrite`. Task cảnh báo gửi ảnh chụp trạng thái qua `statusQueue`. Các queue sao chép bản ghi giữa các tác vụ. Cảnh báo tại thiết bị tiếp tục chạy trong lúc task mạng kết nối lại.

Độ cao theo mét được tính từ áp suất đo được `P` theo `44330 × [1 − (P / 101325)^0,190295]`, với `P` tính bằng Pa. Dashboard dùng hPa, bằng số Pa chia cho 100.

| Tình huống | Điều kiện cảnh báo |
| --- | --- |
| Nhiệt độ thấp | `T < 15 °C` |
| Nhiệt độ cao | `T > 35 °C` |
| Đổi độ cao đột ngột | `|h mới − h trước| ≥ 10 m` giữa hai mẫu hợp lệ liên tiếp. Giữ cảnh báo 5 giây từ lần vượt ngưỡng cuối. |
| Lỗi BMP180 | Phát trạng thái lỗi và thử khởi tạo lại cảm biến ở chu kỳ tiếp theo. |

Ở **AUTO**, một trong các điều kiện trên sẽ bật cả LED và còi. Ở **MANUAL**, hai đầu ra theo lệnh riêng từ dashboard. Các cảnh báo vẫn được tính và hiển thị trên dashboard. Khi vào MANUAL, hai đầu ra bắt đầu ở trạng thái tắt.

Các ngưỡng phục vụ bài thực hành. BMP180 đo nhiệt độ tại cảm biến và ước tính độ cao từ khí áp. Kết quả độ cao phụ thuộc áp suất quy chiếu tại mực nước biển.

## 4. MQTT và nút điều khiển

| Thành phần | Cấu hình |
| --- | --- |
| ESP32 | `broker.emqx.io:1883` |
| Dashboard | `wss://broker.emqx.io:8084/mqtt` |
| Wi-Fi mô phỏng | `Wokwi-GUEST`, mật khẩu rỗng, kênh 6 |
| Base topic | `lab3/runner/ngobinh-<mã phiên>`. Xem `Base topic:` trong Serial Monitor sau mỗi lần khởi động ESP32. |

| Topic sau Base topic | Hướng | Payload |
| --- | --- | --- |
| `/telemetry` | ESP32 → web | JSON gồm `seq`, `tempC`, `pressureHpa`, `altitudeM`, `deltaM`, `mode`, `alerts`, `led`, `buzzer`. |
| `/cmd/mode` | Web → ESP32 | `AUTO` hoặc `MANUAL`. |
| `/cmd/led` | Web → ESP32 | `ON` hoặc `OFF`. |
| `/cmd/buzzer` | Web → ESP32 | `ON` hoặc `OFF`. |

`alerts` là tổng cờ `1` (nhiệt độ thấp), `2` (nhiệt độ cao), `4` (đổi độ cao), `8` (lỗi BMP180). Ví dụ `6` tương ứng nhiệt độ cao và đổi độ cao. Khi BMP180 lỗi, các trường số đo có giá trị `null`. Nút trên web hiển thị trạng thái do ESP32 gửi lại và bị vô hiệu hóa khi mất bản tin mới quá 5 giây.

## 5. Kịch bản kiểm thử trên Wokwi

| Ca | Thao tác | Kết quả mong đợi |
| --- | --- | --- |
| Bình thường | 24 °C, 101325 Pa, AUTO | Nhiệt độ khoảng 24 °C, áp suất gần 1013,25 hPa, độ cao xấp xỉ 0 m. LED và còi tắt. |
| Nhiệt độ cao | Đặt 39 °C, giữ áp suất | Cảnh báo nhiệt độ cao. LED và còi bật. |
| Nhiệt độ thấp | Đặt 10 °C, giữ áp suất | Cảnh báo nhiệt độ thấp. LED và còi bật. |
| Đổi độ cao | Đưa nhiệt độ về 24 °C. Sau một mẫu ổn định, đổi nhanh 101325 → 100825 Pa | Độ cao tăng khoảng 42 m. Cảnh báo giữ khoảng 5 giây từ lần đổi cuối, rồi tắt nếu các giá trị ổn định. |
| Điều khiển tay | Chọn MANUAL, bấm LED và Còi lần lượt để bật rồi tắt | Từng thiết bị đổi trạng thái độc lập. Dashboard cập nhật trạng thái phản hồi từ ESP32. |
| Trở về tự động | Giữ 39 °C, đang ở MANUAL và chọn AUTO | LED và còi cùng bật theo cảnh báo nhiệt độ đang có. |

Để minh họa kết quả, chụp sơ đồ Wokwi, Serial Monitor hiện ba dòng `Core`, dashboard lúc bình thường và khi kích hoạt một cảnh báo. Với kịch bản đổi độ cao, chụp trong 5 giây sau khi đổi khí áp.

## 6. Đưa dashboard lên GitHub Pages

Đặt các tệp trong thư mục `Lab3_De1_NgoBinh/` ở gốc repository. Trong **Settings → Pages**, chọn **Deploy from a branch** và chọn nhánh chứa bộ mã với thư mục `/(root)`. Bấm **Save**, sau đó mở **Visit site** khi GitHub hoàn tất triển khai. URL broker trên trang HTTPS dùng `wss://`.

## 7. Kết quả kiểm tra

- PlatformIO biên dịch thành công cho `esp32dev`. Serial Wokwi xác nhận task truyền trên Core 0, task đọc và task cảnh báo trên Core 1.
- Với giá trị ban đầu 24 °C và 101325 Pa, Serial ghi 24,0 °C, 1013,27 hPa và −0,17 m. Các mức 39 °C và 10 °C lần lượt phát cờ `2` và `1`. Khi giảm áp suất đến 100825 Pa, độ cao đo được 41,54 m. Cờ `4` tự tắt sau thời gian giữ.
- Khi Wokwi đã nối EMQX, client WebSocket nhận được `/telemetry` và xác nhận ESP32 lần lượt chuyển sang MANUAL, bật riêng LED, bật cả hai, tắt riêng LED, tắt còi và trở về AUTO. Dashboard cũng được kiểm tra với MQTT broker thử nghiệm qua WebSocket, gồm trường hợp mất dữ liệu quá 5 giây.

### Tài liệu kỹ thuật

- [Wokwi · BMP180](https://docs.wokwi.com/parts/board-bmp180) · [ESP32 WiFi Networking](https://docs.wokwi.com/guides/esp32-wifi)
- [Espressif · FreeRTOS trong ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/freertos_idf.html)
- [EMQX · Public MQTT Broker](https://www.emqx.com/en/mqtt/public-mqtt5-broker)
