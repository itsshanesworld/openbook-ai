# OpenBook AI

**Transform books and documents into professional audiobooks using open-source AI.**

OpenBook AI is a free, open-source platform that converts EPUB, PDF, and DOCX files into complete audiobooks. It features local text-to-speech narration, chapter detection, MP3 export, and an intuitive web interface—all running on your machine with no cloud dependency.

## Features

- 📚 **Multi-format Support**: Upload EPUB, PDF, and DOCX files
- 🎙️ **Local Text-to-Speech**: Piper-powered narration on your CPU (no cloud API required)
- 📖 **Automatic Chapter Detection**: Intelligent chapter parsing with manual override
- ✏️ **Section Editing**: Fine-tune narration text before synthesis
- 🎵 **Audio Formats**: Generate WAV or MP3 audiobooks with adjustable playback speed
- 💾 **Storage Management**: Local file organization with disk usage tracking
- 🚀 **Full-Stack App**: Standalone application with zero external dependencies

## Stack

- **Frontend**: TypeScript, Next.js 16, React 19, Tailwind CSS 4
- **Backend**: Python, FastAPI 0.140, SQLModel/SQLAlchemy, Piper TTS
- **Database**: SQLite (local)
- **Notable Libraries**:
  - `piper-tts` — local speech synthesis
  - `EbookLib` — EPUB parsing
  - `PyMuPDF` — PDF text extraction
  - `python-docx` — DOCX document handling
  - `fastapi`, `uvicorn` — REST API and server

## How It's Organized

```
openbook-ai/
  backend/                 FastAPI server and services
    app/
      routers/             HTTP endpoints (books, tts, audiobooks)
      audiobook_service.py Audiobook job processing and state
      tts_service.py       Text-to-speech synthesis pipeline
      document_processing.py File parsing and chapter detection
      models.py            SQLModel definitions (Book, Chapter, AudiobookJob)
      database.py          SQLite connection and table creation
      storage_service.py   File I/O and cleanup
    main.py                FastAPI application entry point
    requirements.txt       Python dependencies
  
  frontend/                Next.js web application
    app/
      page.tsx             Home page (book upload, editor)
      audiobooks/          Audiobook list and player
      layout.tsx           Root layout with styling
    package.json           Node.js dependencies (Next, React, Tailwind)
  
  docs/
    TTS.md                 Piper voice model setup guide
    MP3_EXPORT.md          MP3 encoding configuration
  
  scripts/
    start-dev.sh           Unified startup script (backend + frontend)
```

### How It Fits Together

1. **File Upload & Parsing**: User uploads a book file via the Next.js frontend to the FastAPI backend. The `document_processing` module extracts text, detects chapters, and chunks content into narration sections stored in SQLite.

2. **Text-to-Speech Preview**: The TTS router (`/tts/voice-preview`, `/sections/{id}/audio-preview`) uses Piper to generate WAV samples for voice selection and section editing without committing to a full audiobook.

3. **Audiobook Generation**: When the user starts an audiobook job, `audiobook_service` queues synthesis tasks. Each narration section is synthesized to WAV sequentially via the background queue (`audiobook_queue`), and progress is tracked in the database.

4. **Export & Storage**: Completed audiobooks are stored in `backend/data/audiobooks/`. Users can download the WAV directly or trigger MP3 export via `export_service`, which uses FFmpeg to compress to 64 kbps mono MP3 with metadata.

## How to Run It

### Prerequisites

- Python 3.9+
- Node.js 18+
- FFmpeg (for MP3 export)

### Quick Start

**1. Clone and set up the Python backend:**

```bash
git clone https://github.com/itsshanesworld/openbook-ai.git
cd openbook-ai/backend

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Download a Piper voice model (required for TTS)
python -m piper.download_voices --data-dir data/voices en_US-lessac-medium
```

**2. Set up the frontend:**

```bash
cd ../frontend
npm install
```

**3. Start the application:**

**Option A: Use the convenience script (Linux/macOS):**
```bash
cd ..
bash scripts/start-dev.sh
```

**Option B: Manual startup:**

Terminal 1 (Backend):
```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Terminal 2 (Frontend):
```bash
cd frontend
npm run dev
```

**4. Access the application:**
- **Main App**: http://localhost:3000
- **Audiobooks**: http://localhost:3000/audiobooks
- **Backend API Docs**: http://localhost:8000/docs

## Configuration

### Environment Variables

Set these in your shell or `.env` file:

- `OPENBOOK_PIPER_VOICE` — Override the default voice model (default: `en_US-lessac-medium`)
  - Example: `OPENBOOK_PIPER_VOICE=en_US-example-medium`

### Voice Models

Download additional Piper voices:
```bash
python -m piper.download_voices --data-dir backend/data/voices <voice_name>
```

List available voices: https://github.com/rhasspy/piper#voices

### Data Storage

- Voice models: `backend/data/voices/` (excluded from Git)
- Audiobooks: `backend/data/audiobooks/` (excluded from Git)
- Database: `openbook-ai.db` (SQLite, in backend root)

## API Endpoints

### Books
- `GET /books` — List uploaded books
- `POST /books` — Upload a book file
- `GET /books/{book_id}` — Get book details
- `GET /books/{book_id}/chapters` — List detected chapters
- `GET /books/{book_id}/sections` — List narration sections
- `PUT /sections/{section_id}` — Edit section text

### Text-to-Speech
- `GET /tts/status` — Check Piper availability
- `POST /tts/voice-preview` — Generate voice sample WAV
- `POST /sections/{section_id}/audio-preview` — Preview section narration

### Audiobooks
- `POST /audiobooks` — Create a new audiobook job
- `GET /audiobooks` — List all audiobook jobs
- `GET /audiobooks/{job_id}` — Get job status and progress
- `POST /audiobooks/{job_id}/cancel` — Cancel an in-progress job
- `POST /audiobooks/{job_id}/export-mp3` — Export WAV to MP3

Full API documentation: http://localhost:8000/docs

## Testing

Run the test suite:

```bash
cd backend
pytest
```

## License

OpenBook AI is released under the [MIT License](LICENSE).

### Third-Party Dependencies

- **Piper TTS** — [GPL-3.0](https://github.com/rhasspy/piper) (voice synthesis)
- **EbookLib** — [AGPL-3.0](https://github.com/aerkalov/ebooklib) (EPUB parsing)
- **PyMuPDF** — [AGPL-3.0](https://github.com/pymupdf/PyMuPDF) (PDF extraction)
- **Next.js** — [MIT](https://github.com/vercel/next.js) (React framework)

See `backend/requirements.txt` and `frontend/package.json` for all dependencies.

## Troubleshooting

### "Piper is unavailable" error

Ensure the voice model is downloaded:
```bash
cd backend
source .venv/bin/activate
python -m piper.download_voices --data-dir data/voices en_US-lessac-medium
```

### MP3 export not working

Verify FFmpeg is installed:
```bash
ffmpeg -version
```

If not installed:
- **macOS**: `brew install ffmpeg`
- **Ubuntu/Debian**: `apt-get install ffmpeg`
- **Windows**: Download from https://ffmpeg.org/download.html

### Database errors on startup

Delete the corrupted database and restart:
```bash
cd backend
rm openbook-ai.db
# Restart the server to recreate the schema
```

## Contributing

Contributions are welcome! Please fork the repository, create a feature branch, and submit a pull request.

## Support

For issues, questions, or feature requests, please open a [GitHub issue](https://github.com/itsshanesworld/openbook-ai/issues).

---

Made with ❤️ for readers and developers everywhere.
