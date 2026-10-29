"""Password hashing and signed access tokens for SukariSol."""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any


PASSWORD_ITERATIONS = 600_000
TOKEN_LIFETIME_SECONDS = 30 * 60
ALLOWED_ROLES = {"admin", "farmer", "organisation"}


class AuthenticationError(ValueError):
    """Raised when credentials or an access token are invalid."""


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _secret() -> bytes:
    value = os.getenv("SUKARISOL_AUTH_SECRET", "")
    if len(value.encode("utf-8")) < 32:
        raise RuntimeError(
            "SUKARISOL_AUTH_SECRET must contain at least 32 bytes."
        )
    return value.encode("utf-8")


def hash_password(password: str) -> str:
    """Hash a password with PBKDF2-HMAC-SHA256 and a random salt."""
    if len(password) < 12:
        raise ValueError("Passwords must contain at least 12 characters.")
    if len(password) > 1024:
        raise ValueError("Password is too long.")

    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        _b64encode(salt),
        _b64encode(digest),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a stored password hash without revealing comparison timing."""
    try:
        algorithm, iterations_text, salt_text, digest_text = (
            stored_hash.split("$")
        )
        if algorithm != "pbkdf2_sha256":
            return False

        iterations = int(iterations_text)
        if not 100_000 <= iterations <= 2_000_000:
            return False

        expected = _b64decode(digest_text)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            _b64decode(salt_text),
            iterations,
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, UnicodeError):
        return False


def create_access_token(
    user_id: int,
    email: str,
    role: str,
) -> str:
    """Create a short-lived HS256-signed access token."""
    if role not in ALLOWED_ROLES:
        raise ValueError("Invalid account role.")

    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": str(user_id),
        "email": email,
        "role": role,
        "iat": now,
        "exp": now + TOKEN_LIFETIME_SECONDS,
    }

    signing_input = (
        _b64encode(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64encode(json.dumps(payload, separators=(",", ":")).encode())
    )
    signature = hmac.new(
        _secret(),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()

    return signing_input + "." + _b64encode(signature)


def verify_access_token(token: str) -> dict[str, Any]:
    """Validate token signature, expiry, and required claims."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise AuthenticationError("Invalid access token.")

        header_part, payload_part, signature_part = parts
        header = json.loads(_b64decode(header_part))
        payload = json.loads(_b64decode(payload_part))

        if header != {"alg": "HS256", "typ": "JWT"}:
            raise AuthenticationError("Invalid access token.")

        signing_input = header_part + "." + payload_part
        expected = hmac.new(
            _secret(),
            signing_input.encode("ascii"),
            hashlib.sha256,
        ).digest()

        if not hmac.compare_digest(
            expected,
            _b64decode(signature_part),
        ):
            raise AuthenticationError("Invalid access token.")

        if int(payload["exp"]) <= int(time.time()):
            raise AuthenticationError("Access token has expired.")

        if payload.get("role") not in ALLOWED_ROLES:
            raise AuthenticationError("Invalid account role.")

        if not str(payload.get("sub", "")).isdigit():
            raise AuthenticationError("Invalid account identifier.")

        if not isinstance(payload.get("email"), str):
            raise AuthenticationError("Invalid account email.")

        return payload

    except AuthenticationError:
        raise
    except (ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError):
        raise AuthenticationError("Invalid access token.") from None
