#!/usr/bin/env python3
"""
visualizer.py -- live 3D aircraft attitude from an MPU-6050 / Arduino Uno.

Reads "roll,pitch,yaw" CSV (degrees) from the serial port and drives:
  * a 3D aircraft model that follows the sensor's orientation
  * a small artificial-horizon overlay (pitch ladder + bank pointer)
  * a text HUD with the numeric roll / pitch / yaw

Yaw drifts (no magnetometer). Re-zero it any time:
  * press  Z  while the 3D canvas has focus, or
  * press  Enter  (or type  z  then Enter) in the terminal.
Press  Q  on the canvas, or type  q  in the terminal, to quit.

Run:
  python visualizer.py                 # auto-detect the Arduino's port
  python visualizer.py --port COM3     # or name it explicitly
  python visualizer.py --sim           # no hardware: synthetic motion demo
  python visualizer.py --list-ports    # show available serial ports

Ports look like:  COM3 (Windows)  /dev/ttyACM0 (Linux)  /dev/cu.usbmodemXXXX (macOS)
Close the Arduino IDE Serial Monitor first -- it locks the port.
"""

import argparse
import math
import os
import sys
import threading
import time

import numpy as np
from vpython import (box, compound, vector, color, scene, rate, wtext,
                     canvas, ring, cone, sphere)


class SourceLost(Exception):
    """The data source went away mid-run (cable pulled, board reset)."""


def wrap180(deg):
    """Fold an angle in degrees into [-180, +180)."""
    return (deg + 180.0) % 360.0 - 180.0


# --------------------------------------------------------------------------
# data sources
# --------------------------------------------------------------------------
# Built-in ports that are never an Arduino; picking one of these as a
# "fallback" just makes the visualizer sit there reading nothing.
_PORT_BLACKLIST = ("ttys0", "ttys1", "bluetooth", "debug-console", "wlan-debug")


def find_port():
    """Best guess at the Arduino's serial port."""
    from serial.tools import list_ports
    ports = list(list_ports.comports())
    keys = ("arduino", "usbmodem", "ttyacm", "ttyusb", "wch", "ch340", "cp210", "slab")

    def blob(p):
        return f"{p.device} {p.description or ''} {p.manufacturer or ''}".lower()

    for p in ports:
        if any(k in blob(p) for k in keys):
            return p.device
    plausible = [p for p in ports if not any(b in blob(p) for b in _PORT_BLACKLIST)]
    return plausible[0].device if plausible else None


def parse_sample(raw):
    """Bytes of one line -> (roll, pitch, yaw), or None if it isn't a sample."""
    parts = raw.decode("ascii", errors="ignore").strip().split(",")
    if len(parts) != 3:                 # skips "Calibrating", "Ready", blanks
        return None
    try:
        vals = tuple(float(p) for p in parts)
    except ValueError:
        return None
    # float() happily accepts "nan"/"inf"; a garbled line must not reach the
    # renderer, because a NaN axis makes the model vanish for good.
    if not all(math.isfinite(v) for v in vals):
        return None
    return vals


class SerialSource:
    """Lines of 'roll,pitch,yaw' from the Arduino, newest sample only."""

    MAX_BUF = 4096                      # cap the buffer if a newline never comes

    def __init__(self, port, baud):
        try:
            import serial
        except ImportError:
            sys.exit("pyserial is not installed.  pip install pyserial   "
                     "(or run with --sim)")
        self._serial = serial
        if port is None:
            port = find_port()
            if port is None:
                sys.exit("No serial port found. Plug in the Arduino, or pass --port, "
                         "or use --sim.")
            print(f"Auto-detected serial port: {port}")
        self.name = port
        try:
            self.ser = serial.Serial(port, baud, timeout=1)
        except serial.SerialException as exc:
            sys.exit(f"Could not open {port}: {exc}\n"
                     "Close the Arduino IDE Serial Monitor (it locks the port), "
                     "check the cable, or name a different port with --port.")
        self._buf = b""

    def read(self):
        """
        Return the most recent complete sample and drop any backlog.

        The Arduino streams at ~50 Hz whether or not we keep up.  Consuming one
        line per rendered frame lets the OS receive buffer grow without bound as
        soon as rendering dips below the sample rate, so the displayed attitude
        falls further and further behind the real board.  Draining to the newest
        line each frame keeps latency bounded.
        """
        try:
            waiting = self.ser.in_waiting
            chunk = self.ser.read(waiting) if waiting else self.ser.readline()
        except (OSError, self._serial.SerialException) as exc:
            raise SourceLost(str(exc)) from exc

        if not chunk:
            return None
        self._buf += chunk
        if b"\n" not in self._buf:
            if len(self._buf) > self.MAX_BUF:
                self._buf = self._buf[-self.MAX_BUF:]
            return None

        *lines, self._buf = self._buf.split(b"\n")
        for raw in reversed(lines):     # newest usable line wins
            sample = parse_sample(raw)
            if sample is not None:
                return sample
        return None

    def close(self):
        try:
            self.ser.close()
        except Exception:
            pass


class SimSource:
    """Synthetic smooth motion so the visualizer works with no hardware."""

    name = "SIMULATION (no hardware)"

    def __init__(self):
        self.t0 = time.time()

    def read(self):
        # Purely a function of wall-clock time: no sleep, so the render loop's
        # rate() stays in charge of pacing instead of being blocked here.
        t = time.time() - self.t0
        roll = 35.0 * math.sin(t * 0.70)
        pitch = 20.0 * math.sin(t * 0.90 + 1.0)
        yaw = wrap180(t * 15.0)
        return roll, pitch, yaw

    def close(self):
        pass


# --------------------------------------------------------------------------
# 3D model + artificial-horizon overlay
# --------------------------------------------------------------------------
SCALE_PITCH = 2.2                           # instrument world-units per degree of pitch


def build_scene():
    # ----- main 3D aircraft (nose = +x, up = +y, right wing = +z) -----
    fuselage  = box(length=6,   height=0.6,  width=0.6,  color=color.gray(0.7))
    wing      = box(length=1.4, height=0.15, width=5,    color=color.red)
    tailplane = box(length=1.2, height=0.12, width=2,    pos=vector(-2.4, 0, 0),   color=color.red)
    fin       = box(length=1.2, height=1.4,  width=0.12, pos=vector(-2.4, 0.6, 0), color=color.blue)
    plane = compound([fuselage, wing, tailplane, fin])

    scene.title = ("MPU-6050 aircraft attitude   -   Z zeros yaw,  Q quits "
                   "(canvas or terminal)\n")
    scene.forward = vector(-1, -0.4, -1)
    scene.range = 6
    hud = wtext(text="")

    # ----- artificial-horizon instrument on its own canvas -----
    SKY = vector(0.20, 0.45, 0.80)
    GND = vector(0.45, 0.30, 0.15)

    inst = canvas(title="Attitude indicator\n", width=260, height=260,
                  background=color.gray(0.05))
    inst.range = 130
    inst.userzoom = inst.userspin = inst.userpan = False

    CW = 700                                # card width, covers the view when rolled
    parts = [
        box(canvas=inst, pos=vector(0,  200, 0), size=vector(CW, 400, 1), color=SKY),
        box(canvas=inst, pos=vector(0, -200, 0), size=vector(CW, 400, 1), color=GND),
        box(canvas=inst, pos=vector(0,    0, 2), size=vector(CW,   3, 1), color=color.white),
    ]
    for d in (10, 20, 30):                  # pitch-ladder rungs at +/- d degrees
        for s in (1, -1):
            half = 26 if d % 20 == 0 else 16
            parts.append(box(canvas=inst, pos=vector(0, s * d * SCALE_PITCH, 2),
                             size=vector(half * 2, 2, 1), color=color.white))
    parts.append(cone(canvas=inst, pos=vector(0, 108, 3), axis=vector(0, -12, 0),
                      radius=7, color=color.yellow))          # bank pointer on the card
    adi = compound(parts, canvas=inst)
    # A compound's pos is its bounding-box centre, which is NOT the origin the
    # parts were laid out around (the cone's radius pushes it off in z).  Anchor
    # every later move to wherever it actually started.
    adi_home = vector(adi.pos)

    # fixed elements (do not move with attitude)
    box(canvas=inst, pos=vector(-40, 0, 5), size=vector(40, 4, 1), color=color.yellow)
    box(canvas=inst, pos=vector( 40, 0, 5), size=vector(40, 4, 1), color=color.yellow)
    box(canvas=inst, pos=vector(  0, 0, 5), size=vector(6, 6, 1),  color=color.yellow)
    ring(canvas=inst, pos=vector(0, 0, 4), axis=vector(0, 0, 1),
         radius=120, thickness=4, color=color.gray(0.5))
    for ang in (-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60):
        a = math.radians(ang)
        sphere(canvas=inst, pos=vector(120 * math.sin(a), 120 * math.cos(a), 5),
               radius=(3 if ang % 30 == 0 else 2), color=color.white)

    scene.select()                          # restore default canvas
    return plane, adi, adi_home, hud


def rot_matrix(roll, pitch, yaw):
    """Body->world rotation from aerospace-style Euler angles (radians)."""
    cr, sr = math.cos(roll),  math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw),   math.sin(yaw)
    Rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])   # roll  about nose (x)
    Rz = np.array([[cp, -sp, 0], [sp, cp, 0], [0, 0, 1]])   # pitch about wing (z)
    # Aviation sign conventions are defined with the vertical axis pointing
    # DOWN, so a positive (nose-right) yaw is a right-hand rotation about -y
    # here, not +y.  Using +y would bank and pitch correctly but turn the model
    # the wrong way.
    Ry = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])   # yaw   about up   (y)
    return Ry @ Rz @ Rx


def adi_transform(roll_deg, pitch_deg, home):
    """Axis, up and pos that put the horizon card at this roll/pitch."""
    r = math.radians(-roll_deg)   # flip sign if the horizon tilts the wrong way
    axis = vector(math.cos(r), math.sin(r), 0)
    up = vector(-math.sin(r), math.cos(r), 0)
    off = -pitch_deg * SCALE_PITCH  # flip sign if pitch moves the wrong way
    pos = home + vector(-off * math.sin(r), off * math.cos(r), 0)
    return axis, up, pos


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="MPU-6050 aircraft attitude visualizer")
    ap.add_argument("--port", help="serial port (auto-detected if omitted)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--sim", action="store_true",
                    help="run without hardware using synthetic motion")
    ap.add_argument("--list-ports", action="store_true",
                    help="list serial ports and exit")
    args = ap.parse_args()

    if args.list_ports:
        try:
            from serial.tools import list_ports
        except ImportError:
            sys.exit("pyserial is not installed.  pip install pyserial")
        found = list(list_ports.comports())
        if not found:
            print("No serial ports detected.")
        for p in found:
            print(f"{p.device:22} {p.description}")
        return

    plane, adi, adi_home, hud = build_scene()
    src = SimSource() if args.sim else SerialSource(args.port, args.baud)
    print(f"Source: {src.name}")

    state = {"raw_yaw": 0.0, "yaw_offset": 0.0, "running": True,
             "roll": 0.0, "pitch": 0.0, "yaw": 0.0}

    def update_hud():
        hud.text = ("<pre>"
                    f"roll  {state['roll']:+7.1f}&deg;\n"
                    f"pitch {state['pitch']:+7.1f}&deg;\n"
                    f"yaw   {state['yaw']:+7.1f}&deg;   "
                    f"(offset {state['yaw_offset']:+.1f}&deg;)"
                    "</pre>")

    def zero_yaw():
        state["yaw_offset"] = state["raw_yaw"]
        update_hud()
        print(f"yaw zeroed (offset {state['yaw_offset']:.1f} deg)")

    def on_key(evt):
        key = (evt.key or "").lower()
        if key == "z":
            zero_yaw()
        elif key == "q":
            state["running"] = False

    scene.bind("keydown", on_key)

    def stdin_listener():
        for line in sys.stdin:
            cmd = line.strip().lower()
            if cmd in ("", "z"):
                zero_yaw()
            elif cmd in ("q", "quit", "exit"):
                state["running"] = False
                break

    if sys.stdin and sys.stdin.isatty():
        threading.Thread(target=stdin_listener, daemon=True).start()
        print("Streaming. Terminal: Enter or 'z' to zero yaw, 'q' to quit.")
    else:
        # No console to read from (launched from an IDE/pythonw): the canvas
        # keybindings are the only controls, so say so rather than silently
        # starting a listener thread that returns immediately.
        print("Streaming. No interactive terminal: use Z / Q on the canvas.")

    frame = 0
    try:
        while state["running"]:
            rate(100)
            try:
                sample = src.read()
            except SourceLost as exc:
                print(f"Lost the serial connection: {exc}")
                break
            if sample is None:
                continue
            roll, pitch, raw_yaw = sample

            state["raw_yaw"] = raw_yaw
            yaw = wrap180(raw_yaw - state["yaw_offset"])
            state["roll"], state["pitch"], state["yaw"] = roll, pitch, yaw

            # ----- 3D model -----
            R = rot_matrix(math.radians(roll), math.radians(pitch), math.radians(yaw))
            plane.axis = vector(*(R @ [1, 0, 0]))
            plane.up = vector(*(R @ [0, 1, 0]))

            # ----- artificial horizon: roll the card by -roll, slide by -pitch -----
            adi.axis, adi.up, adi.pos = adi_transform(roll, pitch, adi_home)

            frame += 1
            if frame % 5 == 0:
                update_hud()
    except KeyboardInterrupt:
        pass
    finally:
        src.close()
        print("stopped")
        sys.stdout.flush()
        # VPython's HTTP and websocket server threads are only daemonic on
        # Windows (no_notebook.makeDaemonic), so off Windows returning from
        # main() leaves the process hanging forever instead of quitting.
        os._exit(0)


if __name__ == "__main__":
    main()
