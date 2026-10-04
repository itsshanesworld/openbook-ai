"""Local/private voice clone storage and metadata."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


VOICE_CLONE_DIRECTORY = (
    Path(__file__).resolve().parents[2]
    / "data"
    / "voice_clones"
)

CLONE_VOICE_PREFIX = "clone:"
CLONE_ENGINE_NAME = "openvoice-v2"
EMBEDDING_FILE_NAME = "speaker_embedding.pt"

DEFAULT_BASE_VOICE = "kokoro:af_heart"

_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$")
_CLONE_ID_PATTERN = re.compile(r"^clone-[0-9a-f]{32}$")


@dataclass(frozen=True)
class VoiceClone:
    id: str
    name: str
    model_path: str
    sample_path: str | None = None
    base_voice: str = DEFAULT_BASE_VOICE
    consent_at: str | None = None

    @property
    def voice_id(self) -> str:
        """Return the narrator identifier used by OpenBook."""
        return f"{CLONE_VOICE_PREFIX}{self.id}"

    @property
    def ready(self) -> bool:
        """Return whether the clone's voice has been prepared."""
        return (
            _clone_directory(self.id)
            / EMBEDDING_FILE_NAME
        ).is_file()


def is_clone_voice_id(voice_id: str) -> bool:
    """Return whether an identifier belongs to the clone namespace."""
    return voice_id.startswith(CLONE_VOICE_PREFIX)


def clone_id_from_voice_id(voice_id: str) -> str:
    """Return the clone ID inside a narrator identifier."""
    clone_id = voice_id[len(CLONE_VOICE_PREFIX):]

    if not _CLONE_ID_PATTERN.fullmatch(clone_id):
        raise ValueError("Invalid voice clone ID.")

    return clone_id


def _clone_directory(clone_id: str) -> Path:
    if not _CLONE_ID_PATTERN.fullmatch(clone_id or ""):
        raise ValueError("Invalid voice clone ID.")

    return VOICE_CLONE_DIRECTORY / clone_id


def _metadata_path(clone_id: str) -> Path:
    return _clone_directory(clone_id) / "metadata.json"


def read_voice_clone(clone_id: str) -> VoiceClone:
    """Return one stored clone or raise FileNotFoundError."""
    metadata_path = _metadata_path(clone_id)

    if not metadata_path.is_file():
        raise FileNotFoundError(
            f"Voice clone not found: {clone_id}"
        )

    data = json.loads(
        metadata_path.read_text(encoding="utf-8")
    )

    return VoiceClone(
        id=str(data["id"]),
        name=str(data["name"]),
        model_path=str(data.get("model_path", "")),
        sample_path=(
            str(data["sample_path"])
            if data.get("sample_path")
            else None
        ),
        base_voice=str(
            data.get("base_voice") or DEFAULT_BASE_VOICE
        ),
        consent_at=(
            str(data["consent_at"])
            if data.get("consent_at")
            else None
        ),
    )


def list_voice_clones() -> list[VoiceClone]:
    """Return all locally stored voice clones."""
    if not VOICE_CLONE_DIRECTORY.is_dir():
        return []

    clones: list[VoiceClone] = []

    for directory in sorted(
        VOICE_CLONE_DIRECTORY.iterdir()
    ):
        if not directory.is_dir():
            continue

        try:
            clones.append(
                read_voice_clone(directory.name)
            )
        except (
            OSError,
            KeyError,
            TypeError,
            ValueError,
            FileNotFoundError,
            json.JSONDecodeError,
        ):
            continue

    return clones


def create_voice_clone(
    name: str,
    *,
    sample_path: str | None = None,
    model_path: str = "",
    base_voice: str = DEFAULT_BASE_VOICE,
    consent: bool = False,
) -> VoiceClone:
    """Create local metadata for a voice clone.

    A clone can only be created with explicit confirmation that the
    sample is the user's own voice (or that they have permission).
    """
    if not consent:
        raise ValueError(
            "Voice cloning requires confirmation that the "
            "recording is your own voice or that you have "
            "the speaker's permission."
        )

    cleaned_name = " ".join(name.split()).strip()

    if not _NAME_PATTERN.fullmatch(cleaned_name):
        raise ValueError(
            "Voice clone name must be 1-64 characters "
            "using letters, numbers, spaces, hyphens, "
            "or underscores."
        )

    VOICE_CLONE_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    clone_id = f"clone-{uuid.uuid4().hex}"

    clone_directory = _clone_directory(clone_id)
    clone_directory.mkdir()

    consent_at = datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    )

    metadata = {
        "id": clone_id,
        "name": cleaned_name,
        "model_path": model_path or CLONE_ENGINE_NAME,
        "sample_path": sample_path,
        "base_voice": base_voice,
        "consent_at": consent_at,
    }

    _write_metadata(clone_id, metadata)

    return read_voice_clone(clone_id)


def _write_metadata(
    clone_id: str,
    metadata: dict[str, object],
) -> None:
    """Write metadata atomically so a crash cannot corrupt it."""
    metadata_path = _metadata_path(clone_id)
    temporary_path = metadata_path.with_suffix(".tmp")

    temporary_path.write_text(
        json.dumps(metadata, indent=2),
        encoding="utf-8",
    )
    temporary_path.replace(metadata_path)


def set_clone_sample(
    clone_id: str,
    sample_file_name: str,
) -> VoiceClone:
    """Record the stored sample file name for a clone."""
    if Path(sample_file_name).name != sample_file_name:
        raise ValueError("Invalid sample file name.")

    metadata_path = _metadata_path(clone_id)

    metadata = json.loads(
        metadata_path.read_text(encoding="utf-8")
    )
    metadata["sample_path"] = sample_file_name

    _write_metadata(clone_id, metadata)

    return read_voice_clone(clone_id)


def delete_voice_clone(
    clone_id: str,
) -> None:
    """Delete one local voice clone and its files."""
    clone_directory = _clone_directory(clone_id)

    if not clone_directory.is_dir():
        raise FileNotFoundError(
            f"Voice clone not found: {clone_id}"
        )

    shutil.rmtree(clone_directory)
