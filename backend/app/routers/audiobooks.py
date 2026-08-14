"""Audiobook generation API routes."""

from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
)
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.audiobook_service import (
    delete_job_output,
    get_book_sections,
    ensure_available_disk_space,
    run_audiobook_job,
)
from app.cover_service import get_cover_info, get_cover_path
from app.database import get_session
from app.metadata_service import resolve_book_metadata
from app.export_service import (
    ExportError,
    create_mp3_export as build_mp3_export,
    delete_mp3_export,
    get_mp3_export_info,
    require_mp3_export,
)
from app.m4b_service import (
    create_m4b_export as build_m4b_export,
    delete_m4b_export,
    get_chapter_markers,
    get_job_timings,
    get_m4b_export_info,
    require_m4b_export,
    validate_timings,
)
from app.models import AudiobookJob, Book
from app.schemas import AudiobookCreateRequest
from app.storage_service import get_storage_status
from app.tts_service import (
    TtsUnavailableError,
    get_default_voice_name,
    get_tts_status,
    list_installed_voices,
    resolve_voice_name,
)

router = APIRouter(tags=["Audiobooks"])

DatabaseSession = Annotated[
    Session,
    Depends(get_session),
]


@router.get("/storage/status")
def storage_status() -> dict[str, int | bool]:
    """Return current Linux storage safety information."""
    return get_storage_status()


@router.get("/tts/voices")
def list_tts_voices() -> dict[str, object]:
    """Return locally installed Piper narrator voices."""
    return {
        "default_voice": get_default_voice_name(),
        "voices": list_installed_voices(),
    }


@router.post(
    "/books/{book_id}/audiobook-jobs",
    status_code=202,
)
def create_audiobook_job(
    book_id: int,
    request: AudiobookCreateRequest,
    background_tasks: BackgroundTasks,
    session: DatabaseSession,
) -> dict[str, object]:
    """Create a complete WAV audiobook generation job."""
    book = session.get(Book, book_id)

    if book is None:
        raise HTTPException(
            status_code=404,
            detail="Book not found.",
        )

    sections = get_book_sections(session, book_id)

    if not sections:
        raise HTTPException(
            status_code=422,
            detail=(
                "This book has no narration sections. "
                "Create narration sections first."
            ),
        )

    try:
        voice_name = resolve_voice_name(
            request.voice
        )
    except TtsUnavailableError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    tts_status = get_tts_status(
        voice_name
    )

    if not bool(tts_status["available"]):
        raise HTTPException(
            status_code=503,
            detail="The selected local Piper voice is unavailable.",
        )

    try:
        ensure_available_disk_space(
            total_words=sum(
                section.word_count
                for section in sections
            ),
            speed=request.speed,
        )
    except RuntimeError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    active_statement = select(AudiobookJob).where(
        AudiobookJob.book_id == book_id,
        AudiobookJob.status.in_(["queued", "running"]),
    )
    active_job = session.exec(active_statement).first()

    if active_job is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This book already has an active "
                "audiobook generation job."
            ),
        )

    job = AudiobookJob(
        book_id=book_id,
        status="queued",
        speed=request.speed,
        voice=voice_name,
        total_sections=len(sections),
        completed_sections=0,
    )

    session.add(job)
    session.commit()
    session.refresh(job)

    if job.id is None:
        raise HTTPException(
            status_code=500,
            detail="The audiobook job could not be created.",
        )

    background_tasks.add_task(
        run_audiobook_job,
        job.id,
    )

    return serialize_job(job, book, session)


@router.get("/books/{book_id}/audiobook-jobs")
def list_audiobook_jobs(
    book_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Return audiobook jobs for one book."""
    book = session.get(Book, book_id)

    if book is None:
        raise HTTPException(
            status_code=404,
            detail="Book not found.",
        )

    statement = (
        select(AudiobookJob)
        .where(AudiobookJob.book_id == book_id)
        .order_by(AudiobookJob.created_at.desc())
    )

    jobs = session.exec(statement).all()

    return [
        serialize_job(job, book, session)
        for job in jobs
    ]


@router.get("/audiobook-jobs/{job_id}")
def get_audiobook_job(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Return one audiobook job."""
    job, book = get_job_and_book(
        session,
        job_id,
    )

    return serialize_job(job, book, session)


@router.get("/audiobook-jobs/{job_id}/audio")
def play_wav_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Play a completed WAV audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    output_path = require_completed_wav(job)

    return FileResponse(
        path=output_path,
        media_type="audio/wav",
    )


@router.get("/audiobook-jobs/{job_id}/download")
def download_wav_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Download a completed WAV audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    output_path = require_completed_wav(job)

    return FileResponse(
        path=output_path,
        media_type="audio/wav",
        filename=(
            job.output_filename
            or output_path.name
        ),
    )


@router.post("/audiobook-jobs/{job_id}/exports/mp3")
def generate_mp3_export(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Create a compressed MP3 from a completed WAV."""
    job, book = get_job_and_book(
        session,
        job_id,
    )

    try:
        (
            book_title,
            book_author,
        ) = resolve_book_metadata(
            book,
            session,
        )

        build_mp3_export(
            job,
            book.filename,
            title=book_title,
            author=book_author,
            cover_path=get_cover_path(
                job.book_id
            ),
        )
    except ExportError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    return serialize_job(job, book, session)


@router.get("/audiobook-jobs/{job_id}/audio/mp3")
def play_mp3_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Play an existing MP3 audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    try:
        output_path = require_mp3_export(job)
    except ExportError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    return FileResponse(
        path=output_path,
        media_type="audio/mpeg",
    )


@router.get("/audiobook-jobs/{job_id}/download/mp3")
def download_mp3_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Download an existing MP3 audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    try:
        output_path = require_mp3_export(job)
    except ExportError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    return FileResponse(
        path=output_path,
        media_type="audio/mpeg",
        filename=output_path.name,
    )


@router.post("/audiobook-jobs/{job_id}/exports/m4b")
def generate_m4b_export(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Create a chaptered M4B from a completed WAV."""
    job, book = get_job_and_book(
        session,
        job_id,
    )

    try:
        build_m4b_export(
            job,
            book.filename,
        )
    except ExportError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    return serialize_job(job, book, session)



@router.get("/audiobook-jobs/{job_id}/chapters")
def list_audiobook_chapters(
    job_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Return playable chapter markers for an audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    if job.status != "completed":
        return []

    if job.id is None:
        raise HTTPException(
            status_code=500,
            detail="The audiobook job has no database ID.",
        )

    timings = get_job_timings(job.id)

    if not timings:
        return []

    try:
        validate_timings(timings)

        markers = get_chapter_markers(
            job,
            timings,
        )
    except ExportError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error

    return [
        {
            "title": marker.title,
            "start_ms": marker.start_ms,
            "end_ms": marker.end_ms,
        }
        for marker in markers
    ]


@router.get("/audiobook-jobs/{job_id}/audio/m4b")
def play_m4b_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Play an existing M4B audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    try:
        output_path = require_m4b_export(job)
    except ExportError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    return FileResponse(
        path=output_path,
        media_type="audio/mp4",
    )


@router.get("/audiobook-jobs/{job_id}/download/m4b")
def download_m4b_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Download an existing M4B audiobook."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    try:
        output_path = require_m4b_export(job)
    except ExportError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    return FileResponse(
        path=output_path,
        media_type="audio/mp4",
        filename=output_path.name,
    )


@router.delete("/audiobook-jobs/{job_id}")
def delete_audiobook_job(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Delete an inactive audiobook job and its WAV file."""
    job, _ = get_job_and_book(
        session,
        job_id,
    )

    if job.status in {"queued", "running"}:
        raise HTTPException(
            status_code=409,
            detail=(
                "An active audiobook job "
                "cannot be deleted."
            ),
        )

    try:
        delete_m4b_export(job)
        delete_mp3_export(job)
        delete_job_output(job)

        session.delete(job)
        session.commit()
    except Exception as error:
        session.rollback()

        raise HTTPException(
            status_code=500,
            detail=(
                "The audiobook could not "
                f"be deleted: {error}"
            ),
        ) from error

    return {
        "deleted": True,
        "job_id": job_id,
    }


def get_job_and_book(
    session: Session,
    job_id: int,
) -> tuple[AudiobookJob, Book]:
    """Return an audiobook job and its book."""
    job = session.get(
        AudiobookJob,
        job_id,
    )

    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Audiobook job not found.",
        )

    book = session.get(
        Book,
        job.book_id,
    )

    if book is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "The book belonging to this "
                "audiobook was not found."
            ),
        )

    return job, book


def require_completed_wav(
    job: AudiobookJob,
) -> Path:
    """Return the WAV file belonging to a completed job."""
    if job.status != "completed":
        raise HTTPException(
            status_code=409,
            detail="The audiobook is not complete yet.",
        )

    if not job.output_path:
        raise HTTPException(
            status_code=404,
            detail="The audiobook file path is missing.",
        )

    output_path = Path(job.output_path)

    if not output_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="The generated WAV file is missing.",
        )

    return output_path


def serialize_job(
    job: AudiobookJob,
    book: Book,
    session: Session,
) -> dict[str, object]:
    """Convert an audiobook job into frontend data."""
    progress_percent = (
        round(
            job.completed_sections
            / job.total_sections
            * 100
        )
        if job.total_sections
        else 0
    )

    (
        book_title,
        book_author,
    ) = resolve_book_metadata(
            book,
            session,
        )

    return {
        "id": job.id,
        "book_id": job.book_id,
        "book_filename": book.filename,
        "book_title": book_title,
        "book_author": book_author,
        "cover": get_cover_info(job.book_id),
        "status": job.status,
        "speed": job.speed,
        "voice": (
            job.voice
            or get_default_voice_name()
        ),
        "total_sections": job.total_sections,
        "completed_sections": job.completed_sections,
        "progress_percent": progress_percent,
        "output_filename": job.output_filename,
        "output_size_bytes": job.output_size_bytes,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "mp3": get_mp3_export_info(job),
        "m4b": get_m4b_export_info(job),
    }
