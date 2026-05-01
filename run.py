

import threading
import time
import sys
import os

#  Import all service modules
# Each module's main() will run in its own thread

def run_serial_reader():
    import serial_reader
    serial_reader.main()

def run_mqtt_subscriber():
    import mqtt_subscriber
    mqtt_subscriber.main()

def run_ids():
    import ids
    ids.main()

def run_dashboard():
    import dashboard
    dashboard.app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)


def main():
    import socket
    ip = socket.gethostbyname(socket.gethostname())

    print("=" * 50)
    print(" SecureBot — Starting all services")
    print("=" * 50)

    services = [
        ("MQTT Subscriber",  run_mqtt_subscriber),
        ("IDS",              run_ids),
        ("Serial Reader",    run_serial_reader),
        ("Flask Dashboard",  run_dashboard),
    ]

    threads = []
    for name, target in services:
        t = threading.Thread(target=target, name=name, daemon=True)
        t.start()
        threads.append(t)
        print(f"[run] ✓ {name} started")
        time.sleep(1)   # stagger startup slightly

    print()
    print(f"[run] All services running.")
    print(f"[run] Dashboard: http://{ip}:5000")
    print(f"[run] Press Ctrl-C to stop.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[run] Shutting down SecureBot...")
        sys.exit(0)


if __name__ == "__main__":
    main()
