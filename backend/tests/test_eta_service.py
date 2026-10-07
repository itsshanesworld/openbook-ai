"""Tests for audiobook generation time estimates."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

from sqlmodel import Session, SQLModel, create_engine

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import eta_service  # noqa: E402
from app.models import AudiobookJob, NarrationSection  # noqa: E402

NOW = datetime(2026, 10, 10, 12, 0, 0, tzinfo=timezone.utc)


def stamp(seconds_ago: float) -> str:
    return (NOW - timedelta(seconds=seconds_ago)).isoformat()


class EtaTestCase(unittest.TestCase):
    def setUp(self) -> None:
        eta_service._history_cache.clear()

        self.engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)

    def tearDown(self) -> None:
        self.session.close()

    def add_sections(
        self,
        book_id: int,
        count: int,
        words: int,
    ) -> None:
        for position in range(count):
            self.session.add(
                NarrationSection(
                    book_id=book_id,
                    position=position,
                    text="word " * words,
                    word_count=words,
                )
            )

        self.session.commit()

    def add_job(self, **fields) -> AudiobookJob:
        values = {
            "book_id": 1,
            "status": "queued",
            "speed": 1.0,
            "voice": "kokoro:af_heart",
            "total_sections": 10,
        }
        values.update(fields)

        job = AudiobookJob(**values)
        self.session.add(job)
        self.session.commit()
        self.session.refresh(job)

        return job


class VoiceProfileTests(unittest.TestCase):
    def test_voice_kinds(self) -> None:
        self.assertEqual(eta_service.voice_kind("clone:clone-abc"), "clone")
        self.assertEqual(eta_service.voice_kind("kokoro:af_heart"), "kokoro")
        self.assertEqual(eta_service.voice_kind("en_US-lessac-medium"), "piper")
        self.assertEqual(eta_service.voice_kind(None), "kokoro")

    def test_profile_keys(self) -> None:
        self.assertEqual(
            eta_service.profile_key("kokoro:af_heart", None),
            "kokoro",
        )
        self.assertEqual(
            eta_service.profile_key("kokoro:af_heart", "kokoro:af_heart"),
            "kokoro",
        )
        self.assertEqual(
            eta_service.profile_key("kokoro:af_heart", "clone:clone-abc"),
            "kokoro+clone",
        )

    def test_two_voices_cost_more_than_one(self) -> None:
        single = eta_service.default_factor("kokoro:af_heart", None)
        mixed = eta_service.default_factor(
            "kokoro:af_heart",
            "clone:clone-abc",
        )

        self.assertGreater(mixed, single)
        self.assertLess(
            mixed,
            eta_service.default_factor("clone:clone-abc", None) * 1.2,
        )

    def test_piper_is_fastest_and_clone_slowest(self) -> None:
        piper = eta_service.default_factor("en_US-lessac-medium", None)
        kokoro = eta_service.default_factor("kokoro:af_heart", None)
        clone = eta_service.default_factor("clone:clone-abc", None)

        self.assertLess(piper, kokoro)
        self.assertLess(kokoro, clone)


class EstimateGenerationTests(EtaTestCase):
    def test_default_estimate_uses_measured_factor(self) -> None:
        # 9,600 words is one hour of audio at 160 words per minute.
        result = eta_service.estimate_generation_seconds(
            self.session,
            9_600,
            1.0,
            "kokoro:af_heart",
            None,
        )

        self.assertEqual(result["basis"], "default")
        self.assertEqual(result["seconds"], round(3_600 * 0.7))

    def test_faster_speed_means_less_audio_to_generate(self) -> None:
        normal = eta_service.estimate_generation_seconds(
            self.session, 9_600, 1.0, "kokoro:af_heart", None
        )["seconds"]
        fast = eta_service.estimate_generation_seconds(
            self.session, 9_600, 1.5, "kokoro:af_heart", None
        )["seconds"]

        self.assertLess(fast, normal)

    def test_history_overrides_defaults(self) -> None:
        # A 2,000-word book that took 1,500 s: factor = 1500 / 750 = 2.0.
        self.add_sections(book_id=1, count=10, words=200)
        self.add_job(
            status="completed",
            started_at=stamp(1_500),
            finished_at=stamp(0),
        )

        result = eta_service.estimate_generation_seconds(
            self.session,
            9_600,
            1.0,
            "kokoro:af_heart",
            None,
        )

        self.assertEqual(result["basis"], "history")
        self.assertEqual(result["history_jobs"], 1)
        self.assertEqual(result["seconds"], round(3_600 * 2.0))

    def test_history_ignores_a_different_voice_combination(self) -> None:
        self.add_sections(book_id=1, count=10, words=200)
        self.add_job(
            status="completed",
            voice="clone:clone-abc",
            started_at=stamp(1_500),
            finished_at=stamp(0),
        )

        result = eta_service.estimate_generation_seconds(
            self.session,
            9_600,
            1.0,
            "kokoro:af_heart",
            None,
        )

        self.assertEqual(result["basis"], "default")

    def test_tiny_past_jobs_are_ignored(self) -> None:
        self.add_sections(book_id=1, count=2, words=50)
        self.add_job(
            status="completed",
            started_at=stamp(60),
            finished_at=stamp(0),
        )

        result = eta_service.estimate_generation_seconds(
            self.session, 9_600, 1.0, "kokoro:af_heart", None
        )

        self.assertEqual(result["basis"], "default")


class JobRemainingTests(EtaTestCase):
    def test_running_job_uses_its_measured_pace(self) -> None:
        # 1,000 words, 400 done after 400 s -> 600 s to go.
        self.add_sections(book_id=1, count=10, words=100)
        job = self.add_job(
            status="running",
            completed_sections=4,
            started_at=stamp(400),
        )

        result = eta_service.estimate_job_remaining(
            self.session, job, now=NOW
        )

        self.assertEqual(result["basis"], "measured")
        self.assertEqual(result["eta_seconds"], 600)
        self.assertEqual(result["elapsed_seconds"], 400)

    def test_early_running_job_falls_back_to_the_estimate(self) -> None:
        self.add_sections(book_id=1, count=10, words=100)
        job = self.add_job(
            status="running",
            completed_sections=0,
            started_at=stamp(5),
        )

        result = eta_service.estimate_job_remaining(
            self.session, job, now=NOW
        )

        expected_total = eta_service.estimate_generation_seconds(
            self.session, 1_000, 1.0, "kokoro:af_heart", None
        )["seconds"]

        self.assertEqual(result["basis"], "default")
        self.assertEqual(result["eta_seconds"], expected_total - 5)

    def test_queued_job_reports_its_full_expected_time(self) -> None:
        self.add_sections(book_id=1, count=10, words=100)
        job = self.add_job(status="queued")

        result = eta_service.estimate_job_remaining(
            self.session, job, now=NOW
        )

        self.assertIsNone(result["elapsed_seconds"])
        self.assertGreater(result["eta_seconds"], 0)

    def test_completed_job_has_no_eta_but_reports_its_duration(self) -> None:
        self.add_sections(book_id=1, count=10, words=100)
        job = self.add_job(
            status="completed",
            started_at=stamp(300),
            finished_at=stamp(0),
        )

        result = eta_service.estimate_job_remaining(
            self.session, job, now=NOW
        )

        self.assertIsNone(result["eta_seconds"])
        self.assertEqual(result["elapsed_seconds"], 300)

    def test_queue_wait_adds_running_remainder_and_jobs_ahead(self) -> None:
        self.add_sections(book_id=1, count=10, words=100)
        self.add_sections(book_id=2, count=10, words=100)

        running = self.add_job(
            book_id=1,
            status="running",
            completed_sections=4,
            started_at=stamp(400),
        )
        ahead = self.add_job(book_id=2, status="queued")
        mine = self.add_job(book_id=2, status="queued")

        self.assertGreater(ahead.id, running.id)

        ahead_total = eta_service.estimate_job_remaining(
            self.session, ahead, now=NOW
        )["eta_seconds"]

        wait = eta_service.estimate_queue_wait_seconds(
            self.session, mine, now=NOW
        )

        # 600 s left on the running job plus the full queued job ahead.
        self.assertEqual(wait, 600 + ahead_total)

    def test_queue_wait_is_none_for_a_job_that_is_not_queued(self) -> None:
        job = self.add_job(status="running", started_at=stamp(10))

        self.assertIsNone(
            eta_service.estimate_queue_wait_seconds(
                self.session, job, now=NOW
            )
        )


if __name__ == "__main__":
    unittest.main()
