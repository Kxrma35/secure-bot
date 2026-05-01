

import json
import time
import hashlib
from collections import deque

import paho.mqtt.client as mqtt
from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime
from sqlalchemy.orm import DeclarativeBase, Session
from datetime import datetime

MQTT_HOST        = "localhost"
MQTT_PORT        = 1883
MQTT_TOPIC       = "securebot/telemetry"
DB_PATH          = "sqlite:////home/karma/securebot.db"

# Thresholds
MAX_MSG_PER_SEC  = 10    # more than this = flood attack
REPLAY_WINDOW    = 5     # seconds to keep payload hashes


class Base(DeclarativeBase):
    pass


class SecurityEvent(Base):
    __tablename__ = "security_log"
    id         = Column(Integer, primary_key=True, autoincrement=True)
    ts         = Column(Float, nullable=False)
    received   = Column(DateTime, default=datetime.utcnow)
    event_type = Column(String)   # flood, replay, tamper
    detail     = Column(String)


engine = create_engine(DB_PATH, echo=False)
Base.metadata.create_all(engine)
print("[ids] security_log table ready")

#  State 
msg_times    = deque()          # timestamps of recent messages
recent_hashes= {}               # hash -> timestamp, for replay detection
event_count  = 0


def log_event(event_type: str, detail: str):
    global event_count
    event_count += 1
    now = time.time()
    print(f"[ids] ⚠ SECURITY EVENT #{event_count}: {event_type} — {detail}")
    with Session(engine) as s:
        s.add(SecurityEvent(ts=now, event_type=event_type, detail=detail))
        s.commit()


def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        client.subscribe(MQTT_TOPIC)
        print(f"[ids] Connected. Monitoring {MQTT_TOPIC}\n")


def on_message(client, userdata, msg):
    now     = time.time()
    payload = msg.payload.decode()

    #  Flood detection 
    msg_times.append(now)
    # Remove timestamps older than 1 second
    while msg_times and msg_times[0] < now - 1:
        msg_times.popleft()

    if len(msg_times) > MAX_MSG_PER_SEC:
        log_event("flood", f"{len(msg_times)} messages in last second")

    #  Replay detection 
    h = hashlib.sha256(payload.encode()).hexdigest()
    if h in recent_hashes:
        age = round(now - recent_hashes[h], 2)
        log_event("replay", f"Duplicate payload seen {age}s ago")
    recent_hashes[h] = now

    # Clean old hashes
    expired = [k for k, t in recent_hashes.items() if now - t > REPLAY_WINDOW]
    for k in expired:
        del recent_hashes[k]

    #  Tamper detection
    try:
        data = json.loads(payload)
        if data.get("tamper"):
            log_event("tamper", f"ax={data.get('ax')} ay={data.get('ay')} az={data.get('az')}")
    except Exception:
        pass

    # Heartbeat every 50 messages
    total = len(msg_times)
    if total % 50 == 0:
        print(f"[ids] Monitoring... {event_count} events logged")


def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT)
    print("[ids] Intrusion Detection System running. Press Ctrl-C to stop.")
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print(f"\n[ids] Stopped. {event_count} security events logged.")
        client.disconnect()


if __name__ == "__main__":
    main()
