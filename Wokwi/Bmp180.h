#pragma once

#include <stdint.h>

struct Bmp180Calibration {
  int16_t ac1, ac2, ac3;
  uint16_t ac4, ac5, ac6;
  int16_t b1, b2, mc, md;
};

struct Bmp180Reading {
  float temperatureC;
  int32_t pressurePa;
};

// Bosch BMP180 datasheet, section 3.5. OSS = 0 and one UT/UP pair per sample.
inline bool compensateBmp180(const Bmp180Calibration& c, uint16_t ut, uint16_t up,
                             Bmp180Reading& reading) {
  int64_t x1 = ((static_cast<int64_t>(ut) - c.ac6) * c.ac5) >> 15;
  if (x1 + c.md == 0) return false;
  int64_t x2 = static_cast<int64_t>(c.mc) * 2048 / (x1 + c.md);
  const int64_t b5 = x1 + x2;
  const int64_t b6 = b5 - 4000;
  const int64_t b6Squared = (b6 * b6) >> 12;

  x1 = (c.b2 * b6Squared) >> 11;
  x2 = (c.ac2 * b6) >> 11;
  const int64_t b3 = (static_cast<int64_t>(c.ac1) * 4 + x1 + x2 + 2) >> 2;
  x1 = (c.ac3 * b6) >> 13;
  x2 = (c.b1 * b6Squared) >> 16;
  const int64_t b4 = (c.ac4 * (((x1 + x2 + 2) >> 2) + 32768)) >> 15;
  const int64_t b7 = (static_cast<int64_t>(up) - b3) * 50000;
  if (b4 <= 0 || b7 <= 0) return false;

  int64_t pressure = b7 < 0x80000000LL ? 2 * b7 / b4 : 2 * (b7 / b4);
  if (pressure < 20000 || pressure > 125000) return false;
  x1 = pressure >> 8;
  x1 = (x1 * x1 * 3038) >> 16;
  x2 = (-7357 * pressure) >> 16;
  pressure += (x1 + x2 + 3791) >> 4;

  const float temperature = static_cast<float>((b5 + 8) >> 4) / 10.0f;
  if (temperature < -40.1f || temperature > 85.1f || pressure < 29950 || pressure > 110050) {
    return false;
  }

  reading = {temperature, static_cast<int32_t>(pressure)};
  return true;
}

#ifdef ARDUINO
#include <Arduino.h>
#include <Wire.h>

class Bmp180 {
 public:
  bool begin() {
    uint8_t id;
    uint8_t bytes[22];
    if (!read(0xD0, &id, 1) || id != 0x55 || !read(0xAA, bytes, sizeof(bytes))) return false;
    coefficients = {
      signedWord(bytes), signedWord(bytes + 2), signedWord(bytes + 4),
      word(bytes + 6), word(bytes + 8), word(bytes + 10), signedWord(bytes + 12),
      signedWord(bytes + 14), signedWord(bytes + 18), signedWord(bytes + 20)
    };
    return coefficients.ac4 != 0 && coefficients.ac4 != 0xFFFF && coefficients.ac5 != 0;
  }

  bool measure(Bmp180Reading& reading) {
    uint8_t temperature[2];
    uint8_t pressure[3];
    if (!convert(0x2E, temperature, sizeof(temperature))) return false;
    if (!convert(0x34, pressure, sizeof(pressure))) return false;
    return compensateBmp180(coefficients, word(temperature), word(pressure), reading);
  }

 private:
  static constexpr uint8_t address = 0x77;
  Bmp180Calibration coefficients{};

  static uint16_t word(const uint8_t* bytes) {
    return static_cast<uint16_t>((static_cast<uint16_t>(bytes[0]) << 8) | bytes[1]);
  }

  static int16_t signedWord(const uint8_t* bytes) {
    return static_cast<int16_t>(word(bytes));
  }

  static bool read(uint8_t reg, uint8_t* target, size_t count) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0 || Wire.requestFrom(address, count, true) != count) {
      return false;
    }
    for (size_t index = 0; index < count; ++index) {
      const int value = Wire.read();
      if (value < 0) return false;
      target[index] = static_cast<uint8_t>(value);
    }
    return true;
  }

  static bool convert(uint8_t command, uint8_t* target, size_t count) {
    Wire.beginTransmission(address);
    Wire.write(0xF4);
    Wire.write(command);
    if (Wire.endTransmission() != 0) return false;
    delay(6);
    return read(0xF6, target, count);
  }
};
#endif
