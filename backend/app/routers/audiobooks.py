"""Complete audiobook generation and export API routes."""

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
from starlette.concurrency import run_in_threadpool

from app.audiobook_service import (
    delete_job_output,
    get_book_sections,
    run_audiobook_job,
)
from app.database import get_session
from app.export_service import (
    ExportError,
    create_mp3_export,
    delete_mp3_export,
    get_ffmpeg_status,
    get_mp3_export_info,
    require_mp3_export,
)
from app.models import AudiobookJob, Book
from app.schemas import AudiobookCreateRequest
from app.tts_service import get_tts_status

router = APIRouter(tags=["Audiobooks"])
DatabaseSession = Annotated[Session, Depends(get_session)]


@router.get("/exports/status")
def export_status() -> dict[str, object]:
    """Return installed export-tool information."""
    return get_ffmpeg_status()


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
    """Queue complete local WAV audiobook generation."""
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
                "Create narration sections before generating "
                "an audiobook."
            ),
        )

    tts_status = get_tts_status()

    if not tts_status["available"]:
        raise HTTPException(
            status_code=503,
            detail="The local Piper voice is unavailable.",
        )

    active_statement = select(AudiobookJob).where(
        AudiobookJob.book_id == book_id,
        AudiobookJob.status.in_(["queued", "running"]),
    )
    active_job = session.exec(active_statement).first()

    if active_job is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This book already has an active generation job."
            ),
        )

    job = AudiobookJob(
        book_id=book_id,
        status="queued",
        speed=request.speed,
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

    return serialize_job(job, book.filename)


@router.get("/books/{book_id}/audiobook-jobs")
def list_book_audiobook_jobs(
    book_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Return generation jobs for one book."""
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
        serialize_job(job, book.filename)
        for job in jobs
    ]


@router.get("/audiobook-jobs/{job_id}")
def get_audiobook_job(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Return one audiobook generation job."""
    job, book = get_job_and_book(session, job_id)
    return serialize_job(job, book.filename)


@router.post("/audiobook-jobs/{job_id}/exports/mp3")
async def generate_mp3_export(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Generate a compressed MP3 from a completed WAV."""
    job, book = get_job_and_book(session, job_id)

    try:
        await run_in_threadpool(
            create_mp3_export,
            job,
            book.filename,
        )
    except ExportError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"MP3 export failed: {error}",
        ) from error

    return serialize_job(job, book.filename)


@router.get("/audiobook-jobs/{job_id}/audio")
def play_wav_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Stream a completed WAV audiobook."""
    job, _ = get_job_and_book(session, job_id)
    output_path = require_completed_wav_output(job)

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
    job, _ = get_job_and_book(session, job_id)
    output_path = require_completed_wav_output(job)

    return FileResponse(
        path=output_path,
        media_type="audio/wav",
        filename=job.output_filename or output_path.name,
    )


@router.get("/audiobook-jobs/{job_id}/audio/mp3")
def play_mp3_audiobook(
    job_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Stream a generated MP3 audiobook."""
    job, _ = get_job_and_book(session, job_id)

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
    """Download a generated MP3 audiobook."""
    job, _ = get_job_and_book(session, job_id)

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


@router.delete("/audiobook-jobs/{job_id}")
def delete_audiobook_job(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Delete an audiobook job and all generated files."""
    job, _ = get_job_and_book(session, job_id)

    if job.status in {"queued", "running"}:
        raise HTTPException(
            status_code=409,
            detail=(
                "An active audiobook job cannot be deleted."
            ),
        )

    try:
        delete_mp3_export(job)
        delete_job_output(job)
        session.delete(job)
        session.commit()
    except Exception as error:
        session.rollback()

        raise HTTPException(
            status_code=500,
            detail=f"The audiobook could not be deleted: {error}",
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
    job = session.get(AudiobookJob, job_id)

    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Audiobook job not found.",
        )

    book = session.get(Book, job.book_id)

    if book is None:
        raise HTTPException(
            status_code=404,
            detail="The audiobook's book was not found.",
        )

    return job, book


def require_completed_wav_output(
    job: AudiobookJob,
) -> Path:
    """Return a validated completed WAV output."""
    if job.status != "completed":
        raise HTTPException(
            status_code=409,
            detail="The audiobook is not complete.",
        )

    if not job.output_path:
        raise HTTPException(
            status_code=404,
            detail="The generated audiobook file is missing.",
        )

    output_path = Path(job.output_path)

    if (
        not output_path.is_file()
        or output_path.suffix.lower() != ".wav"
    ):
        raise HTTPException(
            status_code=404,
            detail="The generated WAV audiobook is missing.",
        )

    return output_path


def serialize_job(
    job: AudiobookJob,
    book_filename: str,
) -> dict[str, object]:
    """Convert an audiobook job into an API response."""
    progress_percent = (
        round(
            job.completed_sections
            / job.total_sections
            * 100
        )
        if job.total_sections
        else 0
    )

    return {
        "id": job.id,
        "book_id": job.book_id,
        "book_filename": book_filename,
        "status": job.status,
        "speed": job.speed,
        "total_sections": job.total_sections,
        "completed_sections": job.completed_sections,
        "progress_percent": progress_percent,
        "output_filename": job.output_filename,
        "output_size_bytes": job.output_size_bytes,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "mp3": get_mp3_export_info(job),
    }
