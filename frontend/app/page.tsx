"use client";

import {
  ChangeEvent,
  FormEvent,
  ReactNode,
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

interface CoverInfo {
  available: boolean;
  filename: string | null;
  size_bytes: number | null;
  media_type: string | null;
}

interface BookMetadata {
  title: string | null;
  author: string | null;
  automatic_title: string | null;
  automatic_author: string | null;
  manual_title: string | null;
  manual_author: string | null;
  source: string | null;
}

interface BookSummary {
  display_title: string;
  display_author: string | null;
  id: number;
  filename: string;
  file_type: string;
  size_bytes: number;
  character_count: number;
  word_count: number;
  estimated_minutes: number;
  chapter_count: number;
  cover: CoverInfo;
  created_at: string;
}

interface BookDetail extends BookSummary {
  metadata: BookMetadata;
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

interface TtsStatus {
  available: boolean;
  engine: string;
  voice: string;
  model_installed: boolean;
  config_installed: boolean;
  max_preview_characters: number;
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
    throw new Error(getApiErrorMessage(data, response.status));
  }

  return data as T;
}

async function requestAudio(
  url: string,
  options: RequestInit,
): Promise<{
  blob: Blob;
  truncated: boolean;
  characterCount: number | null;
}> {
  const response = await fetch(url, options);

  if (!response.ok) {
    const contentType =
      response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const data = (await response.json()) as ErrorResponse;

      throw new Error(
        getApiErrorMessage(data, response.status),
      );
    }

    const responseText = await response.text();

    throw new Error(
      responseText ||
        `Audio request failed with status ${response.status}.`,
    );
  }

  const characterHeader = response.headers.get(
    "X-OpenBook-Preview-Characters",
  );

  return {
    blob: await response.blob(),
    truncated:
      response.headers.get(
        "X-OpenBook-Preview-Truncated",
      ) === "true",
    characterCount: characterHeader
      ? Number(characterHeader)
      : null,
  };
}

function getApiErrorMessage(
  data: ErrorResponse,
  status: number,
): string {
  if (typeof data.detail === "string") {
    return data.detail;
  }

  if (Array.isArray(data.detail)) {
    const validationMessage = data.detail
      .map((item) => item.msg)
      .filter(Boolean)
      .join(", ");

    if (validationMessage) {
      return validationMessage;
    }
  }

  return `Request failed with status ${status}.`;
}

export default function Home() {
  const audioUrlReference = useRef<string | null>(null);

  const [apiStatus, setApiStatus] =
    useState<ApiStatus>("checking");
  const [ttsStatus, setTtsStatus] =
    useState<TtsStatus | null>(null);
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
  const [selectedCoverFile, setSelectedCoverFile] =
    useState<File | null>(null);
  const [uploadingCover, setUploadingCover] =
    useState(false);
  const [removingCover, setRemovingCover] =
    useState(false);
  const [coverVersion, setCoverVersion] =
    useState(0);
  const [metadataTitle, setMetadataTitle] =
    useState("");
  const [metadataAuthor, setMetadataAuthor] =
    useState("");
  const [savingMetadata, setSavingMetadata] =
    useState(false);
  const [targetWords, setTargetWords] = useState(350);
  const [previewSpeed, setPreviewSpeed] = useState(1);
  const [audioUrl, setAudioUrl] =
    useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [working, setWorking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
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

  const replaceAudioUrl = useCallback(
    (nextUrl: string | null): void => {
      if (audioUrlReference.current) {
        URL.revokeObjectURL(audioUrlReference.current);
      }

      audioUrlReference.current = nextUrl;
      setAudioUrl(nextUrl);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (audioUrlReference.current) {
        URL.revokeObjectURL(audioUrlReference.current);
      }
    };
  }, []);

  useEffect(() => {
    setMetadataTitle(
      selectedBook?.metadata.manual_title ?? "",
    );
    setMetadataAuthor(
      selectedBook?.metadata.manual_author ?? "",
    );
  }, [selectedBook]);

  const loadBooks = useCallback(async (): Promise<void> => {
    const storedBooks = await requestJson<BookSummary[]>(
      `${API_URL}/books`,
    );

    setBooks(storedBooks);
  }, []);

  useEffect(() => {
    async function initialize(): Promise<void> {
      try {
        const [health, localTtsStatus] = await Promise.all([
          requestJson<{ status: string }>(
            `${API_URL}/health`,
          ),
          requestJson<TtsStatus>(`${API_URL}/tts/status`),
        ]);

        if (health.status !== "online") {
          throw new Error(
            "Backend returned an invalid status.",
          );
        }

        setApiStatus("online");
        setTtsStatus(localTtsStatus);
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
    replaceAudioUrl(null);
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
        document.querySelector<HTMLInputElement>(
          "#book-file",
        );

      if (fileInput) {
        fileInput.value = "";
      }
    } catch (uploadError) {
      showError(uploadError, "The upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function saveBookMetadata(): Promise<void> {
    if (!selectedBook) {
      return;
    }

    setSavingMetadata(true);
    clearMessages();

    try {
      const savedBook = await requestJson<BookDetail>(
        `${API_URL}/books/${selectedBook.id}/metadata`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({
            title: metadataTitle,
            author: metadataAuthor,
          }),
        },
      );

      setSelectedBook(savedBook);
      await loadBooks();

      setSuccessMessage(
        "Book title and author were saved.",
      );
    } catch (metadataError) {
      showError(
        metadataError,
        "The book metadata could not be saved.",
      );
    } finally {
      setSavingMetadata(false);
    }
  }

  function handleCoverFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    setSelectedCoverFile(
      event.target.files?.[0] ?? null,
    );
    clearMessages();
  }

  async function refreshSelectedBook(
    bookId: number,
  ): Promise<void> {
    const refreshedBook = await requestJson<BookDetail>(
      `${API_URL}/books/${bookId}`,
    );

    setSelectedBook(refreshedBook);
    await loadBooks();
  }

  async function uploadCover(): Promise<void> {
    if (!selectedBook) {
      setError("Open a book before uploading a cover.");
      return;
    }

    if (!selectedCoverFile) {
      setError("Choose a JPG or PNG cover first.");
      return;
    }

    const formData = new FormData();
    formData.append(
      "file",
      selectedCoverFile,
    );

    setUploadingCover(true);
    clearMessages();

    try {
      await requestJson<CoverInfo>(
        `${API_URL}/books/${selectedBook.id}/cover`,
        {
          method: "POST",
          body: formData,
        },
      );

      await refreshSelectedBook(
        selectedBook.id,
      );

      setCoverVersion(
        (current) => current + 1,
      );

      setSelectedCoverFile(null);

      const coverInput =
        document.querySelector<HTMLInputElement>(
          "#cover-file",
        );

      if (coverInput) {
        coverInput.value = "";
      }

      setSuccessMessage(
        "Cover artwork was uploaded.",
      );
    } catch (uploadError) {
      showError(
        uploadError,
        "The cover could not be uploaded.",
      );
    } finally {
      setUploadingCover(false);
    }
  }

  async function removeCover(): Promise<void> {
    if (!selectedBook) {
      return;
    }

    const approved = window.confirm(
      "Remove this book's cover artwork?",
    );

    if (!approved) {
      return;
    }

    setRemovingCover(true);
    clearMessages();

    try {
      await requestJson<{
        deleted: boolean;
        book_id: number;
      }>(
        `${API_URL}/books/${selectedBook.id}/cover`,
        {
          method: "DELETE",
        },
      );

      await refreshSelectedBook(
        selectedBook.id,
      );

      setCoverVersion(
        (current) => current + 1,
      );

      setSuccessMessage(
        "Cover artwork was removed.",
      );
    } catch (deleteError) {
      showError(
        deleteError,
        "The cover could not be removed.",
      );
    } finally {
      setRemovingCover(false);
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
        requestJson<BookDetail>(
          `${API_URL}/books/${bookId}`,
        ),
        loadSections(bookId),
      ]);

      setSelectedBook(book);
      displaySections(bookSections);
    } catch (loadError) {
      showError(
        loadError,
        "The book could not be opened.",
      );
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
      showError(
        deleteError,
        "The book could not be deleted.",
      );
    }
  }

  function selectSection(
    section: NarrationSection,
  ): void {
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
      showError(
        saveError,
        "The section could not be saved.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function generateAudioPreview(): Promise<void> {
    if (!activeSection || !draftText.trim()) {
      setError("The section has no text to preview.");
      return;
    }

    if (!ttsStatus?.available) {
      setError(
        "The local Piper voice is not installed.",
      );
      return;
    }

    setPreviewing(true);
    replaceAudioUrl(null);
    clearMessages();

    try {
      const preview = await requestAudio(
        `${API_URL}/sections/${activeSection.id}/audio-preview`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            text: draftText,
            speed: previewSpeed,
          }),
        },
      );

      const nextAudioUrl = URL.createObjectURL(preview.blob);

      replaceAudioUrl(nextAudioUrl);

      if (preview.truncated) {
        setSuccessMessage(
          `Preview generated from the first ${
            preview.characterCount ??
            ttsStatus.max_preview_characters
          } characters.`,
        );
      } else {
        setSuccessMessage("Audio preview generated.");
      }
    } catch (previewError) {
      showError(
        previewError,
        "The audio preview could not be generated.",
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function splitAtCursor(): Promise<void> {
    if (!activeSection) {
      return;
    }

    const firstText = draftText
      .slice(0, cursorPosition)
      .trim();
    const secondText = draftText
      .slice(cursorPosition)
      .trim();

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
      showError(
        splitError,
        "The section could not be split.",
      );
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
      showError(
        mergeError,
        "The sections could not be merged.",
      );
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
      showError(
        deleteError,
        "The section could not be deleted.",
      );
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
      showError(
        moveError,
        "The section could not be moved.",
      );
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
            <h1 className="text-2xl font-bold">
              OpenBook AI
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Open-source audiobook creation studio
            </p>
          </div>

          <div className="text-right">
            <p className={statusClass}>{statusLabel}</p>

            {ttsStatus && (
              <p
                className={`mt-1 text-xs ${
                  ttsStatus.available
                    ? "text-emerald-300"
                    : "text-amber-300"
                }`}
              >
                Local voice:{" "}
                {ttsStatus.available
                  ? `${ttsStatus.voice} ready`
                  : "not installed"}
              </p>
            )}
          </div>
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
              <h2 className="text-lg font-bold">
                Import book
              </h2>

              <form
                className="mt-5"
                onSubmit={handleUpload}
              >
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
                      disabled={
                        loadingBookId === book.id
                      }
                      onClick={() =>
                        void openBook(book.id)
                      }
                      type="button"
                    >
                      <h3 className="break-words font-semibold">
                        {book.display_title}
                      </h3>

                      {book.display_author && (
                        <p className="mt-1 break-words text-sm text-slate-300">
                          {book.display_author}
                        </p>
                      )}

                      <p className="mt-2 break-all text-xs text-slate-500">
                        {book.filename}
                      </p>

                      <p className="mt-2 text-xs text-slate-400">
                        {book.word_count.toLocaleString()}{" "}
                        words · {book.estimated_minutes} min
                      </p>
                    </button>

                    <button
                      className="mt-3 text-sm text-red-300"
                      onClick={() =>
                        void deleteBook(book.id)
                      }
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
                    setTargetWords(
                      Number(event.target.value),
                    )
                  }
                  type="number"
                  value={targetWords}
                />

                <button
                  className="mt-3 w-full rounded-lg border border-slate-600 px-4 py-2 font-semibold disabled:opacity-50"
                  disabled={working}
                  onClick={() =>
                    void rebuildSections()
                  }
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
                  onClick={() =>
                    selectSection(section)
                  }
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
                    {dirty
                      ? "Unsaved changes"
                      : "Saved"}
                  </span>
                </div>

                <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-950 p-5">
                  <h3 className="text-lg font-bold">
                    Book metadata
                  </h3>

                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Saved values override automatic title and author
                    detection in future M4B exports. Clear both fields
                    and save to return to automatic detection.
                  </p>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <div>
                      <label
                        className="text-sm font-semibold"
                        htmlFor="book-title"
                      >
                        Title
                      </label>

                      <input
                        className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:border-cyan-500"
                        id="book-title"
                        maxLength={200}
                        onChange={(event) =>
                          setMetadataTitle(event.target.value)
                        }
                        placeholder={
                          selectedBook?.metadata.automatic_title ??
                          "Use automatic title detection"
                        }
                        type="text"
                        value={metadataTitle}
                      />

                      <p className="mt-2 text-xs text-slate-500">
                        Automatic:{" "}
                        {selectedBook?.metadata.automatic_title ??
                          "text detection"}
                      </p>
                    </div>

                    <div>
                      <label
                        className="text-sm font-semibold"
                        htmlFor="book-author"
                      >
                        Author
                      </label>

                      <input
                        className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:border-cyan-500"
                        id="book-author"
                        maxLength={200}
                        onChange={(event) =>
                          setMetadataAuthor(event.target.value)
                        }
                        placeholder={
                          selectedBook?.metadata.automatic_author ??
                          "Use automatic author detection"
                        }
                        type="text"
                        value={metadataAuthor}
                      />

                      <p className="mt-2 text-xs text-slate-500">
                        Automatic:{" "}
                        {selectedBook?.metadata.automatic_author ??
                          "text detection"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-4">
                    <button
                      className="rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={savingMetadata}
                      onClick={() =>
                        void saveBookMetadata()
                      }
                      type="button"
                    >
                      {savingMetadata
                        ? "Saving..."
                        : "Save metadata"}
                    </button>

                    <p className="text-xs text-slate-500">
                      Source:{" "}
                      {selectedBook?.metadata.source ??
                        "automatic fallback"}
                    </p>
                  </div>
                </div>

                <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-950 p-5">
                  <div className="grid gap-5 md:grid-cols-[180px_1fr]">
                    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
                      {selectedBook?.cover.available ? (
                        <img
                          alt={`Cover artwork for ${selectedBook.filename}`}
                          className="h-full w-full object-cover"
                          src={`${API_URL}/books/${selectedBook.id}/cover?v=${coverVersion}`}
                        />
                      ) : (
                        <div className="px-5 text-center">
                          <div className="text-4xl">
                            📚
                          </div>

                          <p className="mt-3 text-sm text-slate-500">
                            No cover artwork
                          </p>
                        </div>
                      )}
                    </div>

                    <div>
                      <h3 className="text-lg font-bold">
                        Cover artwork
                      </h3>

                      <p className="mt-2 text-sm leading-6 text-slate-400">
                        Upload a JPG or PNG cover. OpenBook AI
                        will embed it into future M4B exports.
                      </p>

                      <div className="mt-5">
                        <label
                          className="text-sm font-semibold"
                          htmlFor="cover-file"
                        >
                          Choose cover image
                        </label>

                        <input
                          accept="image/jpeg,image/png"
                          className="mt-2 block w-full text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-slate-700 file:px-4 file:py-2 file:font-semibold file:text-slate-100 hover:file:bg-slate-600"
                          id="cover-file"
                          onChange={handleCoverFileChange}
                          type="file"
                        />

                        {selectedCoverFile && (
                          <p className="mt-2 text-xs text-cyan-300">
                            Selected: {selectedCoverFile.name}
                          </p>
                        )}
                      </div>

                      <div className="mt-5 flex flex-wrap gap-3">
                        <button
                          className="rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={
                            !selectedCoverFile ||
                            uploadingCover ||
                            removingCover
                          }
                          onClick={() =>
                            void uploadCover()
                          }
                          type="button"
                        >
                          {uploadingCover
                            ? "Uploading..."
                            : "Upload cover"}
                        </button>

                        {selectedBook?.cover.available && (
                          <button
                            className="rounded-lg border border-red-500/50 px-5 py-2 font-semibold text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={
                              uploadingCover ||
                              removingCover
                            }
                            onClick={() =>
                              void removeCover()
                            }
                            type="button"
                          >
                            {removingCover
                              ? "Removing..."
                              : "Remove cover"}
                          </button>
                        )}
                      </div>

                      {selectedBook?.cover.available && (
                        <p className="mt-4 text-xs text-slate-500">
                          Stored locally
                          {selectedBook.cover.size_bytes
                            ? ` · ${formatFileSize(
                                selectedBook.cover.size_bytes,
                              )}`
                            : ""}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <textarea
                  className="mt-6 min-h-[480px] w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-5 leading-8 outline-none focus:border-cyan-500"
                  onChange={(event) => {
                    replaceAudioUrl(null);
                    setDraftText(event.target.value);
                    setDirty(
                      event.target.value !==
                        activeSection.text,
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
                  spellCheck
                  value={draftText}
                />

                <p className="mt-2 text-xs text-slate-500">
                  Cursor position: {cursorPosition}
                </p>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <ActionButton
                    disabled={!dirty || working}
                    onClick={() =>
                      void saveActiveSection()
                    }
                  >
                    Save
                  </ActionButton>

                  <ActionButton
                    disabled={working}
                    onClick={() =>
                      void splitAtCursor()
                    }
                  >
                    Split at cursor
                  </ActionButton>

                  <ActionButton
                    disabled={
                      working ||
                      dirty ||
                      activeSectionIndex >=
                        sections.length - 1
                    }
                    onClick={() =>
                      void mergeWithNext()
                    }
                  >
                    Merge with next
                  </ActionButton>

                  <ActionButton
                    disabled={
                      working ||
                      dirty ||
                      activeSectionIndex <= 0
                    }
                    onClick={() =>
                      void moveSection("up")
                    }
                  >
                    Move up
                  </ActionButton>

                  <ActionButton
                    disabled={
                      working ||
                      dirty ||
                      activeSectionIndex >=
                        sections.length - 1
                    }
                    onClick={() =>
                      void moveSection("down")
                    }
                  >
                    Move down
                  </ActionButton>

                  <button
                    className="rounded-lg border border-red-500/50 px-4 py-3 font-semibold text-red-300 disabled:opacity-40"
                    disabled={working || dirty}
                    onClick={() =>
                      void deleteActiveSection()
                    }
                    type="button"
                  >
                    Delete section
                  </button>
                </div>

                <div className="mt-8 rounded-2xl border border-slate-700 bg-slate-950 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-bold">
                        Local audio preview
                      </h3>

                      <p className="mt-2 text-sm leading-6 text-slate-400">
                        Generate a temporary WAV preview
                        using the local Piper narrator.
                      </p>
                    </div>

                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        ttsStatus?.available
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {ttsStatus?.available
                        ? `${ttsStatus.voice} ready`
                        : "Voice unavailable"}
                    </span>
                  </div>

                  <div className="mt-5">
                    <div className="flex items-center justify-between">
                      <label
                        className="text-sm font-semibold"
                        htmlFor="preview-speed"
                      >
                        Speaking speed
                      </label>

                      <span className="text-sm text-slate-300">
                        {previewSpeed.toFixed(2)}×
                      </span>
                    </div>

                    <input
                      className="mt-3 w-full"
                      id="preview-speed"
                      max={1.5}
                      min={0.75}
                      onChange={(event) => {
                        replaceAudioUrl(null);
                        setPreviewSpeed(
                          Number(event.target.value),
                        );
                      }}
                      step={0.05}
                      type="range"
                      value={previewSpeed}
                    />
                  </div>

                  {ttsStatus &&
                    draftText.length >
                      ttsStatus.max_preview_characters && (
                      <p className="mt-4 text-sm text-amber-300">
                        Long sections are limited to the
                        first{" "}
                        {ttsStatus.max_preview_characters.toLocaleString()}{" "}
                        characters for previews.
                      </p>
                    )}

                  <button
                    className="mt-5 rounded-lg bg-cyan-400 px-6 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={
                      previewing ||
                      !draftText.trim() ||
                      !ttsStatus?.available
                    }
                    onClick={() =>
                      void generateAudioPreview()
                    }
                    type="button"
                  >
                    {previewing
                      ? "Generating speech..."
                      : "Generate audio preview"}
                  </button>

                  {audioUrl && (
                    <div className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4">
                      <audio
                        className="w-full"
                        controls
                        key={audioUrl}
                        preload="metadata"
                        src={audioUrl}
                      >
                        Your browser does not support
                        audio playback.
                      </audio>

                      <a
                        className="mt-4 inline-block text-sm font-semibold text-cyan-300"
                        download={`section-${activeSection.position}-preview.wav`}
                        href={audioUrl}
                      >
                        Download WAV preview
                      </a>
                    </div>
                  )}
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
  children: ReactNode;
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kilobytes = bytes / 1024;

  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(1)} KB`;
  }

  const megabytes = kilobytes / 1024;

  if (megabytes < 1024) {
    return `${megabytes.toFixed(1)} MB`;
  }

  const gigabytes = megabytes / 1024;

  return `${gigabytes.toFixed(1)} GB`;
}

