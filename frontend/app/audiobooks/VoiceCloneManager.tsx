"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

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

  const loadClones = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${apiUrl}/voice-clones`);

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as VoiceCloneList;

      setClones(data.voice_clones);
      setEngineOnline(data.engine_online);
    } catch {
      setEngineOnline(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    void loadClones();
  }, [loadClones]);

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
      setSample(null);
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
            <p className="text-xs leading-5 text-slate-400">
              Record 20&ndash;60 seconds of yourself reading aloud in a quiet
              room, then upload it here (WAV, MP3, M4A, FLAC or OGG, up to
              25&nbsp;MB). Longer, clearer recordings sound better.
            </p>

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

            <label className="grid gap-1 text-xs font-semibold text-slate-300">
              Voice recording
              <input
                type="file"
                required
                accept=".wav,.mp3,.m4a,.flac,.ogg,audio/*"
                onChange={(event) =>
                  setSample(event.target.files?.[0] ?? null)
                }
                className="text-xs font-normal text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-200"
              />
            </label>

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
                busy || !engineOnline || !consent || !sample || !name.trim()
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
