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


class BookMetadata(SQLModel, table=True):
    """Persistent metadata belonging to one source book."""

    id: int | None = Field(
        default=None,
        primary_key=True,
    )

    book_id: int = Field(
        foreign_key="book.id",
        index=True,
        unique=True,
    )

    title: str | None = None
    author: str | None = None
    manual_title: str | None = None
    manual_author: str | None = None
    source: str = "epub"

    created_at: str = Field(
        default_factory=utc_timestamp,
    )

    updated_at: str = Field(
        default_factory=utc_timestamp,
    )


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


class AudiobookJob(SQLModel, table=True):
    """Persistent complete-audiobook generation job."""

    id: int | None = Field(default=None, primary_key=True)
    book_id: int = Field(foreign_key="book.id", index=True)
    status: str = Field(default="queued", index=True)
    speed: float = 1.0
    voice: str | None = None
    total_sections: int
    completed_sections: int = 0
    output_filename: str | None = None
    output_path: str | None = None
    output_size_bytes: int | None = None
    error_message: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
    )
    created_at: str = Field(default_factory=utc_timestamp)
    updated_at: str = Field(default_factory=utc_timestamp)


class AudiobookSectionTiming(SQLModel, table=True):
    """Audio timestamps for one narration section."""

    id: int | None = Field(default=None, primary_key=True)

    job_id: int = Field(
        foreign_key="audiobookjob.id",
        index=True,
    )

    section_id: int = Field(
        foreign_key="narrationsection.id",
        index=True,
    )

    position: int

    start_ms: int

    end_ms: int

