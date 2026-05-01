

import hashlib
import json
import sys
import os
from datetime import datetime

HASH_STORE = os.path.expanduser("~/firmware_hashes.json")


def hash_file(path: str) -> str:
    """Return SHA-256 hex digest of a file."""
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha.update(chunk)
    return sha.hexdigest()


def load_store() -> dict:
    if os.path.exists(HASH_STORE):
        with open(HASH_STORE) as f:
            return json.load(f)
    return {}


def save_store(store: dict):
    with open(HASH_STORE, "w") as f:
        json.dump(store, f, indent=2)


def generate(path: str):
    if not os.path.exists(path):
        print(f"[firmware] ERROR: File not found: {path}")
        sys.exit(1)

    digest = hash_file(path)
    store  = load_store()
    store[os.path.basename(path)] = {
        "hash":      digest,
        "generated": datetime.utcnow().isoformat(),
        "path":      os.path.abspath(path),
    }
    save_store(store)
    print(f"[firmware] Hash generated and stored:")
    print(f"           File : {path}")
    print(f"           SHA256: {digest}")
    print(f"           Stored in: {HASH_STORE}")


def verify(path: str):
    if not os.path.exists(path):
        print(f"[firmware] ERROR: File not found: {path}")
        sys.exit(1)

    store = load_store()
    name  = os.path.basename(path)

    if name not in store:
        print(f"[firmware] ERROR: No stored hash for '{name}'.")
        print(f"           Run: python firmware_check.py generate {path}")
        sys.exit(1)

    expected = store[name]["hash"]
    actual   = hash_file(path)

    if actual == expected:
        print(f"[firmware] ✓ INTEGRITY OK — {name}")
        print(f"           SHA256: {actual}")
    else:
        print(f"[firmware] ✗ INTEGRITY FAIL — {name} has been MODIFIED")
        print(f"           Expected: {expected}")
        print(f"           Got:      {actual}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python firmware_check.py [generate|verify] <file>")
        sys.exit(1)

    cmd  = sys.argv[1]
    path = sys.argv[2]

    if cmd == "generate":
        generate(path)
    elif cmd == "verify":
        verify(path)
    else:
        print(f"Unknown command: {cmd}. Use 'generate' or 'verify'.")
        sys.exit(1)
