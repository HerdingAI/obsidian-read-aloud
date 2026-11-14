# Read Aloud (`obsidian-read-aloud`)

An Obsidian Community Plugin that transforms Markdown notes into natural **listenable** spoken-word scripts using local/CLI AI harnesses, caches both scripts and generated audio persistently on disk, and reads them aloud with self-contained **Kokoro-82M** or Web Speech.

## Features

- **Self-Contained Kokoro-82M Studio Voices**:
  - One-click setup in **Settings → Read Aloud** automatically detects your hardware (Apple Silicon, NVIDIA CUDA, or CPU fallback), creates an isolated runtime in `~/.cache/obsidian-read-aloud/`, and downloads `kokoro-v1.0.int8.onnx` + `voices-v1.0.bin`.
  - Managed warm worker stays loaded between paragraphs for instant chunk synthesis and shuts down cleanly on plugin unload.
- **Persistent Script & Audio Cache**:
  - Caches both AI-generated listenable scripts and synthesized WAV/MP3 audio clips in `~/.cache/obsidian-read-aloud/cache/` so re-listening to a note is instant and spends zero extra tokens.
- **Listenable Script Generator**:
  - **Antigravity CLI (`agy`)**: `--disable-slash-commands --model gemini-3.8-flash-low --print`
  - **Claude Code CLI (`claude`)**: `-p --no-session-persistence --tools "" --model haiku`
  - **Local Ollama** (`http://127.0.0.1:11434/api/generate`) or **OpenAI-compatible HTTP LLM**
  - **Direct Mode**: Instant offline deterministic Markdown-to-speech cleaner
- **Additional TTS Engines**:
  - **Local GPU HTTP TTS** (`/v1/audio/speech`) for MLX-Audio (Apple Silicon) or Kokoro-FastAPI (NVIDIA CUDA)
  - **Web Speech API**: Zero-config cross-platform fallback

## Community Plugin Release Packaging

```bash
npm install
npm run package
```

This runs the unit tests (`npm test`), typechecks and builds `main.js` (`npm run build`), and packages `main.js`, `manifest.json`, `styles.css`, and `versions.json` into `release/read-aloud-0.1.0.zip` (also automated on git tags via `.github/workflows/release.yml`).

### Submitting to Obsidian Community Plugins

1. Push this repository to a public GitHub repo (e.g. `https://github.com/<user>/obsidian-read-aloud`).
2. Create a GitHub Release tagged `0.1.0` (note: no `v` prefix, matching `manifest.json`) and attach `main.js`, `manifest.json`, and `styles.css` (`.github/workflows/release.yml` does this automatically on `git tag 0.1.0 && git push --tags`).
3. Fork `obsidianmd/obsidian-releases` and add an entry to `community-plugins.json` with `"id": "read-aloud"`, `"name": "Read Aloud"`, `"author"`, `"description"`, and `"repo"`.
