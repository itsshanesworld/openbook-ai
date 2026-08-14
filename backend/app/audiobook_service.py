"""Complete audiobook generation services."""

from __future__ import annotations

import re
import wave
from collections.abc import Callable, Sequence
from io import BytesIO
from pathlib import Path

from sqlmodel import Session, select

from app.database import engine
from app.metadata_service import resolve_book_metadata
from app.models import (
    AudiobookJob,
    AudiobookSectionTiming,
    Book,
    NarrationSection,
    utc_timestamp,
)
from app.storage_service import ensure_storage_capacity
from app.tts_service import synthesize_wav

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
AUDIOBOOK_DIRECTORY = BACKEND_DIRECTORY / "data" / "audiobooks"

SECTION_PAUSE_SECONDS = 0.35
MAX_OUTPUT_FILENAME_STEM_LENGTH = 180

AUDIOBOOK_DIRECTORY.mkdir(parents=True, exist_ok=True)

TimingCallback = Callable[
    [NarrationSection, int, int, int],
    None,
]


def run_audiobook_job(job_id: int) -> None:
    """Generate and combine every narration section for one job."""
    output_path: Path | None = None

    with Session(engine) as session:
        job = session.get(AudiobookJob, job_id)

        if job is None:
            return

        try:
            delete_job_timings(session, job_id)

            job.status = "running"
            job.completed_sections = 0
            job.error_message = None
            job.updated_at = utc_timestamp()

            session.add(job)
            session.commit()
            session.refresh(job)

            book = session.get(Book, job.book_id)

            if book is None:
                raise RuntimeError(
                    "The audiobook's book was deleted."
                )

            sections = get_book_sections(
                session,
                job.book_id,
            )

            if not sections:
                raise RuntimeError(
                    "The book has no narration sections."
                )

            ensure_available_disk_space(
                total_words=sum(
                    section.word_count
                    for section in sections
                ),
                speed=job.speed,
            )

            (
                book_title,
                book_author,
            ) = resolve_book_metadata(
                book,
                session,
            )

            output_filename = build_output_filename(
                book_title,
                book_author,
                job_id,
            )
            output_path = (
                AUDIOBOOK_DIRECTORY / output_filename
            )

            job.output_filename = output_filename
            job.output_path = str(output_path)
            job.updated_at = utc_timestamp()

            session.add(job)
            session.commit()

            generate_combined_wav(
                sections=sections,
                speed=job.speed,
                output_path=output_path,
                timing_callback=lambda section, start_ms, end_ms, completed: (
                    record_section_timing(
                        session=session,
                        job=job,
                        section=section,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        completed_sections=completed,
                    )
                ),
                voice_name=job.voice,
            )

            job.status = "completed"
            job.completed_sections = job.total_sections
            job.output_size_bytes = (
                output_path.stat().st_size
            )
            job.updated_at = utc_timestamp()

            session.add(job)
            session.commit()
        except Exception as error:
            if output_path is not None:
                output_path.unlink(missing_ok=True)
                get_temporary_output_path(
                    output_path
                ).unlink(missing_ok=True)

            session.rollback()

            delete_job_timings(
                session,
                job_id,
            )

            failed_job = session.get(
                AudiobookJob,
                job_id,
            )

            if failed_job is not None:
                failed_job.status = "failed"
                failed_job.error_message = str(error)
                failed_job.updated_at = utc_timestamp()

                session.add(failed_job)
                session.commit()


def generate_combined_wav(
    sections: Sequence[NarrationSection],
    speed: float,
    output_path: Path,
    timing_callback: TimingCallback,
    voice_name: str | None = None,
) -> None:
    """Generate one WAV and record section timestamps."""
    temporary_path = get_temporary_output_path(
        output_path
    )
    temporary_path.unlink(missing_ok=True)

    output_wave: wave.Wave_write | None = None
    audio_format: tuple[int, int, int, str] | None = None

    frames_written = 0
    sample_rate: int | None = None

    try:
        for index, section in enumerate(
            sections,
            start=1,
        ):
            audio_bytes = synthesize_wav(
                section.text,
                speed,
                voice_name=voice_name,
            )

            with wave.open(
                BytesIO(audio_bytes),
                "rb",
            ) as source:
                current_format = (
                    source.getnchannels(),
                    source.getsampwidth(),
                    source.getframerate(),
                    source.getcomptype(),
                )

                if output_wave is None:
                    output_wave = wave.open(
                        str(temporary_path),
                        "wb",
                    )
                    output_wave.setnchannels(
                        source.getnchannels()
                    )
                    output_wave.setsampwidth(
                        source.getsampwidth()
                    )
                    output_wave.setframerate(
                        source.getframerate()
                    )
                    output_wave.setcomptype(
                        source.getcomptype(),
                        source.getcompname(),
                    )

                    audio_format = current_format
                    sample_rate = source.getframerate()

                elif current_format != audio_format:
                    raise RuntimeError(
                        "Piper produced incompatible WAV formats."
                    )

                if sample_rate is None:
                    raise RuntimeError(
                        "The WAV sample rate is unavailable."
                    )

                start_frame = frames_written
                section_frame_count = source.getnframes()

                copy_wave_frames(
                    source,
                    output_wave,
                )

                frames_written += section_frame_count
                end_frame = frames_written

                start_ms = frames_to_milliseconds(
                    start_frame,
                    sample_rate,
                )
                end_ms = frames_to_milliseconds(
                    end_frame,
                    sample_rate,
                )

                timing_callback(
                    section,
                    start_ms,
                    end_ms,
                    index,
                )

                if index < len(sections):
                    silence_frames = write_silence(
                        destination=output_wave,
                        sample_rate=sample_rate,
                        sample_width=source.getsampwidth(),
                        channels=source.getnchannels(),
                        duration_seconds=SECTION_PAUSE_SECONDS,
                    )

                    frames_written += silence_frames

        if output_wave is None:
            raise RuntimeError(
                "No audiobook audio was generated."
            )

        output_wave.close()
        output_wave = None

        temporary_path.replace(output_path)
    finally:
        if output_wave is not None:
            output_wave.close()

        temporary_path.unlink(missing_ok=True)


def record_section_timing(
    session: Session,
    job: AudiobookJob,
    section: NarrationSection,
    start_ms: int,
    end_ms: int,
    completed_sections: int,
) -> None:
    """Save one section's timestamps and job progress."""
    if job.id is None:
        raise RuntimeError(
            "The audiobook job has no database ID."
        )

    if section.id is None:
        raise RuntimeError(
            "A narration section has no database ID."
        )

    timing = AudiobookSectionTiming(
        job_id=job.id,
        section_id=section.id,
        position=section.position,
        start_ms=start_ms,
        end_ms=end_ms,
    )

    session.add(timing)

    job.completed_sections = completed_sections
    job.updated_at = utc_timestamp()

    session.add(job)
    session.commit()
    session.refresh(job)


def delete_job_timings(
    session: Session,
    job_id: int,
) -> None:
    """Delete stored timing rows for one audiobook job."""
    statement = select(
        AudiobookSectionTiming
    ).where(
        AudiobookSectionTiming.job_id == job_id
    )

    timings = session.exec(statement).all()

    for timing in timings:
        session.delete(timing)

    session.commit()


def frames_to_milliseconds(
    frame_number: int,
    sample_rate: int,
) -> int:
    """Convert WAV frame position to milliseconds."""
    if sample_rate <= 0:
        raise ValueError(
            "Sample rate must be greater than zero."
        )

    return round(
        frame_number / sample_rate * 1000
    )


def copy_wave_frames(
    source: wave.Wave_read,
    destination: wave.Wave_write,
) -> None:
    """Copy WAV frames in manageable chunks."""
    while frames := source.readframes(8192):
        destination.writeframesraw(frames)


def write_silence(
    destination: wave.Wave_write,
    sample_rate: int,
    sample_width: int,
    channels: int,
    duration_seconds: float,
) -> int:
    """Insert silence and return the number of frames."""
    frame_count = round(
        sample_rate * duration_seconds
    )

    silent_frame = (
        b"\x00" * sample_width * channels
    )

    destination.writeframesraw(
        silent_frame * frame_count
    )

    return frame_count


def get_book_sections(
    session: Session,
    book_id: int,
) -> list[NarrationSection]:
    """Return narration sections in reading order."""
    statement = (
        select(NarrationSection)
        .where(
            NarrationSection.book_id == book_id
        )
        .order_by(
            NarrationSection.position,
            NarrationSection.id,
        )
    )

    return list(
        session.exec(statement).all()
    )


def build_output_filename(
    title: str,
    author: str | None,
    job_id: int,
) -> str:
    """Create a readable, collision-safe audiobook filename."""
    safe_title = sanitize_filename_component(
        title,
        fallback="OpenBook AI",
    )

    safe_author = (
        sanitize_filename_component(
            author,
            fallback="",
        )
        if author is not None
        else ""
    )

    readable_name = (
        f"{safe_title} - {safe_author}"
        if safe_author
        else safe_title
    )

    unique_suffix = (
        f" - audiobook-{job_id}"
    )

    maximum_readable_length = max(
        1,
        MAX_OUTPUT_FILENAME_STEM_LENGTH
        - len(unique_suffix),
    )

    readable_name = (
        readable_name[
            :maximum_readable_length
        ]
        .rstrip(" .-_")
    )

    if not readable_name:
        readable_name = "OpenBook AI"

    return (
        f"{readable_name}"
        f"{unique_suffix}.wav"
    )


def sanitize_filename_component(
    value: str,
    *,
    fallback: str,
) -> str:
    """Make metadata safe for portable audiobook filenames."""
    cleaned = re.sub(
        r'[\x00-\x1f<>:"/\\|?*]+',
        " ",
        value,
    )

    cleaned = re.sub(
        r"\s+",
        " ",
        cleaned,
    )

    return (
        cleaned.strip(" .-_")
        or fallback
    )


def get_temporary_output_path(
    output_path: Path,
) -> Path:
    """Return the temporary output filename."""
    return output_path.with_name(
        f".{output_path.name}.temporary"
    )


def estimate_output_size_bytes(
    total_words: int,
    speed: float,
) -> int:
    """Estimate uncompressed WAV output size."""
    estimated_seconds = (
        max(total_words, 1)
        / 160
        * 60
        / speed
    )

    return round(
        estimated_seconds * 48_000
    )


def ensure_available_disk_space(
    total_words: int,
    speed: float,
) -> None:
    """Ensure enough protected storage exists for WAV generation."""
    estimated_output_size = estimate_output_size_bytes(
        total_words,
        speed,
    )

    ensure_storage_capacity(
        estimated_output_size,
        operation="WAV audiobook generation",
    )


def recover_interrupted_audiobook_jobs() -> None:
    """Mark interrupted jobs as failed after restart."""
    with Session(engine) as session:
        statement = select(
            AudiobookJob
        ).where(
            AudiobookJob.status.in_(
                ["queued", "running"]
            )
        )

        interrupted_jobs = session.exec(
            statement
        ).all()

        for job in interrupted_jobs:
            if job.id is not None:
                delete_job_timings(
                    session,
                    job.id,
                )

            job.status = "failed"
            job.error_message = (
                "Generation was interrupted because "
                "the backend stopped or restarted."
            )
            job.updated_at = utc_timestamp()

            session.add(job)

        session.commit()


def delete_job_output(
    job: AudiobookJob,
) -> None:
    """Delete the generated WAV belonging to a job."""
    if not job.output_path:
        return

    output_path = Path(job.output_path)

    if (
        output_path.parent.resolve()
        != AUDIOBOOK_DIRECTORY.resolve()
    ):
        raise RuntimeError(
            "Invalid audiobook output path."
        )

    output_path.unlink(missing_ok=True)
