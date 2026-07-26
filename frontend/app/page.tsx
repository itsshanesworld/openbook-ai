"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
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

interface NarrationSection {
  id: number;
  book_id: number;
  position: number;
  text: string;
  word_count: number;
  estimated_seconds: number;
  created_at: string;
  updated_at: string;
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
    let message = `Request failed with status ${response.status}.`;

    if ("detail" in data) {
      if (typeof data.detail === "string") {
        message = data.detail;
      } else if (Array.isArray(data.detail)) {
        message = data.detail
          .map((item) => item.msg)
          .filter(Boolean)
          .join(", ");
      }
    }

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
  const [sections, setSections] =
    useState<NarrationSection[]>([]);
  const [activeSectionId, setActiveSectionId] =
    useState<number | null>(null);
  const [draftText, setDraftText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [selectedFile, setSelectedFile] =
    useState<File | null>(null);
  const [targetWords, setTargetWords] = useState(350);
  const [uploading, setUploading] = useState(false);
  const [loadingBookId, setLoadingBookId] =
    useState<number | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const [rebuildingSections, setRebuildingSections] =
    useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const activeSection = useMemo(
    () =>
      sections.find(
        (section) => section.id === activeSectionId,
      ) ?? null,
    [activeSectionId, sections],
  );

  const activeSectionIndex = useMemo(
    () =>
      sections.findIndex(
        (section) => section.id === activeSectionId,
      ),
    [activeSectionId, sections],
  );

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

  function displaySections(
    nextSections: NarrationSection[],
  ): void {
    setSections(nextSections);

    const firstSection = nextSections[0] ?? null;

    setActiveSectionId(firstSection?.id ?? null);
    setDraftText(firstSection?.text ?? "");
    setDirty(false);
  }

  async function loadSections(
    bookId: number,
  ): Promise<NarrationSection[]> {
    return requestJson<NarrationSection[]>(
      `${API_URL}/books/${bookId}/sections`,
    );
  }

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    setSelectedFile(event.target.files?.[0] ?? null);
    setError("");
    setSuccessMessage("");
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
    setSuccessMessage("");

    try {
      const uploadedBook = await requestJson<BookDetail>(
        `${API_URL}/books/upload`,
        {
          method: "POST",
          body: formData,
        },
      );

      const uploadedSections = await loadSections(
        uploadedBook.id,
      );

      setSelectedBook(uploadedBook);
      displaySections(uploadedSections);
      setSelectedFile(null);
      setSuccessMessage(
        `${uploadedBook.filename} was added to your library.`,
      );

      await loadBooks();

      const fileInput =
        document.querySelector<HTMLInputElement>("#book-file");

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
    if (
      dirty &&
      !window.confirm(
        "You have unsaved section changes. Discard them?",
      )
    ) {
      return;
    }

    setLoadingBookId(bookId);
    setError("");
    setSuccessMessage("");

    try {
      const [book, bookSections] = await Promise.all([
        requestJson<BookDetail>(`${API_URL}/books/${bookId}`),
        loadSections(bookId),
      ]);

      setSelectedBook(book);
      displaySections(bookSections);
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
      "Delete this book and all of its narration sections?",
    );

    if (!approved) {
      return;
    }

    setError("");
    setSuccessMessage("");

    try {
      await requestJson<{
        deleted: boolean;
        book_id: number;
      }>(`${API_URL}/books/${bookId}`, {
        method: "DELETE",
      });

      if (selectedBook?.id === bookId) {
        setSelectedBook(null);
        displaySections([]);
      }

      await loadBooks();
      setSuccessMessage("The book was deleted.");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The book could not be deleted.",
      );
    }
  }

  function selectSection(section: NarrationSection): void {
    if (
      dirty &&
      section.id !== activeSectionId &&
      !window.confirm(
        "You have unsaved edits. Discard them and open another section?",
      )
    ) {
      return;
    }

    setActiveSectionId(section.id);
    setDraftText(section.text);
    setDirty(false);
    setError("");
    setSuccessMessage("");
  }

  function moveToSection(offset: number): void {
    const nextSection = sections[activeSectionIndex + offset];

    if (nextSection) {
      selectSection(nextSection);
    }
  }

  async function saveActiveSection(): Promise<void> {
    if (!activeSection) {
      return;
    }

    const cleanedText = draftText.trim();

    if (!cleanedText) {
      setError("A narration section cannot be blank.");
      return;
    }

    setSavingSection(true);
    setError("");
    setSuccessMessage("");

    try {
      const savedSection =
        await requestJson<NarrationSection>(
          `${API_URL}/sections/${activeSection.id}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: cleanedText,
            }),
          },
        );

      setSections((currentSections) =>
        currentSections.map((section) =>
          section.id === savedSection.id
            ? savedSection
            : section,
        ),
      );

      setDraftText(savedSection.text);
      setDirty(false);
      setSuccessMessage(
        `Section ${savedSection.position} was saved.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The section could not be saved.",
      );
    } finally {
      setSavingSection(false);
    }
  }

  async function rebuildSections(): Promise<void> {
    if (!selectedBook) {
      return;
    }

    if (
      sections.length > 0 &&
      !window.confirm(
        "Rebuilding will replace all current narration sections and discard section edits. Continue?",
      )
    ) {
      return;
    }

    const safeTargetWords = Math.min(
      1000,
      Math.max(100, targetWords),
    );

    setTargetWords(safeTargetWords);
    setRebuildingSections(true);
    setError("");
    setSuccessMessage("");

    try {
      const rebuiltSections =
        await requestJson<NarrationSection[]>(
          `${API_URL}/books/${selectedBook.id}/sections/rebuild?target_words=${safeTargetWords}`,
          {
            method: "POST",
          },
        );

      displaySections(rebuiltSections);
      setSuccessMessage(
        `${rebuiltSections.length} narration sections were created.`,
      );
    } catch (rebuildError) {
      setError(
        rebuildError instanceof Error
          ? rebuildError.message
          : "The sections could not be rebuilt.",
      );
    } finally {
      setRebuildingSections(false);
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
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-white sm:px-6">
      <div className="mx-auto max-w-[1600px]">
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

        {successMessage && (
          <div className="mt-6 rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-4 text-emerald-200">
            {successMessage}
          </div>
        )}

        <section className="mt-8 grid gap-6 xl:grid-cols-[300px_340px_minmax(0,1fr)]">
          <aside className="space-y-6">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-bold">Import book</h2>

              <p className="mt-2 text-sm leading-6 text-slate-400">
                Supports PDF, EPUB, DOCX, and TXT files up to
                25 MB.
              </p>

              <form className="mt-5" onSubmit={handleUpload}>
                <label
                  className="text-sm font-semibold"
                  htmlFor="book-file"
                >
                  Book file
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
                  className="mt-4 w-full rounded-lg bg-white px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    !selectedFile ||
                    uploading ||
                    apiStatus !== "online"
                  }
                  type="submit"
                >
                  {uploading
                    ? "Extracting..."
                    : "Add to library"}
                </button>
              </form>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Library</h2>
                <span className="rounded-full bg-slate-800 px-3 py-1 text-sm">
                  {books.length}
                </span>
              </div>

              {books.length === 0 && (
                <p className="mt-4 text-sm text-slate-400">
                  Your saved books will appear here.
                </p>
              )}

              <div className="mt-4 max-h-[600px] space-y-3 overflow-y-auto">
                {books.map((book) => (
                  <article
                    className={`rounded-xl border p-4 ${
                      selectedBook?.id === book.id
                        ? "border-cyan-500 bg-cyan-500/10"
                        : "border-slate-700 bg-slate-950"
                    }`}
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

                      <p className="mt-2 text-xs leading-5 text-slate-400">
                        {book.word_count.toLocaleString()} words
                        <br />
                        {book.estimated_minutes} minutes
                        <br />
                        {formatDate(book.created_at)}
                      </p>
                    </button>

                    <button
                      className="mt-3 text-sm font-semibold text-red-300"
                      onClick={() => void deleteBook(book.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </aside>

          <aside className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">
                Narration sections
              </h2>

              <span className="rounded-full bg-slate-800 px-3 py-1 text-sm">
                {sections.length}
              </span>
            </div>

            {!selectedBook && (
              <p className="mt-4 text-sm leading-6 text-slate-400">
                Select a book to view its narration sections.
              </p>
            )}

            {selectedBook && (
              <>
                <div className="mt-5 rounded-xl bg-slate-950 p-4">
                  <label
                    className="text-sm font-semibold"
                    htmlFor="target-words"
                  >
                    Target words per section
                  </label>

                  <input
                    className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                    id="target-words"
                    max={1000}
                    min={100}
                    onChange={(event) =>
                      setTargetWords(
                        Number(event.target.value),
                      )
                    }
                    type="number"
                    value={targetWords}
                  />

                  <button
                    className="mt-3 w-full rounded-lg border border-slate-600 px-4 py-2 font-semibold disabled:opacity-50"
                    disabled={rebuildingSections}
                    onClick={() => void rebuildSections()}
                    type="button"
                  >
                    {rebuildingSections
                      ? "Rebuilding..."
                      : sections.length === 0
                        ? "Create sections"
                        : "Rebuild sections"}
                  </button>
                </div>

                {sections.length === 0 && (
                  <p className="mt-5 text-sm leading-6 text-slate-400">
                    This book does not have narration sections
                    yet. Create them using the button above.
                  </p>
                )}

                <div className="mt-5 max-h-[650px] space-y-2 overflow-y-auto">
                  {sections.map((section) => (
                    <button
                      className={`w-full rounded-xl border p-4 text-left ${
                        section.id === activeSectionId
                          ? "border-cyan-500 bg-cyan-500/10"
                          : "border-slate-700 bg-slate-950"
                      }`}
                      key={section.id}
                      onClick={() => selectSection(section)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold">
                          Section {section.position}
                        </span>

                        <span className="text-xs text-slate-400">
                          {formatDuration(
                            section.estimated_seconds,
                          )}
                        </span>
                      </div>

                      <p className="mt-2 line-clamp-3 text-sm leading-5 text-slate-400">
                        {section.text}
                      </p>

                      <p className="mt-2 text-xs text-slate-500">
                        {section.word_count} words
                      </p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>

          <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
            {!selectedBook && (
              <>
                <h2 className="text-xl font-bold">
                  Narration editor
                </h2>

                <p className="mt-4 text-slate-400">
                  Select a book from your library to begin
                  editing.
                </p>
              </>
            )}

            {selectedBook && !activeSection && (
              <>
                <h2 className="break-words text-xl font-bold">
                  {selectedBook.filename}
                </h2>

                <p className="mt-4 text-slate-400">
                  Create narration sections to begin editing this
                  book.
                </p>

                <div className="mt-6 rounded-xl bg-slate-950 p-5">
                  <h3 className="font-semibold">Book details</h3>

                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <Statistic
                      label="Words"
                      value={selectedBook.word_count.toLocaleString()}
                    />
                    <Statistic
                      label="Estimated audio"
                      value={`${selectedBook.estimated_minutes} min`}
                    />
                    <Statistic
                      label="File type"
                      value={selectedBook.file_type}
                    />
                    <Statistic
                      label="Detected chapters"
                      value={selectedBook.chapter_count.toString()}
                    />
                  </dl>
                </div>
              </>
            )}

            {selectedBook && activeSection && (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-sm text-cyan-300">
                      {selectedBook.filename}
                    </p>

                    <h2 className="mt-1 text-2xl font-bold">
                      Section {activeSection.position}
                    </h2>

                    <p className="mt-2 text-sm text-slate-400">
                      {draftText.trim().split(/\s+/).filter(Boolean)
                        .length}{" "}
                      words · Approximately{" "}
                      {formatDuration(
                        Math.max(
                          1,
                          Math.round(
                            draftText
                              .trim()
                              .split(/\s+/)
                              .filter(Boolean).length /
                              160 *
                              60,
                          ),
                        ),
                      )}
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-sm ${
                      dirty
                        ? "bg-amber-500/15 text-amber-300"
                        : "bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {dirty ? "Unsaved changes" : "Saved"}
                  </span>
                </div>

                <textarea
                  className="mt-6 min-h-[500px] w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-5 leading-8 text-slate-200 outline-none focus:border-cyan-500"
                  onChange={(event) => {
                    setDraftText(event.target.value);
                    setDirty(
                      event.target.value !== activeSection.text,
                    );
                    setSuccessMessage("");
                  }}
                  spellCheck
                  value={draftText}
                />

                <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex gap-3">
                    <button
                      className="rounded-lg border border-slate-600 px-4 py-2 font-semibold disabled:opacity-40"
                      disabled={activeSectionIndex <= 0}
                      onClick={() => moveToSection(-1)}
                      type="button"
                    >
                      Previous
                    </button>

                    <button
                      className="rounded-lg border border-slate-600 px-4 py-2 font-semibold disabled:opacity-40"
                      disabled={
                        activeSectionIndex < 0 ||
                        activeSectionIndex >=
                          sections.length - 1
                      }
                      onClick={() => moveToSection(1)}
                      type="button"
                    >
                      Next
                    </button>
                  </div>

                  <button
                    className="rounded-lg bg-white px-6 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={
                      !dirty ||
                      savingSection ||
                      !draftText.trim()
                    }
                    onClick={() => void saveActiveSection()}
                    type="button"
                  >
                    {savingSection
                      ? "Saving..."
                      : "Save section"}
                  </button>
                </div>
              </>
            )}
          </section>
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
  }).format(date);
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0
    ? `${minutes}m ${seconds}s`
    : `${minutes} min`;
}
