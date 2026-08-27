"use client";

import Link from "next/link";
import {
  ReactNode,
  RefObject,
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

interface StorageStatus {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  warning_threshold_bytes: number;
  reserve_bytes: number;
  low: boolean;
  critical: boolean;
}

interface AudiobookStorageSummary {
  job_count: number;
  wav_count: number;
  mp3_count: number;
  m4b_count: number;
  wav_bytes: number;
  mp3_bytes: number;
  m4b_bytes: number;
  total_bytes: number;
  reclaimable_wav_count: number;
  reclaimable_wav_bytes: number;
}

interface AudiobookStorageArtifact {
  job_id: number;
  book_id: number;
  book_title: string;
  book_author: string | null;
  book_filename: string;
  kind: "wav" | "mp3" | "m4b";
  size_bytes: number;
  can_delete: boolean;
  created_at: string;
}

interface AudiobookStorageArtifacts {
  artifact_count: number;
  total_bytes: number;
  artifacts: AudiobookStorageArtifact[];
}

interface StorageCleanupFile {
  filename: string;
  size_bytes: number;
  category: string;
  reason: string;
  safe_to_delete: boolean;
  job_id: number | null;
}

interface StorageCleanupSummary {
  active_job_count: number;
  total_file_count: number;
  total_bytes: number;
  owned_count: number;
  owned_bytes: number;
  protected_count: number;
  protected_bytes: number;
  temporary_count: number;
  temporary_bytes: number;
  inactive_artifact_count: number;
  inactive_artifact_bytes: number;
  orphaned_count: number;
  manual_review_bytes: number;
  safe_reclaimable_count: number;
  safe_reclaimable_bytes: number;
  temporary_files: StorageCleanupFile[];
  inactive_artifacts: StorageCleanupFile[];
  orphaned_files: StorageCleanupFile[];
}

interface StorageCleanupResult {
  deleted_count: number;
  freed_bytes: number;
  deleted_files: string[];
  summary: StorageCleanupSummary;
}


interface GenerationEstimate {
  book_id: number;
  speed: number;
  total_words: number;
  estimated_duration_seconds: number;
  estimated_output_bytes: number;
  estimated_mp3_bytes: number;
  estimated_m4b_bytes: number;
  mp3_required_free_bytes: number;
  mp3_projected_free_bytes: number;
  mp3_safe: boolean;
  m4b_required_free_bytes: number;
  m4b_projected_free_bytes: number;
  m4b_safe: boolean;
  free_bytes: number;
  reserve_bytes: number;
  required_free_bytes: number;
  projected_free_bytes: number;
  safe: boolean;
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
  status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  output_format: "wav" | "mp3" | "m4b" | null;
  speed: number;
  voice: string;
  total_sections: number;
  completed_sections: number;
  progress_percent: number;
  queue_position: number | null;
  output_filename: string | null;
  output_size_bytes: number | null;
  wav_available: boolean;
  can_delete_wav: boolean;
  wav_cleanup_requested?: boolean;
  wav_cleanup_freed_bytes?: number;
  wav_cleanup_warning?: string | null;
  error_message: string | null;
  updated_at: string;
  mp3: Mp3Export;
  m4b: M4bExport;
}

type JobStatusFilter =
  | "all"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

type JobFormatFilter =
  | "all"
  | "wav"
  | "mp3"
  | "m4b";

type JobAvailabilityFilter =
  | "all"
  | "playable"
  | "wav"
  | "mp3"
  | "m4b";

type JobSortOrder =
  | "newest"
  | "recent"
  | "oldest"
  | "title"
  | "size";

type JobPinnedFilter =
  | "all"
  | "pinned";

type JobListeningFilter =
  | "all"
  | "continue";

interface ErrorResponse {
  detail?: string | Array<{ msg?: string }>;
}

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const NARRATOR_STORAGE_KEY =
  "openbook-audiobooks-narrator";
const SPEED_STORAGE_KEY =
  "openbook-audiobooks-speed";
const MIN_NARRATION_SPEED = 0.75;
const MAX_NARRATION_SPEED = 1.5;

function readStoredNarrator(): string | null {
  try {
    const value = window.localStorage.getItem(
      NARRATOR_STORAGE_KEY,
    );

    const cleaned = value?.trim() ?? "";

    return cleaned || null;
  } catch {
    return null;
  }
}

function readStoredNarrationSpeed(): number | null {
  try {
    const value = window.localStorage.getItem(
      SPEED_STORAGE_KEY,
    );

    if (value === null) {
      return null;
    }

    const parsed = Number(value);

    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_NARRATION_SPEED ||
      parsed > MAX_NARRATION_SPEED
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function saveAudiobookPreference(
  key: string,
  value: string,
): void {
  try {
    window.localStorage.setItem(
      key,
      value,
    );
  } catch {
    // Preferences are optional when browser storage is unavailable.
  }
}

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

const JOB_HISTORY_PAGE_SIZE = 5;
const AUDIOBOOK_PIN_STORAGE_KEY =
  "openbook-audiobook-pins-v1";


function readPinnedAudiobookJobIds(): Set<number> {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    const storedValue =
      window.localStorage.getItem(
        AUDIOBOOK_PIN_STORAGE_KEY,
      );

    if (!storedValue) {
      return new Set();
    }

    const parsedValue: unknown =
      JSON.parse(storedValue);

    if (!Array.isArray(parsedValue)) {
      return new Set();
    }

    return new Set(
      parsedValue.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value > 0,
      ),
    );
  } catch {
    return new Set();
  }
}


function storePinnedAudiobookJobIds(
  pinnedJobIds: Set<number>,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const sortedJobIds = [
      ...pinnedJobIds,
    ].sort(
      (left, right) =>
        left - right,
    );

    window.localStorage.setItem(
      AUDIOBOOK_PIN_STORAGE_KEY,
      JSON.stringify(
        sortedJobIds,
      ),
    );
  } catch {
    // Browser storage can be unavailable in restricted sessions.
  }
}


function getStoredAudioBytes(
  job: AudiobookJob,
): number {
  const wavBytes =
    job.wav_available
      ? (job.output_size_bytes ?? 0)
      : 0;

  const mp3Bytes =
    job.mp3?.available
      ? (job.mp3.size_bytes ?? 0)
      : 0;

  const m4bBytes =
    job.m4b?.available
      ? (job.m4b.size_bytes ?? 0)
      : 0;

  return (
    wavBytes
    + mp3Bytes
    + m4bBytes
  );
}



function formatRecentlyPlayed(
  lastPlayedAt: number,
  now: number,
): string {
  const elapsedMilliseconds =
    Math.max(
      0,
      now - lastPlayedAt,
    );

  const elapsedMinutes =
    Math.floor(
      elapsedMilliseconds / 60_000,
    );

  if (elapsedMinutes < 1) {
    return "Played just now";
  }

  if (elapsedMinutes < 60) {
    return `Played ${elapsedMinutes} min ago`;
  }

  const elapsedHours =
    Math.floor(
      elapsedMinutes / 60,
    );

  if (elapsedHours < 24) {
    return `Played ${elapsedHours} ${
      elapsedHours === 1
        ? "hr"
        : "hr"
    } ago`;
  }

  const elapsedDays =
    Math.floor(
      elapsedHours / 24,
    );

  if (elapsedDays === 1) {
    return "Played yesterday";
  }

  if (elapsedDays < 7) {
    return `Played ${elapsedDays} days ago`;
  }

  return `Played ${
    new Date(
      lastPlayedAt,
    ).toLocaleDateString(
      undefined,
      {
        month: "short",
        day: "numeric",
        year: "numeric",
      },
    )
  }`;
}

export default function AudiobooksPage() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookId, setBookId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<AudiobookJob[]>([]);
  const [speed, setSpeed] = useState(1);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voice, setVoice] = useState("");
  const [storageStatus, setStorageStatus] =
    useState<StorageStatus | null>(null);
  const [storageSummary, setStorageSummary] =
    useState<AudiobookStorageSummary | null>(null);
  const [storageArtifacts, setStorageArtifacts] =
    useState<AudiobookStorageArtifacts | null>(null);
  const [cleanupSummary, setCleanupSummary] =
    useState<StorageCleanupSummary | null>(null);
  const [generationEstimate, setGenerationEstimate] =
    useState<GenerationEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] =
    useState(false);
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
  const [
    removeWavAfterExport,
    setRemoveWavAfterExport,
  ] = useState(false);
  const [deletingId, setDeletingId] =
    useState<number | null>(null);
  const [deletingArtifact, setDeletingArtifact] =
    useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] =
    useState<number | null>(null);
  const [retryingJobId, setRetryingJobId] =
    useState<number | null>(null);
  const [cleaningStorage, setCleaningStorage] =
    useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [jobStatusFilter, setJobStatusFilter] =
    useState<JobStatusFilter>("all");
  const [jobFormatFilter, setJobFormatFilter] =
    useState<JobFormatFilter>("all");
  const [jobBookFilter, setJobBookFilter] =
    useState("all");
  const [
    jobAvailabilityFilter,
    setJobAvailabilityFilter,
  ] = useState<JobAvailabilityFilter>("all");
  const [jobSortOrder, setJobSortOrder] =
    useState<JobSortOrder>("newest");
  const [jobPinnedFilter, setJobPinnedFilter] =
    useState<JobPinnedFilter>("all");
  const [jobListeningFilter, setJobListeningFilter] =
    useState<JobListeningFilter>("all");
  const [pinnedJobIds, setPinnedJobIds] =
    useState<Set<number>>(
      () => new Set(),
    );
  const [
    resumePositionByJobId,
    setResumePositionByJobId,
  ] = useState<Map<number, number>>(
    () => new Map(),
  );
  const [
    lastPlayedAtByJobId,
    setLastPlayedAtByJobId,
  ] = useState<Map<number, number>>(
    () => new Map(),
  );
  const [
    recentlyPlayedNow,
    setRecentlyPlayedNow,
  ] = useState(0);
  const [visibleJobCount, setVisibleJobCount] =
    useState(JOB_HISTORY_PAGE_SIZE);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");


  useEffect(() => {
    setPinnedJobIds(
      readPinnedAudiobookJobIds(),
    );
  }, []);


  useEffect(() => {
    function updateRecentlyPlayedClock(): void {
      setRecentlyPlayedNow(
        Date.now(),
      );
    }

    updateRecentlyPlayedClock();

    const interval =
      window.setInterval(
        updateRecentlyPlayedClock,
        60_000,
      );

    return () => {
      window.clearInterval(
        interval,
      );
    };
  }, []);


  const refreshPlaybackLibraryState =
    useCallback((): void => {
      setRecentlyPlayedNow(
        Date.now(),
      );

      const nextResumePositions =
        new Map<number, number>();

      const nextLastPlayedAt =
        new Map<number, number>();

      for (const job of jobs) {
        const resumePosition =
          readPlaybackPosition(
            job.id,
          );

        if (
          resumePosition !== null
        ) {
          nextResumePositions.set(
            job.id,
            resumePosition,
          );
        }

        const lastPlayedAt =
          readLastPlayedAt(
            job.id,
          );

        if (
          lastPlayedAt !== null
        ) {
          nextLastPlayedAt.set(
            job.id,
            lastPlayedAt,
          );
        }
      }

      setResumePositionByJobId(
        nextResumePositions,
      );

      setLastPlayedAtByJobId(
        nextLastPlayedAt,
      );
    }, [jobs]);


  useEffect(() => {
    refreshPlaybackLibraryState();

    function handlePlaybackLibraryChange(): void {
      refreshPlaybackLibraryState();
    }

    window.addEventListener(
      PLAYBACK_LIBRARY_EVENT,
      handlePlaybackLibraryChange,
    );

    return () => {
      window.removeEventListener(
        PLAYBACK_LIBRARY_EVENT,
        handlePlaybackLibraryChange,
      );
    };
  }, [refreshPlaybackLibraryState]);


  function togglePinnedJob(
    jobId: number,
  ): void {
    setPinnedJobIds(
      (currentPinnedJobIds) => {
        const nextPinnedJobIds =
          new Set(
            currentPinnedJobIds,
          );

        if (
          nextPinnedJobIds.has(jobId)
        ) {
          nextPinnedJobIds.delete(
            jobId,
          );
        } else {
          nextPinnedJobIds.add(
            jobId,
          );
        }

        storePinnedAudiobookJobIds(
          nextPinnedJobIds,
        );

        return nextPinnedJobIds;
      },
    );
  }


  const selectedBook = useMemo(
    () => books.find((book) => book.id === bookId) ?? null,
    [bookId, books],
  );

  const activeFormats = useMemo(
    () =>
      new Set(
        jobs
          .filter(
            (job) =>
              job.book_id === bookId &&
              (
                job.status === "queued" ||
                job.status === "running" ||
                job.status === "cancelling"
              ),
          )
          .map((job) => job.output_format),
      ),
    [
      bookId,
      jobs,
    ],
  );

  const activeFormatKeys = useMemo(
    () =>
      new Set(
        jobs
          .filter(
            (job) =>
              job.status === "queued" ||
              job.status === "running" ||
              job.status === "cancelling",
          )
          .map(
            (job) =>
              `${job.book_id}:${job.output_format ?? "legacy"}`,
          ),
      ),
    [jobs],
  );

  function isJobOutputFormatActive(
    job: AudiobookJob,
  ): boolean {
    if (!job.output_format) {
      return false;
    }

    return activeFormatKeys.has(
      `${job.book_id}:${job.output_format}`,
    );
  }


  const filteredJobs = useMemo(() => {
    const normalizedSearch =
      jobSearch.trim().toLowerCase();

    const matchingJobs = jobs.filter(
      (job) => {
        let statusMatches: boolean;

        switch (jobStatusFilter) {
          case "all":
            statusMatches = true;
            break;

          case "active":
            statusMatches =
              job.status === "queued" ||
              job.status === "running" ||
              job.status === "cancelling";
            break;

          default:
            statusMatches =
              job.status === jobStatusFilter;
        }

        const generationFormatMatches =
          jobFormatFilter === "all" ||
          job.output_format ===
            jobFormatFilter;

        const bookMatches =
          jobBookFilter === "all" ||
          String(job.book_id) ===
            jobBookFilter;

        let availabilityMatches: boolean;

        switch (
          jobAvailabilityFilter
        ) {
          case "playable":
            availabilityMatches =
              job.wav_available ||
              job.mp3?.available ||
              job.m4b?.available;
            break;

          case "wav":
            availabilityMatches =
              job.wav_available;
            break;

          case "mp3":
            availabilityMatches =
              job.mp3?.available ?? false;
            break;

          case "m4b":
            availabilityMatches =
              job.m4b?.available ?? false;
            break;

          default:
            availabilityMatches = true;
        }

        const pinnedMatches =
          jobPinnedFilter === "all" ||
          pinnedJobIds.has(job.id);

        const continueListeningMatches =
          jobListeningFilter === "all" ||
          (
            resumePositionByJobId.has(
              job.id,
            ) &&
            (
              job.wav_available ||
              job.mp3?.available ||
              job.m4b?.available
            )
          );

        if (
          !statusMatches ||
          !generationFormatMatches ||
          !bookMatches ||
          !availabilityMatches ||
          !pinnedMatches ||
          !continueListeningMatches
        ) {
          return false;
        }

        if (!normalizedSearch) {
          return true;
        }

        const narratorName =
          voices.find(
            (installedVoice) =>
              installedVoice.id ===
              job.voice,
          )?.name ?? job.voice;

        const searchableText = [
          String(job.id),
          job.book_title,
          job.book_author ?? "",
          job.book_filename,
          narratorName,
          job.voice,
          job.status,
          job.output_format ?? "legacy",
        ]
          .join(" ")
          .toLowerCase();

        return searchableText.includes(
          normalizedSearch,
        );
      },
    );

    return matchingJobs.sort(
      (left, right) => {
        const leftPinned =
          pinnedJobIds.has(left.id);

        const rightPinned =
          pinnedJobIds.has(right.id);

        if (
          leftPinned !== rightPinned
        ) {
          return leftPinned
            ? -1
            : 1;
        }

        switch (jobSortOrder) {
          case "recent": {
            const recentComparison =
              (
                lastPlayedAtByJobId.get(
                  right.id,
                ) ?? 0
              ) -
              (
                lastPlayedAtByJobId.get(
                  left.id,
                ) ?? 0
              );

            return (
              recentComparison ||
              right.id - left.id
            );
          }

          case "oldest":
            return left.id - right.id;

          case "title": {
            const titleComparison =
              left.book_title.localeCompare(
                right.book_title,
                undefined,
                {
                  sensitivity: "base",
                },
              );

            return (
              titleComparison ||
              right.id - left.id
            );
          }

          case "size": {
            const sizeComparison =
              getStoredAudioBytes(right) -
              getStoredAudioBytes(left);

            return (
              sizeComparison ||
              right.id - left.id
            );
          }

          default:
            return right.id - left.id;
        }
      },
    );
  }, [
    jobAvailabilityFilter,
    jobBookFilter,
    jobFormatFilter,
    jobListeningFilter,
    jobPinnedFilter,
    jobSearch,
    jobSortOrder,
    jobs,
    jobStatusFilter,
    lastPlayedAtByJobId,
    pinnedJobIds,
    resumePositionByJobId,
    voices,
  ]);

  const jobFiltersActive =
    jobSearch.trim() !== "" ||
    jobStatusFilter !== "all" ||
    jobFormatFilter !== "all" ||
    jobBookFilter !== "all" ||
    jobAvailabilityFilter !== "all" ||
    jobPinnedFilter !== "all" ||
    jobListeningFilter !== "all";

  const jobControlsModified =
    jobFiltersActive ||
    jobSortOrder !== "newest";


  function clearJobLibraryControls(): void {
    setJobSearch("");
    setJobStatusFilter("all");
    setJobFormatFilter("all");
    setJobBookFilter("all");
    setJobAvailabilityFilter("all");
    setJobPinnedFilter("all");
    setJobListeningFilter("all");
    setJobSortOrder("newest");
  }


  const visibleJobs = useMemo(
    () =>
      filteredJobs.slice(
        0,
        visibleJobCount,
      ),
    [
      filteredJobs,
      visibleJobCount,
    ],
  );

  const hiddenJobCount = Math.max(
    filteredJobs.length - visibleJobs.length,
    0,
  );

  useEffect(() => {
    setVisibleJobCount(
      JOB_HISTORY_PAGE_SIZE,
    );
  }, [
    jobAvailabilityFilter,
    jobBookFilter,
    jobFormatFilter,
    jobListeningFilter,
    jobPinnedFilter,
    jobSearch,
    jobSortOrder,
    jobStatusFilter,
  ]);

  useEffect(() => {
    return () => {
      if (voicePreviewUrlRef.current) {
        URL.revokeObjectURL(
          voicePreviewUrlRef.current,
        );
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshStorageInformation(): Promise<void> {
      try {
        const [
          status,
          summary,
          artifacts,
          cleanup,
        ] = await Promise.all([
          requestJson<StorageStatus>(
            `${API_URL}/storage/status`,
          ),
          requestJson<AudiobookStorageSummary>(
            `${API_URL}/storage/audiobooks-summary`,
          ),
          requestJson<AudiobookStorageArtifacts>(
            `${API_URL}/storage/audiobook-artifacts`,
          ),
          requestJson<StorageCleanupSummary>(
            `${API_URL}/storage/cleanup-summary`,
          ),
        ]);

        if (!cancelled) {
          setStorageStatus(status);
          setStorageSummary(summary);
          setStorageArtifacts(artifacts);
          setCleanupSummary(cleanup);
        }
      } catch {
        // Existing user actions continue to surface backend errors.
      }
    }

    void refreshStorageInformation();

    const timer = window.setInterval(
      () => void refreshStorageInformation(),
      15000,
    );

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!bookId) {
      setGenerationEstimate(null);
      setEstimateLoading(false);
      return;
    }

    let cancelled = false;

    setEstimateLoading(true);

    const timer = window.setTimeout(() => {
      async function loadGenerationEstimate(): Promise<void> {
        try {
          const estimate =
            await requestJson<GenerationEstimate>(
              `${API_URL}/books/${bookId}/audiobook-estimate?speed=${encodeURIComponent(
                String(speed),
              )}`,
            );

          if (!cancelled) {
            setGenerationEstimate(estimate);
          }
        } catch {
          if (!cancelled) {
            setGenerationEstimate(null);
          }
        } finally {
          if (!cancelled) {
            setEstimateLoading(false);
          }
        }
      }

      void loadGenerationEstimate();
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    bookId,
    speed,
    storageStatus?.free_bytes,
  ]);

  const loadJobs = useCallback(async (): Promise<void> => {
    const nextJobs = await requestJson<AudiobookJob[]>(
      `${API_URL}/audiobook-jobs`,
    );

    setJobs(nextJobs);
  }, []);

  useEffect(() => {
    async function initialize(): Promise<void> {
      try {
        const [
          storedBooks,
          voiceData,
          storageData,
        ] = await Promise.all([
          requestJson<BookSummary[]>(
            `${API_URL}/books`,
          ),
          requestJson<VoiceListResponse>(
            `${API_URL}/tts/voices`,
          ),
          requestJson<StorageStatus>(
            `${API_URL}/storage/status`,
          ),
        ]);

        setBooks(storedBooks);
        setBookId(storedBooks[0]?.id ?? null);
        setVoices(voiceData.voices);
        setStorageStatus(storageData);

        const storedNarrator =
          readStoredNarrator();

        const storedNarratorAvailable =
          storedNarrator !== null &&
          voiceData.voices.some(
            (installedVoice) =>
              installedVoice.id === storedNarrator,
          );

        const defaultVoiceAvailable =
          voiceData.voices.some(
            (installedVoice) =>
              installedVoice.id === voiceData.default_voice,
          );

        const selectedVoice =
          storedNarratorAvailable
            ? storedNarrator
            : defaultVoiceAvailable
              ? voiceData.default_voice
              : (voiceData.voices[0]?.id ?? "");

        setVoice(selectedVoice);

        if (selectedVoice) {
          saveAudiobookPreference(
            NARRATOR_STORAGE_KEY,
            selectedVoice,
          );
        }

        const storedSpeed =
          readStoredNarrationSpeed();

        if (storedSpeed !== null) {
          setSpeed(storedSpeed);
        }
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
    void loadJobs();

    const interval = window.setInterval(
      () => {
        void loadJobs();
      },
      2000,
    );

    return () =>
      window.clearInterval(interval);
  }, [loadJobs]);

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

  async function createAudiobook(
    outputFormat: "wav" | "mp3" | "m4b" = "wav",
  ): Promise<void> {
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
            output_format: outputFormat,
          }),
        },
      );

      setJobs((current) => [
        job,
        ...current,
      ]);

      const queuePositionMessage =
        job.queue_position !== null
          ? ` Queue position: #${job.queue_position}.`
          : "";

      if (outputFormat === "m4b") {
        setMessage(
          "Storage-efficient M4B job queued."
          + queuePositionMessage
          + " OpenBook AI will process audiobook jobs one at a time.",
        );
      } else if (outputFormat === "mp3") {
        setMessage(
          "Storage-efficient MP3 job queued."
          + queuePositionMessage
          + " OpenBook AI will process audiobook jobs one at a time.",
        );
      } else {
        setMessage(
          "WAV audiobook job queued."
          + queuePositionMessage
          + " OpenBook AI will process audiobook jobs one at a time.",
        );
      }
    } catch (caughtError) {
      showError(
        caughtError,
        outputFormat === "m4b"
          ? "Direct M4B generation could not start."
          : outputFormat === "mp3"
            ? "Direct MP3 generation could not start."
            : "Audiobook generation could not start.",
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
        `${API_URL}/audiobook-jobs/${jobId}/exports/mp3?delete_wav_after_export=${removeWavAfterExport}`,
        {
          method: "POST",
        },
      );

      setJobs((current) =>
        current.map((job) =>
          job.id === updatedJob.id ? updatedJob : job,
        ),
      );

      await refreshStorageAfterCleanup();

      if (updatedJob.wav_cleanup_warning) {
        setMessage(
          `Compressed MP3 audiobook created successfully. ${updatedJob.wav_cleanup_warning}`,
        );
      } else if (
        (updatedJob.wav_cleanup_freed_bytes ?? 0) > 0
      ) {
        setMessage(
          `Compressed MP3 audiobook created successfully. WAV master removed automatically; ${formatFileSize(
            updatedJob.wav_cleanup_freed_bytes ?? 0,
          )} reclaimed.`,
        );
      } else {
        setMessage(
          "Compressed MP3 audiobook created successfully.",
        );
      }
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
        `${API_URL}/audiobook-jobs/${jobId}/exports/m4b?delete_wav_after_export=${removeWavAfterExport}`,
        {
          method: "POST",
        },
      );

      setJobs((current) =>
        current.map((job) =>
          job.id === updatedJob.id ? updatedJob : job,
        ),
      );

      await refreshStorageAfterCleanup();

      if (updatedJob.wav_cleanup_warning) {
        setMessage(
          `Chaptered M4B audiobook created successfully. ${updatedJob.wav_cleanup_warning}`,
        );
      } else if (
        (updatedJob.wav_cleanup_freed_bytes ?? 0) > 0
      ) {
        setMessage(
          `Chaptered M4B audiobook created successfully. WAV master removed automatically; ${formatFileSize(
            updatedJob.wav_cleanup_freed_bytes ?? 0,
          )} reclaimed.`,
        );
      } else {
        setMessage(
          "Chaptered M4B audiobook created successfully.",
        );
      }
    } catch (caughtError) {
      showError(
        caughtError,
        "The M4B export could not be created.",
      );
    } finally {
      setExportingM4bId(null);
    }
  }

  async function refreshStorageAfterCleanup(): Promise<void> {
    try {
      const [
        status,
        summary,
        artifacts,
        cleanup,
      ] = await Promise.all([
        requestJson<StorageStatus>(
          `${API_URL}/storage/status`,
        ),
        requestJson<AudiobookStorageSummary>(
          `${API_URL}/storage/audiobooks-summary`,
        ),
        requestJson<AudiobookStorageArtifacts>(
          `${API_URL}/storage/audiobook-artifacts`,
        ),
        requestJson<StorageCleanupSummary>(
          `${API_URL}/storage/cleanup-summary`,
        ),
      ]);

      setStorageStatus(status);
      setStorageSummary(summary);
      setStorageArtifacts(artifacts);
      setCleanupSummary(cleanup);
    } catch {
      // Periodic storage refresh will retry.
    }
  }

  async function cleanSafeStorage(): Promise<void> {
    if (
      !cleanupSummary ||
      cleanupSummary.safe_reclaimable_count === 0
    ) {
      setMessage(
        "Storage is already clean. No safe files need removal.",
      );
      return;
    }

    setCleaningStorage(true);
    clearMessages();

    try {
      const result = await requestJson<StorageCleanupResult>(
        `${API_URL}/storage/cleanup-safe`,
        {
          method: "POST",
        },
      );

      setCleanupSummary(result.summary);

      await refreshStorageAfterCleanup();

      if (result.deleted_count === 0) {
        setMessage(
          "No safe cleanup files remained.",
        );
      } else {
        setMessage(
          `Cleaned ${result.deleted_count.toLocaleString()} safe ${
            result.deleted_count === 1 ? "file" : "files"
          } and reclaimed ${formatFileSize(result.freed_bytes)}.`,
        );
      }
    } catch (caughtError) {
      showError(
        caughtError,
        "Safe storage cleanup could not be completed.",
      );
    } finally {
      setCleaningStorage(false);
    }
  }

  async function deleteExport(
    jobId: number,
    kind: "wav" | "mp3" | "m4b",
  ): Promise<void> {
    const cleanupId = `${jobId}-${kind}`;

    setDeletingArtifact(cleanupId);
    clearMessages();

    try {
      const response = await fetch(
        `${API_URL}/audiobook-jobs/${jobId}/exports/${kind}`,
        {
          method: "DELETE",
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

      const result = (await response.json()) as {
        freed_bytes?: number;
      };

      await loadJobs();
      await refreshStorageAfterCleanup();

      const freedBytes = result.freed_bytes ?? 0;

      setMessage(
        freedBytes > 0
          ? `${kind.toUpperCase()} removed. ${formatFileSize(
              freedBytes,
            )} of storage was reclaimed.`
          : `${kind.toUpperCase()} removed.`,
      );
    } catch (caughtError) {
      showError(
        caughtError,
        "The audiobook file could not be deleted.",
      );
    } finally {
      setDeletingArtifact(null);
    }
  }

  async function retryAudiobook(
    job: AudiobookJob,
  ): Promise<void> {
    if (!job.output_format) {
      setError(
        "This legacy audiobook job cannot be retried because its original output format was not recorded.",
      );
      return;
    }

    setRetryingJobId(job.id);
    clearMessages();

    try {
      const retriedJob = await requestJson<AudiobookJob>(
        `${API_URL}/audiobook-jobs/${job.id}/retry`,
        {
          method: "POST",
        },
      );

      setJobs((current) => [
        retriedJob,
        ...current.filter(
          (existingJob) =>
            existingJob.id !== retriedJob.id,
        ),
      ]);

      setMessage(
        `Retry started using the original ${job.output_format.toUpperCase()} format, narrator, and speed.`,
      );
    } catch (caughtError) {
      showError(
        caughtError,
        "Audiobook retry could not be started.",
      );
    } finally {
      setRetryingJobId(null);
    }
  }

  async function cancelAudiobook(
    jobId: number,
  ): Promise<void> {
    setCancellingJobId(jobId);
    clearMessages();

    try {
      const updatedJob = await requestJson<AudiobookJob>(
        `${API_URL}/audiobook-jobs/${jobId}/cancel`,
        {
          method: "POST",
        },
      );

      setJobs((current) =>
        current.map((job) =>
          job.id === updatedJob.id ? updatedJob : job,
        ),
      );

      if (updatedJob.status === "cancelled") {
        setMessage(
          "Audiobook generation cancelled.",
        );
      } else {
        setMessage(
          "Cancellation requested. OpenBook AI will stop safely after the current narration section.",
        );
      }
    } catch (caughtError) {
      showError(
        caughtError,
        "Audiobook generation could not be cancelled.",
      );
    } finally {
      setCancellingJobId(null);
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

      await refreshStorageAfterCleanup();

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

        {storageStatus?.low && (
          <div
            className={`mt-5 rounded-xl border p-4 text-sm ${
              storageStatus.critical
                ? "border-red-500/40 bg-red-500/10 text-red-200"
                : "border-amber-500/40 bg-amber-500/10 text-amber-100"
            }`}
          >
            <p className="font-semibold">
              {storageStatus.critical
                ? "Storage critically low"
                : "Linux storage is running low"}
            </p>

            <p className="mt-1 leading-6">
              {formatFileSize(storageStatus.free_bytes)} free.
              {" "}
              OpenBook AI protects a{" "}
              {formatFileSize(storageStatus.reserve_bytes)} safety
              reserve and will block audiobook or export jobs that
              would cross it.
            </p>
          </div>
        )}

        {storageSummary && (
          <section className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  OpenBook audiobook storage
                </h2>

                <p className="mt-1 text-sm leading-6 text-slate-400">
                  Verified generated audio across{" "}
                  {storageSummary.job_count.toLocaleString()} audiobook{" "}
                  {storageSummary.job_count === 1 ? "job" : "jobs"}.
                </p>
              </div>

              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Total audio
                </p>

                <p className="mt-1 text-xl font-bold text-white">
                  {formatFileSize(
                    storageSummary.total_bytes,
                  )}
                </p>
              </div>
            </div>

            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-slate-950 p-3">
                <dt className="text-slate-400">
                  WAV masters
                </dt>
                <dd className="mt-1 font-semibold text-white">
                  {formatFileSize(
                    storageSummary.wav_bytes,
                  )}{" "}
                  <span className="font-normal text-slate-500">
                    ({storageSummary.wav_count})
                  </span>
                </dd>
              </div>

              <div className="rounded-lg bg-slate-950 p-3">
                <dt className="text-slate-400">
                  MP3 exports
                </dt>
                <dd className="mt-1 font-semibold text-white">
                  {formatFileSize(
                    storageSummary.mp3_bytes,
                  )}{" "}
                  <span className="font-normal text-slate-500">
                    ({storageSummary.mp3_count})
                  </span>
                </dd>
              </div>

              <div className="rounded-lg bg-slate-950 p-3">
                <dt className="text-slate-400">
                  M4B exports
                </dt>
                <dd className="mt-1 font-semibold text-white">
                  {formatFileSize(
                    storageSummary.m4b_bytes,
                  )}{" "}
                  <span className="font-normal text-slate-500">
                    ({storageSummary.m4b_count})
                  </span>
                </dd>
              </div>
            </dl>

            <div
              className={`mt-4 rounded-lg border p-3 text-sm ${
                storageSummary.reclaimable_wav_bytes > 0
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
                  : "border-slate-700 bg-slate-950 text-slate-400"
              }`}
            >
              {storageSummary.reclaimable_wav_bytes > 0 ? (
                <>
                  <span className="font-semibold">
                    Safely reclaimable WAV space:{" "}
                    {formatFileSize(
                      storageSummary.reclaimable_wav_bytes,
                    )}
                  </span>
                  {" · "}
                  {storageSummary.reclaimable_wav_count}{" "}
                  {storageSummary.reclaimable_wav_count === 1
                    ? "master"
                    : "masters"}{" "}
                  already have a verified MP3 or M4B copy.
                </>
              ) : (
                <>
                  No WAV masters are currently marked safely
                  reclaimable. Keep a compressed copy before deleting
                  a WAV master.
                </>
              )}
            </div>

            <p className="mt-3 text-xs leading-5 text-slate-500">
              Informational only. Use each job&apos;s Storage cleanup
              controls to choose exactly what to remove.
            </p>
          </section>
        )}

        {storageArtifacts && (
          <section className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  Storage by audiobook
                </h2>

                <p className="mt-1 text-sm leading-6 text-slate-400">
                  Verified audiobook files sorted largest-first so
                  you can reclaim the most space first.
                </p>
              </div>

              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Stored artifacts
                </p>

                <p className="mt-1 text-xl font-bold text-white">
                  {storageArtifacts.artifact_count.toLocaleString()}
                </p>

                <p className="text-xs text-slate-500">
                  {formatFileSize(
                    storageArtifacts.total_bytes,
                  )} total
                </p>
              </div>
            </div>

            {storageArtifacts.artifacts.length === 0 ? (
              <p className="mt-5 rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-400">
                No generated audiobook files are currently stored.
              </p>
            ) : (
              <div className="mt-5 space-y-3">
                {storageArtifacts.artifacts.map(
                  (artifact, index) => {
                    const deletionId =
                      `${artifact.job_id}-${artifact.kind}`;

                    return (
                      <div
                        className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4 lg:flex-row lg:items-center lg:justify-between"
                        key={deletionId}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-slate-500">
                              #{index + 1}
                            </span>

                            <span className="rounded-md bg-slate-800 px-2 py-1 text-xs font-bold uppercase text-cyan-200">
                              {artifact.kind}
                            </span>

                            <span className="text-xs text-slate-500">
                              Job {artifact.job_id}
                            </span>
                          </div>

                          <p className="mt-2 truncate font-semibold text-white">
                            {artifact.book_title}
                          </p>

                          <p className="mt-1 truncate text-sm text-slate-400">
                            {artifact.book_author
                              ? `${artifact.book_author} • `
                              : ""}
                            {artifact.book_filename}
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-4">
                          <div className="text-right">
                            <p className="text-lg font-bold text-white">
                              {formatFileSize(
                                artifact.size_bytes,
                              )}
                            </p>

                            <p className="text-xs text-slate-500">
                              {storageArtifacts.total_bytes > 0
                                ? `${(
                                    (artifact.size_bytes /
                                      storageArtifacts.total_bytes) *
                                    100
                                  ).toFixed(1)}% of audio storage`
                                : "0% of audio storage"}
                            </p>
                          </div>

                          <button
                            className="rounded-lg border border-red-400/40 px-4 py-2 text-sm font-semibold text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={
                              deletingArtifact !== null ||
                              !artifact.can_delete
                            }
                            onClick={() =>
                              void deleteExport(
                                artifact.job_id,
                                artifact.kind,
                              )
                            }
                            type="button"
                          >
                            {deletingArtifact === deletionId
                              ? `Deleting ${artifact.kind.toUpperCase()}...`
                              : artifact.can_delete
                                ? `Delete ${artifact.kind.toUpperCase()}`
                                : "Keep compressed copy first"}
                          </button>
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            )}

            <p className="mt-4 text-xs leading-5 text-slate-500">
              WAV masters without an MP3 or M4B copy stay protected.
              MP3 and M4B exports can be removed individually using
              the same verified deletion logic as job history.
            </p>
          </section>
        )}

        {cleanupSummary && (
          <section className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  Storage cleanup dashboard
                </h2>

                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
                  OpenBook AI can safely remove stale temporary files
                  and leftover audio from failed or cancelled jobs.
                  Active jobs and orphaned files are protected.
                </p>
              </div>

              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Safely reclaimable
                </p>

                <p className="mt-1 text-xl font-bold text-white">
                  {formatFileSize(
                    cleanupSummary.safe_reclaimable_bytes,
                  )}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Safe files
                </p>

                <p className="mt-2 text-lg font-semibold">
                  {cleanupSummary.safe_reclaimable_count.toLocaleString()}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  Ready for automatic cleanup
                </p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Temporary
                </p>

                <p className="mt-2 text-lg font-semibold">
                  {formatFileSize(
                    cleanupSummary.temporary_bytes,
                  )}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  {cleanupSummary.temporary_count.toLocaleString()} stale{" "}
                  {cleanupSummary.temporary_count === 1
                    ? "file"
                    : "files"}
                </p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Protected
                </p>

                <p className="mt-2 text-lg font-semibold">
                  {cleanupSummary.active_job_count.toLocaleString()}{" "}
                  {cleanupSummary.active_job_count === 1
                    ? "job"
                    : "jobs"}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  Active generation is never cleaned
                </p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Manual review
                </p>

                <p className="mt-2 text-lg font-semibold">
                  {formatFileSize(
                    cleanupSummary.manual_review_bytes,
                  )}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  {cleanupSummary.orphaned_count.toLocaleString()} orphaned{" "}
                  {cleanupSummary.orphaned_count === 1
                    ? "file"
                    : "files"}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-400">
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <span>
                  Failed/cancelled leftovers:{" "}
                  <strong className="text-slate-200">
                    {cleanupSummary.inactive_artifact_count.toLocaleString()}
                  </strong>{" "}
                  ({formatFileSize(
                    cleanupSummary.inactive_artifact_bytes,
                  )})
                </span>

                <span>
                  Owned audio:{" "}
                  <strong className="text-slate-200">
                    {cleanupSummary.owned_count.toLocaleString()}
                  </strong>{" "}
                  ({formatFileSize(
                    cleanupSummary.owned_bytes,
                  )})
                </span>

                <span>
                  Files scanned:{" "}
                  <strong className="text-slate-200">
                    {cleanupSummary.total_file_count.toLocaleString()}
                  </strong>
                </span>
              </div>
            </div>

            {cleanupSummary.active_job_count > 0 && (
              <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100">
                Safe cleanup is paused while audiobook generation is
                active. This prevents cleanup from racing with a
                running encoder.
              </p>
            )}

            {cleanupSummary.orphaned_count > 0 && (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-amber-100">
                  Manual review required
                </p>

                <p className="mt-1 text-sm leading-6 text-amber-100/80">
                  Orphaned files are never deleted automatically because
                  they are not associated with a known audiobook job.
                </p>

                <div className="mt-3 space-y-2">
                  {cleanupSummary.orphaned_files
                    .slice(0, 8)
                    .map((file) => (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-950/50 px-3 py-2 text-xs"
                        key={file.filename}
                      >
                        <span className="break-all text-slate-300">
                          {file.filename}
                        </span>

                        <span className="text-slate-500">
                          {formatFileSize(file.size_bytes)}
                        </span>
                      </div>
                    ))}
                </div>

                {cleanupSummary.orphaned_count > 8 && (
                  <p className="mt-2 text-xs text-amber-100/70">
                    Plus{" "}
                    {(
                      cleanupSummary.orphaned_count - 8
                    ).toLocaleString()}{" "}
                    more orphaned files.
                  </p>
                )}
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button
                className="rounded-lg bg-emerald-400 px-5 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={
                  cleaningStorage ||
                  cleanupSummary.safe_reclaimable_count === 0 ||
                  cleanupSummary.active_job_count > 0
                }
                onClick={() =>
                  void cleanSafeStorage()
                }
                type="button"
              >
                {cleaningStorage
                  ? "Cleaning..."
                  : cleanupSummary.safe_reclaimable_count === 0
                    ? "Storage is clean"
                    : `Clean ${cleanupSummary.safe_reclaimable_count.toLocaleString()} safe ${
                        cleanupSummary.safe_reclaimable_count === 1
                          ? "file"
                          : "files"
                      }`}
              </button>

              <p className="text-xs leading-5 text-slate-500">
                Bulk cleanup never removes completed audiobook files
                or orphaned/manual-review files.
              </p>
            </div>
          </section>
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
                          const nextVoice =
                            event.target.value;

                          setVoice(nextVoice);

                          saveAudiobookPreference(
                            NARRATOR_STORAGE_KEY,
                            nextVoice,
                          );

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
                    onChange={(event) => {
                      const nextSpeed = Number(
                        event.target.value,
                      );

                      setSpeed(nextSpeed);

                      saveAudiobookPreference(
                        SPEED_STORAGE_KEY,
                        String(nextSpeed),
                      );

                      clearVoicePreview();
                    }}
                    step={0.05}
                    type="range"
                    value={speed}
                  />
                </div>

                <div
                  className={`mt-5 rounded-xl border p-4 text-sm ${
                    generationEstimate?.safe === false
                      ? "border-red-500/40 bg-red-500/10"
                      : "border-slate-700 bg-slate-950"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold">
                      Pre-generation estimate
                    </p>

                    {generationEstimate && (
                      <span
                        className={
                          generationEstimate.safe
                            ? "text-emerald-300"
                            : "text-red-300"
                        }
                      >
                        {generationEstimate.safe
                          ? "Safe to generate"
                          : "Not enough storage"}
                      </span>
                    )}
                  </div>

                  {estimateLoading ? (
                    <p className="mt-3 text-slate-400">
                      Calculating from narration sections...
                    </p>
                  ) : generationEstimate ? (
                    <>
                      <dl className="mt-4 space-y-2 text-slate-300">
                        <div className="flex justify-between gap-4">
                          <dt>Estimated duration</dt>
                          <dd className="font-semibold text-white">
                            {formatDuration(
                              generationEstimate.estimated_duration_seconds,
                            )}
                          </dd>
                        </div>

                        <div className="flex justify-between gap-4">
                          <dt>Estimated WAV</dt>
                          <dd className="font-semibold text-white">
                            {formatFileSize(
                              generationEstimate.estimated_output_bytes,
                            )}
                          </dd>
                        </div>

                        <div className="flex justify-between gap-4">
                          <dt>Estimated MP3 (64 kbps)</dt>
                          <dd>
                            {formatFileSize(
                              generationEstimate.estimated_mp3_bytes,
                            )}
                          </dd>
                        </div>

                        <div className="flex justify-between gap-4">
                          <dt>Estimated M4B (64 kbps)</dt>
                          <dd>
                            {formatFileSize(
                              generationEstimate.estimated_m4b_bytes,
                            )}
                          </dd>
                        </div>

                        <div className="flex justify-between gap-4">
                          <dt>Free now</dt>
                          <dd>
                            {formatFileSize(
                              generationEstimate.free_bytes,
                            )}
                          </dd>
                        </div>

                        <div className="flex justify-between gap-4">
                          <dt>Protected reserve</dt>
                          <dd>
                            {formatFileSize(
                              generationEstimate.reserve_bytes,
                            )}
                          </dd>
                        </div>

                        <div className="flex justify-between gap-4">
                          <dt>Projected free after WAV</dt>
                          <dd>
                            {formatFileSize(
                              generationEstimate.projected_free_bytes,
                            )}
                          </dd>
                        </div>
                      </dl>

                      <p className="mt-3 text-xs leading-5 text-slate-400">
                        MP3 and M4B estimates use the same 64 kbps
                        setting as the exporters, plus a small
                        container margin. Cover artwork and metadata
                        can make final files slightly larger.
                      </p>

                      <p className="mt-3 text-xs leading-5 text-slate-400">
                        Estimate uses{" "}
                        {generationEstimate.total_words.toLocaleString()}{" "}
                        narration words at {speed.toFixed(2)}×.
                      </p>

                      {!generationEstimate.safe && (
                        <p className="mt-2 text-xs leading-5 text-red-200">
                          About{" "}
                          {formatFileSize(
                            generationEstimate.required_free_bytes,
                          )}{" "}
                          free is required including the protected
                          reserve.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-3 text-slate-400">
                      Generation estimate is temporarily unavailable.
                      The backend safety check will still protect
                      generation.
                    </p>
                  )}
                </div>

                <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
                  <input
                    checked={removeWavAfterExport}
                    className="mt-1 h-4 w-4"
                    onChange={(event) => {
                      setRemoveWavAfterExport(
                        event.target.checked,
                      );
                      clearMessages();
                    }}
                    type="checkbox"
                  />

                  <span>
                    <span className="block text-sm font-semibold text-white">
                      Remove WAV after successful export
                    </span>

                    <span className="mt-1 block text-xs leading-5 text-slate-400">
                      Applies when creating MP3 or M4B from an
                      existing WAV job. Off by default. Direct MP3
                      generation below never creates a WAV master.
                    </span>

                    <span className="mt-2 block text-xs leading-5 text-amber-300">
                      After the WAV is removed, the other compressed
                      format cannot be created from that job unless
                      you generate a new WAV.
                    </span>
                  </span>
                </label>

                <button
                  className="mt-7 w-full rounded-lg bg-white px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
                  disabled={
                    storageStatus?.critical ||
                    generationEstimate?.safe === false ||
                    !bookId ||
                    !voice ||
                    creating ||
                    activeFormats.has("wav")
                  }
                  onClick={() => void createAudiobook()}
                  type="button"
                >
                  {creating
                    ? "Starting..."
                    : activeFormats.has("wav")
                      ? "WAV queued or running"
                      : "Generate WAV audiobook"}
                </button>

                <button
                  className="mt-3 w-full rounded-lg bg-cyan-400 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
                  disabled={
                    storageStatus?.critical ||
                    generationEstimate?.mp3_safe === false ||
                    !bookId ||
                    !voice ||
                    creating ||
                    activeFormats.has("mp3")
                  }
                  onClick={() =>
                    void createAudiobook("mp3")
                  }
                  type="button"
                >
                  {creating
                    ? "Starting..."
                    : activeFormats.has("mp3")
                      ? "MP3 queued or running"
                      : "Generate MP3 directly"}
                </button>

                <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs leading-5 text-slate-400">
                  <p>
                    Direct MP3 skips the full WAV master and streams
                    each narration section into a 64 kbps MP3.
                  </p>

                  {generationEstimate && (
                    <p className="mt-2">
                      Estimated MP3:{" "}
                      <span className="font-semibold text-white">
                        {formatFileSize(
                          generationEstimate.estimated_mp3_bytes,
                        )}
                      </span>
                      {" · "}
                      Projected free storage:{" "}
                      <span className="font-semibold text-white">
                        {formatFileSize(
                          generationEstimate.mp3_projected_free_bytes,
                        )}
                      </span>
                    </p>
                  )}

                  <p className="mt-2 text-amber-300">
                    No WAV master is stored. Choose direct M4B below
                    when you want a chaptered M4B audiobook.
                  </p>
                </div>

                <button
                  className="mt-3 w-full rounded-lg bg-violet-400 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
                  disabled={
                    storageStatus?.critical ||
                    generationEstimate?.m4b_safe === false ||
                    !bookId ||
                    !voice ||
                    creating ||
                    activeFormats.has("m4b")
                  }
                  onClick={() =>
                    void createAudiobook("m4b")
                  }
                  type="button"
                >
                  {creating
                    ? "Starting..."
                    : activeFormats.has("m4b")
                      ? "M4B queued or running"
                      : "Generate M4B directly"}
                </button>

                <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-xs leading-5 text-slate-400">
                  <p>
                    Direct M4B streams narration into 64 kbps AAC,
                    then adds OpenBook AI chapter timestamps,
                    metadata, narrator information, and cover art.
                    No full WAV master is stored.
                  </p>

                  {generationEstimate && (
                    <p className="mt-2">
                      Estimated M4B:{" "}
                      <span className="font-semibold text-white">
                        {formatFileSize(
                          generationEstimate.estimated_m4b_bytes,
                        )}
                      </span>
                      {" · "}
                      Projected free storage:{" "}
                      <span className="font-semibold text-white">
                        {formatFileSize(
                          generationEstimate.m4b_projected_free_bytes,
                        )}
                      </span>
                    </p>
                  )}

                  <p className="mt-2 text-violet-300">
                    Best choice when you want one compact audiobook
                    file with chapter navigation.
                  </p>
                </div>
              </>
            )}
          </aside>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">
                Audiobook library
              </h2>

              <span className="rounded-full bg-slate-800 px-3 py-1 text-sm">
                {jobFiltersActive
                  ? `${filteredJobs.length}/${jobs.length}`
                  : jobs.length}
              </span>
            </div>

            {jobs.length === 0 && (
              <p className="mt-5 text-slate-400">
                Generated audiobooks from every book will appear here.
              </p>
            )}

            {jobs.length > 0 && (
              <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-200">
                    Search, filter, and sort your audiobook library
                  </p>

                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Audiobook jobs from every book appear here. The
                    book selected above still controls new generation.
                  </p>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-9">
                  <div className="xl:col-span-2">
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-search"
                    >
                      Search
                    </label>

                    <input
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
                      id="job-history-search"
                      onChange={(event) =>
                        setJobSearch(
                          event.target.value,
                        )
                      }
                      placeholder="Title, author, narrator, file, or job ID"
                      type="search"
                      value={jobSearch}
                    />
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-book"
                    >
                      Book
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-book"
                      onChange={(event) =>
                        setJobBookFilter(
                          event.target.value,
                        )
                      }
                      value={jobBookFilter}
                    >
                      <option value="all">
                        All books
                      </option>

                      {[...books]
                        .sort(
                          (left, right) =>
                            left.display_title.localeCompare(
                              right.display_title,
                              undefined,
                              {
                                sensitivity: "base",
                              },
                            ),
                        )
                        .map((book) => (
                          <option
                            key={book.id}
                            value={String(
                              book.id,
                            )}
                          >
                            {book.display_title}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-status"
                    >
                      Status
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-status"
                      onChange={(event) =>
                        setJobStatusFilter(
                          event.target
                            .value as JobStatusFilter,
                        )
                      }
                      value={jobStatusFilter}
                    >
                      <option value="all">
                        All statuses
                      </option>
                      <option value="active">
                        Active
                      </option>
                      <option value="completed">
                        Completed
                      </option>
                      <option value="failed">
                        Failed
                      </option>
                      <option value="cancelled">
                        Cancelled
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-format"
                    >
                      Generation format
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-format"
                      onChange={(event) =>
                        setJobFormatFilter(
                          event.target
                            .value as JobFormatFilter,
                        )
                      }
                      value={jobFormatFilter}
                    >
                      <option value="all">
                        All formats
                      </option>
                      <option value="wav">
                        WAV
                      </option>
                      <option value="mp3">
                        MP3
                      </option>
                      <option value="m4b">
                        M4B
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-availability"
                    >
                      Stored audio
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-availability"
                      onChange={(event) =>
                        setJobAvailabilityFilter(
                          event.target
                            .value as JobAvailabilityFilter,
                        )
                      }
                      value={
                        jobAvailabilityFilter
                      }
                    >
                      <option value="all">
                        All
                      </option>
                      <option value="playable">
                        Any playable
                      </option>
                      <option value="wav">
                        WAV stored
                      </option>
                      <option value="mp3">
                        MP3 stored
                      </option>
                      <option value="m4b">
                        M4B stored
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-pinned"
                    >
                      Pinned
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-pinned"
                      onChange={(event) =>
                        setJobPinnedFilter(
                          event.target
                            .value as JobPinnedFilter,
                        )
                      }
                      value={jobPinnedFilter}
                    >
                      <option value="all">
                        All
                      </option>
                      <option value="pinned">
                        Pinned only
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-listening"
                    >
                      Listening
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-listening"
                      onChange={(event) =>
                        setJobListeningFilter(
                          event.target
                            .value as JobListeningFilter,
                        )
                      }
                      value={
                        jobListeningFilter
                      }
                    >
                      <option value="all">
                        All
                      </option>
                      <option value="continue">
                        Continue listening
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="job-history-sort"
                    >
                      Sort
                    </label>

                    <select
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      id="job-history-sort"
                      onChange={(event) =>
                        setJobSortOrder(
                          event.target
                            .value as JobSortOrder,
                        )
                      }
                      value={jobSortOrder}
                    >
                      <option value="newest">
                        Newest first
                      </option>
                      <option value="recent">
                        Recently played
                      </option>
                      <option value="oldest">
                        Oldest first
                      </option>
                      <option value="title">
                        Title A–Z
                      </option>
                      <option value="size">
                        Largest stored audio
                      </option>
                    </select>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-slate-500">
                    Showing{" "}
                    <strong className="text-slate-300">
                      {visibleJobs.length.toLocaleString()}
                    </strong>{" "}
                    of{" "}
                    <strong className="text-slate-300">
                      {filteredJobs.length.toLocaleString()}
                    </strong>{" "}
                    {jobFiltersActive
                      ? "matching jobs"
                      : filteredJobs.length === 1
                        ? "job"
                        : "jobs"}

                    {jobFiltersActive && (
                      <>
                        {" "}·{" "}
                        <strong className="text-slate-300">
                          {jobs.length.toLocaleString()}
                        </strong>{" "}
                        total
                      </>
                    )}
                  </div>

                  <button
                    className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={
                      !jobControlsModified
                    }
                    onClick={
                      clearJobLibraryControls
                    }
                    type="button"
                  >
                    Reset library view
                  </button>
                </div>
              </div>
            )}


            {jobs.length > 0 &&
              filteredJobs.length === 0 && (
                <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-5 text-sm text-slate-400">
                  <p>
                    No audiobook jobs match the current filters.
                  </p>

                  <button
                    className="mt-3 font-semibold text-cyan-300"
                    onClick={clearJobLibraryControls}
                    type="button"
                  >
                    Clear filters
                  </button>
                </div>
              )}

            <div className="mt-6 space-y-5">
              {visibleJobs.map((job) => (
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


                      {lastPlayedAtByJobId.has(
                        job.id,
                      ) && (
                        <p
                          className="mt-1 text-xs font-medium text-cyan-300/80"
                          title={
                            new Date(
                              lastPlayedAtByJobId.get(
                                job.id,
                              ) ?? 0,
                            ).toLocaleString()
                          }
                        >
                          {formatRecentlyPlayed(
                            lastPlayedAtByJobId.get(
                              job.id,
                            ) ?? 0,
                            recentlyPlayedNow,
                          )}
                        </p>
                      )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <button
                        aria-pressed={
                          pinnedJobIds.has(
                            job.id,
                          )
                        }
                        className={[
                          "rounded-lg border px-3 py-2 text-xs font-semibold transition",
                          pinnedJobIds.has(
                            job.id,
                          )
                            ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                            : "border-slate-700 text-slate-300 hover:border-amber-400/60 hover:text-amber-200",
                        ].join(" ")}
                        onClick={() =>
                          togglePinnedJob(
                            job.id,
                          )
                        }
                        type="button"
                      >
                        {pinnedJobIds.has(
                          job.id,
                        )
                          ? "★ Pinned"
                          : "☆ Pin"}
                      </button>

                      <StatusBadge
                        status={job.status}
                      />
                    </div>
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

                  {(job.status === "queued" ||
                    job.status === "running" ||
                    job.status === "cancelling") && (
                    <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                      <p className="text-sm leading-6 text-amber-100">
                        {job.status === "cancelling"
                          ? "Cancellation requested. OpenBook AI is finishing safe cleanup."
                          : job.status === "queued"
                            ? job.queue_position !== null
                              ? `Waiting for earlier jobs. Queue position: #${job.queue_position}.`
                              : "Waiting in the audiobook queue."
                            : "Generation is currently active."}
                      </p>

                      <button
                        className="mt-3 rounded-lg border border-amber-400/50 px-4 py-2 text-sm font-semibold text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={
                          cancellingJobId === job.id ||
                          job.status === "cancelling"
                        }
                        onClick={() =>
                          void cancelAudiobook(job.id)
                        }
                        type="button"
                      >
                        {cancellingJobId === job.id ||
                        job.status === "cancelling"
                          ? "Cancelling..."
                          : "Cancel generation"}
                      </button>
                    </div>
                  )}

                  {job.status === "cancelled" && (
                    <p className="mt-4 rounded-lg border border-slate-600 bg-slate-800/60 p-3 text-sm text-slate-300">
                      Audiobook generation was cancelled safely.
                    </p>
                  )}

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

                        {job.wav_available ? (
                          <>
                            <ResumeAudioPlayer
                              bookAuthor={job.book_author}
                              bookTitle={job.book_title}
                              className="mt-3 w-full"
                              format="WAV"
                              jobId={job.id}
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
                          </>
                        ) : (
                          <p className="mt-3 text-sm text-slate-400">
                            WAV master is not stored for this job.
                          </p>
                        )}
                      </div>

                      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                        <h4 className="font-semibold">
                          Compressed MP3
                        </h4>

                        {!job.mp3?.available ? (
                          <button
                            className="mt-4 rounded-lg bg-cyan-400 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
                            disabled={
                              storageStatus?.critical ||
                              !job.wav_available ||
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
                            <ResumeAudioPlayer
                              bookAuthor={job.book_author}
                              bookTitle={job.book_title}
                              className="mt-3 w-full"
                              format="MP3"
                              jobId={job.id}
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
                              storageStatus?.critical ||
                              !job.wav_available ||
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
                            <M4bPlayer
                              bookAuthor={job.book_author}
                              bookTitle={job.book_title}
                              jobId={job.id}
                            />

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

                      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                        <h4 className="font-semibold">
                          Storage cleanup
                        </h4>

                        <p className="mt-2 text-sm leading-6 text-slate-400">
                          Remove individual audio files without
                          deleting this audiobook job, metadata,
                          chapters, cover, or narrator settings.
                        </p>

                        <div className="mt-4 flex flex-wrap gap-3">
                          {job.wav_available && (
                            <button
                              className="rounded-lg border border-amber-500/50 px-4 py-2 text-sm font-semibold text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={
                                !job.can_delete_wav ||
                                deletingArtifact !== null
                              }
                              onClick={() =>
                                void deleteExport(
                                  job.id,
                                  "wav",
                                )
                              }
                              title={
                                job.can_delete_wav
                                  ? "Delete the WAV master"
                                  : "Keep an MP3 or M4B copy before deleting the WAV"
                              }
                              type="button"
                            >
                              {deletingArtifact ===
                              `${job.id}-wav`
                                ? "Deleting WAV..."
                                : "Delete WAV master"}
                            </button>
                          )}

                          {job.mp3?.available && (
                            <button
                              className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-40"
                              disabled={
                                deletingArtifact !== null
                              }
                              onClick={() =>
                                void deleteExport(
                                  job.id,
                                  "mp3",
                                )
                              }
                              type="button"
                            >
                              {deletingArtifact ===
                              `${job.id}-mp3`
                                ? "Deleting MP3..."
                                : "Delete MP3"}
                            </button>
                          )}

                          {job.m4b?.available && (
                            <button
                              className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-40"
                              disabled={
                                deletingArtifact !== null
                              }
                              onClick={() =>
                                void deleteExport(
                                  job.id,
                                  "m4b",
                                )
                              }
                              type="button"
                            >
                              {deletingArtifact ===
                              `${job.id}-m4b`
                                ? "Deleting M4B..."
                                : "Delete M4B"}
                            </button>
                          )}
                        </div>

                        {job.wav_available &&
                          !job.can_delete_wav && (
                            <p className="mt-3 text-xs text-amber-300">
                              Create or keep an MP3 or M4B copy
                              before deleting the WAV master.
                            </p>
                          )}

                        {!job.wav_available && (
                          <p className="mt-3 text-xs text-slate-500">
                            WAV master already removed. Existing
                            compressed exports remain playable.
                          </p>
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

                  {(job.status === "failed" ||
                    job.status === "cancelled") && (
                    <div className="mt-4">
                      {job.output_format ? (
                        <button
                          className="rounded-lg border border-blue-400/40 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-200 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={
                            retryingJobId === job.id ||
                            isJobOutputFormatActive(job)
                          }
                          onClick={() =>
                            void retryAudiobook(job)
                          }
                          type="button"
                        >
                          {retryingJobId === job.id
                            ? "Retrying..."
                            : `Retry ${job.output_format.toUpperCase()}`}
                        </button>
                      ) : (
                        <p className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-sm leading-6 text-slate-400">
                          Retry is unavailable for this legacy job because its original output format was not recorded.
                        </p>
                      )}
                    </div>
                  )}

                  {(job.status === "failed" ||
                    job.status === "cancelled") && (
                    <button
                      className="mt-4 text-sm font-semibold text-red-300 disabled:opacity-50"
                      disabled={deletingId === job.id}
                      onClick={() =>
                        void deleteJob(job.id)
                      }
                      type="button"
                    >
                      {deletingId === job.id
                        ? "Deleting..."
                        : job.status === "cancelled"
                          ? "Delete cancelled job"
                          : "Delete failed job"}
                    </button>
                  )}
                </article>
              ))}
            </div>

            {hiddenJobCount > 0 && (
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  className="rounded-lg border border-slate-700 bg-slate-950 px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-white"
                  onClick={() =>
                    setVisibleJobCount(
                      (currentCount) =>
                        Math.min(
                          currentCount
                            + JOB_HISTORY_PAGE_SIZE,
                          filteredJobs.length,
                        ),
                    )
                  }
                  type="button"
                >
                  Show more audiobook jobs
                </button>

                <p className="text-xs text-slate-500">
                  {Math.min(
                    JOB_HISTORY_PAGE_SIZE,
                    hiddenJobCount,
                  ).toLocaleString()}{" "}
                  more available ·{" "}
                  {hiddenJobCount.toLocaleString()}{" "}
                  hidden
                </p>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

const PLAYBACK_STORAGE_PREFIX =
  "openbook-audiobook-playback-v1";
const PLAYBACK_ACTIVITY_STORAGE_PREFIX =
  "openbook-audiobook-last-played-v1";
const PLAYBACK_RATE_STORAGE_KEY =
  "openbook-audiobook-playback-rate-v1";
const PLAYBACK_LIBRARY_EVENT =
  "openbook-playback-library-changed";
const PLAYBACK_RATE_EVENT =
  "openbook-audiobook-playback-rate-changed";
const PLAYBACK_RATE_OPTIONS = [
  0.75,
  1,
  1.25,
  1.5,
  1.75,
  2,
] as const;
const PLAYBACK_RESUME_MIN_SECONDS = 10;
const PLAYBACK_FINISH_MARGIN_SECONDS = 15;
const PLAYBACK_SAVE_INTERVAL_SECONDS = 5;


function normalizePlaybackRate(
  value: number,
): number {
  return (
    PLAYBACK_RATE_OPTIONS.find(
      (option) =>
        option === value,
    ) ?? 1
  );
}


function readStoredPlaybackRate(): number {
  if (typeof window === "undefined") {
    return 1;
  }

  try {
    const value =
      window.localStorage.getItem(
        PLAYBACK_RATE_STORAGE_KEY,
      );

    if (value === null) {
      return 1;
    }

    return normalizePlaybackRate(
      Number(value),
    );
  } catch {
    return 1;
  }
}


function applyPlaybackRate(
  audio: HTMLAudioElement,
  playbackRate: number,
): void {
  const normalizedRate =
    normalizePlaybackRate(
      playbackRate,
    );

  audio.defaultPlaybackRate =
    normalizedRate;

  audio.playbackRate =
    normalizedRate;
}


function saveStoredPlaybackRate(
  playbackRate: number,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const normalizedRate =
    normalizePlaybackRate(
      playbackRate,
    );

  try {
    window.localStorage.setItem(
      PLAYBACK_RATE_STORAGE_KEY,
      normalizedRate.toString(),
    );
  } catch {
    // Playback speed still works for this session.
  }

  window.dispatchEvent(
    new CustomEvent<PlaybackRateEventDetail>(
      PLAYBACK_RATE_EVENT,
      {
        detail: {
          playbackRate:
            normalizedRate,
        },
      },
    ),
  );
}


function getPlaybackStorageKey(
  jobId: number,
): string {
  return `${PLAYBACK_STORAGE_PREFIX}:${jobId}`;
}


function getPlaybackActivityStorageKey(
  jobId: number,
): string {
  return `${PLAYBACK_ACTIVITY_STORAGE_PREFIX}:${jobId}`;
}


function notifyPlaybackLibraryChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new Event(
      PLAYBACK_LIBRARY_EVENT,
    ),
  );
}


function readLastPlayedAt(
  jobId: number,
): number | null {
  try {
    const value =
      window.localStorage.getItem(
        getPlaybackActivityStorageKey(
          jobId,
        ),
      );

    if (value === null) {
      return null;
    }

    const parsed = Number(value);

    if (
      !Number.isFinite(parsed) ||
      parsed <= 0
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}


function recordLastPlayed(
  jobId: number,
): void {
  try {
    window.localStorage.setItem(
      getPlaybackActivityStorageKey(
        jobId,
      ),
      Date.now().toString(),
    );

    notifyPlaybackLibraryChanged();
  } catch {
    // Playback history remains optional without browser storage.
  }
}


function readPlaybackPosition(
  jobId: number,
): number | null {
  try {
    const value = window.localStorage.getItem(
      getPlaybackStorageKey(jobId),
    );

    if (value === null) {
      return null;
    }

    const parsed = Number(value);

    if (
      !Number.isFinite(parsed) ||
      parsed < PLAYBACK_RESUME_MIN_SECONDS
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}


function clearPlaybackPosition(
  jobId: number,
): void {
  try {
    window.localStorage.removeItem(
      getPlaybackStorageKey(jobId),
    );

    notifyPlaybackLibraryChanged();
  } catch {
    // Resume playback remains optional without browser storage.
  }
}


function storePlaybackPosition(
  jobId: number,
  currentTime: number,
  duration: number,
): boolean {
  if (
    !Number.isFinite(currentTime) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    currentTime < PLAYBACK_RESUME_MIN_SECONDS ||
    currentTime >=
      duration - PLAYBACK_FINISH_MARGIN_SECONDS
  ) {
    clearPlaybackPosition(jobId);
    return false;
  }

  try {
    window.localStorage.setItem(
      getPlaybackStorageKey(jobId),
      currentTime.toFixed(3),
    );

    notifyPlaybackLibraryChanged();

    return true;
  } catch {
    return false;
  }
}


function formatPlaybackPosition(
  totalSeconds: number,
): string {
  const secondsTotal = Math.max(
    0,
    Math.floor(totalSeconds),
  );

  const hours = Math.floor(
    secondsTotal / 3600,
  );

  const minutes = Math.floor(
    (secondsTotal % 3600) / 60,
  );

  const seconds =
    secondsTotal % 60;

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


type NowPlayingFormat =
  | "WAV"
  | "MP3"
  | "M4B";


interface NowPlayingEventDetail {
  playerKey: string;
}


interface PlaybackRateEventDetail {
  playbackRate: number;
}


const NOW_PLAYING_EVENT =
  "openbook-now-playing";


function isAudiobookKeyboardShortcutTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.closest(
    'input, textarea, select, button, a, audio, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  ) !== null;
}


function ResumeAudioPlayer({
  audioRef,
  bookAuthor,
  bookTitle,
  canGoToNextChapter,
  canGoToPreviousChapter,
  chapterCount,
  chapterNumber,
  chapterProgress,
  chapterTitle,
  className,
  format,
  jobId,
  onNextChapter,
  onPreviousChapter,
  src,
}: {
  audioRef?: RefObject<HTMLAudioElement | null>;
  bookAuthor: string | null;
  bookTitle: string;
  canGoToNextChapter?: boolean;
  canGoToPreviousChapter?: boolean;
  chapterCount?: number;
  chapterNumber?: number;
  chapterProgress?: number;
  chapterTitle?: string;
  className: string;
  format: NowPlayingFormat;
  jobId: number;
  onNextChapter?: () => void;
  onPreviousChapter?: () => void;
  src: string;
}) {
  const internalAudioRef =
    useRef<HTMLAudioElement | null>(null);

  const playerContainerRef =
    useRef<HTMLDivElement | null>(null);

  const playerRef =
    audioRef ?? internalAudioRef;

  const restoredForJobRef =
    useRef<number | null>(null);

  const lastSavedBucketRef =
    useRef(-1);

  const [
    restoredPosition,
    setRestoredPosition,
  ] = useState<number | null>(null);

  const [
    positionSaved,
    setPositionSaved,
  ] = useState(false);

  const [
    isNowPlaying,
    setIsNowPlaying,
  ] = useState(false);

  const [
    isPlaying,
    setIsPlaying,
  ] = useState(false);

  const [
    currentTime,
    setCurrentTime,
  ] = useState(0);

  const [
    duration,
    setDuration,
  ] = useState(0);

  const [
    playbackRate,
    setPlaybackRate,
  ] = useState(1);

  const playerKey =
    `${jobId}:${format.toLowerCase()}`;


  useEffect(() => {
    restoredForJobRef.current = null;
    lastSavedBucketRef.current = -1;

    setRestoredPosition(null);
    setPositionSaved(false);
    setIsNowPlaying(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    const storedPlaybackRate =
      readStoredPlaybackRate();

    setPlaybackRate(
      storedPlaybackRate,
    );

    const audio =
      playerRef.current;

    if (audio !== null) {
      applyPlaybackRate(
        audio,
        storedPlaybackRate,
      );
    }
  }, [
    jobId,
    playerRef,
    src,
  ]);


  useEffect(() => {
    function handlePlaybackRateChanged(
      event: Event,
    ): void {
      const customEvent =
        event as CustomEvent<PlaybackRateEventDetail>;

      const nextPlaybackRate =
        normalizePlaybackRate(
          customEvent.detail.playbackRate,
        );

      setPlaybackRate(
        nextPlaybackRate,
      );

      const audio =
        playerRef.current;

      if (audio !== null) {
        applyPlaybackRate(
          audio,
          nextPlaybackRate,
        );
      }
    }

    window.addEventListener(
      PLAYBACK_RATE_EVENT,
      handlePlaybackRateChanged,
    );

    return () => {
      window.removeEventListener(
        PLAYBACK_RATE_EVENT,
        handlePlaybackRateChanged,
      );
    };
  }, [playerRef]);


  useEffect(() => {
    function handleNowPlaying(
      event: Event,
    ): void {
      const customEvent =
        event as CustomEvent<NowPlayingEventDetail>;

      if (
        customEvent.detail.playerKey
        === playerKey
      ) {
        setIsNowPlaying(true);
        return;
      }

      setIsNowPlaying(false);

      const audio =
        playerRef.current;

      if (
        audio !== null
        && !audio.paused
      ) {
        audio.pause();
      }
    }

    window.addEventListener(
      NOW_PLAYING_EVENT,
      handleNowPlaying,
    );

    return () => {
      window.removeEventListener(
        NOW_PLAYING_EVENT,
        handleNowPlaying,
      );
    };
  }, [playerKey, playerRef]);


  function updatePlaybackState(
    audio: HTMLAudioElement,
  ): void {
    setCurrentTime(
      Number.isFinite(
        audio.currentTime,
      )
        ? Math.max(
            0,
            audio.currentTime,
          )
        : 0,
    );

    setDuration(
      Number.isFinite(
        audio.duration,
      )
        ? Math.max(
            0,
            audio.duration,
          )
        : 0,
    );
  }


  function savePosition(
    audio: HTMLAudioElement,
  ): void {
    const saved = storePlaybackPosition(
      jobId,
      audio.currentTime,
      audio.duration,
    );

    setPositionSaved(saved);

    if (saved) {
      setRestoredPosition(
        audio.currentTime,
      );
    } else {
      setRestoredPosition(null);
    }
  }


  function handleLoadedMetadata(
    audio: HTMLAudioElement,
  ): void {
    const storedPlaybackRate =
      readStoredPlaybackRate();

    applyPlaybackRate(
      audio,
      storedPlaybackRate,
    );

    setPlaybackRate(
      storedPlaybackRate,
    );

    updatePlaybackState(
      audio,
    );

    if (
      restoredForJobRef.current === jobId
    ) {
      return;
    }

    restoredForJobRef.current = jobId;

    const savedPosition =
      readPlaybackPosition(jobId);

    if (
      savedPosition === null
      || !Number.isFinite(
        audio.duration,
      )
      || audio.duration <= 0
      || savedPosition >=
        audio.duration
          - PLAYBACK_FINISH_MARGIN_SECONDS
    ) {
      clearPlaybackPosition(jobId);
      setRestoredPosition(null);
      setPositionSaved(false);
      return;
    }

    audio.currentTime =
      savedPosition;

    setCurrentTime(
      savedPosition,
    );

    lastSavedBucketRef.current =
      Math.floor(
        savedPosition
          / PLAYBACK_SAVE_INTERVAL_SECONDS,
      );

    setRestoredPosition(
      savedPosition,
    );

    setPositionSaved(true);
  }


  function handleTimeUpdate(
    audio: HTMLAudioElement,
  ): void {
    updatePlaybackState(
      audio,
    );

    const bucket = Math.floor(
      audio.currentTime
        / PLAYBACK_SAVE_INTERVAL_SECONDS,
    );

    if (
      bucket
      === lastSavedBucketRef.current
    ) {
      return;
    }

    lastSavedBucketRef.current =
      bucket;

    savePosition(
      audio,
    );
  }


  function handleImmediateSave(
    audio: HTMLAudioElement,
  ): void {
    updatePlaybackState(
      audio,
    );

    recordLastPlayed(
      jobId,
    );

    lastSavedBucketRef.current =
      Math.floor(
        audio.currentTime
          / PLAYBACK_SAVE_INTERVAL_SECONDS,
      );

    savePosition(
      audio,
    );
  }


  function handlePlay(
    audio: HTMLAudioElement,
  ): void {
    updatePlaybackState(
      audio,
    );

    recordLastPlayed(
      jobId,
    );

    setIsPlaying(true);
    setIsNowPlaying(true);

    window.dispatchEvent(
      new CustomEvent<NowPlayingEventDetail>(
        NOW_PLAYING_EVENT,
        {
          detail: {
            playerKey,
          },
        },
      ),
    );
  }


  function handlePause(
    audio: HTMLAudioElement,
  ): void {
    setIsPlaying(false);

    handleImmediateSave(
      audio,
    );
  }


  function handleResumeFromSaved(): void {
    const audio =
      playerRef.current;

    if (
      audio === null
      || restoredPosition === null
    ) {
      return;
    }

    audio.currentTime =
      restoredPosition;

    setCurrentTime(
      restoredPosition,
    );

    lastSavedBucketRef.current =
      Math.floor(
        restoredPosition
          / PLAYBACK_SAVE_INTERVAL_SECONDS,
      );
  }


  function handleStartOver(): void {
    const audio =
      playerRef.current;

    clearPlaybackPosition(jobId);

    lastSavedBucketRef.current =
      -1;

    setRestoredPosition(null);
    setPositionSaved(false);
    setCurrentTime(0);

    if (audio !== null) {
      audio.currentTime = 0;
    }
  }


  function handleEnded(): void {
    recordLastPlayed(
      jobId,
    );

    clearPlaybackPosition(jobId);

    lastSavedBucketRef.current =
      -1;

    setRestoredPosition(null);
    setPositionSaved(false);
    setCurrentTime(0);
    setIsPlaying(false);
    setIsNowPlaying(false);
  }


  function togglePlayback(): void {
    const audio =
      playerRef.current;

    if (audio === null) {
      return;
    }

    applyPlaybackRate(
      audio,
      playbackRate,
    );

    if (audio.paused) {
      void audio.play().catch(
        () => undefined,
      );
    } else {
      audio.pause();
    }
  }


  function handlePlaybackRateChange(
    nextPlaybackRate: number,
  ): void {
    const normalizedRate =
      normalizePlaybackRate(
        nextPlaybackRate,
      );

    setPlaybackRate(
      normalizedRate,
    );

    const audio =
      playerRef.current;

    if (audio !== null) {
      applyPlaybackRate(
        audio,
        normalizedRate,
      );
    }

    saveStoredPlaybackRate(
      normalizedRate,
    );
  }


  function seekBy(
    seconds: number,
  ): void {
    const audio =
      playerRef.current;

    if (audio === null) {
      return;
    }

    const maximumTime =
      Number.isFinite(
        audio.duration,
      ) &&
      audio.duration > 0
        ? audio.duration
        : Number.POSITIVE_INFINITY;

    const nextTime = Math.min(
      maximumTime,
      Math.max(
        0,
        audio.currentTime + seconds,
      ),
    );

    audio.currentTime =
      nextTime;

    setCurrentTime(
      nextTime,
    );

    handleImmediateSave(
      audio,
    );
  }


  useEffect(() => {
    if (!isNowPlaying) {
      return;
    }

    function handleKeyboardShortcut(
      event: KeyboardEvent,
    ): void {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isAudiobookKeyboardShortcutTarget(
          event.target,
        )
      ) {
        return;
      }

      if (
        event.key === " " &&
        !event.shiftKey
      ) {
        if (event.repeat) {
          return;
        }

        event.preventDefault();
        togglePlayback();
        return;
      }

      if (event.key === "ArrowLeft") {
        if (event.shiftKey) {
          if (
            event.repeat ||
            onPreviousChapter === undefined ||
            !canGoToPreviousChapter
          ) {
            return;
          }

          event.preventDefault();
          onPreviousChapter();
          return;
        }

        event.preventDefault();
        seekBy(-15);
        return;
      }

      if (event.key === "ArrowRight") {
        if (event.shiftKey) {
          if (
            event.repeat ||
            onNextChapter === undefined ||
            !canGoToNextChapter
          ) {
            return;
          }

          event.preventDefault();
          onNextChapter();
          return;
        }

        event.preventDefault();
        seekBy(30);
      }
    }

    window.addEventListener(
      "keydown",
      handleKeyboardShortcut,
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyboardShortcut,
      );
    };
  });


  function showFullPlayer(): void {
    playerContainerRef.current?.scrollIntoView(
      {
        behavior: "smooth",
        block: "center",
      },
    );
  }


  const progressPercent =
    duration > 0
      ? Math.min(
          100,
          Math.max(
            0,
            (
              currentTime
              / duration
            ) * 100,
          ),
        )
      : 0;


  return (
    <div
      id={`audiobook-player-${playerKey}`}
      ref={playerContainerRef}
    >
      <audio
        className={className}
        controls
        onEnded={handleEnded}
        onLoadedMetadata={(event) =>
          handleLoadedMetadata(
            event.currentTarget,
          )
        }
        onPause={(event) =>
          handlePause(
            event.currentTarget,
          )
        }
        onPlay={(event) =>
          handlePlay(
            event.currentTarget,
          )
        }
        onSeeked={(event) =>
          handleImmediateSave(
            event.currentTarget,
          )
        }
        onTimeUpdate={(event) =>
          handleTimeUpdate(
            event.currentTarget,
          )
        }
        preload="metadata"
        ref={playerRef}
        src={src}
      />

      {restoredPosition !== null ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-emerald-300">
            Position saved at{" "}
            {formatPlaybackPosition(
              restoredPosition,
            )}
            .
          </span>

          <button
            className="rounded-md border border-emerald-500/60 px-2 py-1 font-medium text-emerald-200 transition hover:bg-emerald-500/10"
            onClick={
              handleResumeFromSaved
            }
            type="button"
          >
            Resume from{" "}
            {formatPlaybackPosition(
              restoredPosition,
            )}
          </button>

          <button
            className="rounded-md border border-slate-600 px-2 py-1 font-medium text-slate-300 transition hover:bg-slate-800"
            onClick={
              handleStartOver
            }
            type="button"
          >
            Start over
          </button>
        </div>
      ) : positionSaved ? (
        <p className="mt-2 text-xs text-slate-400">
          Playback position saved automatically
          on this device.
        </p>
      ) : null}

      {isNowPlaying && (
        <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-4xl overflow-hidden rounded-2xl border border-cyan-500/40 bg-slate-950/95 shadow-2xl shadow-black/50 backdrop-blur">
          <div
            aria-hidden="true"
            className="h-1 bg-slate-800"
          >
            <div
              className="h-full bg-cyan-400 transition-[width] duration-300"
              style={{
                width: `${progressPercent}%`,
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
            <div className="flex shrink-0 items-center gap-2">
              {onPreviousChapter && (
                <button
                  aria-label="Previous M4B chapter"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:text-slate-200"
                  disabled={
                    !canGoToPreviousChapter
                  }
                  onClick={
                    onPreviousChapter
                  }
                  title="Previous chapter"
                  type="button"
                >
                  ⏮
                </button>
              )}

              <button
                aria-label="Rewind audiobook 15 seconds"
                className="flex h-9 min-w-12 items-center justify-center rounded-lg border border-slate-700 px-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200"
                onClick={() =>
                  seekBy(-15)
                }
                type="button"
              >
                ↶ 15s
              </button>

              <button
                aria-label={
                  isPlaying
                    ? "Pause audiobook"
                    : "Play audiobook"
                }
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-400 font-bold text-slate-950 transition hover:bg-cyan-300"
                onClick={
                  togglePlayback
                }
                type="button"
              >
                {isPlaying ? "Ⅱ" : "▶"}
              </button>

              <button
                aria-label="Forward audiobook 30 seconds"
                className="flex h-9 min-w-12 items-center justify-center rounded-lg border border-slate-700 px-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200"
                onClick={() =>
                  seekBy(30)
                }
                type="button"
              >
                30s ↷
              </button>

              {onNextChapter && (
                <button
                  aria-label="Next M4B chapter"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:text-slate-200"
                  disabled={
                    !canGoToNextChapter
                  }
                  onClick={
                    onNextChapter
                  }
                  title="Next chapter"
                  type="button"
                >
                  ⏭
                </button>
              )}

              <label
                className="sr-only"
                htmlFor={`playback-rate-${playerKey}`}
              >
                Playback speed
              </label>

              <select
                aria-label="Playback speed"
                className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs font-semibold text-slate-200 outline-none transition focus:border-cyan-400"
                id={`playback-rate-${playerKey}`}
                onChange={(event) =>
                  handlePlaybackRateChange(
                    Number(
                      event.target.value,
                    ),
                  )
                }
                value={playbackRate}
              >
                {PLAYBACK_RATE_OPTIONS.map(
                  (rate) => (
                    <option
                      key={rate}
                      value={rate}
                    >
                      {rate}×
                    </option>
                  ),
                )}
              </select>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                  {format}
                </span>

                <p className="truncate text-sm font-semibold text-slate-100">
                  {bookTitle}
                </p>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                {bookAuthor && (
                  <span className="truncate">
                    {bookAuthor}
                  </span>
                )}

                {chapterTitle && (
                  <span
                    className="max-w-full truncate font-medium text-cyan-300"
                    title={chapterTitle}
                  >
                    Chapter: {chapterTitle}
                  </span>
                )}

                {chapterNumber !== undefined &&
                  chapterCount !== undefined &&
                  chapterProgress !== undefined && (
                    <span className="shrink-0 font-semibold text-cyan-200">
                      Chapter {chapterNumber} of{" "}
                      {chapterCount} ·{" "}
                      {chapterProgress}%
                    </span>
                  )}

                <span>
                  {formatPlaybackPosition(
                    currentTime,
                  )}
                  {" / "}
                  {formatPlaybackPosition(
                    duration,
                  )}
                </span>
              </div>
            </div>

            <button
              className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200"
              onClick={
                showFullPlayer
              }
              type="button"
            >
              Go to player
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const PREVIOUS_CHAPTER_RESTART_THRESHOLD_MS =
  5_000;


function M4bPlayer({
  bookAuthor,
  bookTitle,
  jobId,
}: {
  bookAuthor: string | null;
  bookTitle: string;
  jobId: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [chapters, setChapters] = useState<AudiobookChapter[]>(
    [],
  );
  const [chapterError, setChapterError] = useState("");
  const [currentTimeMs, setCurrentTimeMs] = useState(0);

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

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    setCurrentTimeMs(
      Math.max(
        0,
        audio.currentTime * 1000,
      ),
    );

    function updatePlaybackPosition(): void {
      if (!audio) {
        return;
      }

      setCurrentTimeMs(
        Math.max(
          0,
          audio.currentTime * 1000,
        ),
      );
    }

    audio.addEventListener(
      "loadedmetadata",
      updatePlaybackPosition,
    );
    audio.addEventListener(
      "seeked",
      updatePlaybackPosition,
    );
    audio.addEventListener(
      "timeupdate",
      updatePlaybackPosition,
    );

    return () => {
      audio.removeEventListener(
        "loadedmetadata",
        updatePlaybackPosition,
      );
      audio.removeEventListener(
        "seeked",
        updatePlaybackPosition,
      );
      audio.removeEventListener(
        "timeupdate",
        updatePlaybackPosition,
      );
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

    setCurrentTimeMs(
      chapter.start_ms,
    );

    void audio.play().catch(() => undefined);
  }

  const activeChapterIndex = useMemo(() => {
    if (chapters.length === 0) {
      return -1;
    }

    const matchingIndex = chapters.findIndex(
      (chapter) =>
        currentTimeMs >= chapter.start_ms &&
        currentTimeMs < chapter.end_ms,
    );

    if (matchingIndex >= 0) {
      return matchingIndex;
    }

    const lastIndex =
      chapters.length - 1;

    if (
      currentTimeMs >=
      chapters[lastIndex].start_ms
    ) {
      return lastIndex;
    }

    return -1;
  }, [chapters, currentTimeMs]);

  const activeChapter =
    activeChapterIndex >= 0
      ? chapters[activeChapterIndex]
      : null;

  const canGoToPreviousChapter =
    activeChapterIndex > 0 ||
    (
      activeChapterIndex === 0 &&
      activeChapter !== null &&
      currentTimeMs -
        activeChapter.start_ms >
        PREVIOUS_CHAPTER_RESTART_THRESHOLD_MS
    );

  const canGoToNextChapter =
    activeChapterIndex >= 0 &&
    activeChapterIndex <
      chapters.length - 1;


  function goToPreviousChapter(): void {
    if (
      activeChapterIndex < 0 ||
      activeChapter === null
    ) {
      return;
    }

    const elapsedInChapterMs =
      Math.max(
        0,
        currentTimeMs -
          activeChapter.start_ms,
      );

    const targetIndex =
      elapsedInChapterMs >
      PREVIOUS_CHAPTER_RESTART_THRESHOLD_MS
        ? activeChapterIndex
        : activeChapterIndex - 1;

    if (targetIndex < 0) {
      return;
    }

    jumpToChapter(
      chapters[targetIndex],
    );
  }


  function goToNextChapter(): void {
    if (!canGoToNextChapter) {
      return;
    }

    jumpToChapter(
      chapters[
        activeChapterIndex + 1
      ],
    );
  }


  const activeChapterDurationMs =
    activeChapter === null
      ? 0
      : Math.max(
          1,
          activeChapter.end_ms -
            activeChapter.start_ms,
        );

  const activeChapterElapsedMs =
    activeChapter === null
      ? 0
      : Math.min(
          activeChapterDurationMs,
          Math.max(
            0,
            currentTimeMs -
              activeChapter.start_ms,
          ),
        );

  const activeChapterProgress =
    activeChapter === null
      ? 0
      : Math.min(
          100,
          Math.max(
            0,
            Math.round(
              (
                activeChapterElapsedMs /
                activeChapterDurationMs
              ) * 100,
            ),
          ),
        );

  return (
    <>
      <ResumeAudioPlayer
        audioRef={audioRef}
        bookAuthor={bookAuthor}
        bookTitle={bookTitle}
        canGoToNextChapter={
          canGoToNextChapter
        }
        canGoToPreviousChapter={
          canGoToPreviousChapter
        }
        chapterCount={
          activeChapter === null
            ? undefined
            : chapters.length
        }
        chapterNumber={
          activeChapterIndex >= 0
            ? activeChapterIndex + 1
            : undefined
        }
        chapterProgress={
          activeChapter === null
            ? undefined
            : activeChapterProgress
        }
        chapterTitle={
          activeChapter?.title
        }
        className="mt-4 w-full"
        format="M4B"
        jobId={jobId}
        onNextChapter={
          goToNextChapter
        }
        onPreviousChapter={
          goToPreviousChapter
        }
        src={`${API_URL}/audiobook-jobs/${jobId}/audio/m4b`}
      />

      {chapterError && (
        <p className="mt-3 text-sm text-amber-300">
          Chapter navigation unavailable: {chapterError}
        </p>
      )}

      {chapters.length > 0 && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h5 className="text-sm font-semibold text-slate-200">
              Chapters
            </h5>

            <span className="text-xs text-slate-500">
              {chapters.length}{" "}
              {chapters.length === 1
                ? "chapter"
                : "chapters"}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              aria-label="Previous chapter"
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:text-slate-200"
              disabled={
                !canGoToPreviousChapter
              }
              onClick={
                goToPreviousChapter
              }
              type="button"
            >
              <span
                aria-hidden="true"
                className="mr-2"
              >
                ⏮
              </span>
              Previous chapter
            </button>

            <button
              aria-label="Next chapter"
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:text-slate-200"
              disabled={
                !canGoToNextChapter
              }
              onClick={
                goToNextChapter
              }
              type="button"
            >
              Next chapter
              <span
                aria-hidden="true"
                className="ml-2"
              >
                ⏭
              </span>
            </button>
          </div>

          {activeChapter && (
            <div className="mt-3 rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-sm font-semibold text-cyan-100">
                  Now playing:{" "}
                  <span className="break-words">
                    {activeChapter.title}
                  </span>
                </p>

                <span className="shrink-0 text-xs font-semibold text-cyan-200">
                  {activeChapterProgress}%
                </span>
              </div>

              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-cyan-400 transition-[width] duration-300"
                  style={{
                    width: `${activeChapterProgress}%`,
                  }}
                />
              </div>

              <p className="mt-2 text-xs text-slate-400">
                {formatTimestamp(
                  activeChapterElapsedMs,
                )}{" "}
                of{" "}
                {formatTimestamp(
                  activeChapterDurationMs,
                )}
              </p>
            </div>
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {chapters.map((chapter, index) => {
              const isActive =
                index === activeChapterIndex;

              const chapterProgress =
                isActive
                  ? activeChapterProgress
                  : currentTimeMs >=
                      chapter.end_ms
                    ? 100
                    : 0;

              return (
                <button
                  aria-current={
                    isActive
                      ? "true"
                      : undefined
                  }
                  aria-label={`Play ${chapter.title}`}
                  className={`relative overflow-hidden rounded-lg border px-4 py-3 text-left transition ${
                    isActive
                      ? "border-cyan-400 bg-cyan-500/10 ring-1 ring-cyan-400/30"
                      : "border-slate-700 bg-slate-950 hover:border-cyan-400 hover:bg-slate-900"
                  }`}
                  key={`${chapter.title}-${chapter.start_ms}`}
                  onClick={() =>
                    jumpToChapter(
                      chapter,
                    )
                  }
                  type="button"
                >
                  <span className="flex items-center justify-between gap-4">
                    <span className="min-w-0">
                      <span
                        className={`mr-2 text-xs ${
                          isActive
                            ? "text-cyan-300"
                            : "text-slate-500"
                        }`}
                      >
                        {index + 1}.
                      </span>

                      <span
                        className={`font-semibold ${
                          isActive
                            ? "text-cyan-100"
                            : "text-cyan-200"
                        }`}
                      >
                        {chapter.title}
                      </span>
                    </span>

                    <span className="shrink-0 text-sm text-slate-400">
                      {formatTimestamp(
                        chapter.start_ms,
                      )}
                    </span>
                  </span>

                  {isActive && (
                    <span className="mt-2 flex items-center justify-between gap-3 text-xs">
                      <span className="font-semibold text-cyan-300">
                        Now playing
                      </span>

                      <span className="text-cyan-200">
                        {chapterProgress}%
                      </span>
                    </span>
                  )}

                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-1 bg-slate-800"
                  >
                    <span
                      className={`block h-full transition-[width] duration-300 ${
                        isActive
                          ? "bg-cyan-400"
                          : "bg-slate-600"
                      }`}
                      style={{
                        width: `${chapterProgress}%`,
                      }}
                    />
                  </span>
                </button>
              );
            })}
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
    cancelling: "bg-amber-500/15 text-amber-200",
    cancelled: "bg-slate-500/15 text-slate-300",
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


function formatDuration(
  totalSeconds: number,
): string {
  const roundedSeconds = Math.max(
    0,
    Math.round(totalSeconds),
  );

  const hours = Math.floor(
    roundedSeconds / 3600,
  );

  const minutes = Math.floor(
    (roundedSeconds % 3600) / 60,
  );

  const seconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours} hr ${minutes} min`;
  }

  if (minutes > 0) {
    return `${minutes} min ${seconds} sec`;
  }

  return `${seconds} sec`;
}


function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
