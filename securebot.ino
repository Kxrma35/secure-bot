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

Adafruit_MPU6050 mpu;
unsigned long lastSample = 0;
unsigned long lastTamperTrigger = 0;
bool tamper = false;
int failedReads = 0;

bool initSensor() {
  if (!mpu.begin()) {
    return false;
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  return true;
}

void resetI2CBus() {
  Serial.println(F("{\"status\":\"i2c_reset\"}"));
  Wire.end();
  delay(50);
  Wire.begin();
  delay(50);
  initSensor();
  failedReads = 0;
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
  Serial.println(F("{\"status\":\"ready\"}"));
}

void loop() {
  unsigned long now = millis();
  if (now - lastSample < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSample = now;

  sensors_event_t a, g, temp;
  if (!mpu.getEvent(&a, &g, &temp)) {
    failedReads++;
    if (failedReads >= MAX_FAILED_READS) {
      resetI2CBus();
    }
    return;
  }
  failedReads = 0;

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
