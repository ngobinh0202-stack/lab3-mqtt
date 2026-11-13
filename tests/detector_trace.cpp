#include <iostream>
#include "../Wokwi/FallDetector.h"

int main() {
  FallDetector detector;
  char operation;
  while (std::cin >> operation) {
    if (operation == 'R') {
      detector = FallDetector{};
    } else if (operation == 'S') {
      uint32_t time;
      Motion sample;
      if (!(std::cin >> time >> sample.ax >> sample.ay >> sample.az
                     >> sample.gx >> sample.gy >> sample.gz)) return 1;
      detector.sample(time, sample);
    } else if (operation == 'A') {
      detector.acknowledge();
    } else if (operation == 'F') {
      detector.fault();
    } else {
      return 2;
    }
    std::cout << static_cast<int>(detector.phase) << ',' << static_cast<int>(detector.decision)
              << ',' << detector.count << ',' << detector.heldMs << '\n';
  }
}
