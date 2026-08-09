"""Book and narration section API routes."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.cover_service import (
    CoverError,
    delete_cover,
    get_cover_info,
    get_cover_media_type,
    require_cover,
    save_cover,
)
from app.database import get_session
from app.document_processing import (
    ALLOWED_EXTENSIONS,
    detect_chapters,
    extract_epub_cover,
    extract_pdf_cover,
    extract_text,
    normalize_text,
    save_upload,
    split_into_narration_sections,
)
from app.models import (
    Book,
    Chapter,
    NarrationSection,
    utc_timestamp,
)
from app.schemas import SectionMove, SectionSplit, SectionUpdate

router = APIRouter()
DatabaseSession = Annotated[Session, Depends(get_session)]


@router.get("/books")
def list_books(
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Return all stored books."""
    statement = select(Book).order_by(Book.created_at.desc())
    books = session.exec(statement).all()

    return [
        serialize_book_summary(
            book,
            count_chapters(session, require_book_id(book)),
        )
        for book in books
    ]


@router.get("/books/{book_id}")
def get_book(
    book_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Return one stored book and its chapters."""
    book = get_existing_book(session, book_id)
    chapters = get_chapters(session, book_id)

    return serialize_book_detail(book, chapters)


@router.post("/books/upload", status_code=201)
async def upload_book(
    file: Annotated[UploadFile, File(description="Book document")],
    session: DatabaseSession,
) -> dict[str, object]:
    """Extract, split, and store a supported book."""
    filename = Path(file.filename or "uploaded-book").name
    extension = Path(filename).suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        supported = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type. Supported types: {supported}",
        )

    temporary_path: Path | None = None
    book_id: int | None = None
    book_committed = False

    try:
        temporary_path, size_bytes = await save_upload(
            file,
            extension,
        )
        text = normalize_text(
            extract_text(temporary_path, extension)
        )

        if not text:
            detail = "No readable text was found."

            if extension == ".pdf":
                detail += " Scanned PDFs will require OCR support."

            raise HTTPException(status_code=422, detail=detail)

        words = text.split()
        chapter_titles = detect_chapters(text)
        section_texts = split_into_narration_sections(text)

        book = Book(
            filename=filename,
            file_type=extension.removeprefix(".").upper(),
            size_bytes=size_bytes,
            character_count=len(text),
            word_count=len(words),
            estimated_minutes=math.ceil(len(words) / 160),
            extracted_text=text,
        )

        session.add(book)
        session.flush()

        book_id = require_book_id(book)

        extracted_cover: tuple[str, bytes] | None = None

        if extension == ".epub":
            extracted_cover = extract_epub_cover(
                temporary_path
            )
        elif extension == ".pdf":
            extracted_cover = extract_pdf_cover(
                temporary_path
            )

        if extracted_cover is not None:
            (
                cover_filename,
                cover_content,
            ) = extracted_cover

            try:
                save_cover(
                    book_id,
                    cover_filename,
                    cover_content,
                )
            except CoverError:
                pass

        chapters = [
            Chapter(
                book_id=book_id,
                position=index,
                title=title,
            )
            for index, title in enumerate(
                chapter_titles,
                start=1,
            )
        ]

        narration_sections = [
            NarrationSection(
                book_id=book_id,
                position=index,
                text=section_text,
                word_count=len(section_text.split()),
            )
            for index, section_text in enumerate(
                section_texts,
                start=1,
            )
        ]

        session.add_all(chapters)
        session.add_all(narration_sections)
        session.commit()
        book_committed = True
        session.refresh(book)

        return serialize_book_detail(book, chapters)
    except HTTPException:
        session.rollback()

        if (
            book_id is not None
            and not book_committed
        ):
            delete_cover(book_id)

        raise
    except Exception as error:
        session.rollback()

        if (
            book_id is not None
            and not book_committed
        ):
            delete_cover(book_id)
        raise HTTPException(
            status_code=500,
            detail=f"The book could not be stored: {error}",
        ) from error
    finally:
        await file.close()

        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


@router.post(
    "/books/{book_id}/cover",
    status_code=201,
)
async def upload_book_cover(
    book_id: int,
    file: Annotated[
        UploadFile,
        File(description="JPG or PNG cover artwork"),
    ],
    session: DatabaseSession,
) -> dict[str, object]:
    """Store custom cover artwork for one book."""
    get_existing_book(
        session,
        book_id,
    )

    try:
        content = await file.read(
            10 * 1024 * 1024 + 1
        )

        save_cover(
            book_id,
            file.filename or "cover",
            content,
        )
    except CoverError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error
    finally:
        await file.close()

    return get_cover_info(book_id)


@router.get("/books/{book_id}/cover")
def get_book_cover(
    book_id: int,
    session: DatabaseSession,
) -> FileResponse:
    """Return custom cover artwork for one book."""
    get_existing_book(
        session,
        book_id,
    )

    try:
        path = require_cover(book_id)
    except CoverError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    return FileResponse(
        path,
        media_type=get_cover_media_type(path),
        filename=path.name,
    )


@router.delete("/books/{book_id}/cover")
def remove_book_cover(
    book_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Delete custom cover artwork."""
    get_existing_book(
        session,
        book_id,
    )

    delete_cover(book_id)

    return {
        "deleted": True,
        "book_id": book_id,
    }


@router.delete("/books/{book_id}")
def delete_book(
    book_id: int,
    session: DatabaseSession,
) -> dict[str, object]:
    """Delete a stored book and its related records."""
    book = get_existing_book(session, book_id)

    for chapter in get_chapters(session, book_id):
        session.delete(chapter)

    for section in get_sections(session, book_id):
        session.delete(section)

    delete_cover(book_id)

    session.delete(book)
    session.commit()

    return {
        "deleted": True,
        "book_id": book_id,
    }


@router.get("/books/{book_id}/sections")
def list_narration_sections(
    book_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Return editable narration sections in reading order."""
    get_existing_book(session, book_id)

    return serialize_sections(
        get_sections(session, book_id)
    )


@router.post("/books/{book_id}/sections/rebuild")
def rebuild_narration_sections(
    book_id: int,
    session: DatabaseSession,
    target_words: Annotated[
        int,
        Query(ge=100, le=1_000),
    ] = 350,
) -> list[dict[str, object]]:
    """Replace existing sections using the original book text."""
    book = get_existing_book(session, book_id)

    for existing_section in get_sections(session, book_id):
        session.delete(existing_section)

    session.flush()

    section_texts = split_into_narration_sections(
        book.extracted_text,
        target_words=target_words,
    )

    new_sections = [
        NarrationSection(
            book_id=book_id,
            position=index,
            text=section_text,
            word_count=len(section_text.split()),
        )
        for index, section_text in enumerate(
            section_texts,
            start=1,
        )
    ]

    session.add_all(new_sections)
    session.commit()

    return serialize_sections(
        get_sections(session, book_id)
    )


@router.patch("/sections/{section_id}")
def update_narration_section(
    section_id: int,
    update: SectionUpdate,
    session: DatabaseSession,
) -> dict[str, object]:
    """Save edited narration text."""
    section = get_existing_section(session, section_id)
    section.text = normalize_text(update.text)
    section.word_count = len(section.text.split())
    section.updated_at = utc_timestamp()

    session.add(section)
    session.commit()
    session.refresh(section)

    return serialize_section(section)


@router.post("/sections/{section_id}/split")
def split_narration_section(
    section_id: int,
    split: SectionSplit,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Split one narration section into two sections."""
    section = get_existing_section(session, section_id)
    first_text = normalize_text(split.first_text)
    second_text = normalize_text(split.second_text)

    if not first_text or not second_text:
        raise HTTPException(
            status_code=422,
            detail="Both split sections must contain text.",
        )

    existing_sections = get_sections(
        session,
        section.book_id,
    )

    for existing_section in reversed(existing_sections):
        if existing_section.position > section.position:
            existing_section.position += 1
            session.add(existing_section)

    section.text = first_text
    section.word_count = len(first_text.split())
    section.updated_at = utc_timestamp()
    session.add(section)

    new_section = NarrationSection(
        book_id=section.book_id,
        position=section.position + 1,
        text=second_text,
        word_count=len(second_text.split()),
    )

    session.add(new_section)
    session.commit()

    return serialize_sections(
        get_sections(session, section.book_id)
    )


@router.post("/sections/{section_id}/merge-next")
def merge_with_next_section(
    section_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Merge a section with the section immediately after it."""
    section = get_existing_section(session, section_id)
    sections = get_sections(session, section.book_id)

    current_index = find_section_index(
        sections,
        section_id,
    )

    if current_index >= len(sections) - 1:
        raise HTTPException(
            status_code=422,
            detail="The final section has no next section to merge.",
        )

    next_section = sections[current_index + 1]

    section.text = normalize_text(
        f"{section.text}\n\n{next_section.text}"
    )
    section.word_count = len(section.text.split())
    section.updated_at = utc_timestamp()

    session.add(section)
    session.delete(next_section)
    session.flush()

    renumber_sections(session, section.book_id)
    session.commit()

    return serialize_sections(
        get_sections(session, section.book_id)
    )


@router.delete("/sections/{section_id}")
def delete_narration_section(
    section_id: int,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Delete one narration section and renumber the rest."""
    section = get_existing_section(session, section_id)
    book_id = section.book_id

    session.delete(section)
    session.flush()

    renumber_sections(session, book_id)
    session.commit()

    return serialize_sections(
        get_sections(session, book_id)
    )


@router.post("/sections/{section_id}/move")
def move_narration_section(
    section_id: int,
    move: SectionMove,
    session: DatabaseSession,
) -> list[dict[str, object]]:
    """Move a section one position up or down."""
    section = get_existing_section(session, section_id)
    sections = get_sections(session, section.book_id)
    current_index = find_section_index(
        sections,
        section_id,
    )

    target_index = (
        current_index - 1
        if move.direction == "up"
        else current_index + 1
    )

    if target_index < 0 or target_index >= len(sections):
        raise HTTPException(
            status_code=422,
            detail=f"The section cannot move {move.direction}.",
        )

    target_section = sections[target_index]

    section.position, target_section.position = (
        target_section.position,
        section.position,
    )

    section.updated_at = utc_timestamp()
    target_section.updated_at = utc_timestamp()

    session.add(section)
    session.add(target_section)
    session.commit()

    return serialize_sections(
        get_sections(session, section.book_id)
    )


def get_existing_book(
    session: Session,
    book_id: int,
) -> Book:
    """Return an existing book or raise a 404 response."""
    book = session.get(Book, book_id)

    if book is None:
        raise HTTPException(
            status_code=404,
            detail="Book not found.",
        )

    return book


def get_existing_section(
    session: Session,
    section_id: int,
) -> NarrationSection:
    """Return an existing narration section."""
    section = session.get(NarrationSection, section_id)

    if section is None:
        raise HTTPException(
            status_code=404,
            detail="Narration section not found.",
        )

    return section


def require_book_id(book: Book) -> int:
    """Return a persisted book identifier."""
    if book.id is None:
        raise RuntimeError("The book has not been stored.")

    return book.id


def get_chapters(
    session: Session,
    book_id: int,
) -> list[Chapter]:
    """Return chapters in reading order."""
    statement = (
        select(Chapter)
        .where(Chapter.book_id == book_id)
        .order_by(Chapter.position)
    )

    return list(session.exec(statement).all())


def get_sections(
    session: Session,
    book_id: int,
) -> list[NarrationSection]:
    """Return narration sections in reading order."""
    statement = (
        select(NarrationSection)
        .where(NarrationSection.book_id == book_id)
        .order_by(
            NarrationSection.position,
            NarrationSection.id,
        )
    )

    return list(session.exec(statement).all())


def count_chapters(
    session: Session,
    book_id: int,
) -> int:
    """Count detected chapters for a book."""
    return len(get_chapters(session, book_id))


def find_section_index(
    sections: list[NarrationSection],
    section_id: int,
) -> int:
    """Find a section's position in an ordered list."""
    for index, section in enumerate(sections):
        if section.id == section_id:
            return index

    raise HTTPException(
        status_code=404,
        detail="Narration section not found.",
    )


def renumber_sections(
    session: Session,
    book_id: int,
) -> None:
    """Assign consecutive positions to all book sections."""
    for position, section in enumerate(
        get_sections(session, book_id),
        start=1,
    ):
        section.position = position
        session.add(section)


def serialize_book_summary(
    book: Book,
    chapter_count: int,
) -> dict[str, object]:
    """Convert a book into a frontend-safe summary."""
    return {
        "id": require_book_id(book),
        "filename": book.filename,
        "file_type": book.file_type,
        "size_bytes": book.size_bytes,
        "character_count": book.character_count,
        "word_count": book.word_count,
        "estimated_minutes": book.estimated_minutes,
        "chapter_count": chapter_count,
        "cover": get_cover_info(
            require_book_id(book)
        ),
        "created_at": book.created_at,
    }


def serialize_book_detail(
    book: Book,
    chapters: list[Chapter],
) -> dict[str, object]:
    """Convert a book and chapters into a detailed response."""
    response = serialize_book_summary(book, len(chapters))

    response.update(
        {
            "preview": book.extracted_text[:5000],
            "chapters": [
                {
                    "id": chapter.id,
                    "position": chapter.position,
                    "title": chapter.title,
                }
                for chapter in chapters
            ],
        }
    )

    return response


def serialize_section(
    section: NarrationSection,
) -> dict[str, object]:
    """Convert a narration section into an API response."""
    estimated_seconds = max(
        1,
        round(section.word_count / 160 * 60),
    )

    return {
        "id": section.id,
        "book_id": section.book_id,
        "position": section.position,
        "text": section.text,
        "word_count": section.word_count,
        "estimated_seconds": estimated_seconds,
        "created_at": section.created_at,
        "updated_at": section.updated_at,
    }


def serialize_sections(
    sections: list[NarrationSection],
) -> list[dict[str, object]]:
    """Convert an ordered collection of sections."""
    return [
        serialize_section(section)
        for section in sections
    ]
