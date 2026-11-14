#include <cmath>
#include <iomanip>
#include <iostream>
#include <string>
#include "../Wokwi/Bmp180.h"
#include "../Wokwi/RunnerLogic.h"

int main() {
  const Bmp180Calibration calibration{408, -72, -14383, 32741, 32757, 23153, 6190, 4, -8711, 2868};
  Bmp180Reading bmp{};
  if (!compensateBmp180(calibration, 27898, 23843, bmp)
      || std::fabs(bmp.temperatureC - 15.0f) > 0.001f || bmp.pressurePa != 69964) {
    return 1;
  }
  if (compensateBmp180({}, 0, 0, bmp)) return 2;
  std::cout << "BMP180 15.0 69964\n";
  std::cout << std::fixed << std::setprecision(3) << "Altitude "
            << runner::altitudeFromPressure(101325) << ' '
            << runner::altitudeFromPressure(100600) << ' '
            << runner::altitudeFromPressure(100384) << '\n';

  const char* commands[] = {"auto", "manual", "led-on", "led-off", "buzzer-on", "buzzer-off"};
  for (size_t i = 0; i < 6; ++i) {
    const std::string payload = std::string("123abcdF:") + commands[i];
    runner::Command parsed{};
    if (!runner::parseCommand(payload.data(), payload.size(), parsed)
        || static_cast<size_t>(parsed.kind) != i || std::string(parsed.id) != "123abcdF") return 6;
  }
  for (const std::string malformed : {"123abcdf;manual", "123abcdf:led", "bad-id:manual", "123abcdf:manualx"}) {
    runner::Command parsed{};
    if (runner::parseCommand(malformed.data(), malformed.size(), parsed)) return 7;
  }

  runner::AlertTracker tracker;
  runner::Actuators actuators;
  std::string operation;
  uint8_t flags = 0;
  while (std::cin >> operation) {
    if (operation == "reset") {
      tracker = runner::AlertTracker{};
      actuators = runner::Actuators{};
      flags = 0;
      continue;
    }
    if (operation == "sample") {
      uint32_t time;
      int valid;
      float temperature, altitude;
      if (!(std::cin >> time >> valid >> temperature >> altitude)) return 3;
      flags = tracker.update(time, valid == 1, temperature, altitude);
    } else if (operation == "cmd") {
      int command;
      if (!(std::cin >> command) || command < 0 || command > 5) return 4;
      std::cout << actuators.apply(static_cast<runner::CommandKind>(command)) << ' ';
    } else return 5;
    const auto out = actuators.get(flags);
    std::cout << static_cast<int>(flags) << ' ' << actuators.automatic << ' '
              << out.led << ' ' << out.buzzer << '\n';
  }
}
