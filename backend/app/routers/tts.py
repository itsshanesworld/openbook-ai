"""Local text-to-speech API routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session
from starlette.concurrency import run_in_threadpool

from app.database import get_session
from app.models import NarrationSection
from app.schemas import TtsPreviewRequest
from app.tts_service import (
    TtsUnavailableError,
    get_tts_status,
    prepare_preview_text,
    synthesize_wav_preview,
)

router = APIRouter(tags=["Text to speech"])
DatabaseSession = Annotated[Session, Depends(get_session)]


@router.get("/tts/status")
def tts_status() -> dict[str, object]:
    """Return local speech engine availability."""
    return get_tts_status()


@router.post("/tts/voice-preview")
async def generate_voice_audio_preview(
    preview: TtsPreviewRequest,
) -> Response:
    """Generate an in-memory WAV sample for one narrator."""
    source_text = (
        preview.text
        if preview.text is not None
        else (
            "Welcome to OpenBook AI. "
            "This is a preview of the selected narrator voice."
        )
    )

    try:
        preview_text, was_truncated = prepare_preview_text(
            source_text
        )

        audio_bytes = await run_in_threadpool(
            synthesize_wav_preview,
            preview_text,
            preview.speed,
            preview.voice,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error
    except TtsUnavailableError as error:
        raise HTTPException(
            status_code=503,
            detail=str(error),
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Speech generation failed: {error}",
        ) from error

    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": (
                'inline; filename="narrator-preview.wav"'
            ),
            "X-OpenBook-Preview-Truncated": str(
                was_truncated
            ).lower(),
            "X-OpenBook-Preview-Characters": str(
                len(preview_text)
            ),
        },
    )


@router.post("/sections/{section_id}/audio-preview")
async def generate_section_audio_preview(
    section_id: int,
    preview: TtsPreviewRequest,
    session: DatabaseSession,
) -> Response:
    """Generate a temporary WAV preview for a narration section."""
    section = session.get(NarrationSection, section_id)

    if section is None:
        raise HTTPException(
            status_code=404,
            detail="Narration section not found.",
        )

    source_text = (
        preview.text
        if preview.text is not None
        else section.text
    )

    try:
        preview_text, was_truncated = prepare_preview_text(
            source_text
        )

        audio_bytes = await run_in_threadpool(
            synthesize_wav_preview,
            preview_text,
            preview.speed,
            preview.voice,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error
    except TtsUnavailableError as error:
        raise HTTPException(
            status_code=503,
            detail=str(error),
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Speech generation failed: {error}",
        ) from error

    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": (
                f'inline; filename="section-{section_id}-preview.wav"'
            ),
            "X-OpenBook-Preview-Truncated": str(
                was_truncated
            ).lower(),
            "X-OpenBook-Preview-Characters": str(
                len(preview_text)
            ),
        },
    )
