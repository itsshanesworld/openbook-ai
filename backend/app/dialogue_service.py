"""Split narration from quoted dialogue and join the resulting audio.

Used for the "two voices in one book" feature: dialogue inside double
quotation marks is read by a second narrator.

Only double quotes are treated as dialogue markers (straight "..." and
curly “...”). Single quotes are ignored because apostrophes make them
ambiguous.

A quotation can span several narration sections. ``plan_quote_contexts``
looks across the whole book once, before generation, and records which
sections begin inside an open quote and which leave one open.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from io import BytesIO
import re
import wave

import numpy as np


OPENING_QUOTE = "“"
CLOSING_QUOTE = "”"
STRAIGHT_QUOTE = '"'

# Silence inserted where the voice changes, so hand-offs don't sound
# clipped.
VOICE_CHANGE_GAP_MS = 140

# An open quote is only carried into following sections if it is closed
# within this many sections; otherwise it was almost certainly a stray
# mark and carrying it would flip the voices for the rest of the book.
MAX_CARRY_SECTIONS = 3

_SPOKEN_CONTENT = re.compile(r"\w")


@dataclass(frozen=True, slots=True)
class DialogueSegment:
    """One run of text read by a single voice."""

    text: str
    is_dialogue: bool


@dataclass(frozen=True, slots=True)
class QuoteContext:
    """Quote state at the edges of one narration section."""

    starts_in_dialogue: bool = False
    continues_after: bool = False


DEFAULT_QUOTE_CONTEXT = QuoteContext()


def split_dialogue(
    text: str,
    context: QuoteContext = DEFAULT_QUOTE_CONTEXT,
) -> list[DialogueSegment]:
    """Split text into narration and quoted-dialogue segments.

    Unbalanced quotes degrade gracefully:

    * a closing curly quote with no opener makes the text before it
      dialogue (the quote opened in an earlier section);
    * an opening quote that is never closed makes the rest dialogue
      (the quote continues into the next section);
    * an odd number of straight quotes with no curly quotes is
      ambiguous, so the whole text is read as narration - unless the
      surrounding sections confirm a quote spans the boundary.

    ``context`` comes from :func:`plan_quote_contexts`.
    """
    segments, _ = _tokenize(
        text,
        context.starts_in_dialogue,
        odd_straight_is_narration=(
            not context.starts_in_dialogue
            and not context.continues_after
        ),
    )

    return _clean(segments)


def plan_quote_contexts(
    texts: Sequence[str],
) -> list[QuoteContext]:
    """Work out, for every section, whether a quote spans its edges."""
    contexts: list[QuoteContext] = []
    state = False

    for index, text in enumerate(texts):
        _, ends_open = _tokenize(
            text,
            state,
            odd_straight_is_narration=False,
        )

        continues = ends_open and _closes_soon(
            texts,
            index + 1,
        )

        contexts.append(
            QuoteContext(
                starts_in_dialogue=state,
                continues_after=continues,
            )
        )
        state = continues

    return contexts


def _tokenize(
    text: str,
    start_in_quote: bool,
    *,
    odd_straight_is_narration: bool,
) -> tuple[list[DialogueSegment], bool]:
    """Split text on quotes; also report whether a quote is left open."""
    has_curly = (
        OPENING_QUOTE in text
        or CLOSING_QUOTE in text
    )

    if (
        odd_straight_is_narration
        and not start_in_quote
        and not has_curly
        and text.count(STRAIGHT_QUOTE) % 2 == 1
    ):
        return [DialogueSegment(text, False)], False

    segments: list[DialogueSegment] = []
    buffer: list[str] = []
    in_quote = start_in_quote

    def flush(is_dialogue: bool) -> None:
        if buffer:
            segments.append(
                DialogueSegment(
                    "".join(buffer),
                    is_dialogue,
                )
            )
            buffer.clear()

    for character in text:
        if character == OPENING_QUOTE:
            flush(in_quote)
            in_quote = True
        elif character == CLOSING_QUOTE:
            # With no opener, everything so far was dialogue.
            flush(True)
            in_quote = False
        elif character == STRAIGHT_QUOTE:
            flush(in_quote)
            in_quote = not in_quote
        else:
            buffer.append(character)

    flush(in_quote)

    return segments, in_quote


def _closes_soon(
    texts: Sequence[str],
    start: int,
) -> bool:
    """Whether an open quote is properly closed in the next sections."""
    for offset in range(MAX_CARRY_SECTIONS):
        index = start + offset

        if index >= len(texts):
            return False

        candidate = texts[index]

        if not any(
            mark in candidate
            for mark in (
                OPENING_QUOTE,
                CLOSING_QUOTE,
                STRAIGHT_QUOTE,
            )
        ):
            # Still inside the quote; keep looking.
            continue

        return _begins_by_closing(candidate)

    return False


def _begins_by_closing(text: str) -> bool:
    """Whether a section's first quote mark closes an earlier quote."""
    first_close = text.find(CLOSING_QUOTE)
    first_open = text.find(OPENING_QUOTE)

    if first_close != -1 or first_open != -1:
        return first_close != -1 and (
            first_open == -1 or first_close < first_open
        )

    # Straight quotes only: a closer plus balanced pairs is odd.
    return text.count(STRAIGHT_QUOTE) % 2 == 1


def _clean(
    segments: list[DialogueSegment],
) -> list[DialogueSegment]:
    """Drop empty or punctuation-only runs and merge neighbours."""
    cleaned: list[DialogueSegment] = []

    for segment in segments:
        stripped = segment.text.strip()

        if not _SPOKEN_CONTENT.search(stripped):
            continue

        if (
            cleaned
            and cleaned[-1].is_dialogue
            == segment.is_dialogue
        ):
            cleaned[-1] = DialogueSegment(
                f"{cleaned[-1].text} {stripped}",
                segment.is_dialogue,
            )
        else:
            cleaned.append(
                DialogueSegment(
                    stripped,
                    segment.is_dialogue,
                )
            )

    return cleaned


def synthesize_dialogue(
    text: str,
    synthesize_segment: Callable[[str, str | None], bytes],
    narrator_voice: str | None,
    dialogue_voice: str,
    context: QuoteContext = DEFAULT_QUOTE_CONTEXT,
) -> bytes:
    """Read narration and dialogue with their own voices as one WAV.

    ``synthesize_segment(text, voice)`` must return WAV bytes. Text
    with no dialogue is passed through untouched, in a single call.
    """
    segments = split_dialogue(text, context)

    if not any(
        segment.is_dialogue for segment in segments
    ):
        return synthesize_segment(
            text,
            narrator_voice,
        )

    parts: list[bytes] = []
    gaps: list[bool] = []
    previous_was_dialogue: bool | None = None

    for segment in segments:
        parts.append(
            synthesize_segment(
                segment.text,
                dialogue_voice
                if segment.is_dialogue
                else narrator_voice,
            )
        )
        gaps.append(
            previous_was_dialogue is not None
            and previous_was_dialogue
            != segment.is_dialogue
        )
        previous_was_dialogue = segment.is_dialogue

    return join_wavs(
        parts,
        gap_before=gaps,
    )


def join_wavs(
    wavs: list[bytes],
    *,
    gap_before: list[bool] | None = None,
) -> bytes:
    """Concatenate WAV files, resampling to the first file's rate.

    ``gap_before[i]`` inserts a short silence before part ``i``.
    """
    if not wavs:
        raise ValueError("There is no audio to join.")

    target_rate = 0
    target_channels = 0
    target_width = 0
    chunks: list[bytes] = []

    for index, wav_bytes in enumerate(wavs):
        with wave.open(BytesIO(wav_bytes), "rb") as source:
            channels = source.getnchannels()
            width = source.getsampwidth()
            rate = source.getframerate()
            frames = source.readframes(source.getnframes())

        if index == 0:
            target_rate = rate
            target_channels = channels
            target_width = width

        if (
            channels != target_channels
            or width != target_width
        ):
            raise RuntimeError(
                "The two narrators produce incompatible audio "
                "formats and can't be combined."
            )

        if rate != target_rate:
            frames = _resample(
                frames,
                width,
                channels,
                rate,
                target_rate,
            )

        if (
            gap_before is not None
            and index < len(gap_before)
            and gap_before[index]
        ):
            silent_frames = int(
                target_rate
                * VOICE_CHANGE_GAP_MS
                / 1000
            )
            chunks.append(
                bytes(
                    silent_frames
                    * target_channels
                    * target_width
                )
            )

        chunks.append(frames)

    output = BytesIO()

    with wave.open(output, "wb") as combined:
        combined.setnchannels(target_channels)
        combined.setsampwidth(target_width)
        combined.setframerate(target_rate)
        combined.writeframes(b"".join(chunks))

    return output.getvalue()


def _resample(
    frames: bytes,
    width: int,
    channels: int,
    source_rate: int,
    target_rate: int,
) -> bytes:
    """Linearly resample 16-bit PCM audio."""
    if width != 2:
        raise RuntimeError(
            "Only 16-bit audio can be resampled."
        )

    samples = np.frombuffer(
        frames,
        dtype="<i2",
    ).reshape(-1, channels)

    source_length = samples.shape[0]

    if source_length == 0:
        return frames

    target_length = max(
        1,
        round(
            source_length
            * target_rate
            / source_rate
        ),
    )

    source_positions = np.arange(source_length)
    target_positions = np.linspace(
        0,
        source_length - 1,
        target_length,
    )

    resampled = np.empty(
        (target_length, channels),
        dtype="<i2",
    )

    for channel in range(channels):
        resampled[:, channel] = np.rint(
            np.interp(
                target_positions,
                source_positions,
                samples[:, channel].astype(np.float64),
            )
        ).astype("<i2")

    return resampled.tobytes()
