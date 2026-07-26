"""OpenBook AI backend application."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import create_database_tables
from app.routers.books import router as books_router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Initialize persistent application resources."""
    create_database_tables()
    yield


app = FastAPI(
    title="OpenBook AI API",
    description="Open-source audiobook preparation API.",
    version="0.3.0",
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
)

app.include_router(books_router)


@app.get("/")
def read_root() -> dict[str, str]:
    """Return basic API information."""
    return {
        "name": "OpenBook AI API",
        "version": "0.3.0",
    }


@app.get("/health")
def health_check() -> dict[str, str]:
    """Return the backend health status."""
    return {"status": "online"}
