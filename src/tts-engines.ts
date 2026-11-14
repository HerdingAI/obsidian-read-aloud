import { Platform, requestUrl } from "obsidian";
import { PersistentCache, makeCacheKey } from "./cache";
import { getKokoroInstallStatus } from "./installer";
import { buildDesktopEnv } from "./listenable";
import { ReadAloudSettings } from "./types";

export interface TtsEngine {
  readonly id: string;
  speak(text: string, rate: number, signal: AbortSignal): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

function playAudioBuffer(
  buffer: ArrayBuffer,
  mimeType: string,
  signal: AbortSignal,
  registerAudio: (audio: HTMLAudioElement | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    registerAudio(audio);

    let settled = false;
    const cleanup = () => {
      registerAudio(null);
      URL.revokeObjectURL(url);
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      audio.pause();
      audio.src = "";
      cleanup();
      reject(new Error("Aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    audio.onended = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    audio.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Audio playback failed"));
    };

    audio.play().catch((err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export class KokoroWorkerEngine implements TtsEngine {
  readonly id = "kokoro";
  private activeAudio: HTMLAudioElement | null = null;
  private worker: import("child_process").ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private pendingResolve: ((line: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private stdoutBuffer = "";

  constructor(
    private getSettings: () => ReadAloudSettings,
    private cache?: PersistentCache
  ) {}

  pause(): void {
    this.activeAudio?.pause();
  }

  resume(): void {
    void this.activeAudio?.play();
  }

  stop(): void {
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.src = "";
      this.activeAudio = null;
    }
  }

  dispose(): void {
    this.stop();
    if (this.worker) {
      this.worker.kill("SIGTERM");
      this.worker = null;
      this.readyPromise = null;
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.worker && this.readyPromise) {
      return this.readyPromise;
    }

    const status = getKokoroInstallStatus();
    if (!status.installed) {
      return Promise.reject(
        new Error(
          "Kokoro-82M is not installed yet. Open Settings -> Read Aloud and click 'Install Kokoro-82M'."
        )
      );
    }

    const { spawn } = require("child_process") as typeof import("child_process");
    const child = spawn(
      status.pythonPath,
      [status.workerPath, status.modelPath, status.voicesPath],
      {
        env: buildDesktopEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    this.worker = child;
    this.stdoutBuffer = "";

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let isReady = false;
      let stderrTail = "";

      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
      });

      child.stdout.on("data", (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString("utf8");
        let idx = this.stdoutBuffer.indexOf("\n");
        while (idx !== -1) {
          const line = this.stdoutBuffer.slice(0, idx).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
          if (line) {
            if (!isReady) {
              try {
                const msg = JSON.parse(line) as { ready?: boolean; error?: string };
                if (msg.ready) {
                  isReady = true;
                  resolve();
                } else if (msg.error) {
                  reject(new Error(msg.error));
                }
              } catch {
                // Ignore non-JSON startup lines
              }
            } else if (this.pendingResolve) {
              const r = this.pendingResolve;
              this.pendingResolve = null;
              this.pendingReject = null;
              r(line);
            }
          }
          idx = this.stdoutBuffer.indexOf("\n");
        }
      });

      child.on("error", (err) => {
        this.worker = null;
        this.readyPromise = null;
        if (!isReady) reject(err);
        else this.pendingReject?.(err);
      });

      child.on("close", (code) => {
        this.worker = null;
        this.readyPromise = null;
        const err = new Error(
          stderrTail.trim() || `Kokoro worker exited with code ${code}`
        );
        if (!isReady) reject(err);
        else this.pendingReject?.(err);
      });
    });

    return this.readyPromise;
  }

  async speak(text: string, rate: number, signal: AbortSignal): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error("Self-contained Kokoro worker is only available on desktop.");
    }
    if (signal.aborted) throw new Error("Aborted");

    const settings = this.getSettings();
    const voice = settings.kokoroVoice || "af_heart";
    const speed = Math.max(0.5, Math.min(2.0, rate));
    const cacheKey = makeCacheKey(["kokoro", voice, speed.toFixed(2), text]);

    if (settings.enableAudioCache && this.cache) {
      const cached = this.cache.getAudio(cacheKey, "wav");
      if (cached) {
        await playAudioBuffer(cached, "audio/wav", signal, (a) => {
          this.activeAudio = a;
        });
        return;
      }
    }

    await this.ensureWorker();
    if (signal.aborted) throw new Error("Aborted");

    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    const tmpWav = path.join(
      os.tmpdir(),
      `obsidian-kokoro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
    );

    const payload = JSON.stringify({
      text,
      voice,
      speed,
      out_wav: tmpWav,
    });

    const responseLine = await new Promise<string>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Kokoro worker is not running"));
        return;
      }
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.worker.stdin.write(payload + "\n");
    });

    const parsed = JSON.parse(responseLine) as {
      ok?: boolean;
      error?: string;
      wav?: string;
    };
    if (!parsed.ok) {
      throw new Error(parsed.error || "Kokoro synthesis failed");
    }

    try {
      const buf = fs.readFileSync(tmpWav);
      const arrayBuf = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength
      );
      if (settings.enableAudioCache && this.cache) {
        this.cache.setAudio(cacheKey, "wav", arrayBuf);
      }
      await playAudioBuffer(arrayBuf, "audio/wav", signal, (a) => {
        this.activeAudio = a;
      });
    } finally {
      try {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

export class HttpTtsEngine implements TtsEngine {
  readonly id = "http-tts";
  private activeAudio: HTMLAudioElement | null = null;

  constructor(
    private getSettings: () => ReadAloudSettings,
    private cache?: PersistentCache
  ) {}

  pause(): void {
    this.activeAudio?.pause();
  }

  resume(): void {
    void this.activeAudio?.play();
  }

  stop(): void {
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.src = "";
      this.activeAudio = null;
    }
  }

  async speak(text: string, rate: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Aborted");
    const settings = this.getSettings();
    const ext = settings.httpTtsFormat === "mp3" ? "mp3" : "wav";
    const mimeType = ext === "mp3" ? "audio/mpeg" : "audio/wav";
    const cacheKey = makeCacheKey([
      "http-tts",
      settings.httpTtsModel,
      settings.httpTtsVoice,
      rate.toFixed(2),
      ext,
      text,
    ]);

    if (settings.enableAudioCache && this.cache) {
      const cached = this.cache.getAudio(cacheKey, ext);
      if (cached) {
        await playAudioBuffer(cached, mimeType, signal, (a) => {
          this.activeAudio = a;
        });
        return;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (settings.httpTtsApiKey.trim()) {
      headers["Authorization"] = `Bearer ${settings.httpTtsApiKey.trim()}`;
    }

    const res = await requestUrl({
      url: settings.httpTtsUrl,
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.httpTtsModel,
        input: text,
        voice: settings.httpTtsVoice,
        speed: rate,
        response_format: settings.httpTtsFormat,
      }),
      throw: false,
    });

    if (signal.aborted) throw new Error("Aborted");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP TTS ${res.status}: ${res.text}`);
    }

    if (settings.enableAudioCache && this.cache) {
      this.cache.setAudio(cacheKey, ext, res.arrayBuffer);
    }

    await playAudioBuffer(res.arrayBuffer, mimeType, signal, (a) => {
      this.activeAudio = a;
    });
  }
}

export class WebSpeechTtsEngine implements TtsEngine {
  readonly id = "web-speech";

  constructor(
    private getSettings: () => ReadAloudSettings,
    private cache?: PersistentCache
  ) {}

  pause(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
    }
  }

  resume(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
    }
  }

  stop(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  speak(text: string, rate: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        reject(new Error("Web Speech API is not supported in this environment."));
        return;
      }

      const synth = window.speechSynthesis;
      const voices = synth.getVoices();
      if (voices.length === 0) {
        // On some Linux/Snap builds, speechSynthesis has 0 system voices
        // Still attempt utterance if voices haven't loaded yet, but fail cleanly on error
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = Math.max(0.5, Math.min(2.5, rate));

      const preferred = this.getSettings().webSpeechVoice.trim();
      if (preferred) {
        const match = voices.find((v) => v.name === preferred);
        if (match) utterance.voice = match;
      }

      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        synth.cancel();
        reject(new Error("Aborted"));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      utterance.onend = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      };

      utterance.onerror = (ev) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Web Speech error: ${ev.error || "unknown"}`));
      };

      synth.speak(utterance);
    });
  }
}
