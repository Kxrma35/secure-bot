import threading
import time
import sys
import os

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
    dashboard.start_mqtt()
    dashboard.app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)

def main():
    import socket
    try:
        ip = socket.gethostbyname(socket.gethostname())
    except:
        ip = "localhost"

    print("=" * 50)
    print(" SecureBot — Starting all services")
    print("=" * 50)

    # Kill anything holding the serial port first
    os.system("sudo fuser -k /dev/ttyACM0 2>/dev/null")
    time.sleep(2)

    # Start in correct order with delays
    steps = [
        ("MQTT Subscriber", run_mqtt_subscriber, 3),
        ("IDS",             run_ids,             2),
        ("Serial Reader",   run_serial_reader,   5),
        ("Flask Dashboard", run_dashboard,        2),
    ]

    for name, target, delay in steps:
        t = threading.Thread(target=target, name=name, daemon=True)
        t.start()
        print(f"[run] ✓ {name} started")
        time.sleep(delay)

    print()
    print(f"[run] All services running.")
    print(f"[run] Dashboard: http://{ip}:5000")
    print(f"[run] Press Ctrl-C to stop.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[run] Shutting down...")
        os.system("sudo fuser -k /dev/ttyACM0 2>/dev/null")
        sys.exit(0)

if __name__ == "__main__":
    main()
