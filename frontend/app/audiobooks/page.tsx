"use client";

import Link from "next/link";
import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

interface BookSummary {
  id: number;
  filename: string;
  word_count: number;
  estimated_minutes: number;
}

interface Mp3Export {
  available: boolean;
  filename: string | null;
  size_bytes: number | null;
}

interface AudiobookJob {
  id: number;
  book_id: number;
  book_filename: string;
  status: "queued" | "running" | "completed" | "failed";
  speed: number;
  total_sections: number;
  completed_sections: number;
  progress_percent: number;
  output_filename: string | null;
  output_size_bytes: number | null;
  error_message: string | null;
  updated_at: string;
  mp3: Mp3Export;
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
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [exportingId, setExportingId] =
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
        const storedBooks = await requestJson<BookSummary[]>(
          `${API_URL}/books`,
        );

        setBooks(storedBooks);
        setBookId(storedBooks[0]?.id ?? null);
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
          headers: jsonHeaders(),
          body: JSON.stringify({ speed }),
        },
      );

      setJobs((current) => [job, ...current]);
      setMessage(
        "WAV audiobook generation started. Keep the backend running.",
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
    setExportingId(jobId);
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
        "Compressed MP3 export created successfully.",
      );
    } catch (caughtError) {
      showError(
        caughtError,
        "The MP3 export could not be created.",
      );
    } finally {
      setExportingId(null);
    }
  }

  async function deleteJob(jobId: number): Promise<void> {
    const approved = window.confirm(
      "Delete this job and all of its generated audio?",
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
              Generate the original WAV audiobook, then create
              a smaller MP3 for playback and sharing.
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
                      {book.filename}
                    </option>
                  ))}
                </select>

                {selectedBook && (
                  <div className="mt-5 rounded-xl bg-slate-950 p-4 text-sm">
                    <p>
                      {selectedBook.word_count.toLocaleString()} words
                    </p>
                    <p className="mt-2 text-slate-400">
                      Approximately {selectedBook.estimated_minutes} minutes
                    </p>
                  </div>
                )}

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
                  disabled={!bookId || creating || activeJob}
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
                    <div>
                      <h3 className="break-words font-semibold">
                        {job.book_filename}
                      </h3>

                      <p className="mt-2 text-sm text-slate-400">
                        {job.completed_sections} of{" "}
                        {job.total_sections} sections ·{" "}
                        {job.speed.toFixed(2)}×
                      </p>
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
                          src={`${API_URL}/audiobook-jobs/${job.id}/audio?v=${encodeURIComponent(job.updated_at)}`}
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
                              {formatFileSize(job.output_size_bytes)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                        <h4 className="font-semibold">
                          Compressed MP3
                        </h4>

                        {!job.mp3.available ? (
                          <button
                            className="mt-4 rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
                            disabled={exportingId === job.id}
                            onClick={() => void createMp3(job.id)}
                            type="button"
                          >
                            {exportingId === job.id
                              ? "Creating MP3..."
                              : "Create MP3 export"}
                          </button>
                        ) : (
                          <>
                            <audio
                              className="mt-3 w-full"
                              controls
                              preload="metadata"
                              src={`${API_URL}/audiobook-jobs/${job.id}/audio/mp3?v=${encodeURIComponent(job.updated_at)}`}
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
                                  {formatFileSize(job.mp3.size_bytes)}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <button
                        className="text-sm font-semibold text-red-300 disabled:opacity-50"
                        disabled={deletingId === job.id}
                        onClick={() => void deleteJob(job.id)}
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
                      onClick={() => void deleteJob(job.id)}
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
    <div className={`mt-6 rounded-lg border p-4 ${classes}`}>
      {children}
    </div>
  );
}

function jsonHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
