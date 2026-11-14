# Read Aloud (`obsidian-read-aloud`)

An Obsidian Community Plugin that transforms Markdown notes into natural **listenable** spoken-word scripts using cheap AI harnesses or local LLMs, and reads them aloud using GPU-accelerated local TTS or Web Speech.

## Features

- **Listenable Script Generator** (with content-hash caching & offline fallback):
  - **Antigravity CLI (`agy`)**: Uses `--disable-slash-commands --model gemini-3.8-flash-low --print`.
  - **Claude Code CLI (`claude`)**: Uses `-p --no-session-persistence --tools "" --model haiku`.
  - **Local Ollama** (`http://127.0.0.1:11434/api/generate`) or any **OpenAI-compatible HTTP LLM**.
  - **Direct Mode**: Instant, offline deterministic Markdown-to-speech cleaner.
- **GPU-Accelerated Local TTS + Cross-Platform Fallback**:
  - **Local Piper CLI** (Desktop): Auto-discovers `.onnx` voice models, supports `--cuda` for NVIDIA GPUs with automatic CPU fallback.
  - **Local GPU HTTP TTS** (`/v1/audio/speech`): Compatible with **MLX-Audio / Kokoro** on Apple Silicon (Metal/MPS), **Kokoro-FastAPI** on NVIDIA CUDA, or OpenAI TTS.
  - **Web Speech API**: Zero-config cross-platform fallback.
- **Playback Controls**:
  - Ribbon button, Command Palette commands (Read active page, Read selection, Pause/Resume, Stop, Next/Previous paragraph), status bar indicator, and floating mini-player with speed control (`0.8x`–`2.0x`).

## Local Development & Install

```bash
npm install
npm test
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/read-aloud/`.
