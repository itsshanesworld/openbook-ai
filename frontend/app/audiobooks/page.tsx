"use client";

import Link from "next/link";
import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface CoverInfo {
  available: boolean;
  filename: string | null;
  size_bytes: number | null;
  media_type: string | null;
}

interface VoiceOption {
  id: string;
  name: string;
}

interface VoiceListResponse {
  default_voice: string;
  voices: VoiceOption[];
}

interface BookSummary {
  id: number;
  filename: string;
  display_title: string;
  display_author: string | null;
  word_count: number;
  estimated_minutes: number;
  cover: CoverInfo;
}

interface Mp3Export {
  available: boolean;
  filename: string | null;
  size_bytes: number | null;
}

interface M4bExport {
  available: boolean;
  filename: string | null;
  size_bytes: number | null;
}

interface AudiobookChapter {
  title: string;
  start_ms: number;
  end_ms: number;
}

interface AudiobookJob {
  id: number;
  book_id: number;
  book_filename: string;
  book_title: string;
  book_author: string | null;
  cover: CoverInfo;
  status: "queued" | "running" | "completed" | "failed";
  speed: number;
  voice: string;
  total_sections: number;
  completed_sections: number;
  progress_percent: number;
  output_filename: string | null;
  output_size_bytes: number | null;
  error_message: string | null;
  updated_at: string;
  mp3: Mp3Export;
  m4b: M4bExport;
}

interface ErrorResponse {
  detail?: string | Array<{ msg?: string }>;
}

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function requestJson<T extends object>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, options);
  const data = (await response.json()) as T | ErrorResponse;

  if (!response.ok) {
    throw new Error(getErrorMessage(data, response.status));
  }

  return data as T;
}

function getErrorMessage(
  data: ErrorResponse,
  status: number,
): string {
  if (typeof data.detail === "string") {
    return data.detail;
  }

  if (Array.isArray(data.detail)) {
    const message = data.detail
      .map((item) => item.msg)
      .filter(Boolean)
      .join(", ");

    if (message) {
      return message;
    }
  }

  return `Request failed with status ${status}.`;
}

export default function AudiobooksPage() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookId, setBookId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<AudiobookJob[]>([]);
  const [speed, setSpeed] = useState(1);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voice, setVoice] = useState("");
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [voicePreviewUrl, setVoicePreviewUrl] =
    useState<string | null>(null);
  const voicePreviewUrlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [exportingMp3Id, setExportingMp3Id] =
    useState<number | null>(null);
  const [exportingM4bId, setExportingM4bId] =
    useState<number | null>(null);
  const [deletingId, setDeletingId] =
    useState<number | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selectedBook = useMemo(
    () => books.find((book) => book.id === bookId) ?? null,
    [bookId, books],
  );

  const activeJob = jobs.some(
    (job) =>
      job.status === "queued" ||
      job.status === "running",
  );

  useEffect(() => {
    return () => {
      if (voicePreviewUrlRef.current) {
        URL.revokeObjectURL(
          voicePreviewUrlRef.current,
        );
      }
    };
  }, []);

  const loadJobs = useCallback(async (): Promise<void> => {
    if (!bookId) {
      setJobs([]);
      return;
    }

    const nextJobs = await requestJson<AudiobookJob[]>(
      `${API_URL}/books/${bookId}/audiobook-jobs`,
    );

    setJobs(nextJobs);
  }, [bookId]);

  useEffect(() => {
    async function initialize(): Promise<void> {
      try {
        const [storedBooks, voiceData] = await Promise.all([
          requestJson<BookSummary[]>(
            `${API_URL}/books`,
          ),
          requestJson<VoiceListResponse>(
            `${API_URL}/tts/voices`,
          ),
        ]);

        setBooks(storedBooks);
        setBookId(storedBooks[0]?.id ?? null);
        setVoices(voiceData.voices);

        const defaultVoiceAvailable =
          voiceData.voices.some(
            (installedVoice) =>
              installedVoice.id === voiceData.default_voice,
          );

        setVoice(
          defaultVoiceAvailable
            ? voiceData.default_voice
            : (voiceData.voices[0]?.id ?? ""),
        );
      } catch (caughtError) {
        showError(
          caughtError,
          "The backend could not be reached.",
        );
      } finally {
        setLoading(false);
      }
    }

    void initialize();
  }, []);

  useEffect(() => {
    if (!bookId) {
      setJobs([]);
      return;
    }

    void loadJobs();

    const interval = window.setInterval(() => {
      void loadJobs();
    }, 2000);

    return () => window.clearInterval(interval);
  }, [bookId, loadJobs]);

  function clearVoicePreview(): void {
    if (voicePreviewUrlRef.current) {
      URL.revokeObjectURL(
        voicePreviewUrlRef.current,
      );

      voicePreviewUrlRef.current = null;
    }

    setVoicePreviewUrl(null);
  }

  async function previewNarrator(): Promise<void> {
    if (!voice) {
      return;
    }

    setPreviewingVoice(true);
    clearMessages();

    try {
      const response = await fetch(
        `${API_URL}/tts/voice-preview`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text:
              "Welcome to OpenBook AI. "
              + "This is a preview of the selected narrator voice.",
            speed,
            voice,
          }),
        },
      );

      if (!response.ok) {
        let data: ErrorResponse = {};

        try {
          data = (await response.json()) as ErrorResponse;
        } catch {
          data = {};
        }

        throw new Error(
          getErrorMessage(
            data,
            response.status,
          ),
        );
      }

      const audioBlob = await response.blob();

      clearVoicePreview();

      const nextUrl = URL.createObjectURL(
        audioBlob,
      );

      voicePreviewUrlRef.current = nextUrl;
      setVoicePreviewUrl(nextUrl);
    } catch (caughtError) {
      showError(
        caughtError,
        "The narrator preview could not be generated.",
      );
    } finally {
      setPreviewingVoice(false);
    }
  }

  async function createAudiobook(): Promise<void> {
    if (!bookId) {
      return;
    }

    setCreating(true);
    clearMessages();

    try {
      const job = await requestJson<AudiobookJob>(
        `${API_URL}/books/${bookId}/audiobook-jobs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            speed,
            voice,
          }),
        },
      );

      setJobs((current) => [job, ...current]);

      setMessage(
        "WAV audiobook generation started. Keep OpenBook AI running.",
      );
    } catch (caughtError) {
      showError(
        caughtError,
        "Audiobook generation could not start.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function createMp3(jobId: number): Promise<void> {
    setExportingMp3Id(jobId);
    clearMessages();

    try {
      const updatedJob = await requestJson<AudiobookJob>(
        `${API_URL}/audiobook-jobs/${jobId}/exports/mp3`,
        {
          method: "POST",
        },
      );

      setJobs((current) =>
        current.map((job) =>
          job.id === updatedJob.id ? updatedJob : job,
        ),
      );

      setMessage(
        "Compressed MP3 audiobook created successfully.",
      );
    } catch (caughtError) {
      showError(
        caughtError,
        "The MP3 export could not be created.",
      );
    } finally {
      setExportingMp3Id(null);
    }
  }

  async function createM4b(jobId: number): Promise<void> {
    setExportingM4bId(jobId);
    clearMessages();

    try {
      const updatedJob = await requestJson<AudiobookJob>(
        `${API_URL}/audiobook-jobs/${jobId}/exports/m4b`,
        {
          method: "POST",
        },
      );

      setJobs((current) =>
        current.map((job) =>
          job.id === updatedJob.id ? updatedJob : job,
        ),
      );

      setMessage(
        "Chaptered M4B audiobook created successfully.",
      );
    } catch (caughtError) {
      showError(
        caughtError,
        "The M4B export could not be created.",
      );
    } finally {
      setExportingM4bId(null);
    }
  }

  async function deleteJob(jobId: number): Promise<void> {
    const approved = window.confirm(
      "Delete this job and all generated WAV, MP3, and M4B files?",
    );

    if (!approved) {
      return;
    }

    setDeletingId(jobId);
    clearMessages();

    try {
      await requestJson<{
        deleted: boolean;
        job_id: number;
      }>(`${API_URL}/audiobook-jobs/${jobId}`, {
        method: "DELETE",
      });

      setJobs((current) =>
        current.filter((job) => job.id !== jobId),
      );

      setMessage("Audiobook files deleted.");
    } catch (caughtError) {
      showError(
        caughtError,
        "The audiobook could not be deleted.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  function clearMessages(): void {
    setError("");
    setMessage("");
  }

  function showError(
    caughtError: unknown,
    fallback: string,
  ): void {
    setError(
      caughtError instanceof Error
        ? caughtError.message
        : fallback,
    );
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-950 p-8 text-white">
        Loading audiobook builder...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="font-semibold uppercase tracking-widest text-cyan-300">
              OpenBook AI
            </p>

            <h1 className="mt-2 text-4xl font-bold">
              Audiobook exports
            </h1>

            <p className="mt-3 max-w-2xl leading-7 text-slate-400">
              Generate a WAV master, a compressed MP3, or a
              chaptered M4B audiobook.
            </p>
          </div>

          <Link
            className="rounded-lg border border-slate-700 px-4 py-2 font-semibold"
            href="/"
          >
            Back to editor
          </Link>
        </header>

        {error && (
          <Message type="error">{error}</Message>
        )}

        {message && (
          <Message type="success">{message}</Message>
        )}

        <section className="mt-10 grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-xl font-bold">
              Generation settings
            </h2>

            {books.length === 0 ? (
              <p className="mt-5 text-slate-400">
                Add a book and narration sections first.
              </p>
            ) : (
              <>
                <label
                  className="mt-6 block text-sm font-semibold"
                  htmlFor="book"
                >
                  Book
                </label>

                <select
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
                  id="book"
                  onChange={(event) => {
                    setBookId(Number(event.target.value));
                    clearMessages();
                  }}
                  value={bookId ?? ""}
                >
                  {books.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.display_title}
                      {book.display_author
                        ? ` — ${book.display_author}`
                        : ""}
                    </option>
                  ))}
                </select>

                {selectedBook && (
                  <div className="mt-5 flex gap-4 rounded-xl bg-slate-950 p-4">
                    <div className="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
                      {selectedBook.cover.available ? (
                        <img
                          alt={`Cover for ${selectedBook.display_title}`}
                          className="h-full w-full object-cover"
                          src={`${API_URL}/books/${selectedBook.id}/cover`}
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="text-2xl"
                        >
                          📚
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 text-sm">
                      <p className="break-words font-semibold text-white">
                        {selectedBook.display_title}
                      </p>

                      {selectedBook.display_author && (
                        <p className="mt-1 break-words text-slate-300">
                          {selectedBook.display_author}
                        </p>
                      )}

                      <p className="mt-2 break-all text-xs text-slate-500">
                        {selectedBook.filename}
                      </p>

                      <p className="mt-2 text-slate-400">
                        {selectedBook.word_count.toLocaleString()} words
                        {" · "}
                        approximately{" "}
                        {selectedBook.estimated_minutes} minutes
                      </p>
                    </div>
                  </div>
                )}

                <div className="mt-6">
                  <label
                    className="block text-sm font-semibold"
                    htmlFor="voice"
                  >
                    Narrator voice
                  </label>

                  {voices.length === 0 ? (
                    <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                      No complete Piper voices are installed.
                    </p>
                  ) : (
                    <>
                      <select
                        className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
                        id="voice"
                        onChange={(event) => {
                          setVoice(event.target.value);
                          clearVoicePreview();
                          clearMessages();
                        }}
                        value={voice}
                      >
                        {voices.map((installedVoice) => (
                          <option
                            key={installedVoice.id}
                            value={installedVoice.id}
                          >
                            {installedVoice.name}
                          </option>
                        ))}
                      </select>

                      <p className="mt-2 text-xs text-slate-500">
                        Local Piper voice · saved with this audiobook job
                      </p>

                      <button
                        className="mt-3 w-full rounded-lg border border-cyan-500/50 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                        disabled={
                          !voice || previewingVoice
                        }
                        onClick={() =>
                          void previewNarrator()
                        }
                        type="button"
                      >
                        {previewingVoice
                          ? "Generating preview..."
                          : "Preview narrator"}
                      </button>

                      {voicePreviewUrl && (
                        <audio
                          className="mt-3 w-full"
                          controls
                          preload="metadata"
                          src={voicePreviewUrl}
                        />
                      )}
                    </>
                  )}
                </div>

                <div className="mt-6">
                  <div className="flex justify-between text-sm">
                    <label
                      className="font-semibold"
                      htmlFor="speed"
                    >
                      Narration speed
                    </label>

                    <span className="text-cyan-300">
                      {speed.toFixed(2)}×
                    </span>
                  </div>

                  <input
                    className="mt-3 w-full"
                    id="speed"
                    max={1.5}
                    min={0.75}
                    onChange={(event) =>
                      setSpeed(Number(event.target.value))
                    }
                    step={0.05}
                    type="range"
                    value={speed}
                  />
                </div>

                <button
                  className="mt-7 w-full rounded-lg bg-white px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
                  disabled={
                    !bookId ||
                    !voice ||
                    creating ||
                    activeJob
                  }
                  onClick={() => void createAudiobook()}
                  type="button"
                >
                  {creating
                    ? "Starting..."
                    : activeJob
                      ? "Generation in progress"
                      : "Generate WAV audiobook"}
                </button>
              </>
            )}
          </aside>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">
                Generated audiobooks
              </h2>

              <span className="rounded-full bg-slate-800 px-3 py-1 text-sm">
                {jobs.length}
              </span>
            </div>

            {jobs.length === 0 && (
              <p className="mt-5 text-slate-400">
                Your audiobook jobs will appear here.
              </p>
            )}

            <div className="mt-6 space-y-5">
              {jobs.map((job) => (
                <article
                  className="rounded-2xl border border-slate-700 bg-slate-950 p-5"
                  key={job.id}
                >
                  <div className="flex flex-wrap justify-between gap-4">
                    <div className="flex min-w-0 gap-4">
                      <div className="flex h-28 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
                        {job.cover.available ? (
                          <img
                            alt={`Cover for ${job.book_title}`}
                            className="h-full w-full object-cover"
                            src={`${API_URL}/books/${job.book_id}/cover`}
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="text-3xl"
                          >
                            📚
                          </span>
                        )}
                      </div>

                      <div className="min-w-0">
                        <h3 className="break-words text-lg font-semibold">
                          {job.book_title}
                        </h3>

                        {job.book_author && (
                          <p className="mt-1 break-words text-sm text-slate-300">
                            {job.book_author}
                          </p>
                        )}

                        <p className="mt-2 break-all text-xs text-slate-500">
                          {job.book_filename}
                        </p>

                        <p className="mt-3 text-sm text-slate-400">
                          {job.completed_sections} of{" "}
                          {job.total_sections} sections ·{" "}
                          {job.speed.toFixed(2)}×
                        </p>

                      <p className="mt-1 text-sm text-slate-500">
                        Narrator:{" "}
                        {voices.find(
                          (installedVoice) =>
                            installedVoice.id === job.voice,
                        )?.name ?? job.voice}
                      </p>
                      </div>
                    </div>

                    <StatusBadge status={job.status} />
                  </div>

                  <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full bg-cyan-400"
                      style={{
                        width: `${job.progress_percent}%`,
                      }}
                    />
                  </div>

                  <p className="mt-2 text-sm text-slate-400">
                    {job.progress_percent}% complete
                  </p>

                  {job.error_message && (
                    <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
                      {job.error_message}
                    </p>
                  )}

                  {job.status === "completed" && (
                    <div className="mt-5 space-y-5">
                      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                        <h4 className="font-semibold">
                          WAV original
                        </h4>

                        <audio
                          className="mt-3 w-full"
                          controls
                          preload="metadata"
                          src={`${API_URL}/audiobook-jobs/${job.id}/audio`}
                        />

                        <div className="mt-4 flex flex-wrap items-center gap-4">
                          <a
                            className="font-semibold text-cyan-300"
                            href={`${API_URL}/audiobook-jobs/${job.id}/download`}
                          >
                            Download WAV
                          </a>

                          {job.output_size_bytes && (
                            <span className="text-sm text-slate-400">
                              {formatFileSize(
                                job.output_size_bytes,
                              )}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                        <h4 className="font-semibold">
                          Compressed MP3
                        </h4>

                        {!job.mp3?.available ? (
                          <button
                            className="mt-4 rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
                            disabled={
                              exportingMp3Id === job.id
                            }
                            onClick={() =>
                              void createMp3(job.id)
                            }
                            type="button"
                          >
                            {exportingMp3Id === job.id
                              ? "Creating MP3..."
                              : "Create MP3 export"}
                          </button>
                        ) : (
                          <>
                            <audio
                              className="mt-3 w-full"
                              controls
                              preload="metadata"
                              src={`${API_URL}/audiobook-jobs/${job.id}/audio/mp3`}
                            />

                            <div className="mt-4 flex flex-wrap items-center gap-4">
                              <a
                                className="rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950"
                                href={`${API_URL}/audiobook-jobs/${job.id}/download/mp3`}
                              >
                                Download MP3
                              </a>

                              {job.mp3.size_bytes && (
                                <span className="text-sm text-slate-400">
                                  {formatFileSize(
                                    job.mp3.size_bytes,
                                  )}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                        <h4 className="font-semibold">
                          Chaptered M4B
                        </h4>

                        <p className="mt-2 text-sm leading-6 text-slate-400">
                          M4B uses compressed AAC audio and
                          includes chapter markers for audiobook
                          players.
                        </p>

                        {!job.m4b?.available ? (
                          <button
                            className="mt-4 rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
                            disabled={
                              exportingM4bId === job.id
                            }
                            onClick={() =>
                              void createM4b(job.id)
                            }
                            type="button"
                          >
                            {exportingM4bId === job.id
                              ? "Creating M4B..."
                              : "Create M4B export"}
                          </button>
                        ) : (
                          <>
                            <M4bPlayer jobId={job.id} />

                            <div className="mt-4 flex flex-wrap items-center gap-4">
                              <a
                                className="rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950"
                                href={`${API_URL}/audiobook-jobs/${job.id}/download/m4b`}
                              >
                                Download M4B
                              </a>

                              {job.m4b.size_bytes && (
                                <span className="text-sm text-slate-400">
                                  {formatFileSize(
                                    job.m4b.size_bytes,
                                  )}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <button
                        className="text-sm font-semibold text-red-300 disabled:opacity-50"
                        disabled={deletingId === job.id}
                        onClick={() =>
                          void deleteJob(job.id)
                        }
                        type="button"
                      >
                        {deletingId === job.id
                          ? "Deleting..."
                          : "Delete all job files"}
                      </button>
                    </div>
                  )}

                  {job.status === "failed" && (
                    <button
                      className="mt-4 text-sm font-semibold text-red-300"
                      onClick={() =>
                        void deleteJob(job.id)
                      }
                      type="button"
                    >
                      Delete failed job
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function M4bPlayer({
  jobId,
}: {
  jobId: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [chapters, setChapters] = useState<AudiobookChapter[]>(
    [],
  );
  const [chapterError, setChapterError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadChapters(): Promise<void> {
      try {
        const loadedChapters =
          await requestJson<AudiobookChapter[]>(
            `${API_URL}/audiobook-jobs/${jobId}/chapters`,
          );

        if (!cancelled) {
          setChapters(loadedChapters);
          setChapterError("");
        }
      } catch (caughtError) {
        if (!cancelled) {
          setChapterError(
            caughtError instanceof Error
              ? caughtError.message
              : "Chapter navigation could not be loaded.",
          );
        }
      }
    }

    void loadChapters();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  function jumpToChapter(
    chapter: AudiobookChapter,
  ): void {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    audio.currentTime = chapter.start_ms / 1000;

    void audio.play().catch(() => undefined);
  }

  return (
    <>
      <audio
        className="mt-4 w-full"
        controls
        preload="metadata"
        ref={audioRef}
        src={`${API_URL}/audiobook-jobs/${jobId}/audio/m4b`}
      />

      {chapterError && (
        <p className="mt-3 text-sm text-amber-300">
          Chapter navigation unavailable: {chapterError}
        </p>
      )}

      {chapters.length > 0 && (
        <div className="mt-5">
          <h5 className="text-sm font-semibold text-slate-200">
            Chapters
          </h5>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {chapters.map((chapter, index) => (
              <button
                aria-label={`Play ${chapter.title}`}
                className="flex items-center justify-between gap-4 rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-left transition hover:border-cyan-400 hover:bg-slate-900"
                key={`${chapter.title}-${chapter.start_ms}`}
                onClick={() => jumpToChapter(chapter)}
                type="button"
              >
                <span className="min-w-0">
                  <span className="mr-2 text-xs text-slate-500">
                    {index + 1}.
                  </span>

                  <span className="font-semibold text-cyan-200">
                    {chapter.title}
                  </span>
                </span>

                <span className="shrink-0 text-sm text-slate-400">
                  {formatTimestamp(chapter.start_ms)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}


function StatusBadge({
  status,
}: {
  status: AudiobookJob["status"];
}) {
  const classes = {
    queued: "bg-amber-500/15 text-amber-300",
    running: "bg-cyan-500/15 text-cyan-300",
    completed: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-red-500/15 text-red-300",
  }[status];

  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-semibold capitalize ${classes}`}
    >
      {status}
    </span>
  );
}

function Message({
  children,
  type,
}: {
  children: ReactNode;
  type: "error" | "success";
}) {
  const classes =
    type === "error"
      ? "border-red-500/50 bg-red-500/10 text-red-200"
      : "border-emerald-500/50 bg-emerald-500/10 text-emerald-200";

  return (
    <div
      className={`mt-6 rounded-lg border p-4 ${classes}`}
    >
      {children}
    </div>
  );
}

function formatTimestamp(
  milliseconds: number,
): string {
  const totalSeconds = Math.floor(
    milliseconds / 1000,
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(
    (totalSeconds % 3600) / 60,
  );
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [
      hours,
      minutes.toString().padStart(2, "0"),
      seconds.toString().padStart(2, "0"),
    ].join(":");
  }

  return [
    minutes,
    seconds.toString().padStart(2, "0"),
  ].join(":");
}


function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
