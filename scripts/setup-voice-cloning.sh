#!/usr/bin/env bash
# Installs OpenBook's optional local voice cloning engine (OpenVoice v2).
#
# Everything is installed under backend/data/voice_clone/ in an isolated
# Python 3.12 environment, like Kokoro. Nothing leaves this machine except
# the one-time downloads below.

set -e

PROJECT_DIR="$HOME/openbook-ai"
# OPENBOOK_VOICE_CLONE_DIR is only meant for testing the installer.
CLONE_DIR="${OPENBOOK_VOICE_CLONE_DIR:-$PROJECT_DIR/backend/data/voice_clone}"
VENV_DIR="$CLONE_DIR/.venv"
REPO_DIR="$CLONE_DIR/OpenVoice"
CHECKPOINT_DIR="$CLONE_DIR/ov_ckpt"

OPENVOICE_REPO="https://github.com/myshell-ai/OpenVoice.git"
CHECKPOINT_REPO="myshell-ai/OpenVoiceV2"

echo
echo "Setting up OpenBook voice cloning (OpenVoice v2)..."
echo

mkdir -p "$CLONE_DIR"

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ERROR: ffmpeg is required. Install it with: sudo apt install ffmpeg"
    exit 1
fi

UV_BIN=""

if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
elif [ -x "$PROJECT_DIR/backend/data/kokoro/.uv-bin/uv" ]; then
    UV_BIN="$PROJECT_DIR/backend/data/kokoro/.uv-bin/uv"
elif [ -x "$HOME/kokoro-audition/.uv-bin/uv" ]; then
    UV_BIN="$HOME/kokoro-audition/.uv-bin/uv"
else
    echo "ERROR: uv was not found. Run ./scripts/setup-kokoro.sh first;"
    echo "it installs uv, which this script reuses."
    exit 1
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "Creating isolated Python 3.12 environment..."
    "$UV_BIN" venv --python 3.12 "$VENV_DIR"
fi

PYTHON_BIN="$VENV_DIR/bin/python"

echo
echo "Installing PyTorch (CPU build)..."

"$UV_BIN" pip install \
    --python "$PYTHON_BIN" \
    torch torchaudio \
    --index-url https://download.pytorch.org/whl/cpu

echo
echo "Installing audio and text-processing packages..."

"$UV_BIN" pip install \
    --python "$PYTHON_BIN" \
    numpy scipy librosa soundfile pydub inflect unidecode \
    eng_to_ipa pypinyin cn2an jieba langid huggingface_hub

echo
echo "Fetching the OpenVoice code..."

if [ ! -d "$REPO_DIR" ]; then
    git clone --depth 1 "$OPENVOICE_REPO" "$REPO_DIR"
else
    echo "OpenVoice code already present."
fi

echo
echo "Downloading the OpenVoice v2 converter checkpoint (~130 MB)..."

if [ ! -s "$CHECKPOINT_DIR/converter/checkpoint.pth" ]; then
    "$PYTHON_BIN" - <<PYTHON
from huggingface_hub import snapshot_download

snapshot_download(
    "$CHECKPOINT_REPO",
    allow_patterns=["converter/*"],
    local_dir="$CHECKPOINT_DIR",
)
PYTHON
    rm -rf "$CHECKPOINT_DIR/.cache"
else
    echo "Checkpoint already present."
fi

echo
echo "Verifying the converter loads..."

"$PYTHON_BIN" - <<PYTHON
import sys
sys.path.insert(0, "$REPO_DIR")
from openvoice.api import ToneColorConverter  # noqa: F401
print("SUCCESS: OpenVoice imports correctly.")
PYTHON

echo
du -sh "$CLONE_DIR"
echo
echo "SUCCESS: Voice cloning is installed."
echo "Restart ./scripts/start-dev.sh to start the voice cloning worker."
