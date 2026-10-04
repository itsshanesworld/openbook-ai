"""Long-lived local voice-cloning worker for OpenBook AI.

Runs OpenVoice v2's tone-color converter in an isolated Python
environment. Kokoro narrates; this worker re-colours that narration to
match a user's own voice sample. Everything stays on this machine.
"""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from typing import Any
from urllib.parse import parse_qs, urlparse


BACKEND_DIRECTORY = Path(__file__).resolve().parent
CLONE_ENGINE_DIRECTORY = BACKEND_DIRECTORY / "data" / "voice_clone"
OPENVOICE_DIRECTORY = CLONE_ENGINE_DIRECTORY / "OpenVoice"
CHECKPOINT_DIRECTORY = CLONE_ENGINE_DIRECTORY / "ov_ckpt" / "converter"
CONFIG_PATH = CHECKPOINT_DIRECTORY / "config.json"
CHECKPOINT_PATH = CHECKPOINT_DIRECTORY / "checkpoint.pth"

VOICE_CLONE_DIRECTORY = BACKEND_DIRECTORY / "data" / "voice_clones"
EMBEDDING_FILE_NAME = "speaker_embedding.pt"

CLONE_ID_PATTERN = re.compile(r"^clone-[0-9a-f]{32}$")

MAX_CONVERT_BYTES = 64 * 1024 * 1024
MIN_SAMPLE_SECONDS = 10.0
MAX_SAMPLE_SECONDS = 600.0
MAX_EMBEDDING_CHUNKS = 12
CHUNK_SECONDS = 10

OUTPUT_SAMPLE_RATE = 24_000
CONVERSION_TAU = 0.3


class CloneWorkerError(ValueError):
    """Raised for invalid clone requests."""


class VoiceCloneService:
    """Load the converter lazily and serialize inference."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._converter: Any = None
        self._embeddings: dict[str, tuple[float, Any]] = {}

    @property
    def installed(self) -> bool:
        """Return whether the engine files are present."""
        return (
            OPENVOICE_DIRECTORY.is_dir()
            and CONFIG_PATH.is_file()
            and CHECKPOINT_PATH.is_file()
        )

    @property
    def model_loaded(self) -> bool:
        """Return whether the converter is resident in memory."""
        return self._converter is not None

    def _load_converter(self) -> Any:
        """Load OpenVoice once, on first use."""
        if self._converter is not None:
            return self._converter

        if not self.installed:
            raise RuntimeError(
                "The voice cloning engine is not installed."
            )

        sys.path.insert(0, str(OPENVOICE_DIRECTORY))

        import torch
        from openvoice.api import (
            OpenVoiceBaseClass,
            ToneColorConverter,
        )

        torch.set_num_threads(4)

        class _Converter(ToneColorConverter):
            """Converter without the audio watermark.

            OpenVoice forwards ``enable_watermark`` to a base class that
            rejects it, so initialise the base class directly.
            """

            def __init__(
                self,
                config_path: str,
                device: str,
            ) -> None:
                OpenVoiceBaseClass.__init__(
                    self,
                    config_path,
                    device=device,
                )
                self.watermark_model = None
                self.version = getattr(
                    self.hps,
                    "_version_",
                    "v1",
                )

        converter = _Converter(
            str(CONFIG_PATH),
            "cpu",
        )
        converter.load_ckpt(str(CHECKPOINT_PATH))

        self._converter = converter

        return converter

    def register(
        self,
        clone_id: str,
        sample_path: Path,
    ) -> dict[str, Any]:
        """Compute and store the speaker embedding for one sample."""
        duration = _probe_duration(sample_path)

        if duration < MIN_SAMPLE_SECONDS:
            raise CloneWorkerError(
                "The voice sample is too short. "
                f"Use at least {int(MIN_SAMPLE_SECONDS)} seconds "
                "of clear speech."
            )

        if duration > MAX_SAMPLE_SECONDS:
            raise CloneWorkerError(
                "The voice sample is too long. "
                f"Use at most {int(MAX_SAMPLE_SECONDS // 60)} minutes."
            )

        with tempfile.TemporaryDirectory(
            prefix="openbook-clone-"
        ) as working_name:
            working = Path(working_name)
            normalized = working / "normalized.wav"

            _run_ffmpeg(
                [
                    "-i",
                    str(sample_path),
                    "-af",
                    "loudnorm=I=-20:TP=-2",
                    "-ar",
                    "22050",
                    "-ac",
                    "1",
                    str(normalized),
                ]
            )

            _run_ffmpeg(
                [
                    "-i",
                    str(normalized),
                    "-f",
                    "segment",
                    "-segment_time",
                    str(CHUNK_SECONDS),
                    "-c",
                    "copy",
                    str(working / "chunk-%03d.wav"),
                ]
            )

            chunks = sorted(
                working.glob("chunk-*.wav")
            )[:MAX_EMBEDDING_CHUNKS]

            # A trailing sliver is too short to embed reliably.
            if len(chunks) > 1:
                last = chunks[-1]

                if _probe_duration(last) < 3.0:
                    chunks = chunks[:-1]

            if not chunks:
                raise CloneWorkerError(
                    "No usable speech found in the voice sample."
                )

            with self._lock:
                converter = self._load_converter()

                embedding = converter.extract_se(
                    [str(chunk) for chunk in chunks]
                )

        import torch

        embedding_path = (
            VOICE_CLONE_DIRECTORY
            / clone_id
            / EMBEDDING_FILE_NAME
        )

        torch.save(
            embedding.cpu(),
            embedding_path,
        )

        self._embeddings.pop(clone_id, None)

        return {
            "clone_id": clone_id,
            "sample_seconds": round(duration, 1),
            "chunks_used": len(chunks),
        }

    def _get_embedding(
        self,
        clone_id: str,
    ) -> Any:
        """Return one clone's cached speaker embedding."""
        import torch

        embedding_path = (
            VOICE_CLONE_DIRECTORY
            / clone_id
            / EMBEDDING_FILE_NAME
        )

        if not embedding_path.is_file():
            raise CloneWorkerError(
                "This voice clone has not been prepared yet."
            )

        modified = embedding_path.stat().st_mtime
        cached = self._embeddings.get(clone_id)

        if cached is not None and cached[0] == modified:
            return cached[1]

        embedding = torch.load(
            embedding_path,
            map_location="cpu",
        )

        self._embeddings[clone_id] = (
            modified,
            embedding,
        )

        return embedding

    def convert(
        self,
        clone_id: str,
        wav_bytes: bytes,
    ) -> bytes:
        """Re-colour narration audio with one clone's voice."""
        import librosa
        import soundfile as sf

        target_embedding = self._get_embedding(
            clone_id
        )

        with tempfile.TemporaryDirectory(
            prefix="openbook-convert-"
        ) as working_name:
            source_path = (
                Path(working_name) / "source.wav"
            )
            source_path.write_bytes(wav_bytes)

            with self._lock:
                converter = self._load_converter()

                source_embedding = converter.extract_se(
                    [str(source_path)]
                )

                audio = converter.convert(
                    audio_src_path=str(source_path),
                    src_se=source_embedding,
                    tgt_se=target_embedding,
                    output_path=None,
                    tau=CONVERSION_TAU,
                )

            native_rate = int(
                converter.hps.data.sampling_rate
            )

        if native_rate != OUTPUT_SAMPLE_RATE:
            audio = librosa.resample(
                audio,
                orig_sr=native_rate,
                target_sr=OUTPUT_SAMPLE_RATE,
            )

        output = BytesIO()

        sf.write(
            output,
            audio,
            OUTPUT_SAMPLE_RATE,
            format="WAV",
            subtype="PCM_16",
        )

        return output.getvalue()


def _run_ffmpeg(
    arguments: list[str],
) -> None:
    """Run ffmpeg quietly and surface a readable failure."""
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                *arguments,
            ],
            check=True,
            capture_output=True,
            timeout=300,
        )
    except FileNotFoundError as error:
        raise RuntimeError(
            "ffmpeg is required for voice cloning."
        ) from error
    except subprocess.CalledProcessError as error:
        raise CloneWorkerError(
            "The voice sample could not be read as audio."
        ) from error


def _probe_duration(
    path: Path,
) -> float:
    """Return an audio file's duration in seconds."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        return float(result.stdout.strip())
    except (
        subprocess.CalledProcessError,
        ValueError,
    ) as error:
        raise CloneWorkerError(
            "The voice sample could not be read as audio."
        ) from error
    except FileNotFoundError as error:
        raise RuntimeError(
            "ffprobe is required for voice cloning."
        ) from error


def _find_sample(
    clone_id: str,
) -> Path:
    """Return the stored sample for one clone."""
    metadata_path = (
        VOICE_CLONE_DIRECTORY
        / clone_id
        / "metadata.json"
    )

    if not metadata_path.is_file():
        raise CloneWorkerError(
            "Voice clone not found."
        )

    metadata = json.loads(
        metadata_path.read_text(encoding="utf-8")
    )

    sample_name = metadata.get("sample_path")

    if (
        not isinstance(sample_name, str)
        or Path(sample_name).name != sample_name
    ):
        raise CloneWorkerError(
            "This voice clone has no sample."
        )

    sample_path = (
        VOICE_CLONE_DIRECTORY
        / clone_id
        / sample_name
    )

    if not sample_path.is_file():
        raise CloneWorkerError(
            "The stored voice sample is missing."
        )

    return sample_path


class CloneRequestHandler(BaseHTTPRequestHandler):
    """Serve health, register and convert requests over localhost."""

    service: VoiceCloneService

    def do_GET(self) -> None:
        """Handle worker health requests."""
        if urlparse(self.path).path != "/health":
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"detail": "Not found."},
            )
            return

        self._send_json(
            HTTPStatus.OK,
            {
                "status": (
                    "online"
                    if self.service.installed
                    else "unavailable"
                ),
                "engine": "OpenVoice",
                "model_loaded": self.service.model_loaded,
            },
        )

    def do_POST(self) -> None:
        """Handle register and convert requests."""
        parsed = urlparse(self.path)
        route = parsed.path

        if route not in {"/register", "/convert"}:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"detail": "Not found."},
            )
            return

        try:
            clone_id = _read_clone_id(parsed.query)

            if route == "/register":
                self._read_body(0)

                result = self.service.register(
                    clone_id,
                    _find_sample(clone_id),
                )

                self._send_json(
                    HTTPStatus.OK,
                    result,
                )
                return

            wav_bytes = self._read_body(
                MAX_CONVERT_BYTES
            )

            if not wav_bytes.startswith(b"RIFF"):
                raise CloneWorkerError(
                    "Request body must be WAV audio."
                )

            audio_bytes = self.service.convert(
                clone_id,
                wav_bytes,
            )
        except CloneWorkerError as error:
            self._send_json(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"detail": str(error)},
            )
            return
        except Exception as error:
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "detail": (
                        "Voice cloning failed: "
                        f"{error}"
                    ),
                },
            )
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/wav")
        self.send_header(
            "Content-Length",
            str(len(audio_bytes)),
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        self.wfile.write(audio_bytes)

    def log_message(
        self,
        format_string: str,
        *arguments: Any,
    ) -> None:
        """Write concise worker request logs."""
        print(
            "[VoiceClone] "
            + (format_string % arguments)
        )

    def _read_body(
        self,
        maximum_bytes: int,
    ) -> bytes:
        """Read one bounded request body."""
        length_value = self.headers.get(
            "Content-Length",
            "0",
        )

        try:
            length = int(length_value)
        except ValueError as error:
            raise CloneWorkerError(
                "Invalid Content-Length."
            ) from error

        if length < 0 or length > maximum_bytes:
            raise CloneWorkerError(
                "Request body size is invalid."
            )

        if length == 0:
            return b""

        return self.rfile.read(length)

    def _send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
    ) -> None:
        """Send one JSON response."""
        body = json.dumps(payload).encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
        self.send_header(
            "Content-Length",
            str(len(body)),
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        self.wfile.write(body)


def _read_clone_id(
    query: str,
) -> str:
    """Return a validated clone ID from a query string."""
    values = parse_qs(query).get("clone_id", [])

    if (
        len(values) != 1
        or not CLONE_ID_PATTERN.fullmatch(values[0])
    ):
        raise CloneWorkerError(
            "A valid clone_id is required."
        )

    return values[0]


def parse_arguments() -> argparse.Namespace:
    """Parse local worker command-line options."""
    parser = argparse.ArgumentParser(
        description=(
            "Run the OpenBook AI voice cloning worker."
        ),
    )

    parser.add_argument(
        "--host",
        default="127.0.0.1",
    )

    parser.add_argument(
        "--port",
        default=8002,
        type=int,
    )

    return parser.parse_args()


def main() -> None:
    """Serve localhost voice cloning requests."""
    arguments = parse_arguments()

    service = VoiceCloneService()

    handler_type = type(
        "ConfiguredCloneRequestHandler",
        (CloneRequestHandler,),
        {"service": service},
    )

    server = ThreadingHTTPServer(
        (
            arguments.host,
            arguments.port,
        ),
        handler_type,
    )

    print(
        "Voice clone worker ready at "
        f"http://{arguments.host}:{arguments.port}"
    )

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
