

import serial
import serial.tools.list_ports
import json
import time
import paho.mqtt.client as mqtt

SERIAL_PORT     = "/dev/ttyACM0"
BAUD_RATE       = 115200
MQTT_HOST       = "localhost"
MQTT_PORT       = 1883
MQTT_TOPIC      = "securebot/telemetry"


def find_port() -> str:
    available = [p.device for p in serial.tools.list_ports.comports()]
    for candidate in ["/dev/ttyACM0", "/dev/ttyACM1", "/dev/ttyUSB0"]:
        if candidate in available:
            return candidate
    return available[0] if available else SERIAL_PORT


def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print("[mqtt] Connected to Mosquitto broker")
    else:
        print(f"[mqtt] Connection failed — code {rc}")


def main():
    # MQTT setup 
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.connect(MQTT_HOST, MQTT_PORT)
    client.loop_start()

    #  Serial setup 
    port = find_port()
    print(f"[serial] Opening {port} at {BAUD_RATE} baud...")
    ser = serial.Serial(port, BAUD_RATE, timeout=5)
    print(f"[serial] Listening. Publishing to MQTT topic: {MQTT_TOPIC}\n")

    frames = 0
    try:
        while True:
            raw = ser.readline()
            if not raw:
                continue

            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                data = json.loads(line)

                # Add timestamp
                data["ts"] = round(time.time(), 3)

                payload = json.dumps(data)
                client.publish(MQTT_TOPIC, payload)
                frames += 1

                # Print every frame so you can see it working
                status = "⚠ TAMPER" if data.get("tamper") else "OK"
                print(f"[{frames:04d}] {status} | ax={data['ax']:6.2f} ay={data['ay']:6.2f} az={data['az']:6.2f}")

            except json.JSONDecodeError:
                print(f"[serial] Non-JSON line: {line}")

    except KeyboardInterrupt:
        print(f"\n[serial] Stopped. {frames} frames published.")
    finally:
        ser.close()
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
