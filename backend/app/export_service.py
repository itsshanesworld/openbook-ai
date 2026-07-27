"""Compressed audiobook export services."""

from __future__ import annotations

import shutil
import subprocess
import threading
from pathlib import Path

from app.audiobook_service import AUDIOBOOK_DIRECTORY
from app.models import AudiobookJob

MP3_BITRATE = "64k"
MINIMUM_FREE_SPACE_BYTES = 50 * 1024 * 1024

_export_lock = threading.RLock()


class ExportError(RuntimeError):
    """Raised when an audiobook export cannot be created."""


def get_ffmpeg_status() -> dict[str, object]:
    """Return FFmpeg availability information."""
    executable = shutil.which("ffmpeg")

    return {
        "available": executable is not None,
        "executable": executable,
        "mp3_encoder": "libmp3lame",
        "mp3_bitrate": MP3_BITRATE,
    }


def create_mp3_export(
    job: AudiobookJob,
    book_filename: str,
) -> Path:
    """Convert a completed WAV audiobook into MP3."""
    with _export_lock:
        source_path = require_completed_wav(job)
        output_path = get_mp3_export_path(job)

        if output_path.is_file() and output_path.stat().st_size > 0:
            return output_path

        executable = shutil.which("ffmpeg")

        if executable is None:
            raise ExportError(
                "FFmpeg is not installed on the backend."
            )

        ensure_export_space(source_path)

        temporary_path = output_path.with_name(
            f".{output_path.stem}.temporary.mp3"
        )
        temporary_path.unlink(missing_ok=True)

        title = Path(book_filename).stem or "OpenBook AI Audiobook"

        command = [
            executable,
            "-nostdin",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source_path),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            MP3_BITRATE,
            "-id3v2_version",
            "3",
            "-metadata",
            f"title={title}",
            "-metadata",
            "artist=OpenBook AI",
            "-f",
            "mp3",
            str(temporary_path),
        ]

        try:
            completed_process = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
            )

            if completed_process.returncode != 0:
                message = completed_process.stderr.strip()

                raise ExportError(
                    message or "FFmpeg could not create the MP3."
                )

            if (
                not temporary_path.is_file()
                or temporary_path.stat().st_size == 0
            ):
                raise ExportError(
                    "FFmpeg produced an empty MP3 file."
                )

            temporary_path.replace(output_path)
            return output_path
        finally:
            temporary_path.unlink(missing_ok=True)


def get_mp3_export_path(job: AudiobookJob) -> Path:
    """Return the MP3 path associated with an audiobook job."""
    source_path = get_valid_job_output_path(job)
    return source_path.with_suffix(".mp3")


def get_mp3_export_info(
    job: AudiobookJob,
) -> dict[str, object]:
    """Return frontend-safe MP3 export information."""
    try:
        output_path = get_mp3_export_path(job)
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
        "filename": output_path.name if available else None,
        "size_bytes": (
            output_path.stat().st_size
            if available
            else None
        ),
    }


def delete_mp3_export(job: AudiobookJob) -> None:
    """Delete the MP3 belonging to an audiobook job."""
    try:
        output_path = get_mp3_export_path(job)
    except ExportError:
        return

    output_path.unlink(missing_ok=True)


def require_mp3_export(job: AudiobookJob) -> Path:
    """Return an existing MP3 export."""
    output_path = get_mp3_export_path(job)

    if not output_path.is_file():
        raise ExportError(
            "The MP3 export has not been created."
        )

    if output_path.stat().st_size == 0:
        raise ExportError("The MP3 export is empty.")

    return output_path


def require_completed_wav(job: AudiobookJob) -> Path:
    """Return the source WAV for a completed job."""
    if job.status != "completed":
        raise ExportError(
            "The WAV audiobook must finish before MP3 export."
        )

    source_path = get_valid_job_output_path(job)

    if source_path.suffix.lower() != ".wav":
        raise ExportError(
            "This job does not have a WAV source file."
        )

    if not source_path.is_file():
        raise ExportError(
            "The generated WAV audiobook is missing."
        )

    return source_path


def get_valid_job_output_path(
    job: AudiobookJob,
) -> Path:
    """Return a validated output path owned by OpenBook AI."""
    if not job.output_path:
        raise ExportError(
            "The audiobook job has no output path."
        )

    output_path = Path(job.output_path)
    resolved_parent = output_path.parent.resolve()
    expected_parent = AUDIOBOOK_DIRECTORY.resolve()

    if resolved_parent != expected_parent:
        raise ExportError(
            "The audiobook output path is invalid."
        )

    return output_path


def ensure_export_space(source_path: Path) -> None:
    """Verify that there is enough room for an MP3 export."""
    estimated_mp3_size = max(
        2 * 1024 * 1024,
        source_path.stat().st_size // 10,
    )

    required_space = (
        estimated_mp3_size + MINIMUM_FREE_SPACE_BYTES
    )
    available_space = shutil.disk_usage(
        AUDIOBOOK_DIRECTORY
    ).free

    if required_space > available_space:
        required_mb = round(required_space / 1024 / 1024)
        available_mb = round(available_space / 1024 / 1024)

        raise ExportError(
            "Not enough Linux storage for MP3 export. "
            f"Approximately {required_mb} MB is required, "
            f"but only {available_mb} MB is available."
        )
