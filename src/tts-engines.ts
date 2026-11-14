import { Platform, requestUrl } from "obsidian";
import { getCachePaths, getKokoroInstallStatus } from "./installer";
import { buildDesktopEnv, resolveDesktopBinary } from "./listenable";
import { ReadAloudSettings } from "./types";

export interface TtsEngine {
  readonly id: string;
  speak(text: string, rate: number, signal: AbortSignal): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

/**
 * Discovers local Piper .onnx voice models on desktop.
 */
export function discoverPiperModels(): string[] {
  if (!Platform.isDesktopApp) return [];
  try {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");

    const home = os.homedir();
    const searchDirs = [
      getCachePaths().piperVoicesDir,
      path.join(home, ".local", "share", "piper-voices"),
      path.join(home, ".local", "share", "piper"),
      path.join(home, "piper-voices"),
      "/usr/local/share/piper-voices",
      "/opt/homebrew/share/piper-voices",
    ];

    const found: string[] = [];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".onnx")) {
          found.push(path.join(dir, entry));
        }
      }
    }
    return found.sort();
  } catch {
    return [];
  }
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

  constructor(private getSettings: () => ReadAloudSettings) {}

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
      voice: this.getSettings().kokoroVoice || "af_heart",
      speed: Math.max(0.5, Math.min(2.0, rate)),
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

export class PiperTtsEngine implements TtsEngine {
  readonly id = "piper";
  private activeAudio: HTMLAudioElement | null = null;
  private cudaDisabledForSession = false;

  constructor(private getSettings: () => ReadAloudSettings) {}

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
    if (!Platform.isDesktopApp) {
      throw new Error("Piper CLI is only available on desktop.");
    }

    const settings = this.getSettings();
    let modelPath = settings.piperModelPath.trim();
    if (!modelPath) {
      const discovered = discoverPiperModels();
      if (discovered.length === 0) {
        throw new Error(
          "No Piper .onnx voice model found. Set a model path in Read Aloud settings."
        );
      }
      modelPath = discovered[0];
    }

    const tryCuda = settings.piperUseCuda && !this.cudaDisabledForSession;
    let wavBuffer: ArrayBuffer;

    try {
      wavBuffer = await this.synthesizeWav(
        settings.piperPath || "piper",
        modelPath,
        text,
        rate,
        tryCuda,
        settings.piperSpeakerId.trim(),
        signal
      );
    } catch (err) {
      if (signal.aborted) throw err;
      if (tryCuda) {
        // Automatic CPU fallback when CUDA/NVML is unavailable
        this.cudaDisabledForSession = true;
        wavBuffer = await this.synthesizeWav(
          settings.piperPath || "piper",
          modelPath,
          text,
          rate,
          false,
          settings.piperSpeakerId.trim(),
          signal
        );
      } else {
        throw err;
      }
    }

    await playAudioBuffer(wavBuffer, "audio/wav", signal, (a) => {
      this.activeAudio = a;
    });
  }

  private synthesizeWav(
    piperCmd: string,
    modelPath: string,
    text: string,
    rate: number,
    useCuda: boolean,
    speakerId: string,
    signal: AbortSignal
  ): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const { spawn } = require("child_process") as typeof import("child_process");
      const fs = require("fs") as typeof import("fs");
      const os = require("os") as typeof import("os");
      const path = require("path") as typeof import("path");

      const tmpWav = path.join(
        os.tmpdir(),
        `obsidian-read-aloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
      );
      const lengthScale = (1 / Math.max(0.5, Math.min(2.5, rate))).toFixed(2);
      const args = ["-m", modelPath, "-f", tmpWav, "--length-scale", lengthScale];
      if (useCuda) {
        args.push("--cuda");
      }
      if (speakerId) {
        args.push("-s", speakerId);
      }

      const resolved = resolveDesktopBinary(piperCmd);
      const child = spawn(resolved, args, {
        env: buildDesktopEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      let settled = false;

      const cleanupTmp = () => {
        try {
          if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
        } catch {
          // Ignore temp cleanup errors
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        cleanupTmp();
        reject(new Error("Aborted"));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        cleanupTmp();
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (code !== 0) {
          cleanupTmp();
          reject(new Error(stderr.trim() || `piper exited with ${code}`));
          return;
        }
        try {
          const buf = fs.readFileSync(tmpWav);
          cleanupTmp();
          const arrayBuf = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength
          );
          resolve(arrayBuf);
        } catch (readErr) {
          cleanupTmp();
          reject(readErr);
        }
      });

      child.stdin.write(text);
      child.stdin.end();
    });
  }
}

export class HttpTtsEngine implements TtsEngine {
  readonly id = "http-tts";
  private activeAudio: HTMLAudioElement | null = null;

  constructor(private getSettings: () => ReadAloudSettings) {}

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

    const mimeType = settings.httpTtsFormat === "mp3" ? "audio/mpeg" : "audio/wav";
    await playAudioBuffer(res.arrayBuffer, mimeType, signal, (a) => {
      this.activeAudio = a;
    });
  }
}

export class WebSpeechTtsEngine implements TtsEngine {
  readonly id = "web-speech";

  constructor(private getSettings: () => ReadAloudSettings) {}

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
