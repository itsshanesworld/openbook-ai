"""Sequential execution queue for complete audiobook generation."""

from collections.abc import Callable, Mapping
from threading import Lock, Thread, current_thread
from time import sleep

from sqlmodel import Session, select

from app.database import engine
from app.models import AudiobookJob, utc_timestamp


JobRunner = Callable[[int], None]

_ACTIVE_STATUSES = {
    "running",
    "cancelling",
}
_QUEUE_LOCK = Lock()
_QUEUE_THREAD_LOCK = Lock()
_QUEUE_THREAD: Thread | None = None
_QUEUE_POLL_SECONDS = 0.25


def get_default_job_runners() -> dict[str, JobRunner]:
    """Return the production audiobook runners by output format."""
    from app.audiobook_service import run_audiobook_job
    from app.direct_m4b_service import run_direct_m4b_job
    from app.direct_mp3_service import run_direct_mp3_job

    return {
        "wav": run_audiobook_job,
        "mp3": run_direct_mp3_job,
        "m4b": run_direct_m4b_job,
    }


def get_next_queued_job(
    session: Session,
) -> AudiobookJob | None:
    """Return the oldest queued audiobook job."""
    return session.exec(
        select(AudiobookJob)
        .where(
            AudiobookJob.status == "queued"
        )
        .order_by(
            AudiobookJob.id.asc()
        )
    ).first()


def get_queue_position(
    session: Session,
    job: AudiobookJob,
) -> int | None:
    """Return a queued job's one-based global queue position."""
    if (
        job.status != "queued"
        or job.id is None
    ):
        return None

    queued_job_ids = session.exec(
        select(AudiobookJob.id)
        .where(
            AudiobookJob.status == "queued"
        )
        .order_by(
            AudiobookJob.id.asc()
        )
    ).all()

    for position, queued_job_id in enumerate(
        queued_job_ids,
        start=1,
    ):
        if queued_job_id == job.id:
            return position

    return None


def get_active_job(
    session: Session,
) -> AudiobookJob | None:
    """Return the currently active audiobook job, if any."""
    return session.exec(
        select(AudiobookJob)
        .where(
            AudiobookJob.status.in_(
                _ACTIVE_STATUSES
            )
        )
        .order_by(
            AudiobookJob.id.asc()
        )
    ).first()


def mark_queue_job_failed(
    job_id: int,
    message: str,
) -> None:
    """Mark a queue job failed when dispatch itself cannot run it."""
    with Session(engine) as session:
        job = session.get(
            AudiobookJob,
            job_id,
        )

        if job is None:
            return

        if job.status not in {
            "queued",
            "running",
        }:
            return

        job.status = "failed"
        job.output_size_bytes = None
        job.error_message = message
        job.updated_at = utc_timestamp()

        session.add(job)
        session.commit()


def has_queued_audiobook_jobs() -> bool:
    """Return whether persistent queued jobs are waiting."""
    with Session(engine) as session:
        return (
            get_next_queued_job(
                session
            )
            is not None
        )


def _run_audiobook_queue_thread(
    job_runners: Mapping[str, JobRunner] | None,
    poll_seconds: float,
) -> None:
    """Run the dispatcher and close the thread-state race safely."""
    global _QUEUE_THREAD

    try:
        run_audiobook_queue(
            job_runners=job_runners,
            poll_seconds=poll_seconds,
        )
    finally:
        with _QUEUE_THREAD_LOCK:
            if (
                _QUEUE_THREAD
                is current_thread()
            ):
                _QUEUE_THREAD = None

        # A job may have been enqueued just as the previous
        # dispatcher observed an empty queue.
        if has_queued_audiobook_jobs():
            start_audiobook_queue(
                job_runners=job_runners,
                poll_seconds=poll_seconds,
            )


def start_audiobook_queue(
    job_runners: Mapping[str, JobRunner] | None = None,
    poll_seconds: float = _QUEUE_POLL_SECONDS,
) -> Thread:
    """Ensure one daemon dispatcher is processing queued jobs."""
    global _QUEUE_THREAD

    with _QUEUE_THREAD_LOCK:
        if (
            _QUEUE_THREAD is not None
            and _QUEUE_THREAD.is_alive()
        ):
            return _QUEUE_THREAD

        thread = Thread(
            target=_run_audiobook_queue_thread,
            args=(
                job_runners,
                poll_seconds,
            ),
            name="openbook-audiobook-queue",
            daemon=True,
        )

        _QUEUE_THREAD = thread
        thread.start()

        return thread


def run_audiobook_queue(
    job_runners: Mapping[str, JobRunner] | None = None,
    poll_seconds: float = _QUEUE_POLL_SECONDS,
) -> None:
    """Run queued audiobook jobs sequentially until the queue is empty."""
    if not _QUEUE_LOCK.acquire(
        blocking=False
    ):
        return

    runners = (
        dict(job_runners)
        if job_runners is not None
        else get_default_job_runners()
    )

    try:
        while True:
            with Session(engine) as session:
                active_job = get_active_job(
                    session
                )

                if active_job is None:
                    queued_job = get_next_queued_job(
                        session
                    )
                else:
                    queued_job = None

                job_id = (
                    queued_job.id
                    if queued_job is not None
                    else None
                )

                output_format = (
                    queued_job.output_format
                    if queued_job is not None
                    else None
                )

            if active_job is not None:
                sleep(
                    max(
                        0.01,
                        poll_seconds,
                    )
                )
                continue

            if job_id is None:
                return

            runner = runners.get(
                output_format or ""
            )

            if runner is None:
                mark_queue_job_failed(
                    job_id,
                    (
                        "The queued audiobook has an unsupported "
                        f"output format: {output_format!r}."
                    ),
                )
                continue

            try:
                runner(
                    job_id
                )
            except Exception as error:
                mark_queue_job_failed(
                    job_id,
                    (
                        "Audiobook queue dispatch failed: "
                        f"{error}"
                    ),
                )
    finally:
        _QUEUE_LOCK.release()
