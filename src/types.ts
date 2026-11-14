export type ListenableProvider =
  | "agy"
  | "claude"
  | "ollama"
  | "http-llm"
  | "direct";

export type TtsEngineType = "kokoro" | "http-tts" | "web-speech";

export type PlaybackState = "idle" | "generating" | "playing" | "paused";

export interface ReadAloudSettings {
  // Listenable script generation
  listenableProvider: ListenableProvider;
  agyPath: string;
  agyModel: string;
  claudePath: string;
  claudeModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  httpLlmUrl: string;
  httpLlmModel: string;
  httpLlmApiKey: string;
  listenableSystemPrompt: string;
  enableListenableCache: boolean;

  // TTS engine
  ttsEngine: TtsEngineType;
  speechRate: number;
  skipCodeBlocks: boolean;
  showMiniPlayer: boolean;
  enableAudioCache: boolean;

  // Kokoro-82M (Self-contained managed worker)
  kokoroVoice: string;

  // OpenAI-compatible HTTP TTS (MLX-Audio on Apple Silicon, Kokoro-FastAPI on NVIDIA, OpenAI)
  httpTtsUrl: string;
  httpTtsModel: string;
  httpTtsVoice: string;
  httpTtsApiKey: string;
  httpTtsFormat: "mp3" | "wav";

  // Web Speech API
  webSpeechVoice: string;
}

export const DEFAULT_LISTENABLE_PROMPT = [
  "You are preparing an Obsidian Markdown note to be read aloud as natural spoken audio.",
  "Rewrite the note into a clean, listenable spoken-word script.",
  "Rules:",
  "- Preserve all key facts, arguments, numbers, and structure.",
  "- Convert markdown headings, bullet lists, callouts, and tables into smooth, natural spoken transitions.",
  "- Summarize code blocks or long URLs concisely instead of reading raw syntax or punctuation.",
  "- Remove YAML frontmatter, markdown formatting characters, and wikilink brackets.",
  "- Output ONLY the spoken script with no meta-commentary or intro/outro filler.",
].join("\n");

export const DEFAULT_SETTINGS: ReadAloudSettings = {
  listenableProvider: "agy",
  agyPath: "agy",
  agyModel: "gemini-3.8-flash-low",
  claudePath: "claude",
  claudeModel: "haiku",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2:3b",
  httpLlmUrl: "http://127.0.0.1:11434/v1/chat/completions",
  httpLlmModel: "llama3.2:3b",
  httpLlmApiKey: "",
  listenableSystemPrompt: DEFAULT_LISTENABLE_PROMPT,
  enableListenableCache: true,

  ttsEngine: "kokoro",
  speechRate: 1.0,
  skipCodeBlocks: true,
  showMiniPlayer: true,
  enableAudioCache: true,

  kokoroVoice: "af_heart",

  httpTtsUrl: "http://127.0.0.1:8880/v1/audio/speech",
  httpTtsModel: "kokoro",
  httpTtsVoice: "af_heart",
  httpTtsApiKey: "",
  httpTtsFormat: "wav",

  webSpeechVoice: "",
};

export interface PlayerSnapshot {
  state: PlaybackState;
  title: string;
  currentChunkIndex: number;
  totalChunks: number;
  rate: number;
  statusDetail: string;
  currentText: string;
}
