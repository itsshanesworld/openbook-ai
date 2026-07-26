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


def normalize_text(text: str) -> str:
    """Normalize whitespace while retaining paragraphs."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def detect_chapters(text: str) -> list[str]:
    """Detect common chapter headings."""
    pattern = re.compile(
        r"^(chapter|part|book|section)\s+"
        r"([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)"
        r"(?:\s*[:.-]\s*|\s*$|\s+.+)",
        re.IGNORECASE,
    )

    chapters: list[str] = []
    seen: set[str] = set()

    for line in text.splitlines():
        candidate = line.strip()

        if not candidate or len(candidate) > 120:
            continue

        if pattern.match(candidate):
            key = candidate.casefold()

            if key not in seen:
                chapters.append(candidate)
                seen.add(key)

    return chapters


def split_into_narration_sections(
    text: str,
    target_words: int = 350,
) -> list[str]:
    """Split book text into narration-sized, sentence-aware sections."""
    normalized_text = normalize_text(text)

    if not normalized_text:
        return []

    paragraphs = [
        paragraph.strip()
        for paragraph in normalized_text.split("\n\n")
        if paragraph.strip()
    ]

    sections: list[str] = []
    current_parts: list[str] = []
    current_word_count = 0

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

    for paragraph in paragraphs:
        paragraph_word_count = len(paragraph.split())

        if paragraph_word_count <= target_words:
            add_piece(paragraph)
            continue

        sentences = [
            sentence.strip()
            for sentence in re.split(
                r"(?<=[.!?])\s+",
                paragraph,
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

    flush_current_section()

    return sections
