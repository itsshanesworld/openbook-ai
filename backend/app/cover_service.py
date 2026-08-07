"""Local audiobook cover artwork storage."""

from __future__ import annotations

from pathlib import Path

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
COVER_DIRECTORY = BACKEND_DIRECTORY / "data" / "covers"

MAX_COVER_SIZE_BYTES = 10 * 1024 * 1024

COVER_DIRECTORY.mkdir(
    parents=True,
    exist_ok=True,
)


class CoverError(RuntimeError):
    """Raised when cover artwork is invalid."""


def save_cover(
    book_id: int,
    filename: str,
    content: bytes,
) -> Path:
    """Validate and store one cover image for a book."""
    if not content:
        raise CoverError(
            "The cover image is empty."
        )

    if len(content) > MAX_COVER_SIZE_BYTES:
        raise CoverError(
            "The cover image is larger than 10 MB."
        )

    image_extension = detect_image_extension(
        content
    )

    supplied_extension = (
        Path(filename).suffix.casefold()
    )

    allowed_extensions = {
        ".jpg",
        ".jpeg",
        ".png",
        "",
    }

    if supplied_extension not in allowed_extensions:
        raise CoverError(
            "Cover artwork must be a JPG or PNG image."
        )

    if (
        supplied_extension in {".jpg", ".jpeg"}
        and image_extension != ".jpg"
    ):
        raise CoverError(
            "The uploaded file is not a valid JPG image."
        )

    if (
        supplied_extension == ".png"
        and image_extension != ".png"
    ):
        raise CoverError(
            "The uploaded file is not a valid PNG image."
        )

    delete_cover(book_id)

    output_path = (
        COVER_DIRECTORY
        / f"book-{book_id}{image_extension}"
    )

    temporary_path = output_path.with_name(
        f".{output_path.name}.temporary"
    )

    temporary_path.unlink(
        missing_ok=True,
    )

    try:
        temporary_path.write_bytes(content)
        temporary_path.replace(output_path)
    finally:
        temporary_path.unlink(
            missing_ok=True,
        )

    return output_path


def detect_image_extension(
    content: bytes,
) -> str:
    """Return the supported image type from its signature."""
    if content.startswith(
        b"\x89PNG\r\n\x1a\n"
    ):
        return ".png"

    if content.startswith(
        b"\xff\xd8\xff"
    ):
        return ".jpg"

    raise CoverError(
        "The uploaded file is not a valid JPG or PNG image."
    )


def get_cover_path(
    book_id: int,
) -> Path | None:
    """Return the stored cover for one book."""
    for extension in (
        ".jpg",
        ".png",
    ):
        path = (
            COVER_DIRECTORY
            / f"book-{book_id}{extension}"
        )

        if (
            path.is_file()
            and path.stat().st_size > 0
        ):
            return path

    return None


def get_cover_info(
    book_id: int,
) -> dict[str, object]:
    """Return frontend-safe cover information."""
    path = get_cover_path(book_id)

    if path is None:
        return {
            "available": False,
            "filename": None,
            "size_bytes": None,
            "media_type": None,
        }

    return {
        "available": True,
        "filename": path.name,
        "size_bytes": path.stat().st_size,
        "media_type": get_cover_media_type(path),
    }


def get_cover_media_type(
    path: Path,
) -> str:
    """Return the HTTP media type for a stored cover."""
    if path.suffix.casefold() == ".png":
        return "image/png"

    return "image/jpeg"


def require_cover(
    book_id: int,
) -> Path:
    """Return an existing cover or raise."""
    path = get_cover_path(book_id)

    if path is None:
        raise CoverError(
            "This book does not have cover artwork."
        )

    return path


def delete_cover(
    book_id: int,
) -> None:
    """Delete all stored cover artwork for one book."""
    for extension in (
        ".jpg",
        ".png",
    ):
        (
            COVER_DIRECTORY
            / f"book-{book_id}{extension}"
        ).unlink(
            missing_ok=True,
        )
