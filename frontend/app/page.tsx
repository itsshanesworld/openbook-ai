"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

type ApiStatus = "checking" | "online" | "offline";

interface Chapter {
  id: number;
  position: number;
  title: string;
}

interface BookSummary {
  id: number;
  filename: string;
  file_type: string;
  size_bytes: number;
  character_count: number;
  word_count: number;
  estimated_minutes: number;
  chapter_count: number;
  created_at: string;
}

interface BookDetail extends BookSummary {
  preview: string;
  chapters: Chapter[];
}

interface ErrorResponse {
  detail?: string;
}

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function requestJson<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, options);
  const data = (await response.json()) as T | ErrorResponse;

  if (!response.ok) {
    const message =
      "detail" in data && data.detail
        ? data.detail
        : `Request failed with status ${response.status}.`;

    throw new Error(message);
  }

  return data as T;
}

export default function Home() {
  const [apiStatus, setApiStatus] =
    useState<ApiStatus>("checking");
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [selectedBook, setSelectedBook] =
    useState<BookDetail | null>(null);
  const [selectedFile, setSelectedFile] =
    useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loadingBookId, setLoadingBookId] =
    useState<number | null>(null);
  const [error, setError] = useState("");

  const loadBooks = useCallback(async (): Promise<void> => {
    const storedBooks = await requestJson<BookSummary[]>(
      `${API_URL}/books`,
    );

    setBooks(storedBooks);
  }, []);

  useEffect(() => {
    async function initialize(): Promise<void> {
      try {
        const health = await requestJson<{ status: string }>(
          `${API_URL}/health`,
        );

        if (health.status !== "online") {
          throw new Error("Backend returned an invalid status.");
        }

        setApiStatus("online");
        await loadBooks();
      } catch {
        setApiStatus("offline");
      }
    }

    void initialize();
  }, [loadBooks]);

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    setSelectedFile(event.target.files?.[0] ?? null);
    setError("");
  }

  async function handleUpload(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();

    if (!selectedFile) {
      setError("Choose a book file first.");
      return;
    }

    const formData = new FormData();
    formData.append("file", selectedFile);

    setUploading(true);
    setError("");

    try {
      const uploadedBook = await requestJson<BookDetail>(
        `${API_URL}/books/upload`,
        {
          method: "POST",
          body: formData,
        },
      );

      setSelectedBook(uploadedBook);
      setSelectedFile(null);
      await loadBooks();

      const fileInput = document.querySelector<HTMLInputElement>(
        "#book-file",
      );

      if (fileInput) {
        fileInput.value = "";
      }
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "The upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function openBook(bookId: number): Promise<void> {
    setLoadingBookId(bookId);
    setError("");

    try {
      const book = await requestJson<BookDetail>(
        `${API_URL}/books/${bookId}`,
      );

      setSelectedBook(book);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The book could not be opened.",
      );
    } finally {
      setLoadingBookId(null);
    }
  }

  async function deleteBook(bookId: number): Promise<void> {
    const approved = window.confirm(
      "Delete this book from your library?",
    );

    if (!approved) {
      return;
    }

    setError("");

    try {
      await requestJson<{ deleted: boolean; book_id: number }>(
        `${API_URL}/books/${bookId}`,
        {
          method: "DELETE",
        },
      );

      if (selectedBook?.id === bookId) {
        setSelectedBook(null);
      }

      await loadBooks();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The book could not be deleted.",
      );
    }
  }

  const statusLabel = {
    checking: "Checking backend",
    online: "Backend connected",
    offline: "Backend offline",
  }[apiStatus];

  const statusClass = {
    checking: "text-amber-300",
    online: "text-emerald-300",
    offline: "text-red-300",
  }[apiStatus];

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-white">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">OpenBook AI</h1>
            <p className="mt-1 text-sm text-slate-400">
              Open-source audiobook creation studio
            </p>
          </div>

          <p className={statusClass}>{statusLabel}</p>
        </header>

        {error && (
          <div className="mt-6 rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-red-200">
            {error}
          </div>
        )}

        <section className="mt-10 grid gap-6 xl:grid-cols-[0.8fr_1fr_1.2fr]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-xl font-bold">Import book</h2>

            <p className="mt-3 text-sm leading-6 text-slate-400">
              Upload PDF, EPUB, DOCX, or TXT files. The original
              file is removed after its text is extracted.
            </p>

            <form className="mt-6" onSubmit={handleUpload}>
              <label
                className="text-sm font-semibold"
                htmlFor="book-file"
              >
                Choose a book
              </label>

              <input
                accept=".pdf,.epub,.docx,.txt"
                className="mt-3 block w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm"
                id="book-file"
                onChange={handleFileChange}
                type="file"
              />

              {selectedFile && (
                <p className="mt-3 break-all rounded-lg bg-slate-800 p-3 text-sm">
                  {selectedFile.name}
                </p>
              )}

              <button
                className="mt-5 w-full rounded-lg bg-white px-5 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !selectedFile ||
                  uploading ||
                  apiStatus !== "online"
                }
                type="submit"
              >
                {uploading
                  ? "Extracting and saving..."
                  : "Add to library"}
              </button>
            </form>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Your library</h2>
              <span className="rounded-full bg-slate-800 px-3 py-1 text-sm">
                {books.length}
              </span>
            </div>

            {books.length === 0 && (
              <p className="mt-5 text-sm leading-6 text-slate-400">
                Your saved books will appear here.
              </p>
            )}

            <div className="mt-5 max-h-[650px] space-y-3 overflow-y-auto">
              {books.map((book) => (
                <article
                  className="rounded-xl border border-slate-700 bg-slate-950 p-4"
                  key={book.id}
                >
                  <button
                    className="w-full text-left"
                    disabled={loadingBookId === book.id}
                    onClick={() => void openBook(book.id)}
                    type="button"
                  >
                    <h3 className="break-words font-semibold">
                      {book.filename}
                    </h3>

                    <p className="mt-2 text-sm text-slate-400">
                      {book.file_type} ·{" "}
                      {book.word_count.toLocaleString()} words ·{" "}
                      {book.estimated_minutes} minutes
                    </p>

                    <p className="mt-1 text-xs text-slate-500">
                      {book.chapter_count} chapters ·{" "}
                      {formatDate(book.created_at)}
                    </p>
                  </button>

                  <button
                    className="mt-4 text-sm font-semibold text-red-300"
                    onClick={() => void deleteBook(book.id)}
                    type="button"
                  >
                    Delete
                  </button>
                </article>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-xl font-bold">Book details</h2>

            {!selectedBook && (
              <p className="mt-5 text-sm leading-6 text-slate-400">
                Upload or select a book to view its analysis.
              </p>
            )}

            {selectedBook && (
              <div className="mt-5">
                <h3 className="break-words text-lg font-semibold">
                  {selectedBook.filename}
                </h3>

                <dl className="mt-5 grid grid-cols-2 gap-3">
                  <Statistic
                    label="Type"
                    value={selectedBook.file_type}
                  />
                  <Statistic
                    label="Words"
                    value={selectedBook.word_count.toLocaleString()}
                  />
                  <Statistic
                    label="Audio"
                    value={`${selectedBook.estimated_minutes} min`}
                  />
                  <Statistic
                    label="Chapters"
                    value={selectedBook.chapter_count.toString()}
                  />
                </dl>

                {selectedBook.chapters.length > 0 && (
                  <div className="mt-6">
                    <h4 className="font-semibold">
                      Detected chapters
                    </h4>

                    <ol className="mt-3 max-h-44 space-y-2 overflow-y-auto">
                      {selectedBook.chapters.map((chapter) => (
                        <li
                          className="rounded-lg bg-slate-800 p-3 text-sm"
                          key={chapter.id}
                        >
                          {chapter.position}. {chapter.title}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <div className="mt-6">
                  <h4 className="font-semibold">Text preview</h4>

                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-4 text-sm leading-6 text-slate-300">
                    {selectedBook.preview}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function Statistic({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-slate-800 p-4">
      <dt className="text-xs uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="mt-2 font-semibold">{value}</dd>
    </div>
  );
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
