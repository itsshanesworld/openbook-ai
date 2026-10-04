"""Local/private voice cloning API."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.kokoro_client import (
    KOKORO_DEFAULT_VOICE_ID,
    is_supported_kokoro_voice_id,
)
from app.voice_cloning.client import (
    VoiceCloneClientError,
    is_clone_worker_online,
    register_voice_clone,
)
from app.voice_cloning.service import (
    VOICE_CLONE_DIRECTORY,
    VoiceClone,
    create_voice_clone,
    delete_voice_clone,
    list_voice_clones,
    read_voice_clone,
    set_clone_sample,
)


router = APIRouter(
    prefix="/voice-clones",
    tags=["voice-clones"],
)

ALLOWED_AUDIO_EXTENSIONS = {
    ".wav",
    ".mp3",
    ".m4a",
    ".flac",
    ".ogg",
}

MAX_SAMPLE_BYTES = 25 * 1024 * 1024


def _describe(clone: VoiceClone) -> dict[str, object]:
    """Return the public description of one clone."""
    return {
        "id": clone.id,
        "voice_id": clone.voice_id,
        "name": clone.name,
        "base_voice": clone.base_voice,
        "ready": clone.ready,
        "consent_at": clone.consent_at,
        "model_path": clone.model_path,
    }


@router.get("")
def get_voice_clones():
    """List locally stored voice clones."""
    return {
        "engine_online": is_clone_worker_online(),
        "voice_clones": [
            _describe(clone)
            for clone in list_voice_clones()
        ],
    }


@router.post("")
async def upload_voice_sample(
    name: str = Form(...),
    consent: bool = Form(False),
    base_voice: str = Form(KOKORO_DEFAULT_VOICE_ID),
    sample: UploadFile = File(...),
):
    """Store a voice sample and prepare a local voice clone."""
    if not consent:
        raise HTTPException(
            status_code=400,
            detail=(
                "Please confirm the recording is your own "
                "voice, or that you have the speaker's "
                "permission."
            ),
        )

    if not is_supported_kokoro_voice_id(base_voice):
        raise HTTPException(
            status_code=400,
            detail="Unsupported base narrator.",
        )

    extension = Path(
        sample.filename or ""
    ).suffix.lower()

    if extension not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported audio format. "
                "Use WAV, MP3, M4A, FLAC, or OGG."
            ),
        )

    clone = None

    try:
        try:
            clone = create_voice_clone(
                name,
                base_voice=base_voice,
                consent=consent,
            )
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail=str(error),
            ) from error

        sample_path = (
            VOICE_CLONE_DIRECTORY
            / clone.id
            / f"sample{extension}"
        )

        total_bytes = 0

        with sample_path.open("wb") as output:
            while True:
                chunk = await sample.read(1024 * 1024)

                if not chunk:
                    break

                total_bytes += len(chunk)

                if total_bytes > MAX_SAMPLE_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "Voice sample is too large. "
                            "Maximum size is 25 MB."
                        ),
                    )

                output.write(chunk)

        clone = set_clone_sample(
            clone.id,
            sample_path.name,
        )

        warning = None

        try:
            register_voice_clone(clone.id)
        except VoiceCloneClientError as error:
            if error.status_code == 422:
                # The sample itself is unusable (too short, not
                # audio, ...). Don't keep a clone that can't work.
                raise HTTPException(
                    status_code=422,
                    detail=str(error),
                ) from error

            warning = (
                "Your recording was saved, but the voice "
                "could not be prepared yet: "
                f"{error}"
            )

        clone = read_voice_clone(clone.id)

        return {
            **_describe(clone),
            "sample_path": sample_path.name,
            "status": (
                "ready"
                if clone.ready
                else "sample_uploaded"
            ),
            "warning": warning,
        }

    except HTTPException:
        if clone is not None:
            shutil.rmtree(
                VOICE_CLONE_DIRECTORY / clone.id,
                ignore_errors=True,
            )
        raise

    except Exception as error:
        if clone is not None:
            shutil.rmtree(
                VOICE_CLONE_DIRECTORY / clone.id,
                ignore_errors=True,
            )

        raise HTTPException(
            status_code=500,
            detail=f"Could not save voice sample: {error}",
        ) from error

    finally:
        await sample.close()


@router.post("/{clone_id}/prepare")
def prepare_voice_clone(
    clone_id: str,
):
    """Prepare (or re-prepare) a stored clone, e.g. after the worker was offline."""
    try:
        clone = read_voice_clone(clone_id)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    try:
        register_voice_clone(clone.id)
    except VoiceCloneClientError as error:
        raise HTTPException(
            status_code=(
                422
                if error.status_code == 422
                else 503
            ),
            detail=str(error),
        ) from error

    return _describe(read_voice_clone(clone.id))


@router.delete("/{clone_id}")
def remove_voice_clone(
    clone_id: str,
):
    """Delete one local voice clone."""
    try:
        delete_voice_clone(clone_id)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    return {
        "status": "deleted",
        "id": clone_id,
    }
