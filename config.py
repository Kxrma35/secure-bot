"""Central configuration loaded from environment variables.

Copy .env.example to .env and adjust values before running.
"""

import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

MQTT_HOST = os.environ.get("SECUREBOT_MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("SECUREBOT_MQTT_PORT", "1883"))
MQTT_TOPIC = os.environ.get("SECUREBOT_MQTT_TOPIC", "securebot/telemetry")

DB_PATH = "sqlite:///" + os.path.expanduser(
    os.environ.get("SECUREBOT_DB_FILE", "~/securebot.db")
)

SERIAL_PORT = os.environ.get("SECUREBOT_SERIAL_PORT", "/dev/ttyACM0")
BAUD_RATE = int(os.environ.get("SECUREBOT_BAUD_RATE", "115200"))

DASHBOARD_HOST = os.environ.get("SECUREBOT_DASHBOARD_HOST", "0.0.0.0")
DASHBOARD_PORT = int(os.environ.get("SECUREBOT_DASHBOARD_PORT", "5000"))

SECRET_KEY = os.environ.get("SECUREBOT_SECRET_KEY", "")
ADMIN_USERNAME = os.environ.get("SECUREBOT_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("SECUREBOT_ADMIN_PASSWORD", "")
TOKEN_TTL = int(os.environ.get("SECUREBOT_TOKEN_TTL", "3600"))


def require_auth_config():
    """Exit with a clear message if auth secrets are not configured."""
    missing = []
    if not SECRET_KEY:
        missing.append("SECUREBOT_SECRET_KEY")
    if not ADMIN_PASSWORD:
        missing.append("SECUREBOT_ADMIN_PASSWORD")
    if missing:
        raise SystemExit(
            "Missing required environment variables: "
            + ", ".join(missing)
            + ". Copy .env.example to .env and set them."
        )
