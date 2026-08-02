#!/usr/bin/env bash

PROJECT_DIR="$HOME/openbook-ai"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo
    echo "Stopping OpenBook AI..."

    if [ -n "$BACKEND_PID" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi

    if [ -n "$FRONTEND_PID" ]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi

    wait 2>/dev/null || true

    echo "OpenBook AI stopped."
}

trap cleanup EXIT INT TERM

echo
echo "Starting OpenBook AI..."
echo

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
echo "Main app:    http://localhost:3000"
echo "Audiobooks:  http://localhost:3000/audiobooks"
echo "Backend API: http://localhost:8000/docs"
echo
echo "Press Ctrl+C when you want to stop everything."
echo

wait
