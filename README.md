# Lab 3 Đề 1 — Giám sát và cảnh báo người chạy

**ESP32 DevKit V1 · BMP180 · FreeRTOS · MQTT**

[Dashboard Runner Monitor](https://lab3-runner-bmp180.anvd0910.chatgpt.site) · [Báo cáo Word](Report/Lab3_De1_RunnerMonitor.docx) · [Mã và mạch Wokwi](Wokwi/) · [Tạo dự án ESP32 trên Wokwi](https://wokwi.com/projects/new/esp32)

## 1. Tổng quan

ESP32 lấy mẫu BMP180 mỗi 1 giây, in nhiệt độ, áp suất và độ cao trên Serial Monitor, rồi phát dữ liệu qua MQTT. Dashboard hiển thị ba số đo, hai biểu đồ, nhật ký cảnh báo và nút tải CSV. Thiết bị bật đèn LED và còi khi nhiệt độ nằm ngoài ngưỡng hoặc độ cao thay đổi nhanh. Chế độ MANUAL cho phép bật hoặc tắt riêng từng đầu ra.

Dashboard có hai nguồn dữ liệu:

- **Mô phỏng** tạo số đo trực tiếp trong trình duyệt. Bốn kịch bản gồm bình thường, nhiệt độ cao, nhiệt độ thấp và độ cao đổi nhanh.
- **ESP32 / MQTT** hiển thị bản tin cảm biến thật từ ESP32 hoặc linh kiện BMP180 mô phỏng trên Wokwi. Nút điều khiển chỉ hoạt động khi dashboard có số đo gần đây và báo kết quả theo phản hồi của ESP32.

## 2. Mạch Wokwi

| Linh kiện | Tín hiệu | Nối đến |
| --- | --- | --- |
| BMP180 | VCC | ESP32 3V3 |
| BMP180 | GND | ESP32 GND |
| BMP180 | SDA | GPIO21 |
| BMP180 | SCL | GPIO22 |
| LED đỏ | Anode A | GPIO26 qua điện trở 220 Ω |
| LED đỏ | Cathode C | GND |
| Còi piezo | Chân 2 (+) | GPIO27 |
| Còi piezo | Chân 1 (−) | GND |

BMP180 dùng I²C 100 kHz, địa chỉ `0x77` và mã thiết bị `0x55`. Firmware đọc hiệu chuẩn, kích hoạt lần lượt phép đo nhiệt độ và áp suất rồi bù theo tài liệu Bosch. Còi phát 1.800 Hz khi bật.

## 3. Ba task FreeRTOS

| Task | Core | Ưu tiên | Công việc |
| --- | ---: | ---: | --- |
| `taskRead` | 1 | 2 | Đọc BMP180, tính độ cao, in Serial, gửi mẫu đầy đủ vào `dataQueue` và nhiệt độ, độ cao vào `dataAlert`. |
| `taskAlert` | 1 | 3 | Nhận `dataAlert`, kiểm tra ngưỡng, nhận lệnh qua `commandQueue`, điều khiển LED và còi, gửi trạng thái qua `controlQueue`. |
| `taskTransmit` | 0 | 1 | Kết nối Wi-Fi và MQTT, đọc `dataQueue`, ghép trạng thái cùng số thứ tự mẫu rồi phát bản tin. Chuyển lệnh MQTT vào `commandQueue`. |

Các task được gắn lõi bằng `xTaskCreatePinnedToCore`. Ba hàng đợi chứa mẫu/trạng thái dùng một ô lưu bản ghi mới nhất, giúp tránh phát dồn bản ghi cũ khi kết nối lại. `commandQueue` xếp tối đa 8 lệnh. Nếu MQTT mất kết nối, hai task trên Core 1 tiếp tục lấy mẫu và cảnh báo cục bộ.

## 4. Tính độ cao và cảnh báo

Độ cao tương đối với mực nước biển chuẩn được ước lượng từ áp suất:

```text
h = 44330 × [1 − (p / 101325)^(1 / 5.255)]
```

Trong đó `p` tính bằng Pa và `h` tính bằng m. Dashboard đổi áp suất từ Pa sang hPa bằng cách chia 100.

| Điều kiện | Cờ | Hành động AUTO |
| --- | ---: | --- |
| Nhiệt độ < 35 °C | 1 | Bật LED và còi |
| Nhiệt độ > 38 °C | 2 | Bật LED và còi |
| \|h hiện tại − h mẫu trước\| ≥ 8 m, hai mẫu hợp lệ cách nhau ≤ 2,5 giây | 4 | Bật LED và còi ít nhất 5 giây |
| Lỗi I²C hoặc dữ liệu cảm biến không hợp lệ | 8 | Bật LED và còi, thử đọc lại ở chu kỳ sau |
| Điều kiện bình thường | 0 | Tắt LED và còi |

Hai đầu mút 35 °C và 38 °C nằm trong khoảng thử. Chuyển sang MANUAL đặt hai đầu ra về tắt để bật từng thiết bị theo ý muốn. Thuật toán tiếp tục cập nhật các cờ cảnh báo trong MANUAL để dashboard vẫn ghi nhận bất thường. Khi về AUTO, đầu ra theo trạng thái mới nhất.

## 5. Chạy Wokwi và kết nối dashboard

1. Tạo [dự án ESP32 Arduino trên Wokwi](https://wokwi.com/projects/new/esp32). Dán [sketch.ino](Wokwi/sketch.ino) và [diagram.json](Wokwi/diagram.json) vào hai tab tương ứng.
2. Dùng menu tạo tệp của trình soạn thảo để thêm [Bmp180.h](Wokwi/Bmp180.h) và [RunnerLogic.h](Wokwi/RunnerLogic.h). Thêm **PubSubClient** bằng **Library Manager**. [libraries.txt](Wokwi/libraries.txt) ghim phiên bản 2.8.
3. Bấm **Start the simulation**. Serial Monitor chạy 115200 baud. Chờ dòng `[TX] MQTT OK | Base topic: …`. Ba dòng đầu của task cho biết READ và ALERT chạy Core 1, TX chạy Core 0.
4. Mở [dashboard](https://lab3-runner-bmp180.anvd0910.chatgpt.site) hoặc mở `index.html` từ thư mục đã tải về. Chọn **ESP32 / MQTT**, dán Base topic đầy đủ và bấm **Kết nối**.
5. Bấm vào BMP180 trên sơ đồ để điều chỉnh Temperature và Pressure trong lúc mô phỏng. Wokwi hiển thị áp suất theo hPa, còn thiết lập `pressure` trong `diagram.json` dùng Pa.
6. Chọn **MANUAL** và chờ dòng «ESP32 đã xác nhận lệnh». Bật/tắt **Đèn LED** và **Còi** riêng, đồng thời quan sát mạch Wokwi. Chọn lại AUTO để kiểm tra cảnh báo theo ngưỡng.

### Địa chỉ MQTT

| Thành phần | Địa chỉ hoặc dữ liệu |
| --- | --- |
| ESP32 | `broker.emqx.io:1883` |
| WebSocket của dashboard | `wss://broker.emqx.io:8084/mqtt` |
| Số đo và trạng thái | `<Base topic>/telemetry` |
| Lệnh điều khiển | `<Base topic>/cmd` |
| Lệnh | `<mã 8 ký tự hex>:auto`, `manual`, `led-on`, `led-off`, `buzzer-on`, `buzzer-off` |

Mỗi lần khởi động, ESP32 tạo một Base topic mới. Bản tin JSON dùng `seq` cho số mẫu, `ms` cho thời gian thiết bị, `t` cho °C, `p` cho Pa, `h` cho m và `alerts` cho các cờ. Các trường `mode`, `led`, `buzzer` báo trạng thái xác nhận từ ESP32. `ack` và `ok` xác nhận mã lệnh và kết quả. Bản tin mới và lệnh dùng QoS 0, không giữ lại.

## 6. Kiểm thử

| Kịch bản Wokwi | Giá trị thử | Kết quả cần quan sát |
| --- | --- | --- |
| Bình thường | 36,5 °C · 1006,00 hPa | Độ cao khoảng 60,53 m, cờ 0 |
| Nhiệt độ cao | 39,2 °C ở áp suất ổn định | Cờ 2, LED và còi bật ở AUTO |
| Nhiệt độ thấp | 34,0 °C ở áp suất ổn định | Cờ 1, LED và còi bật ở AUTO |
| Độ cao đổi nhanh | 1006,00 → 1003,84 hPa ở 36,5 °C | Độ cao khoảng 60,53 → 78,64 m, cờ 4 giữ 5 giây |
| Điều khiển độc lập | MANUAL → LED bật → còi bật → LED tắt | Kết thúc LED tắt, còi bật |
| Dừng Wokwi | Bấm **Stop** | Khi bản tin hết hạn, dashboard báo chờ dữ liệu và khóa nút điều khiển |

Chạy `node tests/verify.js` với Node.js và trình biên dịch `g++` để kiểm tra ví dụ chuẩn BMP180, đối chiếu 28 bước C++ và JavaScript, kiểm tra gói MQTT và xác nhận lệnh. Firmware biên dịch với Arduino ESP32 2.0.17 và PubSubClient 2.8.

### Tệp dự án

| Tệp | Nội dung |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Dashboard và tương tác |
| `model.js`, `mqtt-wire.js` | Công thức, cảnh báo mô phỏng và MQTT 3.1.1 qua WebSocket |
| `Wokwi/` | Firmware, thư viện, phần mô phỏng và sơ đồ nối dây |
| `Report/` | Báo cáo Word |
| `tests/` | Kiểm thử C++ và JavaScript |

### Phạm vi mô phỏng

BMP180 đọc nhiệt độ tại cảm biến và áp suất khí quyển. Muốn đo thân nhiệt cần cảm biến và phương pháp đặt cảm biến thích hợp. Giá trị 35–38 °C dùng cho kịch bản thực hành. Độ cao thay đổi theo áp suất quy chiếu và thời tiết. Broker công cộng dùng cho dữ liệu thử.

### Tài liệu kỹ thuật

- [Bosch Sensortec · BMP180 Datasheet](https://www.mouser.com/datasheet/2/783/BST-BMP180-DS000-1509579.pdf)
- [Wokwi · BMP180](https://docs.wokwi.com/parts/board-bmp180) và [ESP32 Wi-Fi](https://docs.wokwi.com/guides/esp32-wifi)
- [Espressif · FreeRTOS task affinity](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/system/freertos_additions.html)
- [EMQX · Public MQTT Broker](https://www.emqx.com/en/mqtt/public-mqtt5-broker)
