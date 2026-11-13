#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <PubSubClient.h>
#include <esp_system.h>
#include "FallDetector.h"

constexpr uint8_t sdaPin = 21;
constexpr uint8_t sclPin = 22;
constexpr uint8_t ledPin = 26;
constexpr uint8_t buzzerPin = 27;
constexpr uint8_t ackPin = 25;
constexpr uint8_t testPin = 32;
constexpr uint8_t mpuAddress = 0x68;

constexpr char brokerHost[] = "broker.emqx.io";
constexpr uint16_t brokerPort = 1883;
constexpr uint32_t telemetryPeriodMs = 500;

enum class Command { Ack, Calibrate, Test };

struct Snapshot {
  uint32_t ms;
  uint32_t impactMs;
  bool hasImpact;
  bool test;
  Reading reading;
  Phase phase;
  Decision decision;
  uint32_t count;
  uint32_t held;
  float peak;
  int calibrationCount;
};

void publishSnapshot(const Snapshot& sample);

struct Button {
  explicit Button(uint8_t pin) : pin(pin) {}

  bool pressed(uint32_t now) {
    const bool down = digitalRead(pin) == LOW;
    if (down != last) {
      last = down;
      changedAt = now;
    }
    if (down == stable || now - changedAt < 40) return false;
    stable = down;
    return stable;
  }

  uint8_t pin;
  bool last = false;
  bool stable = false;
  uint32_t changedAt = 0;
};

QueueHandle_t sampleQueue;
QueueHandle_t commandQueue;
WiFiClient transport;
PubSubClient mqtt(transport);
char topicRoot[64];
char telemetryTopic[80];
char commandTopic[80];
char clientId[40];

bool writeRegister(uint8_t address, uint8_t value) {
  Wire.beginTransmission(mpuAddress);
  Wire.write(address);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegisters(uint8_t address, uint8_t* buffer, size_t count) {
  Wire.beginTransmission(mpuAddress);
  Wire.write(address);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddress, count, true) != count) return false;
  for (size_t index = 0; index < count; index++) {
    const int value = Wire.read();
    if (value < 0) return false;
    buffer[index] = static_cast<uint8_t>(value);
  }
  return true;
}

bool setupSensor() {
  uint8_t identity;
  return readRegisters(0x75, &identity, 1) && identity == 0x68
      && writeRegister(0x6B, 0x01)  // Wake, use X gyro clock.
      && writeRegister(0x1A, 0x03)  // Digital low-pass filter.
      && writeRegister(0x19, 0x13)  // 1 kHz / (19 + 1) = 50 Hz.
      && writeRegister(0x1B, 0x08)  // Gyroscope range ±500 °/s.
      && writeRegister(0x1C, 0x10); // Accelerometer range ±8 g.
}

int16_t wordAt(const uint8_t* buffer, size_t index) {
  return static_cast<int16_t>((static_cast<uint16_t>(buffer[index]) << 8) | buffer[index + 1]);
}

bool readMotion(Motion& sample) {
  uint8_t data[14];
  if (!readRegisters(0x3B, data, sizeof(data))) return false;
  sample = {
    wordAt(data, 0) / 4096.0f, wordAt(data, 2) / 4096.0f, wordAt(data, 4) / 4096.0f,
    wordAt(data, 8) / 65.5f, wordAt(data, 10) / 65.5f, wordAt(data, 12) / 65.5f
  };
  return true;
}

Motion simulatedFall(uint32_t elapsed) {
  if (elapsed < 700) return {0, 0, 1, 0, 0, 0};
  if (elapsed < 800) return {0, 0, 0.62f, 0, 0, 0};
  if (elapsed < 940) return {0.28f, 0, 3.38f, 0, 76, 0};
  if (elapsed < 1200) return {0.78f, 0, 0.63f, 0, 74, 0};
  return {0.984f, 0, 0.16f, 0, 2.2f, 0};
}

const char* phaseName(Phase phase) {
  switch (phase) {
    case Phase::Calibrating: return "CALIBRATING";
    case Phase::Ready: return "READY";
    case Phase::Verify: return "VERIFY";
    case Phase::Alarm: return "ALARM";
    case Phase::Fault: return "SENSOR_FAULT";
  }
  return "SENSOR_FAULT";
}

const char* decisionName(Decision decision) {
  switch (decision) {
    case Decision::Calibration: return "calibration";
    case Decision::Ready: return "ready";
    case Decision::Impact: return "impact";
    case Decision::Confirmed: return "confirmed";
    case Decision::Timeout: return "timeout";
    case Decision::Gap: return "sample_gap";
    case Decision::Fault: return "sensor_fault";
    case Decision::Ack: return "acknowledged";
  }
  return "sensor_fault";
}

void sensorTask(void*) {
  FallDetector detector;
  Button acknowledge(ackPin);
  Button testButton(testPin);
  TickType_t wake = xTaskGetTickCount();
  bool available = false;
  bool testActive = false;
  bool testAlarm = false;
  bool haveImpact = false;
  bool buzzerOn = false;
  uint32_t lastSensorAttempt = 0;
  uint32_t testStart = 0;
  uint32_t impactTime = 0;
  bool firstLoop = true;

  for (;;) {
    const uint32_t now = millis();
    bool startTest = testButton.pressed(now);
    bool requestAck = acknowledge.pressed(now);
    bool requestCalibration = false;
    Command command;
    while (xQueueReceive(commandQueue, &command, 0) == pdTRUE) {
      if (command == Command::Ack) requestAck = true;
      if (command == Command::Calibrate) requestCalibration = true;
      if (command == Command::Test) startTest = true;
    }
    if (requestAck && detector.acknowledge()) {
      testAlarm = false;
      testActive = false;
      if (!available) detector.fault();
    }
    if (requestCalibration && detector.phase == Phase::Ready && !testActive) detector.calibrate();
    if (startTest && detector.phase == Phase::Ready && !testActive) {
      testActive = true;
      testStart = now;
    }
    if (testActive && now - testStart >= 3800) {
      testActive = false;
      if (!available) detector.fault();
    }
    if (!available && (firstLoop || now - lastSensorAttempt >= 1000)) {
      lastSensorAttempt = now;
      available = setupSensor();
    }
    firstLoop = false;

    Motion motion{};
    const bool readOk = available && readMotion(motion);
    if (!readOk) available = false;
    if (testActive) motion = simulatedFall(now - testStart);
    const Phase previous = detector.phase;
    Reading reading;
    if (readOk || testActive) reading = detector.sample(now, motion);
    else detector.fault();
    if (previous != Phase::Verify && detector.phase == Phase::Verify) {
      impactTime = now;
      haveImpact = true;
    }
    if (previous != Phase::Alarm && detector.phase == Phase::Alarm) testAlarm = testActive;

    const bool alarm = detector.phase == Phase::Alarm;
    const bool fault = detector.phase == Phase::Fault;
    digitalWrite(ledPin, (alarm && now % 600 < 300) || (fault && now % 1500 < 100) ? HIGH : LOW);
    const bool sound = alarm && now % 1000 < 300;
    if (sound != buzzerOn) {
      if (sound) tone(buzzerPin, 1800);
      else noTone(buzzerPin);
      buzzerOn = sound;
    }
    const Snapshot snapshot{
      now, impactTime, haveImpact, testActive || testAlarm, reading, detector.phase,
      detector.decision, detector.count, detector.heldMs, detector.peakG, detector.calibrationCount
    };
    xQueueOverwrite(sampleQueue, &snapshot);

    // Resynchronize after an overrun instead of generating catch-up samples in a burst.
    if (xTaskGetTickCount() - wake > pdMS_TO_TICKS(FallDetector::periodMs)) wake = xTaskGetTickCount();
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(FallDetector::periodMs));
  }
}

void receiveCommand(char* topic, byte* data, unsigned int length) {
  if (strcmp(topic, commandTopic) != 0) return;
  Command command;
  if (length == 3 && memcmp(data, "ack", 3) == 0) command = Command::Ack;
  else if (length == 9 && memcmp(data, "calibrate", 9) == 0) command = Command::Calibrate;
  else if (length == 4 && memcmp(data, "test", 4) == 0) command = Command::Test;
  else return;
  xQueueSend(commandQueue, &command, 0);
}

void formatNumber(char* buffer, size_t capacity, float value) {
  if (isfinite(value)) snprintf(buffer, capacity, "%.3f", value);
  else snprintf(buffer, capacity, "null");
}

void publishSnapshot(const Snapshot& sample) {
  char accel[16], gyro[16], tilt[16], peak[16], impact[16], payload[464];
  formatNumber(accel, sizeof(accel), sample.reading.accel);
  formatNumber(gyro, sizeof(gyro), sample.reading.gyro);
  formatNumber(tilt, sizeof(tilt), sample.reading.tilt);
  formatNumber(peak, sizeof(peak), sample.peak);
  if (sample.hasImpact) snprintf(impact, sizeof(impact), "%lu", static_cast<unsigned long>(sample.impactMs));
  else snprintf(impact, sizeof(impact), "null");
  const bool alarm = sample.phase == Phase::Alarm;
  const int length = snprintf(payload, sizeof(payload),
    "{\"ms\":%lu,\"source\":\"%s\",\"state\":\"%s\",\"decision\":\"%s\","
    "\"accel_g\":%s,\"gyro_dps\":%s,\"tilt_deg\":%s,\"peak_g\":%s,\"impact_ms\":%s,"
    "\"held_ms\":%lu,\"event_count\":%lu,\"calibration_samples\":%d,\"led\":%s,\"buzzer\":%s}",
    static_cast<unsigned long>(sample.ms), sample.test ? "TEST" : "MPU6050",
    phaseName(sample.phase), decisionName(sample.decision), accel, gyro, tilt, peak, impact,
    static_cast<unsigned long>(sample.held), static_cast<unsigned long>(sample.count),
    sample.calibrationCount, alarm ? "true" : "false", alarm ? "true" : "false");
  if (length > 0 && static_cast<size_t>(length) < sizeof(payload) && mqtt.connected()) {
    mqtt.publish(telemetryTopic, payload, false);
  }
  Serial.printf("%lu ms | %s | %s | a=%s g | gyro=%s deg/s | tilt=%s deg | count=%lu\n",
    static_cast<unsigned long>(sample.ms), sample.test ? "TEST" : "MPU6050", phaseName(sample.phase),
    accel, gyro, tilt, static_cast<unsigned long>(sample.count));
}

void networkTask(void*) {
  mqtt.setServer(brokerHost, brokerPort);
  mqtt.setCallback(receiveCommand);
  mqtt.setBufferSize(640);
  mqtt.setSocketTimeout(2);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin("Wokwi-GUEST", "", 6);
  uint32_t lastAttempt = millis() - 5000;
  uint32_t lastReport = 0;

  for (;;) {
    const uint32_t now = millis();
    if (WiFi.status() != WL_CONNECTED) {
      if (mqtt.connected()) mqtt.disconnect();
    } else if (!mqtt.connected() && now - lastAttempt >= 5000) {
      lastAttempt = now;
      if (mqtt.connect(clientId) && mqtt.subscribe(commandTopic, 0)) {
        Serial.printf("MQTT OK | Base topic: %s\n", topicRoot);
      } else {
        Serial.printf("MQTT retry | state=%d\n", mqtt.state());
        if (mqtt.connected()) mqtt.disconnect();
      }
    }
    if (mqtt.connected()) mqtt.loop();
    if (now - lastReport >= telemetryPeriodMs) {
      lastReport = now;
      Snapshot snapshot{};
      if (xQueuePeek(sampleQueue, &snapshot, 0) == pdTRUE) publishSnapshot(snapshot);
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
  pinMode(buzzerPin, OUTPUT);
  pinMode(ackPin, INPUT_PULLUP);
  pinMode(testPin, INPUT_PULLUP);
  Wire.begin(sdaPin, sclPin, 100000);
  Wire.setTimeOut(15);

  const unsigned long session = static_cast<unsigned long>(esp_random());
  snprintf(topicRoot, sizeof(topicRoot), "falldetection/ndd/%08lx", session);
  snprintf(telemetryTopic, sizeof(telemetryTopic), "%s/telemetry", topicRoot);
  snprintf(commandTopic, sizeof(commandTopic), "%s/cmd", topicRoot);
  snprintf(clientId, sizeof(clientId), "ndd-fall-%08lx", session);
  Serial.printf("FallDetection | Base topic: %s\n", topicRoot);

  sampleQueue = xQueueCreate(1, sizeof(Snapshot));
  commandQueue = xQueueCreate(8, sizeof(Command));
  if (!sampleQueue || !commandQueue) {
    Serial.println("ERROR: could not allocate queues");
    return;
  }
  if (xTaskCreate(sensorTask, "Sensor", 4096, nullptr, 2, nullptr) != pdPASS) {
    Serial.println("ERROR: could not start sensor task");
    return;
  }
  if (xTaskCreate(networkTask, "Network", 7168, nullptr, 1, nullptr) != pdPASS) {
    Serial.println("ERROR: could not start network task");
  }
}

void loop() {
  delay(1000);
}
