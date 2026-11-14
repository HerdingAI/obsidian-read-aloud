import { setIcon } from "obsidian";
import { ReadAloudPlayer } from "../player";
import { PlayerSnapshot } from "../types";

export class MiniPlayerBar {
  private containerEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;
  private rateSelect: HTMLSelectElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private player: ReadAloudPlayer,
    private isEnabled: () => boolean,
    private onRateChange: (rate: number) => void
  ) {}

  mount(): void {
    if (this.containerEl) return;

    const root = document.body.createDiv({ cls: "read-aloud-mini-player is-hidden" });

    const header = root.createDiv({ cls: "read-aloud-header" });
    const iconSpan = header.createSpan({ cls: "read-aloud-icon" });
    setIcon(iconSpan, "volume-2");

    const textCol = header.createDiv({ cls: "read-aloud-meta" });
    this.titleEl = textCol.createDiv({ cls: "read-aloud-title" });
    this.statusEl = textCol.createDiv({ cls: "read-aloud-status" });

    const controls = root.createDiv({ cls: "read-aloud-controls" });

    this.prevBtn = controls.createEl("button", {
      cls: "read-aloud-btn",
      attr: { "aria-label": "Previous paragraph" },
    });
    setIcon(this.prevBtn, "skip-back");
    this.prevBtn.addEventListener("click", () => this.player.prevChunk());

    this.playPauseBtn = controls.createEl("button", {
      cls: "read-aloud-btn read-aloud-btn-primary",
      attr: { "aria-label": "Play or Pause" },
    });
    setIcon(this.playPauseBtn, "pause");
    this.playPauseBtn.addEventListener("click", () => this.player.togglePause());

    this.nextBtn = controls.createEl("button", {
      cls: "read-aloud-btn",
      attr: { "aria-label": "Next paragraph" },
    });
    setIcon(this.nextBtn, "skip-forward");
    this.nextBtn.addEventListener("click", () => this.player.nextChunk());

    this.stopBtn = controls.createEl("button", {
      cls: "read-aloud-btn",
      attr: { "aria-label": "Stop" },
    });
    setIcon(this.stopBtn, "square");
    this.stopBtn.addEventListener("click", () => this.player.stop());

    this.rateSelect = controls.createEl("select", {
      cls: "read-aloud-rate",
      attr: { "aria-label": "Playback speed" },
    });
    for (const r of [0.8, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0]) {
      const opt = this.rateSelect.createEl("option", {
        text: `${r}x`,
        value: String(r),
      });
      if (Math.abs(r - this.player.getSnapshot().rate) < 0.01) {
        opt.selected = true;
      }
    }
    this.rateSelect.addEventListener("change", () => {
      if (this.rateSelect) {
        this.onRateChange(parseFloat(this.rateSelect.value));
      }
    });

    this.containerEl = root;
    this.unsubscribe = this.player.subscribe((snap) => this.render(snap));
  }

  private render(snap: PlayerSnapshot): void {
    if (!this.containerEl) return;

    if (snap.state === "idle" || !this.isEnabled()) {
      this.containerEl.addClass("is-hidden");
      return;
    }

    this.containerEl.removeClass("is-hidden");

    if (this.titleEl) {
      this.titleEl.setText(snap.title || "Untitled");
    }

    if (this.statusEl) {
      if (snap.state === "generating") {
        this.statusEl.setText(snap.statusDetail || "Preparing...");
      } else {
        const idx = snap.currentChunkIndex + 1;
        const prefix = snap.state === "paused" ? "Paused" : "Playing";
        this.statusEl.setText(
          `${prefix} · ${idx}/${snap.totalChunks} · ${snap.statusDetail}`
        );
      }
    }

    if (this.playPauseBtn) {
      this.playPauseBtn.empty();
      setIcon(this.playPauseBtn, snap.state === "paused" ? "play" : "pause");
      this.playPauseBtn.disabled = snap.state === "generating";
    }

    if (this.prevBtn) this.prevBtn.disabled = snap.state === "generating";
    if (this.nextBtn) this.nextBtn.disabled = snap.state === "generating";

    if (this.rateSelect) {
      this.rateSelect.value = String(snap.rate);
    }
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.containerEl?.remove();
    this.containerEl = null;
  }
}
