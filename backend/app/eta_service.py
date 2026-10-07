"""Time-remaining estimates for audiobook generation.

Generation speed depends mostly on which voices narrate:

* Piper is very fast,
* Kokoro runs a little under real time on a laptop CPU,
* a cloned voice adds a conversion step on top of Kokoro.

Estimates start from measured defaults, then prefer the median speed of
the user's own recently completed jobs with the same voice combination.
A running job is estimated from its own measured pace.
"""

from __future__ import annotations

from datetime import datetime, timezone
from statistics import median
import time

from sqlmodel import Session, select

from app.models import AudiobookJob, NarrationSection


# Generation seconds per second of finished audio, measured on an
# Intel i5-1035G1 laptop CPU with no GPU.
DEFAULT_REALTIME_FACTORS = {
    "piper": 0.12,
    "kokoro": 0.7,
    "clone": 1.6,
}

# Typical share of a novel's audio that is quoted speech.
DIALOGUE_SHARE = 0.25

# Reading a section in several pieces adds per-call overhead.
TWO_VOICE_OVERHEAD = 1.12

WORDS_PER_MINUTE = 160

# Past jobs shorter than this are too noisy to learn from.
MIN_HISTORY_WORDS = 300
MIN_HISTORY_SECONDS = 20.0
HISTORY_JOBS_TO_USE = 5
HISTORY_JOBS_TO_SCAN = 40

# A running job's own pace is trusted once it has done enough work.
MEASURED_MIN_WORDS = 150
MEASURED_MIN_FRACTION = 0.03
MEASURED_MIN_ELAPSED_SECONDS = 20.0

_HISTORY_CACHE_SECONDS = 60.0
_history_cache: dict[str, tuple[float, float | None, int]] = {}


def voice_kind(voice: str | None) -> str:
    """Return the speed class of a narrator identifier."""
    if voice and voice.startswith("clone:"):
        return "clone"

    if voice and voice.startswith("kokoro:"):
        return "kokoro"

    if voice:
        return "piper"

    # Unspecified means the app's default, which is Kokoro when present.
    return "kokoro"


def profile_key(
    voice: str | None,
    dialogue_voice: str | None,
) -> str:
    """Return the voice-combination class used to group past jobs."""
    narrator_kind = voice_kind(voice)

    if dialogue_voice and dialogue_voice != voice:
        return f"{narrator_kind}+{voice_kind(dialogue_voice)}"

    return narrator_kind


def default_factor(
    voice: str | None,
    dialogue_voice: str | None,
) -> float:
    """Return the measured-default generation cost per audio second."""
    narrator_factor = DEFAULT_REALTIME_FACTORS[voice_kind(voice)]

    if not dialogue_voice or dialogue_voice == voice:
        return narrator_factor

    dialogue_factor = DEFAULT_REALTIME_FACTORS[
        voice_kind(dialogue_voice)
    ]

    return (
        (1 - DIALOGUE_SHARE) * narrator_factor
        + DIALOGUE_SHARE * dialogue_factor
    ) * TWO_VOICE_OVERHEAD


def audio_seconds_for_words(
    total_words: int,
    speed: float,
) -> float:
    """Estimate finished audio length from a word count."""
    return max(total_words, 1) / WORDS_PER_MINUTE * 60 / speed


def parse_timestamp(value: str | None) -> datetime | None:
    """Parse a stored ISO timestamp."""
    if not value:
        return None

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed


def get_book_words(
    session: Session,
    book_id: int,
) -> int:
    """Return a book's total narration words."""
    return sum(
        session.exec(
            select(NarrationSection.word_count).where(
                NarrationSection.book_id == book_id
            )
        ).all()
    )


def get_history_factor(
    session: Session,
    key: str,
) -> tuple[float | None, int]:
    """Return (median factor, jobs used) from completed jobs."""
    cached = _history_cache.get(key)
    now = time.monotonic()

    if cached is not None and cached[0] > now:
        return cached[1], cached[2]

    jobs = session.exec(
        select(AudiobookJob)
        .where(
            AudiobookJob.status == "completed",
            AudiobookJob.started_at.is_not(None),  # type: ignore[union-attr]
            AudiobookJob.finished_at.is_not(None),  # type: ignore[union-attr]
        )
        .order_by(AudiobookJob.id.desc())  # type: ignore[union-attr]
        .limit(HISTORY_JOBS_TO_SCAN)
    ).all()

    factors: list[float] = []

    for job in jobs:
        if profile_key(job.voice, job.dialogue_voice) != key:
            continue

        started = parse_timestamp(job.started_at)
        finished = parse_timestamp(job.finished_at)

        if started is None or finished is None:
            continue

        wall_seconds = (finished - started).total_seconds()
        words = get_book_words(session, job.book_id)

        if (
            words < MIN_HISTORY_WORDS
            or wall_seconds < MIN_HISTORY_SECONDS
        ):
            continue

        factors.append(
            wall_seconds
            / audio_seconds_for_words(words, job.speed)
        )

        if len(factors) >= HISTORY_JOBS_TO_USE:
            break

    result = (
        median(factors) if factors else None,
        len(factors),
    )

    _history_cache[key] = (
        now + _HISTORY_CACHE_SECONDS,
        result[0],
        result[1],
    )

    return result


def estimate_generation_seconds(
    session: Session,
    total_words: int,
    speed: float,
    voice: str | None,
    dialogue_voice: str | None,
) -> dict[str, object]:
    """Estimate total generation time before a job starts."""
    audio_seconds = audio_seconds_for_words(total_words, speed)

    history_factor, history_jobs = get_history_factor(
        session,
        profile_key(voice, dialogue_voice),
    )

    if history_factor is not None:
        factor = history_factor
        basis = "history"
    else:
        factor = default_factor(voice, dialogue_voice)
        basis = "default"

    return {
        "seconds": round(audio_seconds * factor),
        "basis": basis,
        "history_jobs": history_jobs,
        "realtime_factor": round(factor, 2),
    }


def estimate_job_remaining(
    session: Session,
    job: AudiobookJob,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Estimate a queued or running job's time left.

    Returns ``eta_seconds`` (None when not applicable), ``basis`` and
    ``elapsed_seconds``. For a queued job ``eta_seconds`` is its full
    expected running time.
    """
    now = now or datetime.now(timezone.utc)

    started = parse_timestamp(job.started_at)
    finished = parse_timestamp(job.finished_at)

    elapsed: float | None = None

    if started is not None:
        end = finished if finished is not None else now
        elapsed = max((end - started).total_seconds(), 0.0)

    if job.status not in {"queued", "running"}:
        return {
            "eta_seconds": None,
            "basis": None,
            "elapsed_seconds": (
                round(elapsed)
                if elapsed is not None
                and job.status == "completed"
                else None
            ),
        }

    total_words = get_book_words(session, job.book_id)

    expected = estimate_generation_seconds(
        session,
        total_words,
        job.speed,
        job.voice,
        job.dialogue_voice,
    )

    expected_seconds = float(expected["seconds"])  # type: ignore[arg-type]

    if job.status == "queued" or elapsed is None:
        return {
            "eta_seconds": round(expected_seconds),
            "basis": expected["basis"],
            "elapsed_seconds": None,
        }

    section_words = session.exec(
        select(NarrationSection.word_count)
        .where(NarrationSection.book_id == job.book_id)
        .order_by(NarrationSection.position)  # type: ignore[arg-type]
    ).all()

    done_words = sum(section_words[: job.completed_sections])

    if (
        done_words >= MEASURED_MIN_WORDS
        and done_words >= MEASURED_MIN_FRACTION * total_words
        and elapsed >= MEASURED_MIN_ELAPSED_SECONDS
    ):
        remaining_words = max(total_words - done_words, 0)

        return {
            "eta_seconds": round(
                elapsed * remaining_words / done_words
            ),
            "basis": "measured",
            "elapsed_seconds": round(elapsed),
        }

    return {
        "eta_seconds": round(max(expected_seconds - elapsed, 0.0)),
        "basis": expected["basis"],
        "elapsed_seconds": round(elapsed),
    }


def estimate_queue_wait_seconds(
    session: Session,
    job: AudiobookJob,
    *,
    now: datetime | None = None,
) -> int | None:
    """Estimate how long until a queued job begins running."""
    if job.status != "queued" or job.id is None:
        return None

    wait = 0

    active_jobs = session.exec(
        select(AudiobookJob).where(
            AudiobookJob.status.in_(  # type: ignore[union-attr]
                ["running", "cancelling"]
            )
        )
    ).all()

    for active in active_jobs:
        remaining = estimate_job_remaining(
            session,
            active,
            now=now,
        )["eta_seconds"]

        wait += int(remaining or 0)

    queued_ahead = session.exec(
        select(AudiobookJob).where(
            AudiobookJob.status == "queued",
            AudiobookJob.id < job.id,  # type: ignore[operator]
        )
    ).all()

    for ahead in queued_ahead:
        total = estimate_job_remaining(
            session,
            ahead,
            now=now,
        )["eta_seconds"]

        wait += int(total or 0)

    return wait
