#include <Arduino.h>
#include <Adafruit_BMP085.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include "RunnerMonitor.h"

using namespace runner;

constexpr int sdaPin = 21;
constexpr int sclPin = 22;
constexpr int ledPin = 26;
constexpr int buzzerPin = 27;
constexpr int buzzerHz = 1500;
constexpr uint8_t bmpAddress = 0x77;
constexpr char wifiSsid[] = "Wokwi-GUEST";
constexpr char wifiPass[] = "";
constexpr char mqttHost[] = "broker.emqx.io";
constexpr uint16_t mqttPort = 1883;

struct SensorData {
  uint32_t seq;
  float tempC;
  float pressureHpa;
  float altitudeM;
  bool valid;
};

Adafruit_BMP085 bmp;
WiFiClient network;
PubSubClient mqtt(network);
QueueHandle_t dataQueue;
QueueHandle_t dataAlert;
QueueHandle_t commandQueue;
QueueHandle_t statusQueue;

char baseTopic[40];
char telemetryTopic[64];
char commandFilter[64];
char modeTopic[64];
char ledTopic[64];
char buzzerTopic[64];
char clientId[24];

bool sensorPresent() {
  Wire.beginTransmission(bmpAddress);
  return Wire.endTransmission() == 0;
}

// Core 1: lấy một mẫu mỗi giây, tính độ cao từ chính áp suất đã đo.
void taskRead(void *) {
  Serial.printf("[READ] Core %d\n", xPortGetCoreID());
  Wire.begin(sdaPin, sclPin, 100000);
  bool initialized = false;
  uint32_t seq = 0;
  TickType_t nextSample = xTaskGetTickCount();

  for (;;) {
    if (!initialized) initialized = bmp.begin(BMP085_STANDARD, &Wire);
    SensorData data{};
    data.seq = ++seq;

    if (initialized && sensorPresent()) {
      data.tempC = bmp.readTemperature();
      const int32_t pressurePa = bmp.readPressure();
      data.valid = std::isfinite(data.tempC) && data.tempC >= -40.1f && data.tempC <= 85.1f &&
                   pressurePa >= 29980 && pressurePa <= 110020 && sensorPresent();
      if (data.valid) {
        data.pressureHpa = pressurePa / 100.0f;
        data.altitudeM = altitudeFromPa(pressurePa);
      }
    }

    if (data.valid) {
      Serial.printf("[READ] #%lu T=%.1f C | P=%.2f hPa | Alt=%.2f m\n",
                    static_cast<unsigned long>(data.seq), data.tempC, data.pressureHpa, data.altitudeM);
    } else {
      initialized = false;
      Serial.println("[READ] BMP180 unavailable; retry at next sample");
    }

    const AlertData alert{data.seq, millis(), data.tempC, data.altitudeM, data.valid};
    xQueueOverwrite(dataAlert, &alert);
    xQueueOverwrite(dataQueue, &data);
    vTaskDelayUntil(&nextSample, pdMS_TO_TICKS(samplePeriodMs));
  }
}

// Core 1: nơi duy nhất quyết định và ghi trạng thái LED/còi.
void taskAlert(void *) {
  Serial.printf("[ALERT] Core %d\n", xPortGetCoreID());
  Monitor monitor;
  Status previous;

  for (;;) {
    AlertData sample;
    Command command;
    if (xQueueReceive(dataAlert, &sample, pdMS_TO_TICKS(50)) == pdPASS) {
      monitor.update(sample, millis());
    }
    while (xQueueReceive(commandQueue, &command, 0) == pdPASS) {
      monitor.control(command, millis());
    }
    monitor.refresh(millis());
    const Status status = monitor.status();

    if (status.led != previous.led) digitalWrite(ledPin, status.led ? HIGH : LOW);
    if (status.buzzer != previous.buzzer) {
      if (status.buzzer) tone(buzzerPin, buzzerHz);
      else noTone(buzzerPin);
    }

    if (status.alerts != previous.alerts || status.mode != previous.mode ||
        status.led != previous.led || status.buzzer != previous.buzzer) {
      Serial.printf("[ALERT] mode=%s flags=%u LED=%u BUZZER=%u\n",
                    status.mode == Mode::Auto ? "AUTO" : "MANUAL",
                    static_cast<unsigned>(status.alerts),
                    static_cast<unsigned>(status.led), static_cast<unsigned>(status.buzzer));
    }
    xQueueOverwrite(statusQueue, &status);
    previous = status;
  }
}

// PubSubClient gọi callback này trong taskTransmit; lệnh đi qua hàng đợi.
void onMqttMessage(char *topic, byte *payload, unsigned int size) {
  Command command;
  if (strcmp(topic, modeTopic) == 0) {
    command.target = Target::Mode;
    if (size == 6 && memcmp(payload, "MANUAL", 6) == 0) command.active = true;
    else if (size == 4 && memcmp(payload, "AUTO", 4) == 0) command.active = false;
    else return;
  } else {
    if (strcmp(topic, ledTopic) == 0) command.target = Target::Led;
    else if (strcmp(topic, buzzerTopic) == 0) command.target = Target::Buzzer;
    else return;

    if (size == 2 && memcmp(payload, "ON", 2) == 0) command.active = true;
    else if (size == 3 && memcmp(payload, "OFF", 3) == 0) command.active = false;
    else return;
  }

  if (xQueueSend(commandQueue, &command, 0) != pdPASS) {
    Serial.println("[MQTT] Command queue full");
  }
}

bool publishTelemetry(const SensorData &data, const Status &status) {
  char numbers[128];
  if (data.valid) {
    snprintf(numbers, sizeof(numbers), "\"tempC\":%.1f,\"pressureHpa\":%.2f,\"altitudeM\":%.2f,\"deltaM\":%.2f",
             data.tempC, data.pressureHpa, data.altitudeM, status.deltaM);
  } else {
    strcpy(numbers, "\"tempC\":null,\"pressureHpa\":null,\"altitudeM\":null,\"deltaM\":null");
  }

  char json[256];
  snprintf(json, sizeof(json),
           "{\"seq\":%lu,%s,\"mode\":\"%s\",\"alerts\":%u,\"led\":%s,\"buzzer\":%s}",
           static_cast<unsigned long>(data.seq), numbers, status.mode == Mode::Auto ? "AUTO" : "MANUAL",
           static_cast<unsigned>(status.alerts), status.led ? "true" : "false", status.buzzer ? "true" : "false");
  return mqtt.publish(telemetryTopic, json, false);
}

// Core 0: quản lý Wi-Fi/MQTT và chỉ phát khi hai hàng đợi có cùng số thứ tự mẫu.
void taskTransmit(void *) {
  Serial.printf("[TX] Core %d\n", xPortGetCoreID());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(wifiSsid, wifiPass, 6);
  auto lastWifiAttempt = millis();

  mqtt.setServer(mqttHost, mqttPort);
  mqtt.setCallback(onMqttMessage);
  mqtt.setSocketTimeout(3);
  mqtt.setKeepAlive(25);
  uint32_t lastMqttAttempt = millis() - 3000;
  SensorData data{};
  Status sent;
  bool haveData = false;
  bool haveSent = false;

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (millis() - lastWifiAttempt >= 10000) {
        lastWifiAttempt = millis();
        WiFi.reconnect();
      }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    if (!mqtt.connected()) {
      if (millis() - lastMqttAttempt >= 3000) {
        lastMqttAttempt = millis();
        if (mqtt.connect(clientId) && mqtt.subscribe(commandFilter)) {
          haveSent = false;
          Serial.printf("[MQTT] Connected to %s:%u\n", mqttHost, static_cast<unsigned>(mqttPort));
        } else {
          Serial.printf("[MQTT] Connect/subscribe failed (state=%d)\n", mqtt.state());
          mqtt.disconnect();
        }
      }
      if (!mqtt.connected()) {
        vTaskDelay(pdMS_TO_TICKS(100));
        continue;
      }
    }

    mqtt.loop();
    if (xQueueReceive(dataQueue, &data, 0) == pdPASS) haveData = true;
    Status status;
    if (haveData && xQueuePeek(statusQueue, &status, 0) == pdPASS && status.seq == data.seq) {
      const bool changed = !haveSent || sent.seq != status.seq || sent.mode != status.mode ||
                           sent.alerts != status.alerts || sent.led != status.led || sent.buzzer != status.buzzer;
      if (changed && publishTelemetry(data, status)) {
        sent = status;
        haveSent = true;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(40));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(ledPin, LOW);
  digitalWrite(buzzerPin, LOW);

  const unsigned long session = esp_random();
  snprintf(baseTopic, sizeof(baseTopic), "lab3/runner/ngobinh-%08lx", session);
  snprintf(clientId, sizeof(clientId), "runner-%08lx", session);
  snprintf(telemetryTopic, sizeof(telemetryTopic), "%s/telemetry", baseTopic);
  snprintf(commandFilter, sizeof(commandFilter), "%s/cmd/+", baseTopic);
  snprintf(modeTopic, sizeof(modeTopic), "%s/cmd/mode", baseTopic);
  snprintf(ledTopic, sizeof(ledTopic), "%s/cmd/led", baseTopic);
  snprintf(buzzerTopic, sizeof(buzzerTopic), "%s/cmd/buzzer", baseTopic);
  Serial.printf("\nRunner Monitor | Base topic: %s\n", baseTopic);

  dataQueue = xQueueCreate(1, sizeof(SensorData));
  dataAlert = xQueueCreate(1, sizeof(AlertData));
  statusQueue = xQueueCreate(1, sizeof(Status));
  commandQueue = xQueueCreate(8, sizeof(Command));
  if (!dataQueue || !dataAlert || !statusQueue || !commandQueue || !mqtt.setBufferSize(384)) {
    Serial.println("[BOOT] Could not allocate queues or MQTT buffer");
    return;
  }

  if (xTaskCreatePinnedToCore(taskAlert, "Task_CanhBao", 4096, nullptr, 3, nullptr, 1) != pdPASS)
    Serial.println("[BOOT] Task_CanhBao failed");
  if (xTaskCreatePinnedToCore(taskRead, "Task_DocData", 4096, nullptr, 2, nullptr, 1) != pdPASS)
    Serial.println("[BOOT] Task_DocData failed");
  if (xTaskCreatePinnedToCore(taskTransmit, "Task_TruyenData", 8192, nullptr, 1, nullptr, 0) != pdPASS)
    Serial.println("[BOOT] Task_TruyenData failed");
}

void loop() {
  vTaskDelete(nullptr);
}
