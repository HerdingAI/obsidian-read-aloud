import { Platform } from "obsidian";
import { hashContent } from "./markdown-cleaner";

export interface CacheStats {
  scriptCount: number;
  audioCount: number;
  totalBytes: number;
}

export function makeCacheKey(parts: Array<string | number>): string {
  const joined = parts.join("\u0000");
  if (Platform.isDesktopApp) {
    try {
      const crypto = require("crypto") as typeof import("crypto");
      return crypto.createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 24);
    } catch {
      // Fallback to pure JS hash
    }
  }
  return `${hashContent(joined)}-${joined.length}`;
}

export class PersistentCache {
  private memScripts = new Map<string, string>();
  private memAudio = new Map<string, ArrayBuffer>();

  constructor(private isDesktop: boolean = Platform.isDesktopApp) {}

  private getDirs(): { scriptsDir: string; audioDir: string } {
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");
    const root = path.join(os.homedir(), ".cache", "obsidian-read-aloud", "cache");
    return {
      scriptsDir: path.join(root, "scripts"),
      audioDir: path.join(root, "audio"),
    };
  }

  getScript(key: string): string | null {
    if (this.memScripts.has(key)) {
      return this.memScripts.get(key)!;
    }
    if (!this.isDesktop) return null;
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const file = path.join(this.getDirs().scriptsDir, `${key}.txt`);
      if (!fs.existsSync(file)) return null;
      const content = fs.readFileSync(file, "utf8");
      this.memScripts.set(key, content);
      return content;
    } catch {
      return null;
    }
  }

  setScript(key: string, script: string): void {
    this.memScripts.set(key, script);
    if (!this.isDesktop) return;
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const { scriptsDir } = this.getDirs();
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, `${key}.txt`), script, "utf8");
    } catch {
      // Ignore disk write failures
    }
  }

  getAudio(key: string, ext: string): ArrayBuffer | null {
    const memKey = `${key}.${ext}`;
    if (this.memAudio.has(memKey)) {
      return this.memAudio.get(memKey)!;
    }
    if (!this.isDesktop) return null;
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const file = path.join(this.getDirs().audioDir, memKey);
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      this.memAudio.set(memKey, arrayBuf);
      return arrayBuf;
    } catch {
      return null;
    }
  }

  setAudio(key: string, ext: string, buffer: ArrayBuffer): void {
    const memKey = `${key}.${ext}`;
    this.memAudio.set(memKey, buffer);
    if (!this.isDesktop) return;
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const { audioDir } = this.getDirs();
      fs.mkdirSync(audioDir, { recursive: true });
      fs.writeFileSync(path.join(audioDir, memKey), Buffer.from(buffer));
    } catch {
      // Ignore disk write failures
    }
  }

  getStats(): CacheStats {
    if (!this.isDesktop) {
      return {
        scriptCount: this.memScripts.size,
        audioCount: this.memAudio.size,
        totalBytes: 0,
      };
    }
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const { scriptsDir, audioDir } = this.getDirs();
      let scriptCount = 0;
      let audioCount = 0;
      let totalBytes = 0;

      if (fs.existsSync(scriptsDir)) {
        for (const f of fs.readdirSync(scriptsDir)) {
          scriptCount++;
          totalBytes += fs.statSync(path.join(scriptsDir, f)).size;
        }
      }
      if (fs.existsSync(audioDir)) {
        for (const f of fs.readdirSync(audioDir)) {
          audioCount++;
          totalBytes += fs.statSync(path.join(audioDir, f)).size;
        }
      }
      return { scriptCount, audioCount, totalBytes };
    } catch {
      return { scriptCount: 0, audioCount: 0, totalBytes: 0 };
    }
  }

  clear(): void {
    this.memScripts.clear();
    this.memAudio.clear();
    if (!this.isDesktop) return;
    try {
      const fs = require("fs") as typeof import("fs");
      const { scriptsDir, audioDir } = this.getDirs();
      if (fs.existsSync(scriptsDir)) {
        fs.rmSync(scriptsDir, { recursive: true, force: true });
      }
      if (fs.existsSync(audioDir)) {
        fs.rmSync(audioDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
