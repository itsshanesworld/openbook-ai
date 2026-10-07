"""Tests for narration/dialogue splitting and audio joining."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import sys
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.dialogue_service import (  # noqa: E402
    VOICE_CHANGE_GAP_MS,
    DialogueSegment,
    join_wavs,
    split_dialogue,
    synthesize_dialogue,
)


def make_wav(rate: int, seconds: float) -> bytes:
    """Return a silent mono 16-bit WAV."""
    output = BytesIO()

    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(bytes(int(rate * seconds) * 2))

    return output.getvalue()


def frame_count(wav_bytes: bytes) -> tuple[int, int]:
    """Return (frames, sample rate) of a WAV."""
    with wave.open(BytesIO(wav_bytes), "rb") as wav:
        return wav.getnframes(), wav.getframerate()


def pairs(segments: list[DialogueSegment]):
    return [(s.text, s.is_dialogue) for s in segments]


class SplitDialogueTests(unittest.TestCase):
    def test_plain_narration_is_one_segment(self) -> None:
        self.assertEqual(
            pairs(split_dialogue("It was a quiet evening.")),
            [("It was a quiet evening.", False)],
        )

    def test_straight_quotes(self) -> None:
        self.assertEqual(
            pairs(
                split_dialogue(
                    'He said, "Hello there," and left.'
                )
            ),
            [
                ("He said,", False),
                ("Hello there,", True),
                ("and left.", False),
            ],
        )

    def test_curly_quotes(self) -> None:
        self.assertEqual(
            pairs(
                split_dialogue(
                    "She asked, “Are you coming?” He nodded."
                )
            ),
            [
                ("She asked,", False),
                ("Are you coming?", True),
                ("He nodded.", False),
            ],
        )

    def test_apostrophes_are_not_dialogue(self) -> None:
        self.assertEqual(
            pairs(split_dialogue("It's Tom's dog, isn't it?")),
            [("It's Tom's dog, isn't it?", False)],
        )

    def test_odd_straight_quotes_stay_narration(self) -> None:
        text = 'The pipe was 3" wide and badly rusted.'

        self.assertEqual(
            pairs(split_dialogue(text)),
            [(text, False)],
        )

    def test_unterminated_opening_quote_continues_as_dialogue(
        self,
    ) -> None:
        self.assertEqual(
            pairs(
                split_dialogue(
                    "She whispered. “Come closer, and listen"
                )
            ),
            [
                ("She whispered.", False),
                ("Come closer, and listen", True),
            ],
        )

    def test_unmatched_closing_quote_ends_earlier_dialogue(
        self,
    ) -> None:
        self.assertEqual(
            pairs(
                split_dialogue(
                    "and that is the whole story,” he said."
                )
            ),
            [
                ("and that is the whole story,", True),
                ("he said.", False),
            ],
        )

    def test_punctuation_only_runs_are_dropped(self) -> None:
        self.assertEqual(
            pairs(split_dialogue("“...” he said.")),
            [("he said.", False)],
        )

    def test_adjacent_dialogue_is_merged(self) -> None:
        self.assertEqual(
            pairs(split_dialogue('"One." "Two."')),
            [("One. Two.", True)],
        )

    def test_empty_text(self) -> None:
        self.assertEqual(split_dialogue(""), [])


class SynthesizeDialogueTests(unittest.TestCase):
    def test_no_dialogue_uses_one_call_with_original_text(
        self,
    ) -> None:
        calls: list[tuple[str, str | None]] = []

        def synth(text: str, voice: str | None) -> bytes:
            calls.append((text, voice))
            return make_wav(24_000, 1.0)

        synthesize_dialogue(
            "Just narration here.",
            synth,
            "narrator",
            "dialogue",
        )

        self.assertEqual(
            calls,
            [("Just narration here.", "narrator")],
        )

    def test_voices_follow_the_segments(self) -> None:
        calls: list[tuple[str, str | None]] = []

        def synth(text: str, voice: str | None) -> bytes:
            calls.append((text, voice))
            return make_wav(24_000, 1.0)

        audio = synthesize_dialogue(
            'He said, "Hello there," and left.',
            synth,
            "narrator",
            "dialogue",
        )

        self.assertEqual(
            calls,
            [
                ("He said,", "narrator"),
                ("Hello there,", "dialogue"),
                ("and left.", "narrator"),
            ],
        )

        # Three 1 s parts plus a gap at each of the two hand-offs.
        frames, rate = frame_count(audio)
        gap_frames = int(rate * VOICE_CHANGE_GAP_MS / 1000)

        self.assertEqual(rate, 24_000)
        self.assertEqual(frames, 3 * 24_000 + 2 * gap_frames)


class JoinWavsTests(unittest.TestCase):
    def test_resamples_to_first_rate(self) -> None:
        joined = join_wavs(
            [
                make_wav(24_000, 1.0),
                make_wav(22_050, 1.0),
            ]
        )

        frames, rate = frame_count(joined)

        self.assertEqual(rate, 24_000)
        self.assertEqual(frames, 48_000)

    def test_incompatible_formats_raise(self) -> None:
        stereo = BytesIO()

        with wave.open(stereo, "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(24_000)
            wav.writeframes(bytes(24_000 * 4))

        with self.assertRaises(RuntimeError):
            join_wavs([make_wav(24_000, 1.0), stereo.getvalue()])

    def test_nothing_to_join_raises(self) -> None:
        with self.assertRaises(ValueError):
            join_wavs([])


if __name__ == "__main__":
    unittest.main()
