"""Request schemas for OpenBook AI."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class SectionUpdate(BaseModel):
    """Editable narration section content."""

    text: str = Field(min_length=1, max_length=50_000)

    @field_validator("text")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        """Reject text containing only whitespace."""
        cleaned_value = value.strip()

        if not cleaned_value:
            raise ValueError("Section text cannot be blank.")

        return cleaned_value


class SectionSplit(BaseModel):
    """Text portions produced by splitting a section."""

    first_text: str = Field(min_length=1, max_length=50_000)
    second_text: str = Field(min_length=1, max_length=50_000)

    @field_validator("first_text", "second_text")
    @classmethod
    def reject_blank_parts(cls, value: str) -> str:
        """Reject empty split portions."""
        cleaned_value = value.strip()

        if not cleaned_value:
            raise ValueError("Both split sections must contain text.")

        return cleaned_value


class SectionMove(BaseModel):
    """Direction used to reorder a narration section."""

    direction: Literal["up", "down"]


class TtsPreviewRequest(BaseModel):
    """Local speech preview settings."""

    text: str | None = Field(
        default=None,
        max_length=50_000,
    )
    speed: float = Field(
        default=1.0,
        ge=0.75,
        le=1.5,
    )

    @field_validator("text")
    @classmethod
    def reject_blank_preview_text(
        cls,
        value: str | None,
    ) -> str | None:
        """Reject explicitly provided blank preview text."""
        if value is None:
            return None

        cleaned_value = value.strip()

        if not cleaned_value:
            raise ValueError("Preview text cannot be blank.")

        return cleaned_value
