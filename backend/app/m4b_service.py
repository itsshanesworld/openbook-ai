"""Chaptered M4B audiobook export services."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from sqlmodel import Session, select

from app.database import engine
from app.export_service import (
    AUDIOBOOK_DIRECTORY,
    ExportError,
    require_completed_wav,
)
from app.models import (
    AudiobookJob,
    AudiobookSectionTiming,
)

M4B_BITRATE = "64k"
MINIMUM_FREE_SPACE_BYTES = 50 * 1024 * 1024

_export_lock = threading.RLock()


def get_m4b_status() -> dict[str, object]:
    """Return M4B export availability."""
    ffmpeg = shutil.which("ffmpeg")

    return {
        "available": ffmpeg is not None,
        "ffmpeg": ffmpeg,
        "codec": "aac",
        "bitrate": M4B_BITRATE,
    }


def create_m4b_export(
    job: AudiobookJob,
    book_filename: str,
) -> Path:
    """Create a chaptered M4B from a completed WAV."""
    with _export_lock:
        source_path = require_completed_wav(job)
        output_path = get_m4b_export_path(job)

        if (
            output_path.is_file()
            and output_path.stat().st_size > 0
        ):
            return output_path

        ffmpeg = shutil.which("ffmpeg")

        if ffmpeg is None:
            raise ExportError(
                "FFmpeg is not installed on this computer."
            )

        if job.id is None:
            raise ExportError(
                "The audiobook job has no database ID."
            )

        timings = get_job_timings(job.id)

        if not timings:
            raise ExportError(
                "This audiobook has no saved chapter timing data. "
                "Generate a new WAV audiobook first."
            )

        validate_timings(timings)
        ensure_m4b_space()

        temporary_output = output_path.with_name(
            f".{output_path.stem}.temporary.m4b"
        )

        metadata_path = Path(
            tempfile.gettempdir()
        ) / f"openbook-job-{job.id}-chapters.ffmetadata"

        temporary_output.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)

        try:
            metadata_path.write_text(
                build_chapter_metadata(
                    book_filename,
                    timings,
                ),
                encoding="utf-8",
            )

            command = [
                ffmpeg,
                "-nostdin",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source_path),
                "-i",
                str(metadata_path),
                "-map",
                "0:a:0",
                "-map_metadata",
                "1",
                "-map_chapters",
                "1",
                "-c:a",
                "aac",
                "-b:a",
                M4B_BITRATE,
                "-ac",
                "1",
                "-movflags",
                "+faststart",
                "-f",
                "ipod",
                str(temporary_output),
            ]

            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
            )

            if result.returncode != 0:
                raise ExportError(
                    result.stderr.strip()
                    or "FFmpeg could not create the M4B."
                )

            if (
                not temporary_output.is_file()
                or temporary_output.stat().st_size == 0
            ):
                raise ExportError(
                    "FFmpeg created an empty M4B file."
                )

            temporary_output.replace(output_path)

            return output_path
        finally:
            temporary_output.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)


def get_m4b_export_path(
    job: AudiobookJob,
) -> Path:
    """Return the M4B path belonging to a job."""
    source_path = require_completed_wav(job)
    return source_path.with_suffix(".m4b")


def get_m4b_export_info(
    job: AudiobookJob,
) -> dict[str, object]:
    """Return M4B information for the frontend."""
    try:
        output_path = get_m4b_export_path(job)
    except ExportError:
        return {
            "available": False,
            "filename": None,
            "size_bytes": None,
        }

    available = (
        output_path.is_file()
        and output_path.stat().st_size > 0
    )

    return {
        "available": available,
        "filename": (
            output_path.name
            if available
            else None
        ),
        "size_bytes": (
            output_path.stat().st_size
            if available
            else None
        ),
    }


def require_m4b_export(
    job: AudiobookJob,
) -> Path:
    """Return an existing M4B export."""
    output_path = get_m4b_export_path(job)

    if (
        not output_path.is_file()
        or output_path.stat().st_size == 0
    ):
        raise ExportError(
            "The M4B export has not been created."
        )

    return output_path


def delete_m4b_export(
    job: AudiobookJob,
) -> None:
    """Delete an M4B export when one exists."""
    try:
        output_path = get_m4b_export_path(job)
    except ExportError:
        return

    output_path.unlink(missing_ok=True)


def get_job_timings(
    job_id: int,
) -> list[AudiobookSectionTiming]:
    """Return chapter timing rows for one job."""
    with Session(engine) as session:
        statement = (
            select(AudiobookSectionTiming)
            .where(
                AudiobookSectionTiming.job_id == job_id
            )
            .order_by(
                AudiobookSectionTiming.position,
                AudiobookSectionTiming.id,
            )
        )

        return list(
            session.exec(statement).all()
        )


def validate_timings(
    timings: list[AudiobookSectionTiming],
) -> None:
    """Validate chapter timing data."""
    previous_start = -1

    for timing in timings:
        if timing.start_ms < 0:
            raise ExportError(
                "A chapter has an invalid start time."
            )

        if timing.end_ms <= timing.start_ms:
            raise ExportError(
                "A chapter has an invalid end time."
            )

        if timing.start_ms <= previous_start:
            raise ExportError(
                "Chapter timestamps are out of order."
            )

        previous_start = timing.start_ms


def build_chapter_metadata(
    book_filename: str,
    timings: list[AudiobookSectionTiming],
) -> str:
    """Build FFmpeg chapter metadata."""
    title = Path(book_filename).stem or "OpenBook AI Audiobook"

    lines = [
        ";FFMETADATA1",
        f"title={escape_metadata(title)}",
        "artist=OpenBook AI",
    ]

    for index, timing in enumerate(timings):
        if index + 1 < len(timings):
            chapter_end = timings[index + 1].start_ms
        else:
            chapter_end = timing.end_ms

        lines.extend(
            [
                "",
                "[CHAPTER]",
                "TIMEBASE=1/1000",
                f"START={timing.start_ms}",
                f"END={chapter_end}",
                (
                    "title="
                    f"{escape_metadata(f'Section {timing.position}')}"
                ),
            ]
        )

    return "\n".join(lines) + "\n"


def escape_metadata(value: str) -> str:
    """Escape special FFmetadata characters."""
    return (
        value.replace("\\", "\\\\")
        .replace("=", "\\=")
        .replace(";", "\\;")
        .replace("#", "\\#")
        .replace("\n", " ")
        .replace("\r", " ")
    )


def ensure_m4b_space() -> None:
    """Keep a safety buffer on the Linux disk."""
    free_bytes = shutil.disk_usage(
        AUDIOBOOK_DIRECTORY
    ).free

    if free_bytes < MINIMUM_FREE_SPACE_BYTES:
        free_mb = round(
            free_bytes / 1024 / 1024
        )

        raise ExportError(
            "There is not enough free Linux storage. "
            f"Only about {free_mb} MB remains."
        )
