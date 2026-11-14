import { ListenableGenerator } from "./listenable";
import { chunkTextForSpeech } from "./markdown-cleaner";
import { TtsEngine } from "./tts-engines";
import { PlaybackState, PlayerSnapshot, ReadAloudSettings } from "./types";

export type SnapshotListener = (snapshot: PlayerSnapshot) => void;

export class ReadAloudPlayer {
  private state: PlaybackState = "idle";
  private title = "";
  private chunks: string[] = [];
  private currentChunkIndex = 0;
  private statusDetail = "";
  private generationAbort: AbortController | null = null;
  private chunkAbort: AbortController | null = null;
  private listeners = new Set<SnapshotListener>();
  private runToken = 0;

  constructor(
    private getSettings: () => ReadAloudSettings,
    private generator: ListenableGenerator,
    private getEngine: () => TtsEngine,
    private onNotify: (message: string) => void
  ) {}

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PlayerSnapshot {
    return {
      state: this.state,
      title: this.title,
      currentChunkIndex: this.currentChunkIndex,
      totalChunks: this.chunks.length,
      rate: this.getSettings().speechRate,
      statusDetail: this.statusDetail,
      currentText: this.chunks[this.currentChunkIndex] ?? "",
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  async play(rawMarkdown: string, title: string): Promise<void> {
    this.stop();

    const trimmed = rawMarkdown.trim();
    if (!trimmed) {
      this.onNotify("Nothing to read in the current note.");
      return;
    }

    const token = ++this.runToken;
    const settings = this.getSettings();
    this.title = title;
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.state = "generating";
    this.statusDetail =
      settings.listenableProvider === "direct"
        ? "Preparing text..."
        : `Creating listenable script (${settings.listenableProvider})...`;
    this.emit();

    const genController = new AbortController();
    this.generationAbort = genController;

    try {
      const result = await this.generator.generate(
        trimmed,
        title,
        settings,
        genController.signal
      );

      if (token !== this.runToken || genController.signal.aborted) {
        return;
      }

      if (result.fallbackReason) {
        this.onNotify(
          `Listenable (${settings.listenableProvider}) fell back to direct cleaner: ${result.fallbackReason}`
        );
      }

      const chunks = chunkTextForSpeech(result.script);
      if (chunks.length === 0) {
        this.onNotify("No readable text found after processing.");
        this.stop();
        return;
      }

      this.chunks = chunks;
      this.currentChunkIndex = 0;
      this.state = "playing";
      this.statusDetail = result.cached
        ? `Listenable (${result.providerUsed}, cached)`
        : `Listenable (${result.providerUsed})`;
      this.emit();

      await this.playbackLoop(token);
    } catch (err) {
      if (token !== this.runToken) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Aborted") {
        this.onNotify(`Read Aloud error: ${msg}`);
      }
      this.stop();
    } finally {
      if (this.generationAbort === genController) {
        this.generationAbort = null;
      }
    }
  }

  private async playbackLoop(token: number): Promise<void> {
    const engine = this.getEngine();

    while (
      token === this.runToken &&
      this.state !== "idle" &&
      this.currentChunkIndex < this.chunks.length
    ) {
      if (this.state === "paused") {
        await new Promise((r) => setTimeout(r, 80));
        continue;
      }

      const chunk = this.chunks[this.currentChunkIndex];
      const controller = new AbortController();
      this.chunkAbort = controller;
      this.emit();

      try {
        await engine.speak(
          chunk,
          this.getSettings().speechRate,
          controller.signal
        );
      } catch (err) {
        if (token !== this.runToken) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Aborted") {
          // Aborted by next/prev/stop; loop checks updated state/index
          continue;
        }
        this.onNotify(`TTS error (${engine.id}): ${msg}`);
        this.stop();
        return;
      } finally {
        if (this.chunkAbort === controller) {
          this.chunkAbort = null;
        }
      }

      if (token === this.runToken && this.state === "playing") {
        this.currentChunkIndex++;
      }
    }

    if (token === this.runToken && this.currentChunkIndex >= this.chunks.length) {
      this.stop();
    }
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.state = "paused";
    this.getEngine().pause();
    this.emit();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "playing";
    this.getEngine().resume();
    this.emit();
  }

  togglePause(): void {
    if (this.state === "playing") {
      this.pause();
    } else if (this.state === "paused") {
      this.resume();
    }
  }

  nextChunk(): void {
    if (this.state !== "playing" && this.state !== "paused") return;
    if (this.currentChunkIndex + 1 >= this.chunks.length) {
      this.stop();
      return;
    }
    this.currentChunkIndex++;
    this.state = "playing";
    this.chunkAbort?.abort();
    this.getEngine().stop();
    this.emit();
  }

  prevChunk(): void {
    if (this.state !== "playing" && this.state !== "paused") return;
    this.currentChunkIndex = Math.max(0, this.currentChunkIndex - 1);
    this.state = "playing";
    this.chunkAbort?.abort();
    this.getEngine().stop();
    this.emit();
  }

  stop(): void {
    this.runToken++;
    this.generationAbort?.abort();
    this.generationAbort = null;
    this.chunkAbort?.abort();
    this.chunkAbort = null;
    this.getEngine().stop();
    this.state = "idle";
    this.title = "";
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.statusDetail = "";
    this.emit();
  }
}
