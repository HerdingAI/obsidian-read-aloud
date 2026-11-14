import { describe, expect, it, vi } from "vitest";
import { ListenableGenerator } from "../src/listenable";
import { DEFAULT_SETTINGS } from "../src/types";

describe("ListenableGenerator", () => {
  it("uses agy CLI with cheap model and caches the result", async () => {
    const cliRunner = vi.fn().mockResolvedValue({
      stdout: "Spoken listenable version of the note.",
      stderr: "",
      exitCode: 0,
    });

    const gen = new ListenableGenerator({ cliRunner, isDesktop: true });
    const settings = { ...DEFAULT_SETTINGS, listenableProvider: "agy" as const };

    const first = await gen.generate("# Title\nBody", "My Note", settings);
    expect(first.script).toBe("Spoken listenable version of the note.");
    expect(first.providerUsed).toBe("agy");
    expect(first.cached).toBe(false);
    expect(cliRunner).toHaveBeenCalledTimes(1);
    expect(cliRunner.mock.calls[0][1]).toContain("gemini-3.8-flash-low");
    expect(cliRunner.mock.calls[0][1]).toContain("--print");

    const second = await gen.generate("# Title\nBody", "My Note", settings);
    expect(second.cached).toBe(true);
    expect(cliRunner).toHaveBeenCalledTimes(1);
  });

  it("uses claude -p with haiku model", async () => {
    const cliRunner = vi.fn().mockResolvedValue({
      stdout: "Claude spoken script.",
      stderr: "",
      exitCode: 0,
    });

    const gen = new ListenableGenerator({ cliRunner, isDesktop: true });
    const settings = { ...DEFAULT_SETTINGS, listenableProvider: "claude" as const };

    const res = await gen.generate("Hello **world**", "Note", settings);
    expect(res.script).toBe("Claude spoken script.");
    expect(res.providerUsed).toBe("claude");
    expect(cliRunner.mock.calls[0][1]).toEqual([
      "-p",
      "--no-session-persistence",
      "--tools",
      "",
      "--model",
      "haiku",
    ]);
  });

  it("falls back to direct markdown cleaner when CLI fails", async () => {
    const cliRunner = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "binary not found",
      exitCode: 1,
    });

    const gen = new ListenableGenerator({ cliRunner, isDesktop: true });
    const settings = { ...DEFAULT_SETTINGS, listenableProvider: "agy" as const };

    const res = await gen.generate("# Heading\nSome **bold** text.", "Note", settings);
    expect(res.providerUsed).toBe("direct");
    expect(res.fallbackReason).toContain("binary not found");
    expect(res.script).toContain("Heading.");
    expect(res.script).toContain("Some bold text.");
  });

  it("supports local Ollama HTTP endpoint", async () => {
    const httpPoster = vi.fn().mockResolvedValue({
      status: 200,
      json: { response: "Ollama spoken script." },
      text: "",
    });

    const gen = new ListenableGenerator({ httpPoster, isDesktop: true });
    const settings = { ...DEFAULT_SETTINGS, listenableProvider: "ollama" as const };

    const res = await gen.generate("Test content", "Note", settings);
    expect(res.script).toBe("Ollama spoken script.");
    expect(res.providerUsed).toBe("ollama");
    expect(httpPoster).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/generate",
      {},
      expect.objectContaining({ model: "llama3.2:3b", stream: false })
    );
  });
});
