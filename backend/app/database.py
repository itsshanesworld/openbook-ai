"""Database configuration for OpenBook AI."""

from collections.abc import Generator
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
DATA_DIRECTORY = BACKEND_DIRECTORY / "data"
DATABASE_PATH = DATA_DIRECTORY / "openbook.db"

DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{DATABASE_PATH}",
    connect_args={"check_same_thread": False},
)


def create_database_tables() -> None:
    """Create tables and apply lightweight SQLite schema upgrades."""
    SQLModel.metadata.create_all(engine)
    ensure_book_metadata_override_columns()


def ensure_book_metadata_override_columns() -> None:
    """Add editable metadata override columns when upgrading."""
    with engine.begin() as connection:
        rows = connection.exec_driver_sql(
            "PRAGMA table_info(bookmetadata)"
        ).mappings().all()

        if not rows:
            return

        column_names = {
            str(row["name"])
            for row in rows
        }

        if "manual_title" not in column_names:
            connection.exec_driver_sql(
                "ALTER TABLE bookmetadata "
                "ADD COLUMN manual_title VARCHAR"
            )

        if "manual_author" not in column_names:
            connection.exec_driver_sql(
                "ALTER TABLE bookmetadata "
                "ADD COLUMN manual_author VARCHAR"
            )


def get_session() -> Generator[Session, None, None]:
    """Provide one database session per API request."""
    with Session(engine) as session:
        yield session
