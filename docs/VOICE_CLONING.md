# Voice Cloning

OpenBook AI can narrate audiobooks in the user's own voice. Everything
runs locally on CPU; no audio is sent to any cloud service.

## How It Works

1. The user records (or uploads) 20-60 seconds of their own voice.
2. A local worker computes a *speaker embedding* from that sample and
   stores it with the clone.
3. When a cloned voice narrates, Kokoro first generates the speech
   using a **starting narrator** chosen at creation time. OpenVoice v2's
   tone-color converter then re-colours that audio to match the
   user's voice.

The result takes on the user's tone and timbre, but the pacing and
expression still come from the starting narrator. It is a voice
*conversion*, not a full clone of how the person reads.

A male voice usually sounds best on a male starting narrator (for
example Michael), and a female voice on a female one.

## Requirements

- Kokoro installed and running (`./scripts/setup-kokoro.sh`)
- `ffmpeg` and `ffprobe` on the PATH
- About 1.5 GB of disk space and ~1 GB of free RAM during conversion
- No GPU required

## Install

`./scripts/setup-voice-cloning.sh`

This creates an isolated Python 3.12 environment under
`backend/data/voice_clone/` containing PyTorch (CPU build), the
OpenVoice code and the OpenVoice v2 converter checkpoint.
`backend/data/` is excluded from Git.

`./scripts/start-dev.sh` starts the voice cloning worker automatically
when it is installed. Without it, the app works normally and cloned
voices are simply unavailable.

## Using It

Open the audiobooks page, expand **Your cloned voices**, then:

1. Choose **Record now** (read the passage aloud) or **Upload a file**.
2. Name the voice and pick a starting narrator.
3. Confirm the recording is your own voice, or that you have the
   speaker's permission.
4. Press **Create my voice**.

The new voice appears among the Featured narrators and works with
previews, audiobook generation and MP3/M4B export like any other
narrator.

Tips for a good sample: a quiet room, steady distance from the
microphone, natural storytelling pace, and at least 30 seconds.

## Privacy And Consent

- Samples, embeddings and metadata are stored only under
  `backend/data/voice_clones/<clone id>/`.
- A clone cannot be created without the consent confirmation; the
  confirmation time is stored in `metadata.json` as `consent_at`.
- Deleting a clone removes its sample and embedding. Audiobooks that
  were already generated are not changed.
- Only clone voices you have the right to use.

## Performance

Measured on a Surface laptop (Intel i5-1035G1, 8 GB RAM, no GPU):

| Step | Speed |
| --- | --- |
| Kokoro narration | about 0.5x real time |
| Voice conversion | about 0.5x real time |
| Combined | about 1x real time |

Cloned narration is therefore roughly twice as slow as plain Kokoro.
The converter loads on first use (a few seconds) and stays in memory
until the worker stops.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/voice-clones` | List clones and whether the engine is online |
| `POST` | `/voice-clones` | Create a clone (multipart: `name`, `consent`, `base_voice`, `sample`) |
| `POST` | `/voice-clones/{id}/prepare` | Re-prepare a clone, for example after the worker was offline |
| `DELETE` | `/voice-clones/{id}` | Delete a clone and its files |

Cloned narrators use the voice ID `clone:<clone id>` everywhere a
narrator ID is accepted.

The worker (`backend/voice_clone_worker.py`, default port 8002) exposes
`/health`, `/register` and `/convert`. Override its address with
`OPENBOOK_VOICE_CLONE_URL`.

## Troubleshooting

- **Voice cloning is not installed:** run
  `./scripts/setup-voice-cloning.sh` and restart `start-dev.sh`.
- **Sample too short:** use at least 10 seconds of speech.
- **Cloned voice missing from the list:** the worker or Kokoro is not
  running. Check the terminal running `start-dev.sh`.
- **Generation stops or a worker disappears:** WSL may have run out of
  memory. Raise the limit in `%UserProfile%\.wslconfig`, for example
  `memory=5GB`, then run `wsl --shutdown`.
- **Microphone blocked:** allow it from the address bar's site
  settings, and use `localhost` rather than an IP address.

## Licensing

OpenVoice v2 is released under the MIT License by MyShell.ai. Review
the license shown on the checkpoint's Hugging Face page
(`myshell-ai/OpenVoiceV2`) before redistributing it or using it in a
public service. Kokoro and Piper have their own licenses; see
`docs/TTS.md`.
