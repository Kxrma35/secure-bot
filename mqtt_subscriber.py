

import json
import time
from datetime import datetime

import paho.mqtt.client as mqtt
from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime, Boolean
from sqlalchemy.orm import DeclarativeBase, Session

MQTT_HOST    = "localhost"
MQTT_PORT    = 1883
MQTT_TOPIC   = "securebot/telemetry"
DB_PATH = "sqlite:////home/karma/securebot.db"


#  Database models 
class Base(DeclarativeBase):
    pass


class TelemetryReading(Base):
    __tablename__ = "telemetry"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    ts        = Column(Float,   nullable=False)
    received  = Column(DateTime, default=datetime.utcnow)
    ax        = Column(Float)
    ay        = Column(Float)
    az        = Column(Float)
    gx        = Column(Float)
    gy        = Column(Float)
    gz        = Column(Float)
    tamper    = Column(Boolean, default=False)


class Alert(Base):
    __tablename__ = "alerts"

    id       = Column(Integer, primary_key=True, autoincrement=True)
    ts       = Column(Float,   nullable=False)
    received = Column(DateTime, default=datetime.utcnow)
    ax       = Column(Float)
    ay       = Column(Float)
    az       = Column(Float)


#  Database setup

engine = create_engine(DB_PATH, echo=False)
Base.metadata.create_all(engine)
print(f"[db] Database ready at {DB_PATH}")


# ── MQTT callbacks ─────────────────────────────────────────────────────────────

readings = 0
tamper_count = 0

def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        client.subscribe(MQTT_TOPIC)
        print(f"[mqtt] Connected. Subscribed to {MQTT_TOPIC}\n")
    else:
        print(f"[mqtt] Connection failed — code {rc}")


def on_message(client, userdata, msg):
    global readings, tamper_count
    try:
        data = json.loads(msg.payload.decode())

        reading = TelemetryReading(
            ts     = data.get("ts", time.time()),
            ax     = data.get("ax"),
            ay     = data.get("ay"),
            az     = data.get("az"),
            gx     = data.get("gx"),
            gy     = data.get("gy"),
            gz     = data.get("gz"),
            tamper = bool(data.get("tamper", 0)),
        )

        with Session(engine) as session:
            session.add(reading)

            # Also log to alerts table if tamper detected
            if reading.tamper:
                alert = Alert(
                    ts = reading.ts,
                    ax = reading.ax,
                    ay = reading.ay,
                    az = reading.az,
                )
                session.add(alert)
                tamper_count += 1
                print(f"[alert] ⚠ TAMPER #{tamper_count} logged to DB")

            session.commit()

        readings += 1
        if readings % 10 == 0:
            print(f"[db] {readings} readings logged ({tamper_count} tamper alerts)")

    except Exception as e:
        print(f"[mqtt] Error processing message: {e}")


#  Main 
def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT)

    print("[mqtt] Starting subscriber loop. Press Ctrl-C to stop.")
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print(f"\n[db] Final count: {readings} readings, {tamper_count} alerts.")
        client.disconnect()


if __name__ == "__main__":
    main()
