"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  const editorRef = useRef<HTMLTextAreaElement>(null);

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
  const [cursorPosition, setCursorPosition] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [selectedFile, setSelectedFile] =
    useState<File | null>(null);
  const [targetWords, setTargetWords] = useState(350);
  const [uploading, setUploading] = useState(false);
  const [working, setWorking] = useState(false);
  const [loadingBookId, setLoadingBookId] =
    useState<number | null>(null);
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

  function setCurrentSection(
    section: NarrationSection | null,
  ): void {
    setActiveSectionId(section?.id ?? null);
    setDraftText(section?.text ?? "");
    setCursorPosition(0);
    setDirty(false);
  }

  function displaySections(
    nextSections: NarrationSection[],
    preferredSectionId?: number,
  ): void {
    setSections(nextSections);

    const preferredSection =
      nextSections.find(
        (section) => section.id === preferredSectionId,
      ) ??
      nextSections[0] ??
      null;

    setCurrentSection(preferredSection);
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
    clearMessages();
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
    clearMessages();

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
      showError(uploadError, "The upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function openBook(bookId: number): Promise<void> {
    if (!confirmDiscardChanges()) {
      return;
    }

    setLoadingBookId(bookId);
    clearMessages();

    try {
      const [book, bookSections] = await Promise.all([
        requestJson<BookDetail>(`${API_URL}/books/${bookId}`),
        loadSections(bookId),
      ]);

      setSelectedBook(book);
      displaySections(bookSections);
    } catch (loadError) {
      showError(loadError, "The book could not be opened.");
    } finally {
      setLoadingBookId(null);
    }
  }

  async function deleteBook(bookId: number): Promise<void> {
    const approved = window.confirm(
      "Delete this book and all narration sections?",
    );

    if (!approved) {
      return;
    }

    clearMessages();

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
      showError(deleteError, "The book could not be deleted.");
    }
  }

  function selectSection(section: NarrationSection): void {
    if (
      section.id !== activeSectionId &&
      !confirmDiscardChanges()
    ) {
      return;
    }

    setCurrentSection(section);
    clearMessages();
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

    setWorking(true);
    clearMessages();

    try {
      const savedSection =
        await requestJson<NarrationSection>(
          `${API_URL}/sections/${activeSection.id}`,
          {
            method: "PATCH",
            headers: jsonHeaders(),
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
      showError(saveError, "The section could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function splitAtCursor(): Promise<void> {
    if (!activeSection) {
      return;
    }

    const firstText = draftText.slice(0, cursorPosition).trim();
    const secondText = draftText.slice(cursorPosition).trim();

    if (!firstText || !secondText) {
      setError(
        "Place the cursor between two portions of text before splitting.",
      );
      return;
    }

    setWorking(true);
    clearMessages();

    try {
      const updatedSections =
        await requestJson<NarrationSection[]>(
          `${API_URL}/sections/${activeSection.id}/split`,
          {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({
              first_text: firstText,
              second_text: secondText,
            }),
          },
        );

      displaySections(
        updatedSections,
        activeSection.id,
      );

      setSuccessMessage(
        "The section was split at the cursor.",
      );
    } catch (splitError) {
      showError(splitError, "The section could not be split.");
    } finally {
      setWorking(false);
    }
  }

  async function mergeWithNext(): Promise<void> {
    if (!activeSection || dirty) {
      setError(
        "Save or discard your current edits before merging.",
      );
      return;
    }

    const approved = window.confirm(
      "Merge this section with the next section?",
    );

    if (!approved) {
      return;
    }

    setWorking(true);
    clearMessages();

    try {
      const updatedSections =
        await requestJson<NarrationSection[]>(
          `${API_URL}/sections/${activeSection.id}/merge-next`,
          {
            method: "POST",
          },
        );

      displaySections(
        updatedSections,
        activeSection.id,
      );

      setSuccessMessage(
        "The two sections were merged.",
      );
    } catch (mergeError) {
      showError(mergeError, "The sections could not be merged.");
    } finally {
      setWorking(false);
    }
  }

  async function deleteActiveSection(): Promise<void> {
    if (!activeSection || dirty) {
      setError(
        "Save or discard your current edits before deleting.",
      );
      return;
    }

    const approved = window.confirm(
      `Delete section ${activeSection.position}?`,
    );

    if (!approved) {
      return;
    }

    const previousIndex = activeSectionIndex;
    setWorking(true);
    clearMessages();

    try {
      const updatedSections =
        await requestJson<NarrationSection[]>(
          `${API_URL}/sections/${activeSection.id}`,
          {
            method: "DELETE",
          },
        );

      const nextSelection =
        updatedSections[previousIndex] ??
        updatedSections[previousIndex - 1] ??
        updatedSections[0] ??
        null;

      setSections(updatedSections);
      setCurrentSection(nextSelection);
      setSuccessMessage("The section was deleted.");
    } catch (deleteError) {
      showError(deleteError, "The section could not be deleted.");
    } finally {
      setWorking(false);
    }
  }

  async function moveSection(
    direction: "up" | "down",
  ): Promise<void> {
    if (!activeSection || dirty) {
      setError(
        "Save or discard your current edits before moving.",
      );
      return;
    }

    setWorking(true);
    clearMessages();

    try {
      const updatedSections =
        await requestJson<NarrationSection[]>(
          `${API_URL}/sections/${activeSection.id}/move`,
          {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({
              direction,
            }),
          },
        );

      displaySections(
        updatedSections,
        activeSection.id,
      );

      setSuccessMessage(
        `The section moved ${direction}.`,
      );
    } catch (moveError) {
      showError(moveError, "The section could not be moved.");
    } finally {
      setWorking(false);
    }
  }

  async function rebuildSections(): Promise<void> {
    if (!selectedBook) {
      return;
    }

    if (
      sections.length > 0 &&
      !window.confirm(
        "Rebuilding replaces all section edits. Continue?",
      )
    ) {
      return;
    }

    const safeTargetWords = Math.min(
      1000,
      Math.max(100, targetWords),
    );

    setTargetWords(safeTargetWords);
    setWorking(true);
    clearMessages();

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
      showError(
        rebuildError,
        "The sections could not be rebuilt.",
      );
    } finally {
      setWorking(false);
    }
  }

  function confirmDiscardChanges(): boolean {
    return (
      !dirty ||
      window.confirm(
        "You have unsaved edits. Discard them?",
      )
    );
  }

  function clearMessages(): void {
    setError("");
    setSuccessMessage("");
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
          <Message type="error">{error}</Message>
        )}

        {successMessage && (
          <Message type="success">
            {successMessage}
          </Message>
        )}

        <section className="mt-8 grid gap-6 xl:grid-cols-[300px_340px_minmax(0,1fr)]">
          <aside className="space-y-6">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-bold">Import book</h2>

              <form className="mt-5" onSubmit={handleUpload}>
                <input
                  accept=".pdf,.epub,.docx,.txt"
                  className="block w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm"
                  id="book-file"
                  onChange={handleFileChange}
                  type="file"
                />

                <button
                  className="mt-4 w-full rounded-lg bg-white px-4 py-3 font-semibold text-slate-950 disabled:opacity-50"
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
              <h2 className="text-lg font-bold">
                Library ({books.length})
              </h2>

              <div className="mt-4 max-h-[620px] space-y-3 overflow-y-auto">
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

                      <p className="mt-2 text-xs text-slate-400">
                        {book.word_count.toLocaleString()} words
                        {" · "}
                        {book.estimated_minutes} min
                      </p>
                    </button>

                    <button
                      className="mt-3 text-sm text-red-300"
                      onClick={() => void deleteBook(book.id)}
                      type="button"
                    >
                      Delete book
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </aside>

          <aside className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">
                Sections
              </h2>

              <span>{sections.length}</span>
            </div>

            {selectedBook && (
              <div className="mt-5 rounded-xl bg-slate-950 p-4">
                <label
                  className="text-sm font-semibold"
                  htmlFor="target-words"
                >
                  Target words
                </label>

                <input
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                  id="target-words"
                  max={1000}
                  min={100}
                  onChange={(event) =>
                    setTargetWords(Number(event.target.value))
                  }
                  type="number"
                  value={targetWords}
                />

                <button
                  className="mt-3 w-full rounded-lg border border-slate-600 px-4 py-2 font-semibold disabled:opacity-50"
                  disabled={working}
                  onClick={() => void rebuildSections()}
                  type="button"
                >
                  Rebuild sections
                </button>
              </div>
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
                  <div className="flex justify-between gap-3">
                    <span className="font-semibold">
                      Section {section.position}
                    </span>

                    <span className="text-xs text-slate-400">
                      {formatDuration(
                        section.estimated_seconds,
                      )}
                    </span>
                  </div>

                  <p className="mt-2 line-clamp-3 text-sm text-slate-400">
                    {section.text}
                  </p>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
            {!activeSection && (
              <p className="text-slate-400">
                Select a book and narration section.
              </p>
            )}

            {activeSection && (
              <>
                <div className="flex flex-wrap justify-between gap-4">
                  <div>
                    <p className="text-sm text-cyan-300">
                      {selectedBook?.filename}
                    </p>

                    <h2 className="mt-1 text-2xl font-bold">
                      Section {activeSection.position}
                    </h2>

                    <p className="mt-2 text-sm text-slate-400">
                      {countWords(draftText)} words
                    </p>
                  </div>

                  <span
                    className={
                      dirty
                        ? "text-amber-300"
                        : "text-emerald-300"
                    }
                  >
                    {dirty ? "Unsaved changes" : "Saved"}
                  </span>
                </div>

                <textarea
                  className="mt-6 min-h-[480px] w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-5 leading-8 outline-none focus:border-cyan-500"
                  onChange={(event) => {
                    setDraftText(event.target.value);
                    setDirty(
                      event.target.value !== activeSection.text,
                    );
                  }}
                  onClick={(event) =>
                    setCursorPosition(
                      event.currentTarget.selectionStart,
                    )
                  }
                  onKeyUp={(event) =>
                    setCursorPosition(
                      event.currentTarget.selectionStart,
                    )
                  }
                  onSelect={(event) =>
                    setCursorPosition(
                      event.currentTarget.selectionStart,
                    )
                  }
                  ref={editorRef}
                  spellCheck
                  value={draftText}
                />

                <p className="mt-2 text-xs text-slate-500">
                  Cursor position: {cursorPosition}
                </p>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <ActionButton
                    disabled={!dirty || working}
                    onClick={() => void saveActiveSection()}
                  >
                    Save
                  </ActionButton>

                  <ActionButton
                    disabled={working}
                    onClick={() => void splitAtCursor()}
                  >
                    Split at cursor
                  </ActionButton>

                  <ActionButton
                    disabled={
                      working ||
                      dirty ||
                      activeSectionIndex >= sections.length - 1
                    }
                    onClick={() => void mergeWithNext()}
                  >
                    Merge with next
                  </ActionButton>

                  <ActionButton
                    disabled={
                      working ||
                      dirty ||
                      activeSectionIndex <= 0
                    }
                    onClick={() => void moveSection("up")}
                  >
                    Move up
                  </ActionButton>

                  <ActionButton
                    disabled={
                      working ||
                      dirty ||
                      activeSectionIndex >= sections.length - 1
                    }
                    onClick={() => void moveSection("down")}
                  >
                    Move down
                  </ActionButton>

                  <button
                    className="rounded-lg border border-red-500/50 px-4 py-3 font-semibold text-red-300 disabled:opacity-40"
                    disabled={working || dirty}
                    onClick={() => void deleteActiveSection()}
                    type="button"
                  >
                    Delete section
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

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="rounded-lg border border-slate-600 px-4 py-3 font-semibold disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Message({
  children,
  type,
}: {
  children: React.ReactNode;
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0
    ? `${minutes}m ${seconds}s`
    : `${minutes}m`;
}
