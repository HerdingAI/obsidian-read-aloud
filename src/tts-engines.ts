import { Platform, requestUrl } from "obsidian";
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
