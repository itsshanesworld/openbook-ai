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

VOICE_NAME = os.getenv(
    "OPENBOOK_PIPER_VOICE",
    "en_US-lessac-medium",
)

MODEL_PATH = VOICE_DIRECTORY / f"{VOICE_NAME}.onnx"
CONFIG_PATH = VOICE_DIRECTORY / f"{VOICE_NAME}.onnx.json"

MAX_PREVIEW_CHARACTERS = 1_800

_voice: PiperVoice | None = None
_voice_lock = threading.RLock()


class TtsUnavailableError(RuntimeError):
    """Raised when the local Piper engine is unavailable."""


def get_tts_status() -> dict[str, object]:
    """Return the local TTS installation status."""
    model_installed = MODEL_PATH.is_file()
    config_installed = CONFIG_PATH.is_file()

    return {
        "available": model_installed and config_installed,
        "engine": "Piper",
        "voice": VOICE_NAME,
        "model_installed": model_installed,
        "config_installed": config_installed,
        "max_preview_characters": MAX_PREVIEW_CHARACTERS,
    }


def prepare_preview_text(text: str) -> tuple[str, bool]:
    """Normalize and shorten text for a quick preview."""
    cleaned_text = normalize_speech_text(text)

    if len(cleaned_text) <= MAX_PREVIEW_CHARACTERS:
        return cleaned_text, False

    shortened_text = cleaned_text[:MAX_PREVIEW_CHARACTERS]
    final_space = shortened_text.rfind(" ")

    if final_space > MAX_PREVIEW_CHARACTERS // 2:
        shortened_text = shortened_text[:final_space]

    return shortened_text.strip(), True


def synthesize_wav_preview(
    text: str,
    speed: float,
) -> bytes:
    """Generate a size-limited WAV preview."""
    preview_text, _ = prepare_preview_text(text)
    return synthesize_wav(preview_text, speed)


def synthesize_wav(
    text: str,
    speed: float,
) -> bytes:
    """Generate complete WAV audio in memory."""
    speech_text = normalize_speech_text(text)
    validate_speed(speed)

    synthesis_config = SynthesisConfig(
        length_scale=1.0 / speed,
    )

    with _voice_lock:
        voice = _load_voice()
        audio_buffer = BytesIO()

        with wave.open(audio_buffer, "wb") as wav_file:
            voice.synthesize_wav(
                speech_text,
                wav_file,
                syn_config=synthesis_config,
            )

        audio_bytes = audio_buffer.getvalue()

    if not audio_bytes.startswith(b"RIFF"):
        raise RuntimeError(
            "Piper did not produce a valid WAV file."
        )

    return audio_bytes


def normalize_speech_text(text: str) -> str:
    """Normalize text before speech generation."""
    cleaned_text = " ".join(text.split())

    if not cleaned_text:
        raise ValueError("Speech text cannot be blank.")

    return cleaned_text


def validate_speed(speed: float) -> None:
    """Validate the supported narration speed."""
    if not 0.75 <= speed <= 1.5:
        raise ValueError(
            "Narration speed must be between 0.75 and 1.5."
        )


def _load_voice() -> PiperVoice:
    """Load and cache the configured Piper voice."""
    global _voice

    if _voice is not None:
        return _voice

    if not MODEL_PATH.is_file():
        raise TtsUnavailableError(
            f"Piper model is missing: {MODEL_PATH}"
        )

    if not CONFIG_PATH.is_file():
        raise TtsUnavailableError(
            f"Piper configuration is missing: {CONFIG_PATH}"
        )

    try:
        _voice = PiperVoice.load(str(MODEL_PATH))
    except Exception as error:
        raise TtsUnavailableError(
            f"The Piper voice could not be loaded: {error}"
        ) from error

    return _voice
