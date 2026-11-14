import { Platform, requestUrl } from "obsidian";
import { PersistentCache, makeCacheKey } from "./cache";
import { cleanMarkdownForSpeech } from "./markdown-cleaner";
import { ListenableProvider, ReadAloudSettings } from "./types";

export interface ListenableResult {
  script: string;
  providerUsed: ListenableProvider;
  cached: boolean;
  fallbackReason?: string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CliRunner = (
  command: string,
  args: string[],
  stdinText: string,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<CliResult>;

export type HttpJsonPoster = (
  url: string,
  headers: Record<string, string>,
  body: unknown
) => Promise<{ status: number; json: unknown; text: string }>;

/**
 * Builds an enriched PATH so GUI-launched Obsidian (Snap/macOS .app)
 * can find binaries in ~/.local/bin, /opt/homebrew/bin, and NVM.
 */
export function buildDesktopEnv(): NodeJS.ProcessEnv {
  const path = require("path") as typeof import("path");
  const os = require("os") as typeof import("os");
  const fs = require("fs") as typeof import("fs");

  const home = os.homedir();
  const extraPaths = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  // Include active NVM node bin if present
  const nvmVersionsDir = path.join(home, ".nvm", "versions", "node");
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
      if (versions.length > 0) {
        extraPaths.unshift(path.join(nvmVersionsDir, versions[0], "bin"));
      }
    } catch {
      // Ignore unreadable nvm directory
    }
  }

  const currentPath = process.env.PATH ?? "";
  const merged = Array.from(
    new Set([...extraPaths, ...currentPath.split(path.delimiter).filter(Boolean)])
  ).join(path.delimiter);

  return {
    ...process.env,
    PATH: merged,
  };
}

/**
 * Resolves a command name (e.g., "agy", "claude", "piper") against common user bin paths.
 */
export function resolveDesktopBinary(command: string): string {
  const path = require("path") as typeof import("path");
  const os = require("os") as typeof import("os");
  const fs = require("fs") as typeof import("fs");

  if (!command || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const env = buildDesktopEnv();
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return command;
}

export const defaultCliRunner: CliRunner = (
  command,
  args,
  stdinText,
  timeoutMs,
  signal
) => {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process") as typeof import("child_process");
    const resolved = resolveDesktopBinary(command);
    const child = spawn(resolved, args, {
      env: buildDesktopEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error("Aborted"));
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
};

export const defaultHttpPoster: HttpJsonPoster = async (url, headers, body) => {
  const res = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    throw: false,
  });
  return {
    status: res.status,
    json: res.json,
    text: res.text,
  };
};

export class ListenableGenerator {
  private cache: PersistentCache;
  private cliRunner: CliRunner;
  private httpPoster: HttpJsonPoster;
  private isDesktop: boolean;

  constructor(deps?: {
    cliRunner?: CliRunner;
    httpPoster?: HttpJsonPoster;
    isDesktop?: boolean;
    cache?: PersistentCache;
  }) {
    this.cliRunner = deps?.cliRunner ?? defaultCliRunner;
    this.httpPoster = deps?.httpPoster ?? defaultHttpPoster;
    this.isDesktop = deps?.isDesktop ?? Platform.isDesktopApp;
    this.cache = deps?.cache ?? new PersistentCache(this.isDesktop);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async generate(
    rawMarkdown: string,
    title: string,
    settings: ReadAloudSettings,
    signal?: AbortSignal
  ): Promise<ListenableResult> {
    const provider = settings.listenableProvider;

    if (provider === "direct") {
      return {
        script: cleanMarkdownForSpeech(rawMarkdown, {
          skipCodeBlocks: settings.skipCodeBlocks,
        }),
        providerUsed: "direct",
        cached: false,
      };
    }

    const modelKey = this.getModelKey(settings);
    const cacheKey = makeCacheKey([
      provider,
      modelKey,
      settings.listenableSystemPrompt,
      rawMarkdown,
    ]);

    if (settings.enableListenableCache) {
      const cachedScript = this.cache.getScript(cacheKey);
      if (cachedScript) {
        return {
          script: cachedScript,
          providerUsed: provider,
          cached: true,
        };
      }
    }

    const prompt = this.buildPrompt(rawMarkdown, title, settings);

    try {
      let generated = "";

      if (provider === "agy") {
        if (!this.isDesktop) {
          throw new Error("Antigravity CLI is only available on desktop.");
        }
        const res = await this.cliRunner(
          settings.agyPath || "agy",
          [
            "--disable-slash-commands",
            "--model",
            settings.agyModel || "gemini-3.8-flash-low",
            "--print",
            prompt,
          ],
          "",
          90_000,
          signal
        );
        if (res.exitCode !== 0) {
          throw new Error(res.stderr.trim() || `agy exited with ${res.exitCode}`);
        }
        generated = res.stdout.trim();
      } else if (provider === "claude") {
        if (!this.isDesktop) {
          throw new Error("Claude CLI is only available on desktop.");
        }
        const res = await this.cliRunner(
          settings.claudePath || "claude",
          [
            "-p",
            "--no-session-persistence",
            "--tools",
            "",
            "--model",
            settings.claudeModel || "haiku",
          ],
          prompt,
          90_000,
          signal
        );
        if (res.exitCode !== 0) {
          throw new Error(
            res.stderr.trim() || `claude exited with ${res.exitCode}`
          );
        }
        generated = res.stdout.trim();
      } else if (provider === "ollama") {
        const baseUrl = (settings.ollamaUrl || "http://127.0.0.1:11434").replace(
          /\/+$/,
          ""
        );
        const res = await this.httpPoster(
          `${baseUrl}/api/generate`,
          {},
          {
            model: settings.ollamaModel || "llama3.2:3b",
            prompt,
            stream: false,
          }
        );
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`Ollama HTTP ${res.status}: ${res.text}`);
        }
        const data = res.json as { response?: string };
        generated = (data?.response ?? "").trim();
      } else if (provider === "http-llm") {
        const headers: Record<string, string> = {};
        if (settings.httpLlmApiKey) {
          headers["Authorization"] = `Bearer ${settings.httpLlmApiKey}`;
        }
        const res = await this.httpPoster(settings.httpLlmUrl, headers, {
          model: settings.httpLlmModel,
          messages: [
            { role: "system", content: settings.listenableSystemPrompt },
            {
              role: "user",
              content: `Note title: ${title}\n\n${rawMarkdown}`,
            },
          ],
          temperature: 0.2,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`HTTP LLM ${res.status}: ${res.text}`);
        }
        const data = res.json as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        generated = (data?.choices?.[0]?.message?.content ?? "").trim();
      }

      if (!generated) {
        throw new Error(`Empty response from ${provider}`);
      }

      if (settings.enableListenableCache) {
        this.cache.setScript(cacheKey, generated);
      }

      return {
        script: generated,
        providerUsed: provider,
        cached: false,
      };
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      return {
        script: cleanMarkdownForSpeech(rawMarkdown, {
          skipCodeBlocks: settings.skipCodeBlocks,
        }),
        providerUsed: "direct",
        cached: false,
        fallbackReason: reason,
      };
    }
  }

  private getModelKey(settings: ReadAloudSettings): string {
    switch (settings.listenableProvider) {
      case "agy":
        return settings.agyModel;
      case "claude":
        return settings.claudeModel;
      case "ollama":
        return settings.ollamaModel;
      case "http-llm":
        return settings.httpLlmModel;
      default:
        return "direct";
    }
  }

  private buildPrompt(
    rawMarkdown: string,
    title: string,
    settings: ReadAloudSettings
  ): string {
    return [
      settings.listenableSystemPrompt.trim(),
      "",
      `Note title: ${title}`,
      "---",
      rawMarkdown.trim(),
    ].join("\n");
  }
}
