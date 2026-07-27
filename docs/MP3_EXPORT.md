# MP3 Audiobook Export

OpenBook AI uses FFmpeg and the `libmp3lame` encoder to convert
completed WAV audiobooks into compressed MP3 files.

## Settings

- Channels: mono
- Bitrate: 64 kbps
- Metadata: title and OpenBook AI artist tag
- Output directory: `backend/data/audiobooks/`

## Workflow

1. Generate a complete WAV audiobook.
2. Open `/audiobooks`.
3. Click **Create MP3 export**.
4. Play or download the resulting MP3.

MP3 files are generated locally. No cloud service or paid API is used.
