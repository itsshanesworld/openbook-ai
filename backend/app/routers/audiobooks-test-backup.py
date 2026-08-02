"""Audiobook API routes."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.database import get_session

router = APIRouter(tags=["Audiobooks"])

DatabaseSession = Annotated[
    Session,
    Depends(get_session),
]


@router.get("/books/{book_id}/audiobook-jobs")
def list_audiobook_jobs(
    book_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Return audiobook jobs for a book."""
    return []


@router.get("/audiobook-jobs/{job_id}")
def get_audiobook_job(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Return one audiobook job."""
    return {
        "id": job_id,
        "status": "test",
    }


@router.post("/audiobook-jobs/{job_id}/exports/mp3")
def create_mp3_export(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Test the MP3 export route."""
    return {
        "job_id": job_id,
        "status": "ready",
    }


@router.get("/audiobook-jobs/{job_id}/audio/mp3")
def play_mp3(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Test the MP3 playback route."""
    return {
        "job_id": job_id,
        "audio": "mp3",
    }


@router.get("/audiobook-jobs/{job_id}/download/mp3")
def download_mp3(
    job_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Test the MP3 download route."""
    return {
        "job_id": job_id,
        "download": "mp3",
    }
