# SecureBot
Tamper-aware autonomous navigation system built with Arduino Uno R3, MPU-6050, and Raspberry Pi 5.

## Stack
- Arduino: C++ with Adafruit MPU6050 library
- Pi: Python 3.13, Flask, Mosquitto MQTT, SQLite, SQLAlchemy, paho-mqtt, pyserial

## Quick Start
```bash
source ~/securebot-env/bin/activate
python run.py
```
Then open http://<pi-ip>:5000
