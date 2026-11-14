import { describe, expect, it } from "vitest";
import { PersistentCache, makeCacheKey } from "../src/cache";

describe("PersistentCache", () => {
  it("stores and retrieves scripts and audio buffers", () => {
    const cache = new PersistentCache(false);
    const key = makeCacheKey(["kokoro", "af_heart", "1.00", "Hello world"]);

    expect(cache.getScript(key)).toBeNull();
    cache.setScript(key, "Hello spoken world.");
    expect(cache.getScript(key)).toBe("Hello spoken world.");

    const wav = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(cache.getAudio(key, "wav")).toBeNull();
    cache.setAudio(key, "wav", wav);
    const got = cache.getAudio(key, "wav");
    expect(got).not.toBeNull();
    expect(new Uint8Array(got!)).toEqual(new Uint8Array([1, 2, 3, 4]));

    expect(cache.getStats()).toEqual({
      scriptCount: 1,
      audioCount: 1,
      totalBytes: 0,
    });

    cache.clear();
    expect(cache.getScript(key)).toBeNull();
    expect(cache.getAudio(key, "wav")).toBeNull();
  });

  it("produces deterministic keys for identical inputs", () => {
    const k1 = makeCacheKey(["kokoro", "af_heart", "1.00", "Same text"]);
    const k2 = makeCacheKey(["kokoro", "af_heart", "1.00", "Same text"]);
    const k3 = makeCacheKey(["kokoro", "af_bella", "1.00", "Same text"]);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});
