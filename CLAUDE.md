# SecureBot v2: private home security with a local AI

Repo: `Kxrma35/secure-bot`. This file replaces the earlier standalone "Room AI" outline:
that project is now merged into SecureBot.

Visual overview (architecture and build order): [SecureBot v2 whiteboard](https://claude.ai/artifact/YMkLj3w3NQeCWgsp7uZWgL)

## What this is

**SecureBot v1 (exists, works):** an Arduino Uno reads an MPU-6050 on the door, detects tampering,
and sends JSON over USB serial to a Raspberry Pi 5. The Pi publishes it to Mosquitto, logs it to SQLite,
runs an intrusion detector (flood and replay detection), and serves a login-protected Flask dashboard.

**SecureBot v2 (what we're building):**

- An **ESP32-S3** replaces the Arduino Uno and USB cable. It connects to the Pi over Wi-Fi (MQTT) and runs all the sensors itself:
  - the MPU-6050 for door tamper detection (same as v1),
  - a PIR motion sensor,
  - an RC522 RFID reader for tapping a card to arm or disarm,
  - an OLED screen showing status on the device.
- A **local AI** on the Pi (Ollama, `gemma3:1b`) answers questions like
  "Did anything happen while I was out?" from the dashboard. No cloud services.
- Later: an **nRF905** radio link to a second sensor node (for example, outside the door).

Goals: a learning project toward ML / AI engineering (embedded -> data pipeline -> backend -> LLM)
and one strong, growing portfolio project.

## Ground rules for this repo

- **Don't break v1 until v2 replaces it.** The Uno + serial path keeps working until the ESP32 node is proven (end of M2).
- **Extend the existing code. Don't rewrite it.** Keep Flask, SQLAlchemy, paho-mqtt (`CallbackAPIVersion.VERSION2`), and `config.py` with environment variables.
  Do **not** add FastAPI or a second web framework.
- Don't restructure the existing Python layout or rename files without asking.
- Python 3.13 in a virtual environment on the Pi (Raspberry Pi OS blocks system-wide `pip install`).

## Core design rule for the AI

**The code looks up the facts; the model only puts them into words.**

- Python queries SQLite and builds a plain-text summary: armed state, events in the time window, counts, last motion, alerts, and how long ago each happened.
- That summary goes into the prompt. The model must not invent events. If there is no data for the window, it says so.
- All counting, time maths and comparisons happen in Python, never in the model.
- Do not rely on LLM tool/function calling. Small 1B models are unreliable at it.

## Hardware

- **Raspberry Pi 5, 16 GB RAM**, 64-bit Raspberry Pi OS, booting from a 500 GB SATA SSD on a USB 3.0 adapter.
  A second 500 GB SSD is available later for backups (needs a second adapter; mind the USB power budget: official 27 W supply or a powered hub).
- **ESP32-S3-WROOM** dev board: the v2 sensor node.
- **MPU-6050** (I2C, 0x68): door tamper detection. Power from 3.3 V.
- **PIR motion sensor**: assumed HC-SR501 (confirm). Power from 5 V; its output is 3.3 V, safe for the ESP32.
- **RC522** RFID reader (SPI, 3.3 V only, never 5 V) with MIFARE cards/tags.
- **OLED**: assumed 0.96" SSD1306 128x64 on I2C (0x3C) (confirm).
- **nRF905** radio transceiver (SPI, 3.3 V). It needs a *second* nRF905 on another board to talk to. Not used until the "Later" stage.
- **Arduino Uno R3**: v1 node, retired after M2.

## Architecture

```
ESP32-S3 node --(Wi-Fi, MQTT with password)--> Mosquitto on the Pi
  MPU-6050, PIR, RC522, OLED                       |
                                                   +--> mqtt_subscriber.py --> SQLite (telemetry, alerts, events)
                                                   +--> ids.py (flood + replay detection) --> security_log
                                                   +--> dashboard.py (Flask: login, live view, /api/ask)
                                                                   |
Phone / laptop browser <--(home Wi-Fi)--> Flask dashboard          +--> Ollama on 127.0.0.1:11434 (gemma3:1b)
```

## Firmware (Arduino C++, ESP32-S3)

Location: `firmware/esp32-s3/securebot_node/`. Secrets go in `secrets.h` (gitignored); commit `secrets.example.h`.

Libraries (check each supports ESP32-S3 before committing to it):

- Adafruit MPU6050 (already used in v1)
- Adafruit SSD1306 + Adafruit GFX
- MFRC522 (miguelbalboa)
- PubSubClient (MQTT) and ArduinoJson
- nRF905: pick a library with confirmed ESP32 support (later stage only)

Behaviour:

- Connect to Wi-Fi and MQTT with backoff, and reconnect on their own after drops. The sensors and OLED keep working while offline.
- Port the v1 tamper logic (acceleration magnitude + debounce) from `securebot.ino`.
- Telemetry at no more than 5 messages per second (v1 is every 200 ms). `ids.py` flags more than 10 per second as a flood.
- Sync time with NTP. If the time isn't synced yet, leave `ts` out and the Pi stamps it.
- Every payload carries an increasing `seq` number, so normal messages are never identical and `ids.py` doesn't flag them as replays.
- OLED status screen: armed or disarmed, Wi-Fi/MQTT connection, last event and time.

### Proposed pin map (verify against the actual board's pinout before wiring)

| Function | ESP32-S3 GPIO |
|---|---|
| I2C SDA (MPU-6050 + OLED, shared bus) | 8 |
| I2C SCL | 9 |
| PIR output | 4 |
| RC522 on SPI2/FSPI: SS, MOSI, SCK, MISO | 10, 11, 12, 13 |
| RC522 RST | 5 |
| nRF905 on SPI3 (later): SCK, MOSI, MISO, CSN | 39, 40, 41, 42 |
| nRF905 control (later): TRX_CE, TX_EN, PWR_UP, DR | 6, 7, 15, 16 |

Rules for choosing pins on the ESP32-S3:

- Avoid the strapping pins 0, 3, 45 and 46.
- Avoid 19 and 20 (native USB), and 43 and 44 (UART0 serial).
- Avoid 26 to 37 (used by flash and PSRAM on most modules).
- On some dev boards GPIO 48 drives the RGB LED.
- The RC522 and the nRF905 each get their own SPI controller (the S3 has two general-purpose ones), so they don't share a bus.

## MQTT contract

Keep the v1 telemetry topic so the existing subscriber, IDS and dashboard keep working.

| Topic | Who publishes | What |
|---|---|---|
| `securebot/telemetry` | node | IMU readings (v1 format plus `device_id` and `seq`) |
| `securebot/events` | node | Discrete events (see below) |
| `securebot/status/<device_id>` | node | `online` on connect; Last Will `offline` (retained) |

Telemetry (v1 fields unchanged):

```json
{"device_id": "door-node", "seq": 1042, "ts": 1763200000.123,
 "ax": 0.12, "ay": -0.04, "az": 9.78, "gx": 0.01, "gy": 0.0, "gz": 0.01, "tamper": 0}
```

Event:

```json
{"device_id": "door-node", "seq": 1043, "ts": 1763200001.5,
 "event": "motion", "armed": true, "detail": ""}
```

Event types: `door_tamper`, `motion`, `card_ok`, `card_denied`, `armed`, `disarmed`, `boot`.

Mosquitto: `allow_anonymous false`, a password file, and separate users for the node, the Pi services and the dashboard.
Credentials come from environment variables (Pi) and `secrets.h` (node).

## Arm / disarm

- Tapping an allowed card toggles between armed and disarmed. The node decides locally, so this still works if Wi-Fi or the Pi is down, and publishes `armed` / `disarmed`.
- The allowed card UIDs live in `secrets.h` only, never in the repo.
- Unknown cards publish `card_denied` and show "Denied" on the OLED. Don't publish the full UID of an unknown card.
- When armed, `door_tamper` and `motion` count as **alerts**. When disarmed they are logged as normal events.
- **Known limitation (write this in the README):** checking only the card UID is weak, because MIFARE Classic UIDs can be cloned. Fine for learning. A card plus PIN is listed under Later.

## Database (SQLite, SQLAlchemy, existing `DB_PATH`)

Keep the existing `telemetry`, `alerts` and `security_log` tables. Add:

```
events: id, ts (float), received (datetime UTC), device_id, event_type, armed (bool), detail (text)
```

`mqtt_subscriber.py` also subscribes to `securebot/events`, validates each message, and writes it.
An event that is an alert (armed + `door_tamper` or `motion`) is also written to `alerts`.
Invalid messages are logged and dropped. They must never crash the service.

## Dashboard / API additions (Flask, existing token auth on all `/api/*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Armed or disarmed, node online or offline, last event |
| GET | `/api/events?since=<ts>` | Recent events |
| POST | `/api/ask` | Body `{"question": "..."}` -> `{"answer", "context", "model"}` |

- `/api/ask` returns the exact context the model was given, so answers can be checked.
- Add a small "Ask SecureBot" box to the existing dashboard (vanilla JS, same style as `static/dashboard.js`).
- Ollama is called with `requests` (add it to `requirements.txt`) at `http://127.0.0.1:11434/api/chat`, `"stream": false`, with a timeout of about 60 s. If Ollama is down, return a clear error instead of hanging.

System prompt (starting point):

```
You are SecureBot, a home security assistant for one room.
Answer using ONLY the security data below. Do not guess or invent events.
If there is no data for what is asked, say so clearly.
Keep answers short and calm.

Current time: {now}
Current state: {state}
Events ({window}):
{summary}
```

For "while I was out", the window is the most recent armed period. That window is computed in Python.

## Security (non-negotiable)

Keep what v1 already does well: secrets only from `.env`, refusing to start without them, HMAC-signed tokens checked with
`hmac.compare_digest`, the login delay, and the flood/replay IDS.

Add:

- Mosquitto authentication (see MQTT contract). Today anyone on the Wi-Fi can publish fake telemetry.
- Ollama listens on `127.0.0.1` only. If an `OLLAMA_HOST=0.0.0.0` override exists from earlier experiments, remove it.
- Validate every MQTT payload and API body before using it.
- No router port forwarding. For remote access prefer **Tailscale** over ngrok. If ngrok is used for a demo, only temporarily and with a strong password.
- `secrets.h`, `.env`, `*.db` and logs stay gitignored.

## Code standards

- Clean, honest, readable code. No placeholder or fake functionality presented as finished.
- Match the style of the file you're editing (the existing services print with `[tag]` prefixes). Don't refactor unrelated code without asking.
- Type hints and short docstrings in new Python code.
- Add `pytest` tests for new logic: payload validation, the events-to-summary builder, arm/disarm alert rules, `/api/ask` with Ollama mocked.
- Configuration via environment variables in `config.py` (add new ones to `.env.example`). No hardcoded IPs, passwords, keys or card UIDs.
- Small, focused commits with clear messages.

## Milestones

Work on one milestone at a time. Each has a clear "done when".

- **M0: Pi base.** Pi boots from the SSD; Ollama installed; `gemma3:1b` runs; SecureBot v1 runs as it does today.
  *Done when:* the Pi boots with no SD card, the model answers in the terminal, and the v1 dashboard works.
- **M1: Lock down and tidy.** Mosquitto passwords, with MQTT credentials in `config.py` / `.env.example` for all services.
  Repo fixes: add the v1 sketch as `firmware/uno/securebot.ino` (I'll provide it), add `assets/dashboard.png` or remove the broken image link,
  remove `.env.example` from `.gitignore`, and make the README title describe the system accurately (ask me for wording).
  *Done when:* anonymous MQTT publishes are refused and v1 still works with credentials.
- **M2: ESP32-S3 node replaces the Uno.** Wi-Fi + MQTT + MPU-6050 tamper detection, publishing to `securebot/telemetry` with `device_id` and `seq`.
  Make the serial reader optional in `run.py` (an env flag, off once the ESP32 is in use).
  *Done when:* the Uno is unplugged, the dashboard is still live from the ESP32, the IDS raises no false replay or flood events, and the node reconnects after a Wi-Fi drop.
- **M3: Motion + OLED.** PIR `motion` events (debounced); OLED status screen; `events` table and subscriber support.
  *Done when:* walking past logs a motion event and the OLED shows it.
- **M4: Card arm/disarm.** RC522 card taps arm and disarm; alert rules; `/api/state` and `/api/events`; armed state shown on the dashboard.
  *Done when:* when armed, opening the door creates an alert, and when disarmed, it creates only an event.
- **M5: Local AI.** Summary builder, `/api/ask`, and the "Ask SecureBot" box on the dashboard.
  *Done when:* "Did anything happen while I was out?" gets a correct answer built from real events, and says so plainly when nothing happened.

## Later (not now, don't build yet)

- Outdoor node over nRF905 radio (needs a second nRF905 and microcontroller), for example motion outside the door.
- Push alerts to my phone.
- Card + PIN for stronger authentication.
- Nightly backups to the second SSD; Tailscale remote access.
- Room temperature/humidity (BME280) so the AI can answer about the room too.
- Gesture control with the MPU-6050 (TinyML).

## Open questions (ask me, don't assume)

- PIR model (HC-SR501 assumed) and OLED model/size (SSD1306 128x64 I2C assumed).
- The exact ESP32-S3 dev board, so the pin map can be checked.
- Whether I have a second nRF905 and a second board (only matters for Later).

## How to work with me

- I'm learning and want to understand the system, not just have it built.
  Briefly explain what you're doing and why, especially when a concept is new.
- Before writing a lot of code for a milestone, propose a short plan and wait for my OK.
- **Ask before:** installing system packages (`apt`), changing Pi system config (`config.txt`, boot order, systemd, Mosquitto config, firewall),
  flashing firmware, or anything that deletes data or formats a drive.
- Keep the scope to the current milestone. Note good ideas under "Later" instead of building them.
- Give me wiring steps one component at a time, with the pins and the power voltage for each.

## Current status

Starting **M0**.
