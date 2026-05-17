import json
import time
from collections import deque
from threading import Lock
import paho.mqtt.client as mqtt
from flask import Flask, jsonify, render_template

MQTT_HOST   = "localhost"
MQTT_PORT   = 1883
MQTT_TOPIC  = "securebot/telemetry"
MAX_HISTORY = 50

latest  = {}
history = deque(maxlen=MAX_HISTORY)
alerts  = deque(maxlen=20)
lock    = Lock()

app = Flask(__name__)

def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        client.subscribe(MQTT_TOPIC)
        print(f"[mqtt] Dashboard connected and subscribed to {MQTT_TOPIC}")
    else:
        print(f"[mqtt] Connection failed — code {rc}")

def on_message(client, userdata, msg):
    global latest
    try:
        data = json.loads(msg.payload.decode())
        data["ts"] = data.get("ts", time.time())
        with lock:
            latest = data
            history.append(data)
            if data.get("tamper"):
                alerts.appendleft({
                    "ts": data["ts"],
                    "ax": data.get("ax"),
                    "ay": data.get("ay"),
                    "az": data.get("az"),
                })
    except Exception as e:
        print(f"[mqtt] Error: {e}")

def start_mqtt():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    connected = False
    while not connected:
        try:
            client.connect(MQTT_HOST, MQTT_PORT)
            connected = True
            print("[mqtt] Dashboard broker connection established")
        except Exception as e:
            print(f"[mqtt] Retrying... {e}")
            time.sleep(2)
    client.loop_start()
    return client

@app.route("/api/telemetry")
def api_telemetry():
    with lock:
        return jsonify(latest)

@app.route("/api/history")
def api_history():
    with lock:
        return jsonify(list(history))

@app.route("/api/alerts")
def api_alerts():
    with lock:
        return jsonify(list(alerts))

@app.route("/")
def dashboard():
    return render_template("dashboard.html")

if __name__ == "__main__":
    import socket
    ip = socket.gethostbyname(socket.gethostname())
    start_mqtt()
    print(f"[dashboard] http://{ip}:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
