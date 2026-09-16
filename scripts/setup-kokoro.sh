#!/usr/bin/env bash

PROJECT_DIR="$HOME/openbook-ai"
BACKEND_DIR="$PROJECT_DIR/backend"
KOKORO_DIR="$BACKEND_DIR/data/kokoro"
VENV_DIR="$KOKORO_DIR/.venv"

MODEL_FILE="$KOKORO_DIR/kokoro-v1.0.onnx"
VOICES_FILE="$KOKORO_DIR/voices-v1.0.bin"

AUDITION_DIR="$HOME/kokoro-audition"

MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx"
VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"

echo
echo "Setting up OpenBook Kokoro narration..."
echo

mkdir -p \
    "$KOKORO_DIR"

UV_BIN=""

if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(
        command -v uv
    )"
elif [ -x "$AUDITION_DIR/.uv-bin/uv" ]; then
    UV_BIN="$AUDITION_DIR/.uv-bin/uv"
else
    UV_INSTALL_DIR="$KOKORO_DIR/.uv-bin"

    mkdir -p \
        "$UV_INSTALL_DIR"

    if ! command -v curl >/dev/null 2>&1; then
        echo "ERROR: curl is required to install uv."
        exit 1
    fi

    curl -LsSf \
        https://astral.sh/uv/install.sh \
        | env \
            UV_UNMANAGED_INSTALL="$UV_INSTALL_DIR" \
            sh

    UV_BIN="$UV_INSTALL_DIR/uv"
fi

if [ ! -x "$UV_BIN" ]; then
    echo "ERROR: uv could not be found or installed."
    exit 1
fi

echo "Using:"
"$UV_BIN" --version

echo
echo "Creating isolated Python 3.12 environment..."

"$UV_BIN" venv \
    --python 3.12 \
    "$VENV_DIR"

PYTHON_BIN="$VENV_DIR/bin/python"

echo
"$PYTHON_BIN" --version

echo
echo "Installing Kokoro..."

"$UV_BIN" pip install \
    --python "$PYTHON_BIN" \
    "kokoro-onnx==0.6.1" \
    "soundfile>=0.13"

echo
echo "Preparing model files..."

if [ ! -s "$MODEL_FILE" ]; then
    if [ -s "$AUDITION_DIR/kokoro-v1.0.onnx" ]; then
        echo "Reusing audition Kokoro model."

        cp \
            "$AUDITION_DIR/kokoro-v1.0.onnx" \
            "$MODEL_FILE"
    else
        echo "Downloading Kokoro model."

        curl \
            -fL \
            --retry 3 \
            --progress-bar \
            "$MODEL_URL" \
            -o "$MODEL_FILE"
    fi
else
    echo "Kokoro model already installed."
fi

if [ ! -s "$VOICES_FILE" ]; then
    if [ -s "$AUDITION_DIR/voices-v1.0.bin" ]; then
        echo "Reusing audition voice bundle."

        cp \
            "$AUDITION_DIR/voices-v1.0.bin" \
            "$VOICES_FILE"
    else
        echo "Downloading Kokoro voice bundle."

        curl \
            -fL \
            --retry 3 \
            --progress-bar \
            "$VOICES_URL" \
            -o "$VOICES_FILE"
    fi
else
    echo "Kokoro voice bundle already installed."
fi

echo
echo "Verifying required audiobook voices..."

"$PYTHON_BIN" - <<'PYTHON'
from pathlib import Path

from kokoro_onnx import Kokoro


base_directory = Path.home() / "openbook-ai" / "backend" / "data" / "kokoro"

model_path = (
    base_directory
    / "kokoro-v1.0.onnx"
)

voices_path = (
    base_directory
    / "voices-v1.0.bin"
)

required_voices = {
    "af_heart",
    "af_bella",
    "af_sarah",
    "am_michael",
    "bf_emma",
    "bm_george",
}

kokoro = Kokoro(
    str(model_path),
    str(voices_path),
)

installed_voices = set(
    kokoro.get_voices()
)

missing_voices = (
    required_voices
    - installed_voices
)

if missing_voices:
    raise SystemExit(
        "ERROR: Missing Kokoro voices: "
        + ", ".join(
            sorted(
                missing_voices
            )
        )
    )

print(
    "SUCCESS: All six OpenBook Kokoro voices are available."
)
PYTHON

echo
echo "Installed runtime:"
du -sh \
    "$KOKORO_DIR"

echo
echo "SUCCESS: OpenBook Kokoro setup is complete."
