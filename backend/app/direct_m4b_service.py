"""Storage-efficient direct M4B streaming services."""

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
from app.export_service import ExportError
from app.m4b_service import (
    M4B_BITRATE,
    build_chapter_metadata,
    get_chapter_markers,
    get_job_timings,
    get_m4b_export_path,
    validate_timings,
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

MetadataBuilder = Callable[[], str]

SynthesisFunction = Callable[..., bytes]

PCM_FORMATS = {
    1: "u8",
    2: "s16le",
    3: "s24le",
    4: "s32le",
}



def create_direct_m4b(
    sections: Sequence[NarrationSection],
    job: AudiobookJob,
    timing_callback: TimingCallback,
    metadata_builder: MetadataBuilder,
    *,
    cover_path: Path | None = None,
    synthesizer: SynthesisFunction = synthesize_wav,
) -> Path:
    """Stream narration into AAC, then remux it into chaptered M4B."""
    if not sections:
        raise ExportError(
            "The book has no narration sections."
        )

    executable = shutil.which("ffmpeg")

    if executable is None:
        raise ExportError(
            "FFmpeg is not installed on the backend."
        )

    output_path = get_m4b_export_path(
        job
    )

    audio_path = output_path.with_name(
        f".{output_path.stem}.direct-audio.m4a"
    )

    metadata_path = output_path.with_name(
        f".{output_path.stem}.direct-metadata.ffmeta"
    )

    temporary_output_path = output_path.with_name(
        f".{output_path.stem}.direct-temporary.m4b"
    )

    for path in (
        audio_path,
        metadata_path,
        temporary_output_path,
    ):
        path.unlink(
            missing_ok=True
        )

    output_path.unlink(
        missing_ok=True
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
                        "Piper produced compressed WAV audio."
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
                        "Piper produced invalid WAV settings."
                    )

                if expected_format is None:
                    expected_format = (
                        current_format
                    )

                    sample_rate = (
                        current_sample_rate
                    )

                    process = subprocess.Popen(
                        _build_aac_command(
                            executable=executable,
                            pcm_format=pcm_format,
                            sample_rate=sample_rate,
                            channels=channels,
                            output_path=audio_path,
                        ),
                        stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                elif current_format != expected_format:
                    raise ExportError(
                        "Piper produced incompatible WAV "
                        "formats between sections."
                    )

                if (
                    process is None
                    or process.stdin is None
                    or sample_rate is None
                ):
                    raise ExportError(
                        "The direct M4B encoder did not start."
                    )

                start_frame = frames_written

                section_frame_count = (
                    source.getnframes()
                )

                while frames := source.readframes(
                    8192
                ):
                    _write_pcm(
                        process,
                        frames,
                    )

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

                    _write_pcm(
                        process,
                        silence,
                    )

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
                or "FFmpeg could not create direct AAC audio."
            )

        if (
            not audio_path.is_file()
            or audio_path.stat().st_size <= 0
        ):
            raise ExportError(
                "FFmpeg produced an empty AAC file."
            )

        metadata_text = metadata_builder()

        if not metadata_text.startswith(
            ";FFMETADATA1"
        ):
            raise ExportError(
                "The M4B chapter metadata is invalid."
            )

        metadata_path.write_text(
            metadata_text,
            encoding="utf-8",
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

        remux = subprocess.run(
            _build_remux_command(
                executable=executable,
                audio_path=audio_path,
                metadata_path=metadata_path,
                cover_path=valid_cover_path,
                output_path=temporary_output_path,
            ),
            capture_output=True,
            text=True,
            check=False,
        )

        if remux.returncode != 0:
            raise ExportError(
                remux.stderr.strip()
                or "FFmpeg could not create the M4B."
            )

        if (
            not temporary_output_path.is_file()
            or temporary_output_path.stat().st_size <= 0
        ):
            raise ExportError(
                "FFmpeg produced an empty M4B."
            )

        temporary_output_path.replace(
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

        audio_path.unlink(
            missing_ok=True
        )

        metadata_path.unlink(
            missing_ok=True
        )

        temporary_output_path.unlink(
            missing_ok=True
        )


def estimate_direct_m4b_size_bytes(
    total_words: int,
    speed: float,
) -> int:
    """Estimate storage for direct 64 kbps M4B generation."""
    duration_seconds = (
        estimate_audiobook_duration_seconds(
            total_words,
            speed,
        )
    )

    return estimate_compressed_audio_size_bytes(
        duration_seconds
    )


def ensure_direct_m4b_disk_space(
    total_words: int,
    speed: float,
) -> None:
    """Protect the storage reserve before direct M4B generation."""
    ensure_storage_capacity(
        estimate_direct_m4b_size_bytes(
            total_words,
            speed,
        ),
        operation="direct M4B generation",
    )


def run_direct_m4b_job(
    job_id: int,
) -> None:
    """Generate one audiobook directly as chaptered M4B."""
    m4b_path: Path | None = None

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

            session.add(job)
            session.commit()
            session.refresh(job)

            if job.id is None:
                raise RuntimeError(
                    "The audiobook job has no database ID."
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

            ensure_direct_m4b_disk_space(
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
                AUDIOBOOK_DIRECTORY
                / output_filename
            )

            job.output_filename = output_filename
            job.output_path = str(
                output_path
            )
            job.output_size_bytes = None
            job.updated_at = utc_timestamp()

            session.add(job)
            session.commit()
            session.refresh(job)

            def build_metadata() -> str:
                timings = get_job_timings(
                    job_id
                )

                if not timings:
                    raise ExportError(
                        "Direct M4B generation produced "
                        "no section timing data."
                    )

                validate_timings(
                    timings
                )

                markers = get_chapter_markers(
                    job,
                    timings,
                )

                return build_chapter_metadata(
                    book_title,
                    markers,
                    author=book_author,
                    narrator=get_voice_display_name(
                        job.voice
                    ),
                )

            m4b_path = create_direct_m4b(
                sections=sections,
                job=job,
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
                metadata_builder=build_metadata,
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

            session.add(job)
            session.commit()
        except Exception as error:
            if m4b_path is not None:
                m4b_path.unlink(
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
                    get_m4b_export_path(
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


def _build_aac_command(
    *,
    executable: str,
    pcm_format: str,
    sample_rate: int,
    channels: int,
    output_path: Path,
) -> list[str]:
    """Build the raw-PCM to AAC command."""
    return [
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
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-codec:a",
        "aac",
        "-b:a",
        M4B_BITRATE,
        "-f",
        "ipod",
        str(output_path),
    ]


def _build_remux_command(
    *,
    executable: str,
    audio_path: Path,
    metadata_path: Path,
    cover_path: Path | None,
    output_path: Path,
) -> list[str]:
    """Build the chapter, metadata, and cover remux command."""
    command = [
        executable,
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(audio_path),
        "-f",
        "ffmetadata",
        "-i",
        str(metadata_path),
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
                "2:v:0",
            ]
        )

    command.extend(
        [
            "-map_metadata",
            "1",
            "-map_chapters",
            "1",
            "-codec:a",
            "copy",
        ]
    )

    if cover_path is not None:
        command.extend(
            [
                "-codec:v",
                "mjpeg",
                "-disposition:v:0",
                "attached_pic",
            ]
        )

    command.extend(
        [
            "-movflags",
            "+faststart",
            "-f",
            "ipod",
            str(output_path),
        ]
    )

    return command

def _write_pcm(
    process: subprocess.Popen[bytes],
    data: bytes,
) -> None:
    """Write PCM bytes to FFmpeg."""
    if process.stdin is None:
        raise ExportError(
            "FFmpeg audio input is unavailable."
        )

    try:
        process.stdin.write(
            data
        )
    except BrokenPipeError as error:
        raise ExportError(
            _read_process_error(process)
            or "FFmpeg stopped while receiving audio."
        ) from error


def _read_process_error(
    process: subprocess.Popen[bytes],
) -> str:
    """Read FFmpeg error output."""
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
