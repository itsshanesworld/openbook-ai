#!/usr/bin/env bash

PROJECT_DIR="$HOME/openbook-ai"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"

KOKORO_DIR="$BACKEND_DIR/data/kokoro"
KOKORO_PYTHON="$KOKORO_DIR/.venv/bin/python"
KOKORO_WORKER="$BACKEND_DIR/kokoro_worker.py"
KOKORO_MODEL="$KOKORO_DIR/kokoro-v1.0.onnx"
KOKORO_VOICES="$KOKORO_DIR/voices-v1.0.bin"

CLONE_DIR="$BACKEND_DIR/data/voice_clone"
CLONE_PYTHON="$CLONE_DIR/.venv/bin/python"
CLONE_WORKER="$BACKEND_DIR/voice_clone_worker.py"
CLONE_CHECKPOINT="$CLONE_DIR/ov_ckpt/converter/checkpoint.pth"

KOKORO_PID=""
CLONE_PID=""
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo
    echo "Stopping OpenBook AI..."

    if [ -n "$CLONE_PID" ]; then
        kill "$CLONE_PID" 2>/dev/null || true
    fi

    if [ -n "$FRONTEND_PID" ]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi

    if [ -n "$BACKEND_PID" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi

    if [ -n "$KOKORO_PID" ]; then
        kill "$KOKORO_PID" 2>/dev/null || true
    fi

    wait 2>/dev/null || true

    echo "OpenBook AI stopped."
}

trap cleanup EXIT INT TERM

echo
echo "Starting OpenBook AI..."
echo

if (
    [ -x "$KOKORO_PYTHON" ] &&
    [ -f "$KOKORO_WORKER" ] &&
    [ -s "$KOKORO_MODEL" ] &&
    [ -s "$KOKORO_VOICES" ]
); then
    echo "Starting Kokoro audiobook narration worker..."

    "$KOKORO_PYTHON" \
        "$KOKORO_WORKER" \
        --host 127.0.0.1 \
        --port 8001 &

    KOKORO_PID=$!

    KOKORO_READY=""

    for ATTEMPT in         1 2 3 4 5 6 7 8 9 10         11 12 13 14 15 16 17 18 19 20         21 22 23 24 25 26 27 28 29 30
    do
        if curl             -fsS             http://127.0.0.1:8001/health             >/dev/null             2>&1
        then
            KOKORO_READY="yes"
            break
        fi

        if ! kill -0 "$KOKORO_PID" 2>/dev/null; then
            break
        fi

        sleep 1
    done

    if [ "$KOKORO_READY" = "yes" ]; then
        echo "Kokoro audiobook narration worker is ready."
    else
        echo "WARNING: Kokoro did not become ready."
        echo "Continuing with Piper fallback voices."

        kill "$KOKORO_PID" 2>/dev/null || true
        wait "$KOKORO_PID" 2>/dev/null || true

        KOKORO_PID=""
    fi
else
    echo "Kokoro is not installed; Piper voices will remain available."
    echo "Run ./scripts/setup-kokoro.sh to install Kokoro."
fi

if (
    [ -x "$CLONE_PYTHON" ] &&
    [ -f "$CLONE_WORKER" ] &&
    [ -s "$CLONE_CHECKPOINT" ]
); then
    echo "Starting voice cloning worker..."

    "$CLONE_PYTHON" \
        "$CLONE_WORKER" \
        --host 127.0.0.1 \
        --port 8002 &

    CLONE_PID=$!

    CLONE_READY=""

    for ATTEMPT in 1 2 3 4 5 6 7 8 9 10
    do
        if curl -fsS http://127.0.0.1:8002/health >/dev/null 2>&1
        then
            CLONE_READY="yes"
            break
        fi

        if ! kill -0 "$CLONE_PID" 2>/dev/null; then
            break
        fi

        sleep 1
    done

    if [ "$CLONE_READY" = "yes" ]; then
        echo "Voice cloning worker is ready."
    else
        echo "WARNING: The voice cloning worker did not become ready."
        echo "Cloned voices will be unavailable."

        kill "$CLONE_PID" 2>/dev/null || true
        wait "$CLONE_PID" 2>/dev/null || true

        CLONE_PID=""
    fi
else
    echo "Voice cloning is not installed (optional)."
    echo "Run ./scripts/setup-voice-cloning.sh to install it."
fi

cd "$BACKEND_DIR" || {
    echo "ERROR: Backend folder not found."
    exit 1
}

if [ ! -f ".venv/bin/activate" ]; then
    echo "ERROR: Python virtual environment is missing."
    exit 1
fi

source .venv/bin/activate

uvicorn main:app \
    --reload \
    --host 0.0.0.0 \
    --port 8000 &

BACKEND_PID=$!

cd "$FRONTEND_DIR" || {
    echo "ERROR: Frontend folder not found."
    exit 1
}

npm run dev &

FRONTEND_PID=$!

echo
echo "OpenBook AI is starting."
echo
echo "Main app:      http://localhost:3000"
echo "Audiobooks:    http://localhost:3000/audiobooks"
echo "Backend API:   http://localhost:8000/docs"

if [ -n "$KOKORO_PID" ]; then
    echo "Kokoro worker: http://127.0.0.1:8001"
fi

if [ -n "$CLONE_PID" ]; then
    echo "Voice cloning: http://127.0.0.1:8002"
fi

echo
echo "Press Ctrl+C when you want to stop everything."
echo

wait
