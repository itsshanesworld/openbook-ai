"""Client for OpenBook's isolated local Kokoro narration worker."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


KOKORO_VOICE_PREFIX = "kokoro:"
KOKORO_DEFAULT_VOICE_ID = (
    f"{KOKORO_VOICE_PREFIX}af_heart"
)

KOKORO_WORKER_URL = os.getenv(
    "OPENBOOK_KOKORO_URL",
    "http://127.0.0.1:8001",
).rstrip("/")


def _read_timeout(
    environment_name: str,
    default: float,
) -> float:
    """Return a positive timeout from an optional environment variable."""
    raw_value = os.getenv(
        environment_name
    )

    if raw_value is None:
        return default

    try:
        value = float(
            raw_value
        )
    except ValueError:
        return default

    return (
        value
        if value > 0
        else default
    )


KOKORO_HEALTH_TIMEOUT_SECONDS = _read_timeout(
    "OPENBOOK_KOKORO_HEALTH_TIMEOUT",
    0.75,
)

KOKORO_SYNTHESIS_TIMEOUT_SECONDS = _read_timeout(
    "OPENBOOK_KOKORO_SYNTHESIS_TIMEOUT",
    600.0,
)


@dataclass(
    frozen=True,
    slots=True,
)
class KokoroVoiceSpec:
    """One curated Kokoro narrator exposed by OpenBook."""

    raw_id: str
    name: str
    group: str
    featured: bool

    @property
    def id(self) -> str:
        """Return the stable OpenBook voice identifier."""
        return (
            f"{KOKORO_VOICE_PREFIX}"
            f"{self.raw_id}"
        )


KOKORO_VOICE_SPECS = (
    KokoroVoiceSpec(
        raw_id="af_heart",
        name="Heart",
        group="featured",
        featured=True,
    ),
    KokoroVoiceSpec(
        raw_id="af_bella",
        name="Bella",
        group="featured",
        featured=True,
    ),
    KokoroVoiceSpec(
        raw_id="am_michael",
        name="Michael",
        group="featured",
        featured=True,
    ),
    KokoroVoiceSpec(
        raw_id="af_sarah",
        name="Sarah",
        group="more",
        featured=False,
    ),
    KokoroVoiceSpec(
        raw_id="bf_emma",
        name="Emma",
        group="more",
        featured=False,
    ),
    KokoroVoiceSpec(
        raw_id="bm_george",
        name="George",
        group="more",
        featured=False,
    ),
)

_KOKORO_VOICES_BY_ID = {
    voice.id: voice
    for voice in KOKORO_VOICE_SPECS
}


class KokoroClientError(RuntimeError):
    """Raised when the isolated Kokoro worker cannot fulfill a request."""


def is_kokoro_voice_id(
    voice_id: str,
) -> bool:
    """Return whether an identifier belongs to the Kokoro namespace."""
    return voice_id.startswith(
        KOKORO_VOICE_PREFIX
    )


def is_supported_kokoro_voice_id(
    voice_id: str,
) -> bool:
    """Return whether OpenBook exposes this Kokoro narrator."""
    return (
        voice_id
        in _KOKORO_VOICES_BY_ID
    )


def get_kokoro_voice_display_name(
    voice_id: str,
) -> str:
    """Return a readable narrator label for metadata."""
    voice = _KOKORO_VOICES_BY_ID.get(
        voice_id
    )

    if voice is None:
        return voice_id

    return (
        f"{voice.name} (Kokoro)"
    )


def get_kokoro_health() -> dict[str, Any] | None:
    """Return validated worker health data when Kokoro is online."""
    request = Request(
        f"{KOKORO_WORKER_URL}/health",
        method="GET",
    )

    try:
        with urlopen(
            request,
            timeout=KOKORO_HEALTH_TIMEOUT_SECONDS,
        ) as response:
            payload = json.loads(
                response.read().decode(
                    "utf-8"
                )
            )
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        return None

    if not isinstance(
        payload,
        dict,
    ):
        return None

    if payload.get(
        "status"
    ) != "online":
        return None

    voices = payload.get(
        "voices"
    )

    if not isinstance(
        voices,
        list,
    ):
        return None

    if not all(
        isinstance(
            voice,
            str,
        )
        for voice in voices
    ):
        return None

    return payload


def is_kokoro_voice_available(
    voice_id: str,
) -> bool:
    """Return whether one curated Kokoro voice is currently usable."""
    voice = _KOKORO_VOICES_BY_ID.get(
        voice_id
    )

    if voice is None:
        return False

    health = get_kokoro_health()

    if health is None:
        return False

    available_voices = health.get(
        "voices",
        [],
    )

    return (
        voice.raw_id
        in available_voices
    )


def list_available_kokoro_voices() -> list[dict[str, object]]:
    """Return curated Kokoro voices reported by the live worker."""
    health = get_kokoro_health()

    if health is None:
        return []

    available_voice_ids = set(
        health.get(
            "voices",
            [],
        )
    )

    return [
        {
            "id": voice.id,
            "name": voice.name,
            "engine": "Kokoro",
            "group": voice.group,
            "featured": voice.featured,
        }
        for voice in KOKORO_VOICE_SPECS
        if voice.raw_id
        in available_voice_ids
    ]


def synthesize_kokoro_wav(
    text: str,
    speed: float,
    voice_id: str,
) -> bytes:
    """Request uncompressed WAV narration from the local worker."""
    voice = _KOKORO_VOICES_BY_ID.get(
        voice_id
    )

    if voice is None:
        raise KokoroClientError(
            "The selected Kokoro narrator is not supported."
        )

    body = json.dumps(
        {
            "text": text,
            "voice": voice.raw_id,
            "speed": speed,
        }
    ).encode(
        "utf-8"
    )

    request = Request(
        f"{KOKORO_WORKER_URL}/synthesize",
        data=body,
        headers={
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(
            request,
            timeout=KOKORO_SYNTHESIS_TIMEOUT_SECONDS,
        ) as response:
            audio_bytes = (
                response.read()
            )
    except HTTPError as error:
        raise KokoroClientError(
            _get_http_error_detail(
                error
            )
        ) from error
    except (
        URLError,
        TimeoutError,
        OSError,
    ) as error:
        raise KokoroClientError(
            "The Kokoro narration worker could not be reached."
        ) from error

    if not audio_bytes.startswith(
        b"RIFF"
    ):
        raise KokoroClientError(
            "Kokoro returned an invalid WAV response."
        )

    return audio_bytes


def _get_http_error_detail(
    error: HTTPError,
) -> str:
    """Extract a worker error message without leaking response internals."""
    try:
        payload = json.loads(
            error.read().decode(
                "utf-8"
            )
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        payload = None

    if isinstance(
        payload,
        dict,
    ):
        detail = payload.get(
            "detail"
        )

        if (
            isinstance(
                detail,
                str,
            )
            and detail.strip()
        ):
            return detail.strip()

    return (
        "The Kokoro narration worker "
        f"returned HTTP {error.code}."
    )
