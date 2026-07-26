// SecureBot firmware - Arduino Uno R3 + MPU-6050
// Reads the IMU every 200 ms, runs tamper detection with debounce,
// and prints one JSON line per reading over serial at 115200 baud.

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
#include <math.h>

const unsigned long SAMPLE_INTERVAL_MS = 200;

// Tamper triggers when total acceleration deviates from gravity by more
// than this margin (m/s^2). The flag holds until readings stay calm for
// TAMPER_HOLD_MS, which gives the ~1.6 s auto-clear.
const float GRAVITY = 9.81;
const float TAMPER_THRESHOLD = 4.0;
const unsigned long TAMPER_HOLD_MS = 1600;

// The MPU-6050 occasionally locks up the I2C bus; after this many
// consecutive failed reads the bus and sensor are reinitialised.
const int MAX_FAILED_READS = 5;

// The Adafruit library reports success even when the bus is dead, so a
// lockup shows up as bit-identical readings. Real sensor noise never
// holds all six axes constant this long.
const int MAX_IDENTICAL_READS = 10;

// Without a timeout, Wire blocks forever on a hung bus and the whole
// sketch freezes (microseconds).
const uint32_t WIRE_TIMEOUT_US = 3000;

Adafruit_MPU6050 mpu;
unsigned long lastSample = 0;
unsigned long lastTamperTrigger = 0;
bool tamper = false;
int failedReads = 0;
int identicalReads = 0;
float lastReading[6] = {0, 0, 0, 0, 0, 0};

bool initSensor() {
  if (!mpu.begin()) {
    return false;
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  return true;
}

void enableWireTimeout() {
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(WIRE_TIMEOUT_US, true);
#endif
}

void resetI2CBus() {
  Serial.println(F("{\"status\":\"i2c_reset\"}"));
  Wire.end();
  // A locked-up slave holds SDA low mid-transfer; pulsing SCL lets it
  // clock out the rest of its byte and release the bus, then a manual
  // STOP condition returns it to idle. Wire.begin() alone cannot do this.
  pinMode(SDA, INPUT_PULLUP);
  pinMode(SCL, INPUT_PULLUP);
  delay(5);
  for (int i = 0; i < 9 && digitalRead(SDA) == LOW; i++) {
    pinMode(SCL, OUTPUT);
    digitalWrite(SCL, LOW);
    delayMicroseconds(10);
    pinMode(SCL, INPUT_PULLUP);
    delayMicroseconds(10);
  }
  pinMode(SDA, OUTPUT);
  digitalWrite(SDA, LOW);
  delayMicroseconds(10);
  pinMode(SCL, INPUT_PULLUP);
  delayMicroseconds(10);
  pinMode(SDA, INPUT_PULLUP);
  delayMicroseconds(10);
  Wire.begin();
  enableWireTimeout();
  delay(50);
  initSensor();
  failedReads = 0;
  identicalReads = 0;
}

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    delay(10);
  }
  if (!initSensor()) {
    Serial.println(F("{\"status\":\"mpu6050_not_found\"}"));
    while (!initSensor()) {
      delay(500);
    }
  }
  enableWireTimeout();
  Serial.println(F("{\"status\":\"ready\"}"));
}

void loop() {
  unsigned long now = millis();
  if (now - lastSample < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSample = now;

  sensors_event_t a, g, temp;
  bool readFailed = !mpu.getEvent(&a, &g, &temp);
#if defined(WIRE_HAS_TIMEOUT)
  if (Wire.getWireTimeoutFlag()) {
    Wire.clearWireTimeoutFlag();
    readFailed = true;
  }
#endif
  if (readFailed) {
    failedReads++;
    if (failedReads >= MAX_FAILED_READS) {
      resetI2CBus();
    }
    return;
  }
  failedReads = 0;

  float reading[6] = {
    a.acceleration.x, a.acceleration.y, a.acceleration.z,
    g.gyro.x, g.gyro.y, g.gyro.z
  };
  bool identical = true;
  for (int i = 0; i < 6; i++) {
    if (reading[i] != lastReading[i]) {
      identical = false;
    }
    lastReading[i] = reading[i];
  }
  if (identical) {
    identicalReads++;
    if (identicalReads >= MAX_IDENTICAL_READS) {
      resetI2CBus();
      return;
    }
  } else {
    identicalReads = 0;
  }

  float ax = a.acceleration.x;
  float ay = a.acceleration.y;
  float az = a.acceleration.z;
  float magnitude = sqrt(ax * ax + ay * ay + az * az);

  if (fabs(magnitude - GRAVITY) > TAMPER_THRESHOLD) {
    tamper = true;
    lastTamperTrigger = now;
  } else if (tamper && now - lastTamperTrigger > TAMPER_HOLD_MS) {
    tamper = false;
  }

  Serial.print(F("{\"ax\":"));
  Serial.print(ax, 3);
  Serial.print(F(",\"ay\":"));
  Serial.print(ay, 3);
  Serial.print(F(",\"az\":"));
  Serial.print(az, 3);
  Serial.print(F(",\"gx\":"));
  Serial.print(g.gyro.x, 3);
  Serial.print(F(",\"gy\":"));
  Serial.print(g.gyro.y, 3);
  Serial.print(F(",\"gz\":"));
  Serial.print(g.gyro.z, 3);
  Serial.print(F(",\"tamper\":"));
  Serial.print(tamper ? 1 : 0);
  Serial.println(F("}"));
}
