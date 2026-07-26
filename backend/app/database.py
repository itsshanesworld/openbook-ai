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
    """Create all database tables that do not already exist."""
    SQLModel.metadata.create_all(engine)


def get_session() -> Generator[Session, None, None]:
    """Provide one database session per API request."""
    with Session(engine) as session:
        yield session
