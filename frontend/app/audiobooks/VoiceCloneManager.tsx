"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface VoiceClone {
  id: string;
  voice_id: string;
  name: string;
  base_voice: string;
  ready: boolean;
  consent_at: string | null;
}

interface VoiceCloneList {
  engine_online: boolean;
  voice_clones: VoiceClone[];
}

interface VoiceCloneManagerProps {
  apiUrl: string;
  onChanged: () => void;
}

const BASE_VOICES = [
  { id: "kokoro:af_heart", label: "Heart · warm female" },
  { id: "kokoro:af_bella", label: "Bella · expressive female" },
  { id: "kokoro:af_sarah", label: "Sarah · natural female" },
  { id: "kokoro:am_michael", label: "Michael · calm male" },
  { id: "kokoro:bf_emma", label: "Emma · British female" },
  { id: "kokoro:bm_george", label: "George · British male" },
];

const MIN_RECORD_SECONDS = 10;
const RECOMMENDED_RECORD_SECONDS = 30;
const MAX_RECORD_SECONDS = 120;

const READING_PASSAGE =
  "The morning light came slowly across the hills, and the village " +
  "began to wake. Somewhere a door opened, a dog barked twice, and " +
  "the baker carried the first warm loaves into the square. Nobody " +
  "hurried. There was time to talk about the weather, the harvest, " +
  "and the long road that wound away toward the sea. By noon the " +
  "streets were full, and the old clock in the tower struck twelve.";

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Encode decoded audio as a mono 16-bit PCM WAV file. */
function encodeWav(audio: AudioBuffer): Blob {
  const length = audio.length;
  const channelCount = audio.numberOfChannels;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audio.getChannelData(channel);

    for (let index = 0; index < length; index += 1) {
      mono[index] += data[index] / channelCount;
    }
  }

  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, length * 2, true);

  for (let index = 0; index < length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, mono[index]));

    view.setInt16(
      44 + index * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Returns the clone list, null on a failed response, "offline" if unreachable. */
async function fetchVoiceClones(
  apiUrl: string,
): Promise<VoiceCloneList | null | "offline"> {
  try {
    const response = await fetch(`${apiUrl}/voice-clones`);

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as VoiceCloneList;
  } catch {
    return "offline";
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };

    if (typeof data.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // Fall through to the generic message.
  }

  return `The request failed (HTTP ${response.status}).`;
}

export default function VoiceCloneManager({
  apiUrl,
  onChanged,
}: VoiceCloneManagerProps) {
  const [open, setOpen] = useState(false);
  const [clones, setClones] = useState<VoiceClone[]>([]);
  const [engineOnline, setEngineOnline] = useState(true);
  const [name, setName] = useState("");
  const [baseVoice, setBaseVoice] = useState(BASE_VOICES[0].id);
  const [sample, setSample] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"upload" | "record">("record");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [uploadKey, setUploadKey] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const releaseMicrophone = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }

      releaseMicrophone();
    };
  }, [releaseMicrophone]);

  useEffect(() => {
    return () => {
      if (recordedUrl) {
        URL.revokeObjectURL(recordedUrl);
      }
    };
  }, [recordedUrl]);

  function discardRecording(): void {
    setRecordedUrl(null);
    setSample(null);
    setElapsed(0);
    setUploadKey((current) => current + 1);
  }

  async function startRecording(): Promise<void> {
    if (recording || busy) {
      return;
    }

    setError(null);
    setMessage(null);
    discardRecording();

    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError(
        "This browser can't record audio. Use the upload option instead.",
      );
      return;
    }

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      setError(
        "Microphone access was blocked. Allow it in your browser's " +
          "address bar, or use the upload option.",
      );
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    const recorder = new MediaRecorder(stream);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const type = recorder.mimeType || "audio/webm";
      const raw = new Blob(chunksRef.current, { type });

      releaseMicrophone();
      setRecording(false);
      void finishRecording(raw);
    };

    recorderRef.current = recorder;
    recorder.start();

    setRecording(true);
    setElapsed(0);

    const startedAt = Date.now();

    timerRef.current = window.setInterval(() => {
      const seconds = (Date.now() - startedAt) / 1000;

      setElapsed(seconds);

      if (seconds >= MAX_RECORD_SECONDS) {
        stopRecording();
      }
    }, 250);
  }

  function stopRecording(): void {
    const recorder = recorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  async function finishRecording(raw: Blob): Promise<void> {
    try {
      // Convert to plain WAV so the length is always readable
      // and the format doesn't depend on the browser.
      const context = new AudioContext();

      try {
        const decoded = await context.decodeAudioData(
          await raw.arrayBuffer(),
        );

        const wav = encodeWav(decoded);

        setSample(
          new File([wav], "recording.wav", { type: "audio/wav" }),
        );
        setRecordedUrl(URL.createObjectURL(wav));
        setElapsed(decoded.duration);
      } finally {
        void context.close();
      }
    } catch {
      setError(
        "The recording couldn't be processed. Try again, or use " +
          "the upload option.",
      );
    }
  }

  const loadClones = useCallback(async (): Promise<void> => {
    const data = await fetchVoiceClones(apiUrl);

    if (data === "offline") {
      setEngineOnline(false);
    } else if (data) {
      setClones(data.voice_clones);
      setEngineOnline(data.engine_online);
    }
  }, [apiUrl]);

  useEffect(() => {
    let ignore = false;

    void fetchVoiceClones(apiUrl).then((data) => {
      if (ignore) {
        return;
      }

      if (data === "offline") {
        setEngineOnline(false);
      } else if (data) {
        setClones(data.voice_clones);
        setEngineOnline(data.engine_online);
      }
    });

    return () => {
      ignore = true;
    };
  }, [apiUrl]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!sample || !consent || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    const form = new FormData();
    form.append("name", name);
    form.append("base_voice", baseVoice);
    form.append("consent", "true");
    form.append("sample", sample);

    try {
      const response = await fetch(`${apiUrl}/voice-clones`, {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        setError(await readError(response));
        return;
      }

      const created = (await response.json()) as {
        status: string;
        warning: string | null;
      };

      setMessage(
        created.status === "ready"
          ? "Your voice is ready. Find it under Featured narrators."
          : (created.warning ??
              "Saved. Start the voice cloning worker, then press Prepare."),
      );

      setName("");
      discardRecording();
      setConsent(false);

      await loadClones();
      onChanged();
    } catch {
      setError("The backend could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePrepare(clone: VoiceClone) {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(
        `${apiUrl}/voice-clones/${clone.id}/prepare`,
        { method: "POST" },
      );

      if (!response.ok) {
        setError(await readError(response));
        return;
      }

      setMessage(`${clone.name} is ready.`);

      await loadClones();
      onChanged();
    } catch {
      setError("The backend could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(clone: VoiceClone) {
    if (
      !window.confirm(
        `Delete the cloned voice "${clone.name}" and its recording? ` +
          "Audiobooks already created with it are not affected.",
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`${apiUrl}/voice-clones/${clone.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        setError(await readError(response));
        return;
      }

      await loadClones();
      onChanged();
    } catch {
      setError("The backend could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 sm:p-5">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <div>
          <h3 className="text-base font-bold text-white">
            Your cloned voices
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Narrate audiobooks in your own voice. Everything stays on this
            computer.
          </p>
        </div>

        <span className="text-xs font-semibold text-cyan-300">
          {open ? "Hide" : clones.length > 0 ? `${clones.length} saved` : "Set up"}
        </span>
      </button>

      {open && (
        <div className="mt-5">
          {!engineOnline && (
            <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
              The voice cloning engine is not running. Install it with{" "}
              <code>./scripts/setup-voice-cloning.sh</code>, then restart{" "}
              <code>./scripts/start-dev.sh</code>.
            </p>
          )}

          {clones.length > 0 && (
            <ul className="mb-5 grid gap-2">
              {clones.map((clone) => (
                <li
                  key={clone.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {clone.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {clone.ready ? "Ready" : "Needs preparing"}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-2">
                    {!clone.ready && (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-50"
                        onClick={() => void handlePrepare(clone)}
                      >
                        Prepare
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-red-400/60 hover:text-red-300 disabled:opacity-50"
                      onClick={() => void handleDelete(clone)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={handleCreate} className="grid gap-4">
            <label className="grid gap-1 text-xs font-semibold text-slate-300">
              Name
              <input
                type="text"
                required
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My voice"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-normal text-white placeholder:text-slate-600"
              />
            </label>

            <div className="grid gap-3">
              <div
                role="tablist"
                className="inline-flex w-fit rounded-lg border border-slate-700 p-0.5 text-xs font-semibold"
              >
                {(["record", "upload"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={mode === option}
                    disabled={recording}
                    className={`rounded-md px-3 py-1.5 transition disabled:opacity-50 ${
                      mode === option
                        ? "bg-cyan-400/20 text-cyan-200"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                    onClick={() => {
                      setMode(option);
                      discardRecording();
                    }}
                  >
                    {option === "record" ? "Record now" : "Upload a file"}
                  </button>
                ))}
              </div>

              {mode === "record" ? (
                <div className="grid gap-3">
                  <p className="text-xs leading-5 text-slate-400">
                    Find a quiet room, then read the passage below out loud
                    in your normal storytelling voice. Aim for{" "}
                    {RECOMMENDED_RECORD_SECONDS} seconds or more; at least{" "}
                    {MIN_RECORD_SECONDS}. You can keep going past the end of
                    the passage.
                  </p>

                  <blockquote className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm leading-6 text-slate-200">
                    {READING_PASSAGE}
                  </blockquote>

                  <div className="flex flex-wrap items-center gap-3">
                    {recording ? (
                      <button
                        type="button"
                        className="rounded-xl border border-red-400/60 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-500/20"
                        onClick={stopRecording}
                      >
                        ■ Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50"
                        onClick={() => void startRecording()}
                      >
                        {recordedUrl ? "● Record again" : "● Start recording"}
                      </button>
                    )}

                    <span
                      className={`font-mono text-sm tabular-nums ${
                        recording ? "text-red-300" : "text-slate-400"
                      }`}
                      aria-live="off"
                    >
                      {formatSeconds(elapsed)} /{" "}
                      {formatSeconds(MAX_RECORD_SECONDS)}
                    </span>

                    {recording && (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-red-300">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
                        Recording
                      </span>
                    )}
                  </div>

                  {recordedUrl && !recording && (
                    <div className="grid gap-2">
                      <audio controls src={recordedUrl} className="w-full" />

                      {elapsed < MIN_RECORD_SECONDS ? (
                        <p className="text-xs text-amber-300">
                          That take is only {Math.floor(elapsed)} seconds.
                          Please record at least {MIN_RECORD_SECONDS}.
                        </p>
                      ) : (
                        <p className="text-xs text-slate-500">
                          Listen back. If it sounds clear, create your voice
                          below; otherwise record again.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <label className="grid gap-1 text-xs font-semibold text-slate-300">
                  <span className="font-normal leading-5 text-slate-400">
                    Upload 20&ndash;60 seconds of yourself reading aloud in a
                    quiet room (WAV, MP3, M4A, FLAC or OGG, up to 25&nbsp;MB).
                  </span>
                  <input
                    key={uploadKey}
                    type="file"
                    required
                    accept=".wav,.mp3,.m4a,.flac,.ogg,audio/*"
                    onChange={(event) =>
                      setSample(event.target.files?.[0] ?? null)
                    }
                    className="text-xs font-normal text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-200"
                  />
                </label>
              )}
            </div>

            <label className="grid gap-1 text-xs font-semibold text-slate-300">
              Starting narrator
              <select
                value={baseVoice}
                onChange={(event) => setBaseVoice(event.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-normal text-white"
              >
                {BASE_VOICES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-[11px] font-normal text-slate-500">
                Your voice is applied on top of this narrator&apos;s pacing.
                Pick the one closest to how you speak.
              </span>
            </label>

            <label className="flex items-start gap-2 text-xs leading-5 text-slate-300">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                className="mt-1"
              />
              <span>
                This recording is my own voice, or I have the speaker&apos;s
                permission to clone it.
              </span>
            </label>

            <button
              type="submit"
              disabled={
                busy ||
                recording ||
                !engineOnline ||
                !consent ||
                !sample ||
                !name.trim() ||
                (mode === "record" && elapsed < MIN_RECORD_SECONDS)
              }
              className="rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2.5 text-sm font-bold text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Working..." : "Create my voice"}
            </button>
          </form>

          {message && (
            <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              {message}
            </p>
          )}

          {error && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
