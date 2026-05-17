# SecureBot 

**Tamper-Aware Autonomous Navigation System**

A real-time IoT security pipeline built on Arduino Uno R3 and Raspberry Pi 5. SecureBot detects physical tampering using an MPU-6050 IMU sensor, routes data through an MQTT broker, logs everything to a SQLite database, and displays live telemetry on a web dashboard accessible from any device on the network. KEEP YOUR PERSONAL SPACE SAFE ALWAYS!!!

---

##  Demo

> Live dashboard showing accelerometer data, gyroscope readings, and tamper alert history in real time.

![SecureBot Dashboard](https://raw.githubusercontent.com/Kxrma35/secure-bot/main/assets/dashboard.png)

---

##  System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        EDGE LAYER                               │
│                                                                 │
│   ┌──────────────┐    I2C     ┌─────────────────────────────┐  │
│   │  MPU-6050    │ ─────────► │       Arduino Uno R3        │  │
│   │  IMU Sensor  │  SDA/SCL   │  Tamper detection logic     │  │
│   │  (6-axis)    │            │  JSON output over serial    │  │
│   └──────────────┘            └──────────────┬──────────────┘  │
└──────────────────────────────────────────────│─────────────────┘
                                               │ USB Serial
                                               │ 115200 baud
┌──────────────────────────────────────────────▼─────────────────┐
│                        BRAIN LAYER                              │
│                    Raspberry Pi 5                               │
│                                                                 │
│  serial_reader.py ──► Mosquitto MQTT ──┬──► mqtt_subscriber.py │
│  (reads serial,        (broker,        │    (logs to SQLite)   │
│   publishes JSON)       port 1883)     │                        │
│                                        ├──► ids.py              │
│                                        │    (flood + replay     │
│                                        │     detection)         │
│                                        │                        │
│                                        └──► dashboard.py        │
│                                             (Flask web server)  │
│                                                    │            │
└────────────────────────────────────────────────────│────────────┘
                                                     │ HTTP :5000
┌────────────────────────────────────────────────────▼────────────┐
│                       CLIENT LAYER                               │
│              Any browser on the same network                     │
│         Live charts · Tamper alerts · System status             │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **MPU-6050** reads 3-axis acceleration and gyroscope via I2C every 200ms
2. **Arduino** calculates total acceleration magnitude, applies tamper debounce logic, outputs JSON over USB serial
3. **serial_reader.py** parses the JSON, adds a Unix timestamp, publishes to Mosquitto on topic `securebot/telemetry`
4. **mqtt_subscriber.py** receives the message and writes it to the SQLite `telemetry` table. If `tamper=1`, also writes to the `alerts` table
5. **ids.py** independently monitors the same topic for flood attacks and replay attacks, logging security events to `security_log`
6. **dashboard.py** receives live messages and serves them via REST API to the browser
7. **Browser** polls `/api/telemetry` every 300ms and updates the live charts and status display

---

##  Hardware

| Component | Model | Role |
|---|---|---|
| Microcontroller | Arduino Uno R3 | Edge processor — reads sensor, runs tamper detection, sends JSON |
| IMU Sensor | MPU-6050 | 6-axis accelerometer + gyroscope over I2C |
| Single-Board Computer | Raspberry Pi 5 | Brain layer — MQTT, database, Flask dashboard |
| Connection | USB-A to USB-B | Serial data + power between Arduino and Pi |

### Wiring — MPU-6050 → Arduino Uno R3

| MPU-6050 Pin | Arduino Pin | Wire Colour | Notes |
|---|---|---|---|
| VCC | 3.3V | Red | ⚠ **NOT 5V** — will destroy the sensor |
| GND | GND | Black | Any GND pin |
| SDA | A4 | Blue | I2C data line |
| SCL | A5 | Yellow | I2C clock line |
| AD0 | GND | Grey | Sets I2C address to 0x68 |
| INT | — | — | Not used |

---

##  Software Stack

| Layer | Language | Key Libraries |
|---|---|---|
| Arduino firmware | C++ | Adafruit MPU6050, Wire.h, math.h |
| Raspberry Pi services | Python 3.13 | Flask, paho-mqtt, pyserial, SQLAlchemy, cryptography |
| Web dashboard | HTML / CSS / JavaScript | Canvas API, Fetch API (no external frameworks) |

### Python Dependencies

```
fastapi
uvicorn[standard]
paho-mqtt
pyserial
pyserial-asyncio
sqlalchemy
python-jose[cryptography]
cryptography
pydantic
flask
```

---

##  Project Structure

```
secure-bot/
├── serial_reader.py      # Reads Arduino serial data, publishes to MQTT
├── mqtt_subscriber.py    # Subscribes to MQTT, logs all readings to SQLite
├── dashboard.py          # Flask web server — live dashboard + REST API
├── ids.py                # Intrusion detection (flood + replay attacks)
├── auth.py               # JWT token generation and verification
├── firmware_check.py     # SHA-256 firmware integrity checker
├── run.py                # Single startup script for all services
├── test_serial.py        # Serial connection test utility
├── templates/
│   └── dashboard.html    # Live dashboard frontend
└── README.md
```

---

##  Quick Start

### Prerequisites

- Raspberry Pi 5 running Raspberry Pi OS
- Arduino Uno R3 with MPU-6050 wired (see wiring table above)
- Arduino IDE on a Windows/macOS/Linux laptop
- Python 3.13

### 1. Set up the Pi environment

```bash
# Update system and install Mosquitto
sudo apt update && sudo apt upgrade -y
sudo apt install -y mosquitto mosquitto-clients python3-venv python3-pip

# Enable Mosquitto
sudo systemctl enable mosquitto
sudo systemctl start mosquitto

# Create virtual environment
python3 -m venv ~/securebot-env
source ~/securebot-env/bin/activate
pip install flask paho-mqtt pyserial pyserial-asyncio sqlalchemy cryptography python-jose
```

### 2. Flash the Arduino

1. Download [Arduino IDE 2](https://www.arduino.cc/en/software)
2. Install library: **Tools → Manage Libraries** → search `Adafruit MPU6050` → Install All
3. Open `securebot.ino`, select board **Arduino Uno** and your COM port
4. Click **Upload**
5. Open Serial Monitor at **115200 baud** — confirm JSON is printing
6. Close Serial Monitor and move USB to the Pi

### 3. Clone the repo onto the Pi

```bash
cd ~
git clone https://github.com/Kxrma35/secure-bot.git securebot-files
cp ~/securebot-files/*.py ~/
cp -r ~/securebot-files/templates ~/
```

### 4. Start everything

```bash
source ~/securebot-env/bin/activate
python ~/run.py
```

### 5. Open the dashboard

Find your Pi's IP address:
```bash
hostname -I
```

Then open a browser on any device on the same network:
```
http://<pi-ip-address>:5000
```

---

##  Public Access with ngrok

To share the dashboard publicly (useful for demos):

```bash
# Install ngrok
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Add your auth token from ngrok.com
ngrok config add-authtoken YOUR_TOKEN

# In a second terminal, with run.py already running:
ngrok http 5000
```

This generates a public URL like `https://abc123.ngrok-free.app` accessible from anywhere.

---

##  Security Features

| Feature | File | Description |
|---|---|---|
| Tamper detection | `securebot.ino` | Hardware-level — detects acceleration spikes with debounce to prevent false positives |
| Flood detection | `ids.py` | Flags MQTT message rates above 10/second as a flood attack |
| Replay detection | `ids.py` | SHA-256 hashes each payload; duplicates within 5 seconds are flagged |
| Firmware integrity | `firmware_check.py` | Generates and verifies SHA-256 hash of the Arduino sketch file |
| JWT authentication | `auth.py` | HMAC-SHA256 signed tokens for protecting dashboard API endpoints |
| Audit logging | `mqtt_subscriber.py` | All telemetry, tamper alerts, and security events logged to SQLite with timestamps |

### Firmware Integrity Check

```bash
# Generate hash after finalising the sketch
python ~/firmware_check.py generate securebot.ino

# Verify before demo
python ~/firmware_check.py verify securebot.ino
```

### Query the Database

```bash
sqlite3 ~/securebot.db

# View all tamper alerts
SELECT * FROM alerts;

# View security events
SELECT * FROM security_log;

# Count total readings
SELECT COUNT(*) FROM telemetry;

.quit
```

---

##  API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Live dashboard HTML |
| `/api/telemetry` | GET | Latest single sensor reading as JSON |
| `/api/history` | GET | Last 50 readings as JSON array |
| `/api/alerts` | GET | Last 20 tamper alerts as JSON array |

### Example Response — `/api/telemetry`

```json
{
  "ax": 0.123,
  "ay": -0.045,
  "az": 9.781,
  "gx": 0.012,
  "gy": -0.004,
  "gz": 0.007,
  "tamper": 0,
  "ts": 1746576000.123
}
```

---

##  Demo Script

| Step | Action | Command |
|---|---|---|
| 1 | Start all services | `python ~/run.py` |
| 2 | Open dashboard | `http://<pi-ip>:5000` |
| 3 | Show live charts | Point out rolling accel/gyro graphs |
| 4 | Trigger tamper | Pick up and shake the Arduino |
| 5 | Show auto-clear | Set it down — flag clears after ~1.6s |
| 6 | Query alerts | `sqlite3 ~/securebot.db "SELECT * FROM alerts;"` |
| 7 | Show IDS log | `sqlite3 ~/securebot.db "SELECT * FROM security_log;"` |
| 8 | Firmware check | `python ~/firmware_check.py verify securebot.ino` |

---

##  Troubleshooting

| Problem | Fix |
|---|---|
| `MPU6050 not found` | Reseat all 4 jumper wires. Check VCC is on 3.3V not 5V |
| I2C lockup after a few minutes | The sketch auto-resets the I2C bus after 5 failed reads |
| Serial port not found | Run `ls /dev/ttyACM*` — use `/dev/ttyACM0` |
| Dashboard shows Frames: 0 | Check Mosquitto is running: `sudo systemctl status mosquitto` |
| Port 5000 already in use | Run `sudo pkill -f python` then restart |
| Push rejected on GitHub | Run `git push origin main --force` |

---

##  Licence

MIT License — free to use, modify, and distribute with attribution.

---

##  Contact

**Developer:** Kxrma35
**Email:** karmanjeruh5@gmail.com
**Phone:** +254 793 960 550
**GitHub:** [github.com/Kxrma35/secure-bot](https://github.com/Kxrma35/secure-bot)
