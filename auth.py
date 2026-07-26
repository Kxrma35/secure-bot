"""JWT-style token generation and verification for the dashboard.

Credentials and the signing key come from environment variables;
see .env.example. The app refuses to start without them.
"""

import base64
import hashlib
import hmac
import json
import time

from config import SECRET_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, TOKEN_TTL


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _sign(header: str, payload: str) -> str:
    return _b64(hmac.new(
        SECRET_KEY.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest())


def generate_token(username: str) -> str:
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64(json.dumps({"sub": username, "exp": time.time() + TOKEN_TTL}).encode())
    return f"{header}.{payload}.{_sign(header, payload)}"


def verify_token(token: str) -> bool:
    try:
        header, payload, sig = token.split(".")
        if not hmac.compare_digest(sig, _sign(header, payload)):
            return False
        data = json.loads(base64.urlsafe_b64decode(payload + "=="))
        return data["exp"] > time.time()
    except Exception:
        return False


def check_credentials(username: str, password: str) -> bool:
    user_ok = hmac.compare_digest(username.encode(), ADMIN_USERNAME.encode())
    pass_ok = hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode())
    return user_ok and pass_ok
