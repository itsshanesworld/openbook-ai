"""Document extraction and narration splitting services."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Callable

import ebooklib
import pymupdf
from bs4 import BeautifulSoup
from docx import Document
from ebooklib import epub
from fastapi import HTTPException, UploadFile

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
ALLOWED_EXTENSIONS = {".pdf", ".epub", ".docx", ".txt"}


async def save_upload(
    upload: UploadFile,
    extension: str,
) -> tuple[Path, int]:
    """Store an upload temporarily while enforcing its size limit."""
    descriptor, filename = tempfile.mkstemp(suffix=extension)
    os.close(descriptor)

    path = Path(filename)
    size_bytes = 0

    try:
        with path.open("wb") as destination:
            while chunk := await upload.read(1024 * 1024):
                size_bytes += len(chunk)

                if size_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="The maximum upload size is 25 MB.",
                    )

                destination.write(chunk)

        return path, size_bytes
    except Exception:
        path.unlink(missing_ok=True)
        raise


def extract_text(path: Path, extension: str) -> str:
    """Extract text using the appropriate document reader."""
    extractors: dict[str, Callable[[Path], str]] = {
        ".txt": extract_txt,
        ".pdf": extract_pdf,
        ".docx": extract_docx,
        ".epub": extract_epub,
    }

    try:
        return extractors[extension](path)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=422,
            detail=f"Could not process the document: {error}",
        ) from error


def extract_txt(path: Path) -> str:
    """Read a plain-text document."""
    content = path.read_bytes()

    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue

    raise ValueError("The text encoding could not be recognized.")


def extract_pdf(path: Path) -> str:
    """Read text from a text-based PDF."""
    with pymupdf.open(path) as document:
        return "\n\n".join(
            page.get_text("text")
            for page in document
        )


def extract_pdf_cover(
    path: Path,
) -> tuple[str, bytes] | None:
    """Render the first PDF page as PNG cover artwork."""
    with pymupdf.open(path) as document:
        if document.page_count < 1:
            return None

        page = document[0]

        pixmap = page.get_pixmap(
            dpi=144,
            alpha=False,
        )

        content = pixmap.tobytes("png")

    if not content.startswith(
        b"\x89PNG\r\n\x1a\n"
    ):
        return None

    return "cover.png", content


def extract_docx(path: Path) -> str:
    """Read paragraphs and tables from a DOCX file."""
    document = Document(path)
    sections: list[str] = []

    sections.extend(
        paragraph.text.strip()
        for paragraph in document.paragraphs
        if paragraph.text.strip()
    )

    for table in document.tables:
        for row in table.rows:
            row_text = " | ".join(
                cell.text.strip()
                for cell in row.cells
                if cell.text.strip()
            )

            if row_text:
                sections.append(row_text)

    return "\n\n".join(sections)


def extract_epub(path: Path) -> str:
    """Read text from EPUB document sections."""
    book = epub.read_epub(str(path))
    sections: list[str] = []

    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")

        for element in soup(["script", "style", "nav"]):
            element.decompose()

        section = soup.get_text("\n", strip=True)

        if section:
            sections.append(section)

    return "\n\n".join(sections)


def extract_epub_cover(
    path: Path,
) -> tuple[str, bytes] | None:
    """Extract JPG or PNG cover artwork from an EPUB."""
    book = epub.read_epub(str(path))

    cover_item = find_epub_cover_item(book)

    if cover_item is None:
        return None

    content = bytes(
        cover_item.get_content()
    )

    extension = detect_epub_cover_extension(
        content
    )

    if extension is None:
        return None

    name_getter = getattr(
        cover_item,
        "get_name",
        None,
    )

    if callable(name_getter):
        item_name = str(name_getter())
    else:
        item_name = str(
            getattr(
                cover_item,
                "file_name",
                "cover",
            )
        )

    filename = Path(item_name).name

    if not filename.casefold().endswith(
        (
            ".jpg",
            ".jpeg",
            ".png",
        )
    ):
        filename = f"cover{extension}"

    return filename, content


def find_epub_cover_item(
    book: epub.EpubBook,
) -> object | None:
    """Find the most likely EPUB cover manifest item."""
    candidates: list[object] = []
    seen_ids: set[int] = set()

    def add_candidate(
        item: object | None,
    ) -> None:
        if item is None:
            return

        identity = id(item)

        if identity in seen_ids:
            return

        candidates.append(item)
        seen_ids.add(identity)

    for item in book.get_items_of_type(
        ebooklib.ITEM_COVER
    ):
        add_candidate(item)

    for _, attributes in book.get_metadata(
        "OPF",
        "cover",
    ):
        cover_id = attributes.get("content")

        if cover_id:
            add_candidate(
                book.get_item_with_id(
                    cover_id
                )
            )

    all_items = list(book.get_items())

    for item in all_items:
        properties = getattr(
            item,
            "properties",
            [],
        )

        if isinstance(properties, str):
            property_names = properties.split()
        else:
            property_names = list(
                properties or []
            )

        if "cover-image" in property_names:
            add_candidate(item)

    for item in book.get_items_of_type(
        ebooklib.ITEM_IMAGE
    ):
        name_getter = getattr(
            item,
            "get_name",
            None,
        )

        if callable(name_getter):
            item_name = str(
                name_getter()
            )
        else:
            item_name = str(
                getattr(
                    item,
                    "file_name",
                    "",
                )
            )

        if "cover" in item_name.casefold():
            add_candidate(item)

    for candidate in candidates:
        try:
            content = bytes(
                candidate.get_content()
            )
        except Exception:
            continue

        if (
            detect_epub_cover_extension(
                content
            )
            is not None
        ):
            return candidate

    return None


def detect_epub_cover_extension(
    content: bytes,
) -> str | None:
    """Recognize cover formats supported by OpenBook AI."""
    if content.startswith(
        b"\x89PNG\r\n\x1a\n"
    ):
        return ".png"

    if content.startswith(
        b"\xff\xd8\xff"
    ):
        return ".jpg"

    return None


def normalize_text(text: str) -> str:
    """Normalize whitespace while retaining paragraphs."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def detect_chapters(text: str) -> list[str]:
    """Detect common numbered and standalone book headings."""
    numbered_pattern = re.compile(
        r"^(chapter|part|book|section)\s+"
        r"([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)"
        r"(?:\s*[:.-]\s*|\s*$|\s+.+)",
        re.IGNORECASE,
    )

    standalone_pattern = re.compile(
        r"^(introduction|prologue|preface|foreword|epilogue|afterword)"
        r"(?:\s*[:.-]\s*.+)?$",
        re.IGNORECASE,
    )

    chapters: list[str] = []
    seen: set[str] = set()

    for line in text.splitlines():
        candidate = line.strip()

        if not candidate or len(candidate) > 120:
            continue

        is_heading = (
            numbered_pattern.match(candidate)
            or standalone_pattern.match(candidate)
        )

        if not is_heading:
            continue

        key = candidate.casefold()

        if key not in seen:
            chapters.append(candidate)
            seen.add(key)

    return chapters


def split_into_narration_sections(
    text: str,
    target_words: int = 350,
) -> list[str]:
    """Split narration while keeping chapter boundaries intact."""
    normalized_text = normalize_text(text)

    if not normalized_text:
        return []

    chapter_headings = {
        heading.casefold()
        for heading in detect_chapters(normalized_text)
    }

    paragraphs = [
        paragraph.strip()
        for paragraph in normalized_text.split("\n\n")
        if paragraph.strip()
    ]

    sections: list[str] = []
    current_parts: list[str] = []
    current_word_count = 0
    chapter_heading_seen = False

    def flush_current_section() -> None:
        nonlocal current_parts
        nonlocal current_word_count

        if current_parts:
            sections.append("\n\n".join(current_parts).strip())
            current_parts = []
            current_word_count = 0

    def add_piece(piece: str) -> None:
        nonlocal current_word_count

        piece = piece.strip()

        if not piece:
            return

        piece_word_count = len(piece.split())

        if (
            current_parts
            and current_word_count + piece_word_count > target_words
        ):
            flush_current_section()

        current_parts.append(piece)
        current_word_count += piece_word_count

        if current_word_count >= target_words:
            flush_current_section()

    def add_size_aware_piece(piece: str) -> None:
        piece = piece.strip()

        if not piece:
            return

        if len(piece.split()) <= target_words:
            add_piece(piece)
            return

        sentences = [
            sentence.strip()
            for sentence in re.split(
                r"(?<=[.!?])\s+",
                piece,
            )
            if sentence.strip()
        ]

        for sentence in sentences:
            words = sentence.split()

            if len(words) <= target_words:
                add_piece(sentence)
                continue

            for start in range(0, len(words), target_words):
                add_piece(
                    " ".join(words[start : start + target_words])
                )

    def split_at_chapter_headings(
        paragraph: str,
    ) -> list[tuple[str, bool]]:
        lines = [
            line.strip()
            for line in paragraph.splitlines()
            if line.strip()
        ]

        if not lines:
            return []

        pieces: list[tuple[str, bool]] = []
        current_lines: list[str] = []
        starts_with_heading = False

        for line in lines:
            is_heading = line.casefold() in chapter_headings

            if is_heading:
                if current_lines:
                    pieces.append(
                        (
                            "\n".join(current_lines),
                            starts_with_heading,
                        )
                    )

                current_lines = [line]
                starts_with_heading = True
                continue

            current_lines.append(line)

        if current_lines:
            pieces.append(
                (
                    "\n".join(current_lines),
                    starts_with_heading,
                )
            )

        return pieces

    for paragraph in paragraphs:
        pieces = split_at_chapter_headings(paragraph)

        for piece, starts_with_heading in pieces:
            if starts_with_heading:
                if chapter_heading_seen:
                    flush_current_section()

                chapter_heading_seen = True

            add_size_aware_piece(piece)

    flush_current_section()

    return sections
