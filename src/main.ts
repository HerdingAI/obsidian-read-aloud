import { MarkdownView, Notice, Plugin } from "obsidian";
import { ListenableGenerator } from "./listenable";
import { ReadAloudPlayer } from "./player";
import { ReadAloudSettingTab } from "./settings";
import {
  HttpTtsEngine,
  KokoroWorkerEngine,
  PiperTtsEngine,
  TtsEngine,
  WebSpeechTtsEngine,
} from "./tts-engines";
import { DEFAULT_SETTINGS, ReadAloudSettings } from "./types";
import { MiniPlayerBar } from "./ui/player-bar";

export default class ReadAloudPlugin extends Plugin {
  settings: ReadAloudSettings = { ...DEFAULT_SETTINGS };
  generator = new ListenableGenerator();
  private kokoroEngine!: KokoroWorkerEngine;
  private piperEngine!: PiperTtsEngine;
  private httpTtsEngine!: HttpTtsEngine;
  private webSpeechEngine!: WebSpeechTtsEngine;
  player!: ReadAloudPlayer;
  private miniPlayer!: MiniPlayerBar;
  private statusBarEl: HTMLElement | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.kokoroEngine = new KokoroWorkerEngine(() => this.settings);
    this.piperEngine = new PiperTtsEngine(() => this.settings);
    this.httpTtsEngine = new HttpTtsEngine(() => this.settings);
    this.webSpeechEngine = new WebSpeechTtsEngine(() => this.settings);

    this.player = new ReadAloudPlayer(
      () => this.settings,
      this.generator,
      () => this.getActiveEngine(),
      (msg) => new Notice(msg)
    );

    this.addRibbonIcon("volume-2", "Read active page aloud", () => {
      void this.readActivePage();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("read-aloud-status-bar");
    this.statusBarEl.addEventListener("click", () => {
      const snap = this.player.getSnapshot();
      if (snap.state === "idle") {
        void this.readActivePage();
      } else {
        this.player.togglePause();
      }
    });

    this.unsubscribeStatus = this.player.subscribe((snap) => {
      if (!this.statusBarEl) return;
      if (snap.state === "idle") {
        this.statusBarEl.setText("");
      } else if (snap.state === "generating") {
        this.statusBarEl.setText("🔊 Preparing listenable...");
      } else if (snap.state === "paused") {
        this.statusBarEl.setText(
          `⏸ ${snap.currentChunkIndex + 1}/${snap.totalChunks}`
        );
      } else {
        this.statusBarEl.setText(
          `🔊 ${snap.currentChunkIndex + 1}/${snap.totalChunks}`
        );
      }
    });

    this.miniPlayer = new MiniPlayerBar(
      this.player,
      () => this.settings.showMiniPlayer,
      (rate) => {
        this.settings.speechRate = rate;
        void this.saveSettings();
      }
    );
    this.miniPlayer.mount();

    this.addCommand({
      id: "read-active-page",
      name: "Read active page aloud",
      callback: () => void this.readActivePage(),
    });

    this.addCommand({
      id: "read-selection",
      name: "Read selected text aloud",
      editorCallback: (editor, view) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          new Notice("Select some text first.");
          return;
        }
        const title = view.file?.basename ?? "Selection";
        void this.player.play(selection, `${title} (Selection)`);
      },
    });

    this.addCommand({
      id: "toggle-pause",
      name: "Pause or resume reading",
      callback: () => this.player.togglePause(),
    });

    this.addCommand({
      id: "stop-reading",
      name: "Stop reading",
      callback: () => this.player.stop(),
    });

    this.addCommand({
      id: "next-paragraph",
      name: "Skip to next paragraph",
      callback: () => this.player.nextChunk(),
    });

    this.addCommand({
      id: "previous-paragraph",
      name: "Go to previous paragraph",
      callback: () => this.player.prevChunk(),
    });

    this.addSettingTab(new ReadAloudSettingTab(this.app, this));
  }

  onunload(): void {
    this.player?.stop();
    this.kokoroEngine?.dispose();
    this.unsubscribeStatus?.();
    this.miniPlayer?.unmount();
  }

  private getActiveEngine(): TtsEngine {
    switch (this.settings.ttsEngine) {
      case "kokoro":
        return this.kokoroEngine;
      case "piper":
        return this.piperEngine;
      case "http-tts":
        return this.httpTtsEngine;
      default:
        return this.webSpeechEngine;
    }
  }

  async readActivePage(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Open a Markdown note to read aloud.");
      return;
    }

    const content = view ? view.editor.getValue() : await this.app.vault.read(file);
    await this.player.play(content, file.basename);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
