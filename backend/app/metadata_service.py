"""Shared book metadata lookup and resolution services."""

from pathlib import Path
import re

from sqlmodel import Session, select

from app.document_processing import detect_chapters
from app.models import Book, BookMetadata


AUTOMATIC_AUTHOR_PLACEHOLDERS = frozenset(
    {
        "python-docx",
    }
)

def get_book_metadata(
    session: Session,
    book_id: int,
) -> BookMetadata | None:
    """Return stored metadata for one book."""
    return session.exec(
        select(BookMetadata).where(
            BookMetadata.book_id == book_id
        )
    ).first()


def clean_book_metadata_value(
    value: str | None,
) -> str | None:
    """Normalize a metadata value."""
    if value is None:
        return None

    cleaned = " ".join(
        value.split()
    ).strip()

    return cleaned or None


def clean_automatic_author_metadata_value(
    value: str | None,
) -> str | None:
    """Normalize automatic author metadata and reject generators."""
    cleaned = clean_book_metadata_value(
        value
    )

    if (
        cleaned is not None
        and cleaned.casefold()
        in AUTOMATIC_AUTHOR_PLACEHOLDERS
    ):
        return None

    return cleaned


def first_nonempty_value(
    *values: str | None,
) -> str | None:
    """Return the first usable metadata value."""
    for value in values:
        cleaned = clean_book_metadata_value(
            value
        )

        if cleaned is not None:
            return cleaned

    return None


def serialize_book_metadata(
    metadata: BookMetadata | None,
) -> dict[str, object]:
    """Convert stored book metadata for API responses."""
    if metadata is None:
        return {
            "title": None,
            "author": None,
            "automatic_title": None,
            "automatic_author": None,
            "manual_title": None,
            "manual_author": None,
            "source": None,
        }

    manual_title = clean_book_metadata_value(
        metadata.manual_title
    )

    manual_author = clean_book_metadata_value(
        metadata.manual_author
    )

    automatic_title = clean_book_metadata_value(
        metadata.title
    )

    automatic_author = (
        clean_automatic_author_metadata_value(
            metadata.author
        )
    )

    manual_override_active = (
        manual_title is not None
        or manual_author is not None
    )

    return {
        "title": (
            manual_title
            if manual_title is not None
            else automatic_title
        ),
        "author": (
            manual_author
            if manual_author is not None
            else automatic_author
        ),
        "automatic_title": automatic_title,
        "automatic_author": automatic_author,
        "manual_title": manual_title,
        "manual_author": manual_author,
        "source": (
            "manual"
            if manual_override_active
            else metadata.source
        ),
    }


def resolve_book_metadata(
    book: Book,
    session: Session,
    *,
    fallback_title: str | None = None,
    use_text_fallback: bool = True,
) -> tuple[str, str | None]:
    """Resolve the effective title and author for one book."""
    if book.id is None:
        raise ValueError(
            "The book must be stored before resolving metadata."
        )

    metadata = get_book_metadata(
        session,
        book.id,
    )

    resolved_fallback_title = (
        clean_book_metadata_value(
            fallback_title
        )
        or Path(book.filename).stem
        or book.filename
        or "OpenBook AI Audiobook"
    )

    title: str | None = None
    author: str | None = None

    if metadata is not None:
        title = first_nonempty_value(
            metadata.manual_title,
            metadata.title,
        )

        author = first_nonempty_value(
            metadata.manual_author,
            clean_automatic_author_metadata_value(
                metadata.author
            ),
        )

    if use_text_fallback:
        if title is None:
            title = detect_title_from_text(
                book.extracted_text,
                resolved_fallback_title,
            )

        if author is None:
            author = detect_author_from_text(
                book.extracted_text
            )

    return (
        title or resolved_fallback_title,
        author,
    )


def detect_title_from_text(
    text: str,
    fallback_title: str,
) -> str:
    """Detect a plausible title near the start of book text."""
    ignored_starts = (
        "chapter ",
        "part ",
        "section ",
        "book ",
        "introduction",
        "prologue",
        "preface",
        "foreword",
        "epilogue",
        "afterword",
        "contents",
        "table of contents",
        "copyright",
        "by ",
    )

    candidates = [
        " ".join(line.split())
        for line in text.splitlines()
        if line.strip()
    ]

    for candidate in candidates[:12]:
        normalized = candidate.casefold()

        if not candidate:
            continue

        if len(candidate) > 120:
            continue

        if len(candidate.split()) > 18:
            continue

        if normalized.startswith(
            ignored_starts
        ):
            continue

        if "http://" in normalized:
            continue

        if "https://" in normalized:
            continue

        if "@" in candidate:
            continue

        if "©" in candidate:
            continue

        if not any(
            character.isalpha()
            for character in candidate
        ):
            continue

        return candidate

    return fallback_title


def detect_author_from_text(
    text: str,
) -> str | None:
    """Detect an explicit author byline before book content."""
    chapter_headings = {
        " ".join(title.split()).casefold()
        for title in detect_chapters(text)
    }

    author_pattern = re.compile(
        r"^(?:by\s+|written\s+by\s+|author\s*[:.-]\s*)"
        r"(.+)$",
        re.IGNORECASE,
    )

    for raw_line in text.splitlines():
        candidate = " ".join(
            raw_line.split()
        )

        if not candidate:
            continue

        normalized = candidate.casefold()

        if normalized in chapter_headings:
            break

        match = author_pattern.match(
            candidate
        )

        if match is None:
            continue

        author = match.group(1).strip(
            " .:-"
        )

        if not author:
            continue

        if len(author) > 100:
            continue

        if len(author.split()) > 12:
            continue

        if not any(
            character.isalpha()
            for character in author
        ):
            continue

        return author

    return None
