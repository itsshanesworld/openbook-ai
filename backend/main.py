"""OpenBook AI backend application."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.audiobook_queue import (
    start_audiobook_queue,
)
from app.audiobook_service import (
    recover_interrupted_audiobook_jobs,
)
from app.database import create_database_tables
from app.routers.audiobooks import router as audiobooks_router
from app.routers.books import router as books_router
from app.routers.tts import router as tts_router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Initialize persistent application resources."""
    create_database_tables()
    recover_interrupted_audiobook_jobs()
    start_audiobook_queue()
    yield


app = FastAPI(
    title="OpenBook AI API",
    description="Open-source audiobook creation API.",
    version="0.7.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-OpenBook-Preview-Truncated",
        "X-OpenBook-Preview-Characters",
    ],
)

app.include_router(books_router)
app.include_router(tts_router)
app.include_router(audiobooks_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Return basic API information."""
    return {
        "name": "OpenBook AI API",
        "version": "0.7.0",
    }


@app.get("/health")
def health_check() -> dict[str, str]:
    """Return the backend health status."""
    return {"status": "online"}
