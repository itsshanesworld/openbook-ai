"""Request schemas for OpenBook AI."""

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
