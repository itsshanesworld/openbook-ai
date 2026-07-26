# Local Text-to-Speech

OpenBook AI uses Piper for free local narration previews.

## Default Voice

- Engine: Piper
- Voice: `en_US-lessac-medium`
- Output: WAV
- Processing: Local CPU
- Cloud API: None

Voice model files are stored under:

`backend/data/voices/`

This directory is excluded from Git.

## Install

Activate the backend environment:

`source backend/.venv/bin/activate`

Install Piper:

`python -m pip install piper-tts`

Download the default voice:

`python -m piper.download_voices --data-dir backend/data/voices en_US-lessac-medium`

## Configuration

Set another installed model with:

`OPENBOOK_PIPER_VOICE=en_US-example-medium`

The matching `.onnx` and `.onnx.json` files must exist in
`backend/data/voices/`.

## Licensing

Piper is a third-party GPL-3.0 project.

Voice models may have their own licenses. Review each voice's
`MODEL_CARD` before redistributing or using it in a public service.
