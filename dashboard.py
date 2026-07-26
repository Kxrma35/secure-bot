import json
import time
from collections import deque
from functools import wraps
from threading import Lock

import paho.mqtt.client as mqtt
from flask import Flask, jsonify, render_template, request

import auth
from config import MQTT_HOST, MQTT_PORT, MQTT_TOPIC, DASHBOARD_HOST, DASHBOARD_PORT, require_auth_config

MAX_HISTORY = 50

latest  = {}
history = deque(maxlen=MAX_HISTORY)
alerts  = deque(maxlen=20)
lock    = Lock()

app = Flask(__name__)


def require_token(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        token = header.removeprefix("Bearer ").strip()
        if not token or not auth.verify_token(token):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper


def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        client.subscribe(MQTT_TOPIC)
        print(f"[mqtt] Dashboard connected and subscribed to {MQTT_TOPIC}")
    else:
        print(f"[mqtt] Connection failed - code {rc}")


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


@app.route("/api/login", methods=["POST"])
def api_login():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    if auth.check_credentials(username, password):
        return jsonify({"token": auth.generate_token(username)})
    time.sleep(1)  # slow down brute-force attempts
    return jsonify({"error": "invalid credentials"}), 401


@app.route("/api/telemetry")
@require_token
def api_telemetry():
    with lock:
        return jsonify(latest)


@app.route("/api/history")
@require_token
def api_history():
    with lock:
        return jsonify(list(history))


@app.route("/api/alerts")
@require_token
def api_alerts():
    with lock:
        return jsonify(list(alerts))


@app.route("/")
def dashboard():
    return render_template("dashboard.html")


if __name__ == "__main__":
    require_auth_config()
    start_mqtt()
    print(f"[dashboard] Listening on {DASHBOARD_HOST}:{DASHBOARD_PORT}")
    app.run(host=DASHBOARD_HOST, port=DASHBOARD_PORT, debug=False)
