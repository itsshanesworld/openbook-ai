"""Persistent audiobook generation cancellation."""

from sqlmodel import Session

from app.database import engine
from app.models import AudiobookJob


class AudiobookCancelled(RuntimeError):
    """Raised when an audiobook generation job is cancelled."""


def raise_if_audiobook_cancelled(
    job_id: int,
) -> None:
    """Raise when a job has received a cancellation request."""
    with Session(engine) as session:
        job = session.get(
            AudiobookJob,
            job_id,
        )

        if job is None:
            raise AudiobookCancelled(
                "The audiobook job no longer exists."
            )

        if job.status in {
            "cancelling",
            "cancelled",
        }:
            raise AudiobookCancelled(
                "Audiobook generation was cancelled."
            )
