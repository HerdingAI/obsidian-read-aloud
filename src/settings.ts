import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
  KOKORO_VOICES,
  PIPER_VOICE_PRESETS,
  detectHardware,
  getKokoroInstallStatus,
  installKokoroSelfContained,
  installPiperVoicePreset,
} from "./installer";
import type ReadAloudPlugin from "./main";
import { discoverPiperModels } from "./tts-engines";
import { ListenableProvider, TtsEngineType } from "./types";

export class ReadAloudSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ReadAloudPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Read Aloud" });

    // ── Listenable Script Generator ────────────────────────────────────────
    containerEl.createEl("h3", { text: "Listenable Script Generator" });

    new Setting(containerEl)
      .setName("Listenable provider")
      .setDesc(
        "Transform notes into natural spoken prose using a cheap AI harness or local LLM before speaking."
      )
      .addDropdown((dd) =>
        dd
          .addOption("agy", "Antigravity CLI (agy -p)")
          .addOption("claude", "Claude Code CLI (claude -p)")
          .addOption("ollama", "Local Ollama (HTTP)")
          .addOption("http-llm", "OpenAI-Compatible HTTP LLM")
          .addOption("direct", "Direct (Offline Markdown Cleaner)")
          .setValue(this.plugin.settings.listenableProvider)
          .onChange(async (val) => {
            this.plugin.settings.listenableProvider = val as ListenableProvider;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    const lp = this.plugin.settings.listenableProvider;

    if (lp === "agy") {
      new Setting(containerEl)
        .setName("Antigravity binary")
        .setDesc("Command name or full path to agy.")
        .addText((t) =>
          t
            .setPlaceholder("agy")
            .setValue(this.plugin.settings.agyPath)
            .onChange(async (v) => {
              this.plugin.settings.agyPath = v.trim() || "agy";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Antigravity model")
        .setDesc("Cheap/fast model recommended (e.g. gemini-3.8-flash-low).")
        .addText((t) =>
          t
            .setPlaceholder("gemini-3.8-flash-low")
            .setValue(this.plugin.settings.agyModel)
            .onChange(async (v) => {
              this.plugin.settings.agyModel = v.trim() || "gemini-3.8-flash-low";
              await this.plugin.saveSettings();
            })
        );
    } else if (lp === "claude") {
      new Setting(containerEl)
        .setName("Claude binary")
        .setDesc("Command name or full path to claude.")
        .addText((t) =>
          t
            .setPlaceholder("claude")
            .setValue(this.plugin.settings.claudePath)
            .onChange(async (v) => {
              this.plugin.settings.claudePath = v.trim() || "claude";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Claude model")
        .setDesc("Cheap/fast model recommended (e.g. haiku).")
        .addText((t) =>
          t
            .setPlaceholder("haiku")
            .setValue(this.plugin.settings.claudeModel)
            .onChange(async (v) => {
              this.plugin.settings.claudeModel = v.trim() || "haiku";
              await this.plugin.saveSettings();
            })
        );
    } else if (lp === "ollama") {
      new Setting(containerEl)
        .setName("Ollama URL")
        .addText((t) =>
          t
            .setPlaceholder("http://127.0.0.1:11434")
            .setValue(this.plugin.settings.ollamaUrl)
            .onChange(async (v) => {
              this.plugin.settings.ollamaUrl = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Ollama model")
        .addText((t) =>
          t
            .setPlaceholder("llama3.2:3b")
            .setValue(this.plugin.settings.ollamaModel)
            .onChange(async (v) => {
              this.plugin.settings.ollamaModel = v.trim();
              await this.plugin.saveSettings();
            })
        );
    } else if (lp === "http-llm") {
      new Setting(containerEl)
        .setName("Chat completions URL")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.httpLlmUrl)
            .onChange(async (v) => {
              this.plugin.settings.httpLlmUrl = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Model")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.httpLlmModel)
            .onChange(async (v) => {
              this.plugin.settings.httpLlmModel = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("API key (optional)")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.httpLlmApiKey)
            .onChange(async (v) => {
              this.plugin.settings.httpLlmApiKey = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Cache listenable scripts")
      .setDesc("Avoid regenerating the script when re-playing an unchanged note.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableListenableCache)
          .onChange(async (v) => {
            this.plugin.settings.enableListenableCache = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clear script cache")
      .setDesc("Remove cached listenable scripts from memory.")
      .addButton((btn) =>
        btn.setButtonText("Clear cache").onClick(() => {
          this.plugin.generator.clearCache();
          new Notice("Listenable script cache cleared.");
        })
      );

    // ── TTS Engine ─────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Text-to-Speech Engine" });

    new Setting(containerEl)
      .setName("TTS engine")
      .setDesc(
        "Use Self-Contained Kokoro-82M (studio voices), Local Piper CLI (desktop), Local GPU HTTP TTS (/v1/audio/speech), or Web Speech API."
      )
      .addDropdown((dd) =>
        dd
          .addOption("kokoro", "Kokoro-82M (Self-Contained Studio)")
          .addOption("piper", "Local Piper CLI (Desktop)")
          .addOption("http-tts", "Local GPU HTTP TTS (/v1/audio/speech)")
          .addOption("web-speech", "Web Speech API (Cross-Platform)")
          .setValue(this.plugin.settings.ttsEngine)
          .onChange(async (v) => {
            this.plugin.settings.ttsEngine = v as TtsEngineType;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    const te = this.plugin.settings.ttsEngine;

    if (te === "kokoro") {
      const hw = detectHardware();
      const status = getKokoroInstallStatus();

      const setupSetting = new Setting(containerEl)
        .setName("Kokoro-82M runtime & model")
        .setDesc(
          status.installed
            ? `Installed (${hw.summary}). Managed worker stays warm for fast playback.`
            : `Not installed. Detected: ${hw.summary}. Click Install to download isolated runtime + Kokoro-82M (~115 MB).`
        )
        .addButton((btn) =>
          btn
            .setButtonText(status.installed ? "Reinstall / Verify" : "Install Kokoro-82M")
            .setCta()
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText("Installing...");
              try {
                await installKokoroSelfContained((msg) => {
                  setupSetting.setDesc(msg);
                });
                new Notice("Kokoro-82M installed and ready!");
                this.display();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`Kokoro install failed: ${msg}`);
                setupSetting.setDesc(`Install failed: ${msg}`);
                btn.setDisabled(false);
                btn.setButtonText("Retry Install");
              }
            })
        );

      new Setting(containerEl)
        .setName("Kokoro voice")
        .setDesc("Studio-quality 82M neural voices.")
        .addDropdown((dd) => {
          for (const v of KOKORO_VOICES) {
            dd.addOption(v.id, v.label);
          }
          dd.setValue(this.plugin.settings.kokoroVoice).onChange(async (v) => {
            this.plugin.settings.kokoroVoice = v;
            await this.plugin.saveSettings();
          });
        });
    } else if (te === "piper") {
      const discovered = discoverPiperModels();
      new Setting(containerEl)
        .setName("Piper binary")
        .setDesc("Command name or full path to piper.")
        .addText((t) =>
          t
            .setPlaceholder("piper")
            .setValue(this.plugin.settings.piperPath)
            .onChange(async (v) => {
              this.plugin.settings.piperPath = v.trim() || "piper";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Piper .onnx model path")
        .setDesc(
          discovered.length > 0
            ? `Leave blank to auto-use: ${discovered[0]}`
            : "Path to a local .onnx voice model."
        )
        .addText((t) =>
          t
            .setPlaceholder(discovered[0] || "/path/to/voice.onnx")
            .setValue(this.plugin.settings.piperModelPath)
            .onChange(async (v) => {
              this.plugin.settings.piperModelPath = v.trim();
              await this.plugin.saveSettings();
            })
        );

      let selectedPreset = PIPER_VOICE_PRESETS[0].id;
      const presetSetting = new Setting(containerEl)
        .setName("Download Piper voice")
        .setDesc("One-click download into ~/.cache/obsidian-read-aloud/voices/piper/")
        .addDropdown((dd) => {
          for (const p of PIPER_VOICE_PRESETS) {
            dd.addOption(p.id, p.label);
          }
          dd.setValue(selectedPreset).onChange((v) => {
            selectedPreset = v;
          });
        })
        .addButton((btn) =>
          btn.setButtonText("Download").onClick(async () => {
            const preset = PIPER_VOICE_PRESETS.find((p) => p.id === selectedPreset);
            if (!preset) return;
            btn.setDisabled(true);
            btn.setButtonText("Downloading...");
            try {
              const onnxPath = await installPiperVoicePreset(preset, (msg) => {
                presetSetting.setDesc(msg);
              });
              this.plugin.settings.piperModelPath = onnxPath;
              await this.plugin.saveSettings();
              new Notice(`Downloaded ${preset.id}`);
              this.display();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`Download failed: ${msg}`);
              btn.setDisabled(false);
              btn.setButtonText("Download");
            }
          })
        );

      new Setting(containerEl)
        .setName("Use NVIDIA CUDA (--cuda)")
        .setDesc(
          "Use GPU acceleration when available; automatically falls back to CPU if CUDA/NVML is unavailable."
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.piperUseCuda)
            .onChange(async (v) => {
              this.plugin.settings.piperUseCuda = v;
              await this.plugin.saveSettings();
            })
        );
    } else if (te === "http-tts") {
      new Setting(containerEl)
        .setName("Audio speech URL")
        .setDesc(
          "OpenAI-compatible endpoint (e.g. MLX-Audio on Apple Silicon or Kokoro-FastAPI on NVIDIA)."
        )
        .addText((t) =>
          t
            .setPlaceholder("http://127.0.0.1:8880/v1/audio/speech")
            .setValue(this.plugin.settings.httpTtsUrl)
            .onChange(async (v) => {
              this.plugin.settings.httpTtsUrl = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("TTS model")
        .addText((t) =>
          t
            .setPlaceholder("kokoro")
            .setValue(this.plugin.settings.httpTtsModel)
            .onChange(async (v) => {
              this.plugin.settings.httpTtsModel = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Voice")
        .addText((t) =>
          t
            .setPlaceholder("af_heart")
            .setValue(this.plugin.settings.httpTtsVoice)
            .onChange(async (v) => {
              this.plugin.settings.httpTtsVoice = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("API key (optional)")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.httpTtsApiKey)
            .onChange(async (v) => {
              this.plugin.settings.httpTtsApiKey = v.trim();
              await this.plugin.saveSettings();
            })
        );
    } else if (te === "web-speech") {
      new Setting(containerEl)
        .setName("Preferred voice name (optional)")
        .setDesc("Exact browser/OS voice name, or blank for system default.")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.webSpeechVoice)
            .onChange(async (v) => {
              this.plugin.settings.webSpeechVoice = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    // ── Playback Preferences ───────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Playback" });

    new Setting(containerEl)
      .setName("Speech speed")
      .setDesc("Playback rate multiplier (0.5x to 2.0x).")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 2.0, 0.05)
          .setValue(this.plugin.settings.speechRate)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.speechRate = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show floating mini-player")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showMiniPlayer)
          .onChange(async (v) => {
            this.plugin.settings.showMiniPlayer = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Skip code blocks (Direct mode)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.skipCodeBlocks)
          .onChange(async (v) => {
            this.plugin.settings.skipCodeBlocks = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
