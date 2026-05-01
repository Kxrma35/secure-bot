

import time
import hashlib
import hmac
import base64
import json

#  Config CHANGE THESE 
SECRET_KEY = "securebot-super-secret-key-change-me"
USERNAME   = "admin"
PASSWORD   = "securebot123"
TOKEN_TTL  = 3600   # seconds (1 hour)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_token(username: str) -> str:
    """Generate a simple signed JWT-style token."""
    header  = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64(json.dumps({"sub": username, "exp": time.time() + TOKEN_TTL}).encode())
    sig     = _b64(hmac.new(
        SECRET_KEY.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest())
    return f"{header}.{payload}.{sig}"


def verify_token(token: str) -> bool:
    """Return True if token is valid and not expired."""
    try:
        header, payload, sig = token.split(".")
        expected = _b64(hmac.new(
            SECRET_KEY.encode(), f"{header}.{payload}".encode(), hashlib.sha256
        ).digest())
        if not hmac.compare_digest(sig, expected):
            return False
        data = json.loads(base64.urlsafe_b64decode(payload + "=="))
        return data["exp"] > time.time()
    except Exception:
        return False


def check_credentials(username: str, password: str) -> bool:
    return username == USERNAME and password == PASSWORD
