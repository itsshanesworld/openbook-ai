"""Database models for OpenBook AI."""

from datetime import datetime, timezone

from sqlalchemy import Column, Text
from sqlmodel import Field, SQLModel


def utc_timestamp() -> str:
    """Return the current UTC timestamp."""
    return datetime.now(timezone.utc).isoformat()


class Book(SQLModel, table=True):
    """Stored source document."""

    id: int | None = Field(default=None, primary_key=True)
    filename: str = Field(index=True)
    file_type: str
    size_bytes: int
    character_count: int
    word_count: int
    estimated_minutes: int
    extracted_text: str = Field(
        sa_column=Column(Text, nullable=False),
    )
    created_at: str = Field(default_factory=utc_timestamp)


class Chapter(SQLModel, table=True):
    """Detected chapter heading."""

    id: int | None = Field(default=None, primary_key=True)
    book_id: int = Field(foreign_key="book.id", index=True)
    position: int
    title: str


class NarrationSection(SQLModel, table=True):
    """Editable narration-sized portion of a book."""

    id: int | None = Field(default=None, primary_key=True)
    book_id: int = Field(foreign_key="book.id", index=True)
    position: int
    text: str = Field(
        sa_column=Column(Text, nullable=False),
    )
    word_count: int
    created_at: str = Field(default_factory=utc_timestamp)
    updated_at: str = Field(default_factory=utc_timestamp)
