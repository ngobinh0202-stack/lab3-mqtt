# FALLDETECTION – HỆ THỐNG MÔ PHỎNG PHÁT HIỆN TÉ NGÃ

# [BÁO CÁO](Report/lab3_report.docx)

**Ngô Bình**  
**Nền tảng** · ESP32 DevKit V1 · MPU6050 · FreeRTOS · MQTT · Web Dashboard

[Mở dashboard trực tuyến](https://falldetection-duc.anvd0910.chatgpt.site) · [Mã và sơ đồ Wokwi](Wokwi/) · [Tạo mô phỏng ESP32](https://wokwi.com/projects/new/esp32)

## 1. Giới thiệu

FallDetection kiểm tra dấu hiệu té ngã qua hai giai đoạn. ESP32 phát hiện đỉnh gia tốc, sau đó xác minh sự thay đổi tư thế và thời gian giữ ổn định. Khi đủ điều kiện, thiết bị bật LED và còi. Dashboard hiển thị số đo, trạng thái và nhật ký cảnh báo.

Chế độ **Mô phỏng** chạy trực tiếp trong trình duyệt và có ba kịch bản để kiểm tra. Chế độ **ESP32 / MQTT** theo dõi thiết bị mô phỏng trên Wokwi, đồng thời gửi lệnh thử, xác nhận và hiệu chuẩn.

## 2. Chạy dashboard

1. Mở [dashboard trực tuyến](https://falldetection-duc.anvd0910.chatgpt.site) hoặc giải nén dự án và mở `index.html` bằng Chrome hoặc Edge.
2. Giữ chế độ **Mô phỏng** rồi bấm **Té ngã**. Sau khoảng 2,2 giây, cảnh báo xuất hiện và bộ đếm tăng một lần.
3. Bấm **Xác nhận cảnh báo**. Thử **Va chạm** và **Nghiêng chậm** để quan sát lý do bộ đếm giữ nguyên.
4. Chuyển giữa **Gia tốc** và **Góc nghiêng** trên biểu đồ. Bấm **Xuất CSV** để tải nhật ký của nguồn dữ liệu đang chọn.

## 3. Mạch ESP32 và kết nối

| Linh kiện | Tín hiệu | Kết nối |
| --- | --- | --- |
| MPU6050 | VCC, GND, AD0 | 3V3, GND, GND |
| MPU6050 | SDA, SCL | GPIO21, GPIO22 |
| LED đỏ | Anode, cathode | GPIO26 qua điện trở 220 Ω, GND |
| Còi piezo | Chân 2 (+), chân 1 (−) | GPIO27, GND |
| Nút ACK | Hai tiếp điểm | GPIO25, GND |
| Nút TEST FALL | Hai tiếp điểm | GPIO32, GND |

MPU6050 dùng địa chỉ I²C `0x68`. Firmware lấy mẫu mục tiêu 50 Hz và phát MQTT khoảng mỗi 500 ms. Tác vụ cảm biến xử lý I²C và cảnh báo tại thiết bị. Tác vụ mạng đọc số đo mới nhất từ hàng đợi FreeRTOS.

## 4. Thuật toán xác minh

Gia tốc tổng là độ dài vector gia tốc ba trục. Độ nghiêng được tính từ góc giữa hướng gia tốc gần tĩnh và hướng chuẩn sau hiệu chuẩn. Ngoài khoảng 0,8–1,2 g, dashboard bỏ trống số đo góc và ngắt đường biểu đồ tại vị trí đó.

| Bước | Điều kiện | Trạng thái |
| --- | --- | --- |
| Hiệu chuẩn | 50 mẫu liên tục trong 0,9–1,1 g, tốc độ góc dưới 8 °/s và hướng lệch tối đa 5° so với mẫu đầu | `CALIBRATING` → `READY` |
| Bắt đầu xác minh | Gia tốc tổng đạt 2,5 g | `VERIFY` |
| Xác nhận | Trong 2,4 giây sau va đập, giữ liên tục 1 giây với gia tốc 0,8–1,2 g, nghiêng từ 60°, đổi hướng từ 35° và tốc độ góc dưới 25 °/s | `ALARM` |
| Hủy xác minh | Hết cửa sổ hoặc gián đoạn lấy mẫu trên 100 ms | `READY` |
| Xác nhận cảnh báo | Nhấn nút ACK hoặc gửi lệnh từ dashboard | Xóa `ALARM` |

Độ đổi hướng dùng mẫu gần tĩnh gần nhất trong 1 giây trước va đập. Khi thiếu mẫu hợp lệ, thuật toán dùng hướng chuẩn. Việc kiểm tra góc đổi hướng giúp từ chối kịch bản va đập khi thiết bị đã nằm nghiêng và giữ cùng tư thế.

## 5. Chạy ESP32 trên Wokwi

1. Tạo một [dự án ESP32 Arduino](https://wokwi.com/projects/new/esp32).
2. Chép [sketch.ino](Wokwi/sketch.ino) và [diagram.json](Wokwi/diagram.json) vào hai tab cùng tên. Dùng dấu **+** ở cạnh các tab để tạo `FallDetector.h` và chép [nội dung tệp](Wokwi/FallDetector.h).
3. Thêm **PubSubClient** trong **Library Manager**. Phiên bản trong [libraries.txt](Wokwi/libraries.txt) là 2.8.
4. Bấm **Start the simulation**, giữ MPU6050 ở tư thế mặc định và đợi Serial Monitor hiện `READY`. Nhấn giữ **TEST FALL** khoảng 0,2 giây để chạy chuỗi thử. Nút **ACK** xóa cảnh báo đã giữ.
5. Để kết nối web, chọn **ESP32 / MQTT**, sao chép giá trị phía sau `Base topic:` trong Serial Monitor rồi bấm **Kết nối**. Mỗi lần khởi động lại ESP32 sẽ tạo Base topic mới.

### Giao tiếp MQTT

| Thành phần | Địa chỉ |
| --- | --- |
| ESP32 | `broker.emqx.io:1883` |
| Dashboard | `wss://broker.emqx.io:8084/mqtt` |
| Bản tin cảm biến | `<Base topic>/telemetry` |
| Lệnh điều khiển | `<Base topic>/cmd` · `ack`, `calibrate`, `test` |

Dashboard chỉ báo **ESP32 trực tuyến** khi nhận bản tin hợp lệ gần đây. Mặc định dự án dùng broker công cộng để truyền dữ liệu thử. Base topic ngẫu nhiên tách các phiên mô phỏng và dùng để định tuyến bản tin.

## 6. Kết quả kiểm tra

| Kịch bản mô phỏng | Đỉnh gia tốc | Góc nghiêng lớn nhất | Kết quả |
| --- | ---: | ---: | --- |
| Té ngã | 3,39 g | 80,8° | Cảnh báo sau 2,20 giây kể từ lúc bắt đầu kịch bản |
| Va chạm | 3,07 g | 6,4° | Kết thúc xác minh và trở về `READY` |
| Nghiêng chậm | 1,04 g | 75,1° | Duy trì `READY` |

Bộ kiểm tra đối chiếu trạng thái, quyết định, bộ đếm và thời gian giữ tư thế giữa JavaScript và C++ ở 1.424 bước xử lý. Chạy lại bằng `node tests/verify.js` với Node.js và trình biên dịch `g++`. Dùng `--web-only` khi chỉ kiểm tra JavaScript và đóng gói bản tin MQTT.

Kiểm tra trên Wokwi xác nhận firmware chạy đến `READY`, dashboard nhận số đo qua MQTT, lệnh thử kích hoạt `ALARM` và lệnh xác nhận xóa cảnh báo.

## 7. Tệp dự án

| Tệp hoặc thư mục | Vai trò |
| --- | --- |
| `index.html`, `styles.css` | Giao diện dashboard |
| `app.js`, `model.js` | Biểu đồ, nhật ký và thuật toán mô phỏng |
| `mqtt-wire.js` | MQTT 3.1.1 qua WebSocket |
| [Wokwi/](Wokwi/) | Firmware, thuật toán C++ và sơ đồ mạch |
| [Report/](Report/) | Báo cáo Word |
| [tests/](tests/) | Kịch bản kiểm tra thuật toán và MQTT |

### GitHub Pages

Đưa các tệp bên trong thư mục `FallDetection` lên thư mục gốc của repository. Trong **Settings → Pages**, chọn **Deploy from a branch**, nhánh **main** và thư mục **/(root)** rồi bấm **Save**. Mở **Visit site** để chạy dashboard. Tab **Code → README.md → Preview** hiển thị tài liệu dự án.

### Phạm vi thử nghiệm

Các số liệu phản ánh chuỗi mô phỏng trong dự án. Để đánh giá độ chính xác ngoài thực tế, cần dữ liệu tại vị trí đeo cụ thể và các tình huống sinh hoạt đa dạng.

### Tài liệu kỹ thuật

- [Wokwi · ESP32 Simulation](https://docs.wokwi.com/guides/esp32) và [MPU6050](https://docs.wokwi.com/parts/wokwi-mpu6050)
- [TDK InvenSense · MPU-6000/MPU-6050 Product Specification](https://product.tdk.com/system/files/dam/doc/product/sensor/mortion-inertial/imu/data_sheet/mpu-6000-datasheet1.pdf)
- [OASIS · MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html) và [EMQX · Public MQTT Broker](https://www.emqx.com/en/mqtt/public-mqtt5-broker)
