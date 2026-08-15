"""Storage-efficient direct MP3 audiobook generation."""

from __future__ import annotations

import shutil
import subprocess
import wave
from collections.abc import Callable, Sequence
from io import BytesIO
from pathlib import Path

from sqlmodel import Session

from app.audiobook_service import (
    AUDIOBOOK_DIRECTORY,
    SECTION_PAUSE_SECONDS,
    build_output_filename,
    delete_job_timings,
    estimate_audiobook_duration_seconds,
    frames_to_milliseconds,
    get_book_sections,
    record_section_timing,
)
from app.cover_service import get_cover_path
from app.database import engine
from app.export_service import (
    ExportError,
    MP3_BITRATE,
    build_mp3_narrator_metadata_arguments,
    get_mp3_export_path,
)
from app.metadata_service import resolve_book_metadata
from app.models import (
    AudiobookJob,
    Book,
    NarrationSection,
    utc_timestamp,
)
from app.storage_service import (
    ensure_storage_capacity,
    estimate_compressed_audio_size_bytes,
)
from app.tts_service import (
    get_voice_display_name,
    synthesize_wav,
)

TimingCallback = Callable[
    [NarrationSection, int, int, int],
    None,
]

SynthesisFunction = Callable[..., bytes]

PCM_FORMATS = {
    1: "u8",
    2: "s16le",
    3: "s24le",
    4: "s32le",
}


def estimate_direct_mp3_size_bytes(
    total_words: int,
    speed: float,
) -> int:
    """Estimate storage required for direct MP3 generation."""
    duration_seconds = (
        estimate_audiobook_duration_seconds(
            total_words,
            speed,
        )
    )

    return estimate_compressed_audio_size_bytes(
        duration_seconds
    )


def ensure_direct_mp3_disk_space(
    total_words: int,
    speed: float,
) -> None:
    """Protect the storage reserve during direct MP3 generation."""
    estimated_bytes = (
        estimate_direct_mp3_size_bytes(
            total_words,
            speed,
        )
    )

    ensure_storage_capacity(
        estimated_bytes,
        operation="direct MP3 audiobook generation",
    )


def create_direct_mp3(
    sections: Sequence[NarrationSection],
    job: AudiobookJob,
    book_filename: str,
    timing_callback: TimingCallback,
    *,
    title: str | None = None,
    author: str | None = None,
    cover_path: Path | None = None,
    synthesizer: SynthesisFunction = synthesize_wav,
) -> Path:
    """Stream section PCM directly into a tagged MP3."""
    if not sections:
        raise ExportError(
            "The book has no narration sections."
        )

    executable = shutil.which("ffmpeg")

    if executable is None:
        raise ExportError(
            "FFmpeg is not installed on the backend."
        )

    output_path = get_mp3_export_path(
        job
    )

    temporary_path = output_path.with_name(
        f".{output_path.stem}.direct-temporary.mp3"
    )

    output_path.unlink(
        missing_ok=True
    )

    temporary_path.unlink(
        missing_ok=True
    )

    fallback_title = (
        Path(book_filename).stem
        or "OpenBook AI Audiobook"
    )

    resolved_title = (
        title.strip()
        if title is not None
        and title.strip()
        else fallback_title
    )

    resolved_author = (
        author.strip()
        if author is not None
        and author.strip()
        else None
    )

    narrator = get_voice_display_name(
        job.voice
    )

    valid_cover_path = (
        cover_path
        if (
            cover_path is not None
            and cover_path.is_file()
            and cover_path.stat().st_size > 0
        )
        else None
    )

    process: subprocess.Popen[bytes] | None = None

    expected_format: tuple[
        int,
        int,
        int,
        str,
    ] | None = None

    frames_written = 0
    sample_rate: int | None = None

    try:
        for index, section in enumerate(
            sections,
            start=1,
        ):
            audio_bytes = synthesizer(
                section.text,
                job.speed,
                voice_name=job.voice,
            )

            with wave.open(
                BytesIO(audio_bytes),
                "rb",
            ) as source:
                channels = source.getnchannels()
                sample_width = source.getsampwidth()
                current_sample_rate = (
                    source.getframerate()
                )
                compression_type = (
                    source.getcomptype()
                )

                current_format = (
                    channels,
                    sample_width,
                    current_sample_rate,
                    compression_type,
                )

                if compression_type != "NONE":
                    raise ExportError(
                        "Piper produced compressed WAV audio "
                        "that cannot be streamed directly."
                    )

                pcm_format = PCM_FORMATS.get(
                    sample_width
                )

                if pcm_format is None:
                    raise ExportError(
                        "Piper produced an unsupported "
                        f"{sample_width}-byte PCM sample width."
                    )

                if (
                    channels <= 0
                    or current_sample_rate <= 0
                ):
                    raise ExportError(
                        "Piper produced invalid WAV audio settings."
                    )

                if expected_format is None:
                    expected_format = (
                        current_format
                    )

                    sample_rate = (
                        current_sample_rate
                    )

                    command = _build_ffmpeg_command(
                        executable=executable,
                        pcm_format=pcm_format,
                        sample_rate=sample_rate,
                        channels=channels,
                        output_path=temporary_path,
                        title=resolved_title,
                        author=resolved_author,
                        narrator=narrator,
                        cover_path=valid_cover_path,
                    )

                    process = subprocess.Popen(
                        command,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                elif current_format != expected_format:
                    raise ExportError(
                        "Piper produced incompatible WAV "
                        "formats between narration sections."
                    )

                if (
                    process is None
                    or process.stdin is None
                    or sample_rate is None
                ):
                    raise ExportError(
                        "The direct MP3 encoder did not start."
                    )

                start_frame = frames_written

                section_frame_count = (
                    source.getnframes()
                )

                try:
                    while frames := source.readframes(
                        8192
                    ):
                        process.stdin.write(
                            frames
                        )
                except BrokenPipeError as error:
                    raise ExportError(
                        _read_process_error(
                            process
                        )
                        or (
                            "FFmpeg stopped while receiving "
                            "audiobook audio."
                        )
                    ) from error

                frames_written += (
                    section_frame_count
                )

                end_frame = frames_written

                timing_callback(
                    section,
                    frames_to_milliseconds(
                        start_frame,
                        sample_rate,
                    ),
                    frames_to_milliseconds(
                        end_frame,
                        sample_rate,
                    ),
                    index,
                )

                if index < len(sections):
                    silence_frame_count = round(
                        sample_rate
                        * SECTION_PAUSE_SECONDS
                    )

                    silence = (
                        b"\x00"
                        * sample_width
                        * channels
                        * silence_frame_count
                    )

                    try:
                        process.stdin.write(
                            silence
                        )
                    except BrokenPipeError as error:
                        raise ExportError(
                            _read_process_error(
                                process
                            )
                            or (
                                "FFmpeg stopped while receiving "
                                "section spacing audio."
                            )
                        ) from error

                    frames_written += (
                        silence_frame_count
                    )

        if process is None or process.stdin is None:
            raise ExportError(
                "No audiobook audio was generated."
            )

        process.stdin.close()

        stderr_text = _read_process_error(
            process
        )

        return_code = process.wait()

        if return_code != 0:
            raise ExportError(
                stderr_text
                or "FFmpeg could not create the direct MP3."
            )

        if (
            not temporary_path.is_file()
            or temporary_path.stat().st_size <= 0
        ):
            raise ExportError(
                "FFmpeg produced an empty direct MP3."
            )

        temporary_path.replace(
            output_path
        )

        return output_path
    finally:
        if (
            process is not None
            and process.poll() is None
        ):
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except (
                    BrokenPipeError,
                    OSError,
                ):
                    pass

            process.kill()
            process.wait()

        temporary_path.unlink(
            missing_ok=True
        )


def run_direct_mp3_job(
    job_id: int,
) -> None:
    """Generate one audiobook directly as MP3."""
    mp3_path: Path | None = None

    with Session(engine) as session:
        job = session.get(
            AudiobookJob,
            job_id,
        )

        if job is None:
            return

        try:
            delete_job_timings(
                session,
                job_id,
            )

            job.status = "running"
            job.completed_sections = 0
            job.output_size_bytes = None
            job.error_message = None
            job.updated_at = utc_timestamp()

            session.add(
                job
            )
            session.commit()
            session.refresh(
                job
            )

            book = session.get(
                Book,
                job.book_id,
            )

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

            ensure_direct_mp3_disk_space(
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

            output_filename = (
                build_output_filename(
                    book_title,
                    book_author,
                    job_id,
                )
            )

            output_path = (
                AUDIOBOOK_DIRECTORY
                / output_filename
            )

            job.output_filename = (
                output_filename
            )

            job.output_path = str(
                output_path
            )

            job.output_size_bytes = None
            job.updated_at = utc_timestamp()

            session.add(
                job
            )
            session.commit()
            session.refresh(
                job
            )

            mp3_path = create_direct_mp3(
                sections=sections,
                job=job,
                book_filename=book.filename,
                timing_callback=(
                    lambda section,
                    start_ms,
                    end_ms,
                    completed: record_section_timing(
                        session=session,
                        job=job,
                        section=section,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        completed_sections=completed,
                    )
                ),
                title=book_title,
                author=book_author,
                cover_path=get_cover_path(
                    job.book_id
                ),
            )

            job.status = "completed"
            job.completed_sections = (
                job.total_sections
            )

            job.output_size_bytes = None
            job.updated_at = utc_timestamp()

            session.add(
                job
            )
            session.commit()
        except Exception as error:
            if mp3_path is not None:
                mp3_path.unlink(
                    missing_ok=True
                )

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
                try:
                    get_mp3_export_path(
                        failed_job
                    ).unlink(
                        missing_ok=True
                    )
                except ExportError:
                    pass

                failed_job.status = "failed"
                failed_job.output_size_bytes = None
                failed_job.error_message = str(
                    error
                )

                failed_job.updated_at = (
                    utc_timestamp()
                )

                session.add(
                    failed_job
                )
                session.commit()


def _build_ffmpeg_command(
    *,
    executable: str,
    pcm_format: str,
    sample_rate: int,
    channels: int,
    output_path: Path,
    title: str,
    author: str | None,
    narrator: str,
    cover_path: Path | None,
) -> list[str]:
    """Build FFmpeg arguments for direct PCM-to-MP3 encoding."""
    command = [
        executable,
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        pcm_format,
        "-ar",
        str(sample_rate),
        "-ac",
        str(channels),
        "-i",
        "pipe:0",
    ]

    if cover_path is not None:
        command.extend(
            [
                "-i",
                str(cover_path),
            ]
        )

    command.extend(
        [
            "-map",
            "0:a:0",
        ]
    )

    if cover_path is not None:
        command.extend(
            [
                "-map",
                "1:v:0",
            ]
        )

    command.extend(
        [
            "-ac",
            "1",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            MP3_BITRATE,
        ]
    )

    if cover_path is not None:
        command.extend(
            [
                "-codec:v",
                "copy",
                "-disposition:v:0",
                "attached_pic",
                "-metadata:s:v",
                "title=Album cover",
                "-metadata:s:v",
                "comment=Cover (front)",
            ]
        )

    command.extend(
        [
            "-id3v2_version",
            "3",
            "-metadata",
            f"title={title}",
            "-metadata",
            f"album={title}",
            "-metadata",
            "encoded_by=OpenBook AI",
            *build_mp3_narrator_metadata_arguments(
                narrator
            ),
        ]
    )

    if author is not None:
        command.extend(
            [
                "-metadata",
                f"artist={author}",
                "-metadata",
                f"album_artist={author}",
            ]
        )

    command.extend(
        [
            "-f",
            "mp3",
            str(output_path),
        ]
    )

    return command


def _read_process_error(
    process: subprocess.Popen[bytes],
) -> str:
    """Read any available FFmpeg error text."""
    if process.stderr is None:
        return ""

    try:
        data = process.stderr.read()
    except OSError:
        return ""

    return data.decode(
        "utf-8",
        errors="replace",
    ).strip()
