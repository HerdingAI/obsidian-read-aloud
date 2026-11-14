import { describe, expect, it, vi } from "vitest";
import { ListenableGenerator } from "../src/listenable";
import { ReadAloudPlayer } from "../src/player";
import { TtsEngine } from "../src/tts-engines";
import { DEFAULT_SETTINGS, PlayerSnapshot } from "../src/types";

function createFakeEngine(): TtsEngine & {
  spoken: string[];
  pauseCalls: number;
  resumeCalls: number;
  stopCalls: number;
} {
  return {
    id: "fake",
    spoken: [],
    pauseCalls: 0,
    resumeCalls: 0,
    stopCalls: 0,
    async speak(text: string, _rate: number, signal: AbortSignal) {
      if (signal.aborted) throw new Error("Aborted");
      this.spoken.push(text);
    },
    pause() {
      this.pauseCalls++;
    },
    resume() {
      this.resumeCalls++;
    },
    stop() {
      this.stopCalls++;
    },
  };
}

describe("ReadAloudPlayer", () => {
  it("plays all chunks and returns to idle", async () => {
    const settings = { ...DEFAULT_SETTINGS, listenableProvider: "direct" as const };
    const gen = new ListenableGenerator();
    const engine = createFakeEngine();
    const notices: string[] = [];
    const states: string[] = [];

    const player = new ReadAloudPlayer(
      () => settings,
      gen,
      () => engine,
      (m) => notices.push(m)
    );

    player.subscribe((s: PlayerSnapshot) => states.push(s.state));

    await player.play("First paragraph.\n\nSecond paragraph.", "Test Note");

    expect(engine.spoken).toEqual(["First paragraph.", "Second paragraph."]);
    expect(player.getSnapshot().state).toBe("idle");
    expect(states).toContain("generating");
    expect(states).toContain("playing");
    expect(notices).toEqual([]);
  });

  it("supports pause, resume, nextChunk, and stop", async () => {
    const settings = { ...DEFAULT_SETTINGS, listenableProvider: "direct" as const };
    const gen = new ListenableGenerator();
    let releaseFirst!: () => void;
    const engine: TtsEngine = {
      id: "blocking",
      speak: vi.fn(
        (_text: string, _rate: number, signal: AbortSignal) =>
          new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Aborted")), {
              once: true,
            });
            releaseFirst = resolve;
          })
      ),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
    };

    const player = new ReadAloudPlayer(
      () => settings,
      gen,
      () => engine,
      () => {}
    );

    const playPromise = player.play("Para 1.\n\nPara 2.\n\nPara 3.", "Note");
    await new Promise((r) => setTimeout(r, 15));

    expect(player.getSnapshot().state).toBe("playing");
    player.pause();
    expect(player.getSnapshot().state).toBe("paused");
    player.resume();
    expect(player.getSnapshot().state).toBe("playing");

    player.nextChunk();
    await new Promise((r) => setTimeout(r, 15));
    expect(player.getSnapshot().currentChunkIndex).toBe(1);

    player.stop();
    releaseFirst?.();
    await playPromise;
    expect(player.getSnapshot().state).toBe("idle");
  });
});
