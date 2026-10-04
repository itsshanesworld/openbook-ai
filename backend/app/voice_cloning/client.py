"""Client for OpenBook's isolated local voice-cloning worker."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


CLONE_WORKER_URL = os.getenv(
    "OPENBOOK_VOICE_CLONE_URL",
    "http://127.0.0.1:8002",
).rstrip("/")


def _read_timeout(
    environment_name: str,
    default: float,
) -> float:
    """Return a positive timeout from an optional environment variable."""
    raw_value = os.getenv(environment_name)

    if raw_value is None:
        return default

    try:
        value = float(raw_value)
    except ValueError:
        return default

    return value if value > 0 else default


CLONE_HEALTH_TIMEOUT_SECONDS = _read_timeout(
    "OPENBOOK_VOICE_CLONE_HEALTH_TIMEOUT",
    0.75,
)

# The first call loads the model; allow for a slow CPU.
CLONE_REQUEST_TIMEOUT_SECONDS = _read_timeout(
    "OPENBOOK_VOICE_CLONE_TIMEOUT",
    600.0,
)


class VoiceCloneClientError(RuntimeError):
    """Raised when the voice-cloning worker cannot fulfil a request."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_clone_worker_online() -> bool:
    """Return whether the cloning worker is up with its engine installed."""
    request = Request(
        f"{CLONE_WORKER_URL}/health",
        method="GET",
    )

    try:
        with urlopen(
            request,
            timeout=CLONE_HEALTH_TIMEOUT_SECONDS,
        ) as response:
            payload = json.loads(
                response.read().decode("utf-8")
            )
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        return False

    return (
        isinstance(payload, dict)
        and payload.get("status") == "online"
    )


def register_voice_clone(clone_id: str) -> dict[str, Any]:
    """Ask the worker to prepare a clone from its stored sample."""
    request = Request(
        f"{CLONE_WORKER_URL}/register?"
        + urlencode({"clone_id": clone_id}),
        data=b"",
        method="POST",
    )

    body = _send(request)

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VoiceCloneClientError(
            "The voice cloning worker returned an invalid response."
        ) from error

    if not isinstance(payload, dict):
        raise VoiceCloneClientError(
            "The voice cloning worker returned an invalid response."
        )

    return payload


def convert_to_clone_voice(
    clone_id: str,
    wav_bytes: bytes,
) -> bytes:
    """Convert narration audio into a clone's voice."""
    request = Request(
        f"{CLONE_WORKER_URL}/convert?"
        + urlencode({"clone_id": clone_id}),
        data=wav_bytes,
        headers={"Content-Type": "audio/wav"},
        method="POST",
    )

    audio_bytes = _send(request)

    if not audio_bytes.startswith(b"RIFF"):
        raise VoiceCloneClientError(
            "The voice cloning worker returned invalid audio."
        )

    return audio_bytes


def _send(request: Request) -> bytes:
    """Send one request and return the response body."""
    try:
        with urlopen(
            request,
            timeout=CLONE_REQUEST_TIMEOUT_SECONDS,
        ) as response:
            return response.read()
    except HTTPError as error:
        raise VoiceCloneClientError(
            _get_http_error_detail(error),
            status_code=error.code,
        ) from error
    except (
        URLError,
        TimeoutError,
        OSError,
    ) as error:
        raise VoiceCloneClientError(
            "The voice cloning worker could not be reached."
        ) from error


def _get_http_error_detail(error: HTTPError) -> str:
    """Extract a worker error message without leaking internals."""
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None

    if isinstance(payload, dict):
        detail = payload.get("detail")

        if isinstance(detail, str) and detail.strip():
            return detail.strip()

    return (
        "The voice cloning worker "
        f"returned HTTP {error.code}."
    )
