"""Long-lived local Kokoro narration worker for OpenBook AI."""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import threading
from typing import Any

from kokoro_onnx import Kokoro
import soundfile as sf


BACKEND_DIRECTORY = Path(__file__).resolve().parent
KOKORO_DIRECTORY = BACKEND_DIRECTORY / "data" / "kokoro"
MODEL_PATH = KOKORO_DIRECTORY / "kokoro-v1.0.onnx"
VOICES_PATH = KOKORO_DIRECTORY / "voices-v1.0.bin"

MAX_REQUEST_BYTES = 250_000

SUPPORTED_VOICES = {
    "af_heart",
    "af_bella",
    "af_sarah",
    "am_michael",
    "bf_emma",
    "bm_george",
}


class KokoroService:
    """Load Kokoro once and serialize local synthesis requests."""

    def __init__(
        self,
        model_path: Path,
        voices_path: Path,
    ) -> None:
        if not model_path.is_file():
            raise RuntimeError(
                f"Kokoro model is missing: {model_path}"
            )

        if not voices_path.is_file():
            raise RuntimeError(
                f"Kokoro voice bundle is missing: {voices_path}"
            )

        self._engine = Kokoro(
            str(model_path),
            str(voices_path),
        )

        installed_voices = set(
            self._engine.get_voices()
        )

        missing_voices = (
            SUPPORTED_VOICES
            - installed_voices
        )

        if missing_voices:
            raise RuntimeError(
                "Kokoro voice bundle is missing required voices: "
                + ", ".join(
                    sorted(
                        missing_voices
                    )
                )
            )

        self._lock = threading.Lock()

    @property
    def voices(self) -> list[str]:
        """Return OpenBook's supported Kokoro narrators."""
        return sorted(
            SUPPORTED_VOICES
        )

    def synthesize(
        self,
        text: str,
        voice: str,
        speed: float,
    ) -> bytes:
        """Generate one uncompressed PCM WAV response."""
        cleaned_text = " ".join(
            text.split()
        )

        if not cleaned_text:
            raise ValueError(
                "Speech text cannot be blank."
            )

        if voice not in SUPPORTED_VOICES:
            raise ValueError(
                f"Unsupported Kokoro voice: {voice}"
            )

        if not 0.75 <= speed <= 1.5:
            raise ValueError(
                "Narration speed must be between 0.75 and 1.5."
            )

        language = (
            "en-gb"
            if voice.startswith(
                ("bf_", "bm_")
            )
            else "en-us"
        )

        with self._lock:
            samples, sample_rate = (
                self._engine.create(
                    cleaned_text,
                    voice=voice,
                    speed=speed,
                    lang=language,
                )
            )

        audio_buffer = BytesIO()

        sf.write(
            audio_buffer,
            samples,
            sample_rate,
            format="WAV",
            subtype="PCM_16",
        )

        audio_bytes = (
            audio_buffer.getvalue()
        )

        if not audio_bytes.startswith(
            b"RIFF"
        ):
            raise RuntimeError(
                "Kokoro did not produce a valid WAV file."
            )

        return audio_bytes


class KokoroRequestHandler(
    BaseHTTPRequestHandler
):
    """Serve health and speech requests over localhost HTTP."""

    service: KokoroService

    def do_GET(self) -> None:
        """Handle worker health requests."""
        if self.path != "/health":
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {
                    "detail": "Not found.",
                },
            )
            return

        self._send_json(
            HTTPStatus.OK,
            {
                "status": "online",
                "engine": "Kokoro",
                "voices": self.service.voices,
            },
        )

    def do_POST(self) -> None:
        """Handle one Kokoro synthesis request."""
        if self.path != "/synthesize":
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {
                    "detail": "Not found.",
                },
            )
            return

        try:
            payload = self._read_json_body()

            text = payload.get(
                "text"
            )
            voice = payload.get(
                "voice"
            )
            speed = payload.get(
                "speed",
                1.0,
            )

            if not isinstance(
                text,
                str,
            ):
                raise ValueError(
                    "text must be a string."
                )

            if not isinstance(
                voice,
                str,
            ):
                raise ValueError(
                    "voice must be a string."
                )

            if not isinstance(
                speed,
                (int, float),
            ):
                raise ValueError(
                    "speed must be numeric."
                )

            audio_bytes = (
                self.service.synthesize(
                    text,
                    voice,
                    float(speed),
                )
            )
        except (
            ValueError,
            json.JSONDecodeError,
        ) as error:
            self._send_json(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {
                    "detail": str(error),
                },
            )
            return
        except Exception as error:
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "detail": (
                        "Kokoro synthesis failed: "
                        f"{error}"
                    ),
                },
            )
            return

        self.send_response(
            HTTPStatus.OK
        )
        self.send_header(
            "Content-Type",
            "audio/wav",
        )
        self.send_header(
            "Content-Length",
            str(
                len(audio_bytes)
            ),
        )
        self.send_header(
            "Cache-Control",
            "no-store",
        )
        self.end_headers()

        self.wfile.write(
            audio_bytes
        )

    def log_message(
        self,
        format_string: str,
        *arguments: Any,
    ) -> None:
        """Write concise worker request logs."""
        print(
            "[Kokoro] "
            + (
                format_string
                % arguments
            )
        )

    def _read_json_body(
        self,
    ) -> dict[str, Any]:
        """Read and validate one bounded JSON request."""
        content_length_value = (
            self.headers.get(
                "Content-Length"
            )
        )

        if content_length_value is None:
            raise ValueError(
                "Content-Length is required."
            )

        try:
            content_length = int(
                content_length_value
            )
        except ValueError as error:
            raise ValueError(
                "Invalid Content-Length."
            ) from error

        if (
            content_length <= 0
            or content_length
            > MAX_REQUEST_BYTES
        ):
            raise ValueError(
                "Request body size is invalid."
            )

        raw_body = self.rfile.read(
            content_length
        )

        payload = json.loads(
            raw_body.decode(
                "utf-8"
            )
        )

        if not isinstance(
            payload,
            dict,
        ):
            raise ValueError(
                "Request body must be a JSON object."
            )

        return payload

    def _send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
    ) -> None:
        """Send one JSON response."""
        body = json.dumps(
            payload
        ).encode(
            "utf-8"
        )

        self.send_response(
            status
        )
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
        self.send_header(
            "Content-Length",
            str(
                len(body)
            ),
        )
        self.send_header(
            "Cache-Control",
            "no-store",
        )
        self.end_headers()

        self.wfile.write(
            body
        )


def parse_arguments() -> argparse.Namespace:
    """Parse local worker command-line options."""
    parser = argparse.ArgumentParser(
        description=(
            "Run the OpenBook AI Kokoro worker."
        ),
    )

    parser.add_argument(
        "--host",
        default="127.0.0.1",
    )

    parser.add_argument(
        "--port",
        default=8001,
        type=int,
    )

    return parser.parse_args()


def main() -> None:
    """Load Kokoro and serve localhost requests."""
    arguments = parse_arguments()

    service = KokoroService(
        MODEL_PATH,
        VOICES_PATH,
    )

    handler_type = type(
        "ConfiguredKokoroRequestHandler",
        (KokoroRequestHandler,),
        {
            "service": service,
        },
    )

    server = ThreadingHTTPServer(
        (
            arguments.host,
            arguments.port,
        ),
        handler_type,
    )

    print(
        "Kokoro worker ready at "
        f"http://{arguments.host}:{arguments.port}"
    )

    print(
        "Voices: "
        + ", ".join(
            service.voices
        )
    )

    try:
        server.serve_forever(
            poll_interval=0.25
        )
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
