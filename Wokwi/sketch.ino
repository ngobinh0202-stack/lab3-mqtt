#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <esp_system.h>
#include <stdio.h>
#include <string.h>
#include "Bmp180.h"
#include "RunnerLogic.h"

using runner::Command;

constexpr uint8_t sdaPin = 21;
constexpr uint8_t sclPin = 22;
constexpr uint8_t ledPin = 26;
constexpr uint8_t buzzerPin = 27;
constexpr char wifiName[] = "Wokwi-GUEST";
constexpr char wifiPassword[] = "";
constexpr char brokerHost[] = "broker.emqx.io";
constexpr uint16_t brokerPort = 1883;

struct Sample {
  uint32_t sequence;
  uint32_t ms;
  bool valid;
  float temperatureC;
  int32_t pressurePa;
  float altitudeM;
};

struct AlertSample {
  uint32_t sequence;
  uint32_t ms;
  bool valid;
  float temperatureC;
  float altitudeM;
};

struct ControlState {
  uint32_t sequence;
  uint32_t commandRevision;
  uint8_t flags;
  bool automatic;
  bool led;
  bool buzzer;
  char ackId[9];
  bool ackOk;
};

QueueHandle_t dataQueue;
QueueHandle_t dataAlert;
QueueHandle_t commandQueue;
QueueHandle_t controlQueue;

WiFiClient socketClient;
PubSubClient mqtt(socketClient);
char topicRoot[48];
char telemetryTopic[64];
char commandTopic[64];
char clientId[32];

void formatNumber(char* text, size_t size, bool valid, float value);
void printSample(const Sample& sample);
bool publishSample(const Sample& sample, const ControlState& control);

void formatNumber(char* text, size_t size, bool valid, float value) {
  if (valid) snprintf(text, size, "%.2f", static_cast<double>(value));
  else snprintf(text, size, "null");
}

void printSample(const Sample& sample) {
  if (sample.valid) {
    Serial.printf("[READ][Core 1] seq=%lu T=%.1f C P=%ld Pa H=%.2f m\n",
      static_cast<unsigned long>(sample.sequence), sample.temperatureC,
      static_cast<long>(sample.pressurePa), sample.altitudeM);
  } else {
    Serial.printf("[READ][Core 1] seq=%lu SENSOR_FAULT\n", static_cast<unsigned long>(sample.sequence));
  }
}

void taskRead(void*) {
  Serial.printf("[READ] Core %d\n", xPortGetCoreID());
  Wire.begin(sdaPin, sclPin, 100000);
  Wire.setTimeOut(30);
  Bmp180 bmp;
  bool sensorReady = false;
  uint32_t sequence = 0;
  TickType_t wake = xTaskGetTickCount();

  for (;;) {
    if (!sensorReady) sensorReady = bmp.begin();
    Bmp180Reading raw{};
    sensorReady = sensorReady && bmp.measure(raw);
    Sample sample{++sequence, millis(), sensorReady, raw.temperatureC, raw.pressurePa, 0.0f};
    if (sample.valid) sample.altitudeM = runner::altitudeFromPressure(sample.pressurePa);
    const AlertSample alert{sample.sequence, sample.ms, sample.valid, sample.temperatureC, sample.altitudeM};

    printSample(sample);
    xQueueOverwrite(dataQueue, &sample);
    xQueueOverwrite(dataAlert, &alert);
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(runner::samplePeriodMs));
  }
}

void taskAlert(void*) {
  Serial.printf("[ALERT] Core %d\n", xPortGetCoreID());
  runner::AlertTracker tracker;
  runner::Actuators actuators;
  ControlState control{};
  control.automatic = true;

  for (;;) {
    AlertSample sample{};
    const bool newSample = xQueueReceive(dataAlert, &sample, pdMS_TO_TICKS(50)) == pdTRUE;
    if (newSample) {
      const uint8_t flags = tracker.update(sample.ms, sample.valid, sample.temperatureC, sample.altitudeM);
      if (flags != control.flags) Serial.printf("[ALERT][Core 1] flags=%u\n", flags);
      control.sequence = sample.sequence;
      control.flags = flags;
    }

    bool newCommand = false;
    Command command{};
    if (xQueueReceive(commandQueue, &command, 0) == pdTRUE) {
      control.ackOk = actuators.apply(command.kind);
      memcpy(control.ackId, command.id, sizeof(control.ackId));
      ++control.commandRevision;
      newCommand = true;
    }
    if (!newSample && !newCommand) continue;

    const runner::Outputs outputs = actuators.get(control.flags);
    if (outputs.led != control.led) digitalWrite(ledPin, outputs.led ? HIGH : LOW);
    if (outputs.buzzer != control.buzzer) {
      if (outputs.buzzer) tone(buzzerPin, 1800);
      else noTone(buzzerPin);
    }
    control.automatic = actuators.automatic;
    control.led = outputs.led;
    control.buzzer = outputs.buzzer;
    xQueueOverwrite(controlQueue, &control);

    if (newCommand) {
      Serial.printf("[ALERT][Core 1] cmd=%s ok=%d mode=%s led=%d buzzer=%d\n", control.ackId,
        control.ackOk, control.automatic ? "AUTO" : "MANUAL", control.led, control.buzzer);
    }
  }
}

void receiveCommand(char* topic, byte* payload, unsigned int length) {
  Command command{};
  if (strcmp(topic, commandTopic) != 0
      || !runner::parseCommand(reinterpret_cast<const char*>(payload), length, command)) return;
  if (xQueueSend(commandQueue, &command, 0) != pdTRUE) Serial.println("[TX] Command queue full");
}

bool publishSample(const Sample& sample, const ControlState& control) {
  char temperature[16], pressure[16], altitude[16], payload[384];
  formatNumber(temperature, sizeof(temperature), sample.valid, sample.temperatureC);
  formatNumber(altitude, sizeof(altitude), sample.valid, sample.altitudeM);
  if (sample.valid) snprintf(pressure, sizeof(pressure), "%ld", static_cast<long>(sample.pressurePa));
  else snprintf(pressure, sizeof(pressure), "null");

  const int length = snprintf(payload, sizeof(payload),
    "{\"seq\":%lu,\"ms\":%lu,\"t\":%s,\"p\":%s,\"h\":%s,\"alerts\":%u,"
    "\"mode\":\"%s\",\"led\":%s,\"buzzer\":%s,\"ack\":\"%s\",\"ok\":%s}",
    static_cast<unsigned long>(sample.sequence), static_cast<unsigned long>(sample.ms),
    temperature, pressure, altitude, control.flags, control.automatic ? "AUTO" : "MANUAL",
    control.led ? "true" : "false", control.buzzer ? "true" : "false",
    control.ackId, control.ackOk ? "true" : "false");
  return length > 0 && static_cast<size_t>(length) < sizeof(payload)
    && mqtt.publish(telemetryTopic, payload, false);
}

void taskTransmit(void*) {
  Serial.printf("[TX] Core %d\n", xPortGetCoreID());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(wifiName, wifiPassword, 6);
  mqtt.setServer(brokerHost, brokerPort);
  mqtt.setCallback(receiveCommand);
  mqtt.setBufferSize(512);
  mqtt.setSocketTimeout(2);
  mqtt.setKeepAlive(90);
  uint32_t lastAttempt = millis() - 3000;
  uint32_t lastSentSequence = 0;
  uint32_t lastSentRevision = 0;

  for (;;) {
    const uint32_t now = millis();
    if (WiFi.status() != WL_CONNECTED) {
      socketClient.stop();
    } else if (!mqtt.connected() && now - lastAttempt >= 3000) {
      lastAttempt = now;
      if (mqtt.connect(clientId) && mqtt.subscribe(commandTopic, 0)) {
        lastSentSequence = 0;
        lastSentRevision = 0;
        Serial.printf("[TX] MQTT OK | Base topic: %s\n", topicRoot);
      } else {
        Serial.printf("[TX] MQTT retry rc=%d\n", mqtt.state());
        if (mqtt.connected()) mqtt.disconnect();
      }
    }
    if (mqtt.connected() && mqtt.loop()) {
      Sample sample{};
      ControlState control{};
      if (xQueuePeek(dataQueue, &sample, 0) == pdTRUE
          && xQueuePeek(controlQueue, &control, 0) == pdTRUE
          && sample.sequence == control.sequence
          && (sample.sequence != lastSentSequence || control.commandRevision != lastSentRevision)
          && publishSample(sample, control)) {
        lastSentSequence = sample.sequence;
        lastSentRevision = control.commandRevision;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(ledPin, LOW);
  digitalWrite(buzzerPin, LOW);

  const unsigned long session = static_cast<unsigned long>(esp_random());
  snprintf(topicRoot, sizeof(topicRoot), "runner/lab3/%08lx", session);
  snprintf(telemetryTopic, sizeof(telemetryTopic), "%s/telemetry", topicRoot);
  snprintf(commandTopic, sizeof(commandTopic), "%s/cmd", topicRoot);
  snprintf(clientId, sizeof(clientId), "runner-%08lx", session);
  Serial.printf("[BOOT] Base topic: %s\n", topicRoot);

  dataQueue = xQueueCreate(1, sizeof(Sample));
  dataAlert = xQueueCreate(1, sizeof(AlertSample));
  commandQueue = xQueueCreate(8, sizeof(Command));
  controlQueue = xQueueCreate(1, sizeof(ControlState));
  if (!dataQueue || !dataAlert || !commandQueue || !controlQueue) {
    Serial.println("[BOOT] Queue allocation failed");
    return;
  }

  TaskHandle_t alertHandle = nullptr;
  if (xTaskCreatePinnedToCore(taskAlert, "Alert", 4096, nullptr, 3, &alertHandle, 1) != pdPASS
      || xTaskCreatePinnedToCore(taskRead, "Read", 4096, nullptr, 2, nullptr, 1) != pdPASS) {
    if (alertHandle) vTaskDelete(alertHandle);
    Serial.println("[BOOT] Local tasks could not start");
    return;
  }
  if (xTaskCreatePinnedToCore(taskTransmit, "Transmit", 7168, nullptr, 1, nullptr, 0) != pdPASS) {
    Serial.println("[BOOT] Network task unavailable. Local monitoring active.");
  }
}

void loop() {
  delay(1000);
}
