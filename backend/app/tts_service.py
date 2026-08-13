"""Local Piper text-to-speech services."""

from __future__ import annotations

import os
import threading
import wave
from io import BytesIO
from pathlib import Path

from piper import PiperVoice, SynthesisConfig

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
VOICE_DIRECTORY = BACKEND_DIRECTORY / "data" / "voices"

DEFAULT_VOICE_NAME = os.getenv(
    "OPENBOOK_PIPER_VOICE",
    "en_US-lessac-medium",
)

MAX_PREVIEW_CHARACTERS = 1_800

_voices: dict[str, PiperVoice] = {}
_voice_lock = threading.RLock()


class TtsUnavailableError(RuntimeError):
    """Raised when the local Piper engine is unavailable."""


def get_default_voice_name() -> str:
    """Return the configured default Piper voice."""
    return DEFAULT_VOICE_NAME


def list_installed_voices() -> list[dict[str, str]]:
    """Return complete Piper voices installed locally."""
    voices: list[dict[str, str]] = []

    if not VOICE_DIRECTORY.is_dir():
        return voices

    for model_path in sorted(
        VOICE_DIRECTORY.glob("*.onnx")
    ):
        voice_name = model_path.stem
        config_path = (
            VOICE_DIRECTORY
            / f"{voice_name}.onnx.json"
        )

        if not config_path.is_file():
            continue

        voices.append(
            {
                "id": voice_name,
                "name": format_voice_display_name(
                    voice_name
                ),
            }
        )

    return voices


def format_voice_display_name(
    voice_name: str,
) -> str:
    """Create a readable label from a Piper voice identifier."""
    parts = voice_name.split("-")

    if len(parts) >= 3:
        locale = parts[0].replace(
            "_",
            "-",
        )

        speaker = " ".join(
            part.replace(
                "_",
                " ",
            ).title()
            for part in parts[1:-1]
        )

        quality = parts[-1].title()

        return (
            f"{speaker} "
            f"({locale}, {quality})"
        )

    return voice_name.replace(
        "_",
        " ",
    ).replace(
        "-",
        " ",
    ).title()


def get_tts_status(
    voice_name: str | None = None,
) -> dict[str, object]:
    """Return local TTS availability for one voice."""
    resolved_name = (
        voice_name
        or DEFAULT_VOICE_NAME
    ).strip()

    try:
        model_path, config_path = (
            get_voice_paths(
                resolved_name
            )
        )

        model_installed = (
            model_path.is_file()
        )

        config_installed = (
            config_path.is_file()
        )
    except ValueError:
        model_installed = False
        config_installed = False

    return {
        "available": (
            model_installed
            and config_installed
        ),
        "engine": "Piper",
        "voice": resolved_name,
        "default_voice": (
            DEFAULT_VOICE_NAME
        ),
        "model_installed": (
            model_installed
        ),
        "config_installed": (
            config_installed
        ),
        "max_preview_characters": (
            MAX_PREVIEW_CHARACTERS
        ),
    }


def resolve_voice_name(
    voice_name: str | None,
) -> str:
    """Resolve and validate an installed Piper voice."""
    resolved_name = (
        voice_name
        or DEFAULT_VOICE_NAME
    ).strip()

    if not resolved_name:
        resolved_name = (
            DEFAULT_VOICE_NAME
        )

    try:
        model_path, config_path = (
            get_voice_paths(
                resolved_name
            )
        )
    except ValueError as error:
        raise TtsUnavailableError(
            "The selected Piper voice name is invalid."
        ) from error

    if not model_path.is_file():
        raise TtsUnavailableError(
            "The selected Piper voice model "
            f"is not installed: {resolved_name}"
        )

    if not config_path.is_file():
        raise TtsUnavailableError(
            "The selected Piper voice configuration "
            f"is not installed: {resolved_name}"
        )

    return resolved_name


def get_voice_paths(
    voice_name: str,
) -> tuple[Path, Path]:
    """Return safe model and configuration paths for one voice."""
    if (
        not voice_name
        or Path(voice_name).name
        != voice_name
        or voice_name in {".", ".."}
    ):
        raise ValueError(
            "Invalid Piper voice name."
        )

    return (
        VOICE_DIRECTORY
        / f"{voice_name}.onnx",
        VOICE_DIRECTORY
        / f"{voice_name}.onnx.json",
    )


def prepare_preview_text(
    text: str,
) -> tuple[str, bool]:
    """Normalize and shorten text for a quick preview."""
    cleaned_text = normalize_speech_text(
        text
    )

    if (
        len(cleaned_text)
        <= MAX_PREVIEW_CHARACTERS
    ):
        return cleaned_text, False

    shortened_text = cleaned_text[
        :MAX_PREVIEW_CHARACTERS
    ]

    final_space = shortened_text.rfind(
        " "
    )

    if (
        final_space
        > MAX_PREVIEW_CHARACTERS // 2
    ):
        shortened_text = (
            shortened_text[:final_space]
        )

    return (
        shortened_text.strip(),
        True,
    )


def synthesize_wav_preview(
    text: str,
    speed: float,
    voice_name: str | None = None,
) -> bytes:
    """Generate a size-limited WAV preview."""
    preview_text, _ = (
        prepare_preview_text(
            text
        )
    )

    return synthesize_wav(
        preview_text,
        speed,
        voice_name=voice_name,
    )


def synthesize_wav(
    text: str,
    speed: float,
    voice_name: str | None = None,
) -> bytes:
    """Generate complete WAV audio using one Piper voice."""
    speech_text = normalize_speech_text(
        text
    )

    validate_speed(
        speed
    )

    resolved_voice = resolve_voice_name(
        voice_name
    )

    synthesis_config = SynthesisConfig(
        length_scale=1.0 / speed,
    )

    with _voice_lock:
        voice = _load_voice(
            resolved_voice
        )

        audio_buffer = BytesIO()

        with wave.open(
            audio_buffer,
            "wb",
        ) as wav_file:
            voice.synthesize_wav(
                speech_text,
                wav_file,
                syn_config=synthesis_config,
            )

        audio_bytes = (
            audio_buffer.getvalue()
        )

    if not audio_bytes.startswith(
        b"RIFF"
    ):
        raise RuntimeError(
            "Piper did not produce a valid WAV file."
        )

    return audio_bytes


def normalize_speech_text(
    text: str,
) -> str:
    """Normalize text before speech generation."""
    cleaned_text = " ".join(
        text.split()
    )

    if not cleaned_text:
        raise ValueError(
            "Speech text cannot be blank."
        )

    return cleaned_text


def validate_speed(
    speed: float,
) -> None:
    """Validate the supported narration speed."""
    if not 0.75 <= speed <= 1.5:
        raise ValueError(
            "Narration speed must be "
            "between 0.75 and 1.5."
        )


def _load_voice(
    voice_name: str,
) -> PiperVoice:
    """Load and cache one Piper voice."""
    cached_voice = _voices.get(
        voice_name
    )

    if cached_voice is not None:
        return cached_voice

    model_path, _ = get_voice_paths(
        voice_name
    )

    try:
        voice = PiperVoice.load(
            str(model_path)
        )
    except Exception as error:
        raise TtsUnavailableError(
            "The Piper voice could not be loaded: "
            f"{error}"
        ) from error

    _voices[voice_name] = voice

    return voice
