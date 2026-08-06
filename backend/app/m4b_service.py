"""Chaptered M4B audiobook export services."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
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
    Chapter,
    NarrationSection,
)

M4B_BITRATE = "64k"
MINIMUM_FREE_SPACE_BYTES = 50 * 1024 * 1024

_export_lock = threading.RLock()


@dataclass(frozen=True)
class ChapterMarker:
    """One named chapter inside an audiobook."""

    title: str
    start_ms: int
    end_ms: int


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

        markers = get_chapter_markers(
            job,
            timings,
        )

        ensure_m4b_space()

        temporary_output = output_path.with_name(
            f".{output_path.stem}.temporary.m4b"
        )

        metadata_path = (
            Path(tempfile.gettempdir())
            / f"openbook-job-{job.id}-chapters.ffmetadata"
        )

        temporary_output.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)

        try:
            metadata_path.write_text(
                build_chapter_metadata(
                    book_filename,
                    markers,
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
    """Return section timing rows for one audiobook job."""
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


def get_chapter_markers(
    job: AudiobookJob,
    timings: list[AudiobookSectionTiming],
) -> list[ChapterMarker]:
    """Build real chapter markers when chapter data exists."""
    with Session(engine) as session:
        chapters = list(
            session.exec(
                select(Chapter)
                .where(Chapter.book_id == job.book_id)
                .order_by(
                    Chapter.position,
                    Chapter.id,
                )
            ).all()
        )

        sections = list(
            session.exec(
                select(NarrationSection)
                .where(
                    NarrationSection.book_id == job.book_id
                )
                .order_by(
                    NarrationSection.position,
                    NarrationSection.id,
                )
            ).all()
        )

    if not chapters:
        return build_section_markers(timings)

    timing_by_section_id = {
        timing.section_id: timing
        for timing in timings
    }

    chapter_starts: list[tuple[str, int]] = []
    used_section_ids: set[int] = set()

    for chapter in chapters:
        matched_section = find_chapter_section(
            chapter.title,
            sections,
        )

        if matched_section is None:
            raise ExportError(
                f'Chapter "{chapter.title}" could not be mapped '
                "to a narration section. Rebuild narration "
                "sections and generate a new WAV."
            )

        if matched_section.id is None:
            raise ExportError(
                "A narration section has no database ID."
            )

        if matched_section.id in used_section_ids:
            raise ExportError(
                "Two chapters begin inside the same narration "
                "section. Rebuild narration sections and "
                "generate a new WAV."
            )

        timing = timing_by_section_id.get(
            matched_section.id
        )

        if timing is None:
            raise ExportError(
                f'No audio timestamp exists for "{chapter.title}". '
                "Generate a new WAV audiobook."
            )

        chapter_starts.append(
            (
                chapter.title,
                timing.start_ms,
            )
        )

        used_section_ids.add(
            matched_section.id
        )

    final_end_ms = timings[-1].end_ms
    markers: list[ChapterMarker] = []

    for index, (title, start_ms) in enumerate(
        chapter_starts
    ):
        if index + 1 < len(chapter_starts):
            end_ms = chapter_starts[index + 1][1]
        else:
            end_ms = final_end_ms

        markers.append(
            ChapterMarker(
                title=title,
                start_ms=start_ms,
                end_ms=end_ms,
            )
        )

    return markers


def find_chapter_section(
    chapter_title: str,
    sections: list[NarrationSection],
) -> NarrationSection | None:
    """Find the narration section containing a chapter heading."""
    normalized_title = normalize_heading(
        chapter_title
    )

    for section in sections:
        lines = {
            normalize_heading(line)
            for line in section.text.splitlines()
            if line.strip()
        }

        if normalized_title in lines:
            return section

    return None


def normalize_heading(
    value: str,
) -> str:
    """Normalize a heading for exact line matching."""
    return " ".join(
        value.split()
    ).casefold()


def build_section_markers(
    timings: list[AudiobookSectionTiming],
) -> list[ChapterMarker]:
    """Build fallback section markers."""
    markers: list[ChapterMarker] = []

    for index, timing in enumerate(timings):
        if index + 1 < len(timings):
            end_ms = timings[index + 1].start_ms
        else:
            end_ms = timing.end_ms

        markers.append(
            ChapterMarker(
                title=f"Section {timing.position}",
                start_ms=timing.start_ms,
                end_ms=end_ms,
            )
        )

    return markers


def validate_timings(
    timings: list[AudiobookSectionTiming],
) -> None:
    """Validate section timing data."""
    previous_start = -1

    for timing in timings:
        if timing.start_ms < 0:
            raise ExportError(
                "A section has an invalid start time."
            )

        if timing.end_ms <= timing.start_ms:
            raise ExportError(
                "A section has an invalid end time."
            )

        if timing.start_ms <= previous_start:
            raise ExportError(
                "Section timestamps are out of order."
            )

        previous_start = timing.start_ms


def build_chapter_metadata(
    book_filename: str,
    markers: list[ChapterMarker],
) -> str:
    """Build FFmpeg chapter metadata."""
    title = (
        Path(book_filename).stem
        or "OpenBook AI Audiobook"
    )

    lines = [
        ";FFMETADATA1",
        f"title={escape_metadata(title)}",
        "artist=OpenBook AI",
    ]

    for marker in markers:
        lines.extend(
            [
                "",
                "[CHAPTER]",
                "TIMEBASE=1/1000",
                f"START={marker.start_ms}",
                f"END={marker.end_ms}",
                (
                    "title="
                    f"{escape_metadata(marker.title)}"
                ),
            ]
        )

    return "\n".join(lines) + "\n"


def escape_metadata(
    value: str,
) -> str:
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
