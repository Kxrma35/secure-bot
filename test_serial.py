import serial
import serial.tools.list_ports
import json
import sys

BAUD_RATE = 115200
TIMEOUT_S = 10
PORT_CANDIDATES = ["/dev/ttyACM0", "/dev/ttyACM1", "/dev/ttyUSB0", "/dev/ttyUSB1"]

def find_port():
    available = [p.device for p in serial.tools.list_ports.comports()]
    print(f"[serial] Available ports: {available}")
    for candidate in PORT_CANDIDATES:
        if candidate in available:
            print(f"[serial] Selected: {candidate}")
            return candidate
    if available:
        print(f"[serial] Falling back to: {available[0]}")
        return available[0]
    return None

def main():
    port = sys.argv[1] if len(sys.argv) > 1 else find_port()
    if not port:
        print("[serial] ERROR: No serial ports found.")
        print("  - Check USB cable is plugged into both Arduino and Pi")
        print("  - Run: ls /dev/ttyACM* /dev/ttyUSB*")
        sys.exit(1)

    print(f"[serial] Opening {port} at {BAUD_RATE} baud...")
    try:
        ser = serial.Serial(port, BAUD_RATE, timeout=TIMEOUT_S)
    except serial.SerialException as e:
        print(f"[serial] ERROR: {e}")
        sys.exit(1)

    print(f"[serial] Waiting for data from Arduino...\n")
    lines = 0
    try:
        while True:
            raw = ser.readline()
            if not raw:
                print("[serial] Timeout — is the Arduino sketch running?")
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                print(data)
                lines += 1
                if lines == 3:
                    print("\n✓ Serial pipeline working!\n")
            except json.JSONDecodeError:
                print(f"[arduino] {line}")
    except KeyboardInterrupt:
        print(f"\n[serial] Stopped after {lines} JSON frames.")
    finally:
        ser.close()

if __name__ == "__main__":
    main()
