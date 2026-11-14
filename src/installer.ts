import { Platform } from "obsidian";
import { buildDesktopEnv, resolveDesktopBinary } from "./listenable";

export interface HardwareProfile {
  platform: string;
  arch: string;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  recommendedBackend: "mlx-audio" | "kokoro-onnx-cuda" | "kokoro-onnx-cpu";
  summary: string;
}

export interface KokoroInstallStatus {
  installed: boolean;
  pythonPath: string;
  modelPath: string;
  voicesPath: string;
  workerPath: string;
}

export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (US Female, Warm)" },
  { id: "af_bella", label: "Bella (US Female, Clear)" },
  { id: "af_nicole", label: "Nicole (US Female, Soft)" },
  { id: "af_sarah", label: "Sarah (US Female, Crisp)" },
  { id: "am_adam", label: "Adam (US Male, Deep)" },
  { id: "am_michael", label: "Michael (US Male, Natural)" },
  { id: "bf_emma", label: "Emma (UK Female)" },
  { id: "bm_george", label: "George (UK Male)" },
];

const KOKORO_MODEL_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx";
const KOKORO_VOICES_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

const KOKORO_WORKER_SCRIPT = `import json
import sys
import time
import soundfile as sf
from kokoro_onnx import Kokoro

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: kokoro_worker.py <model_path> <voices_path>"}), flush=True)
        sys.exit(1)

    model_path = sys.argv[1]
    voices_path = sys.argv[2]
    kokoro = Kokoro(model_path, voices_path)
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text", "")
            voice = req.get("voice", "af_heart")
            speed = float(req.get("speed", 1.0))
            out_wav = req["out_wav"]

            t0 = time.perf_counter()
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
            sf.write(out_wav, samples, sample_rate)
            synth_ms = int((time.perf_counter() - t0) * 1000)
            audio_sec = round(len(samples) / float(sample_rate), 2) if sample_rate else 0.0

            print(json.dumps({
                "ok": True,
                "wav": out_wav,
                "synth_ms": synth_ms,
                "audio_sec": audio_sec,
            }), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)

if __name__ == "__main__":
    main()
`;

export function getCachePaths() {
  const path = require("path") as typeof import("path");
  const os = require("os") as typeof import("os");
  const root = path.join(os.homedir(), ".cache", "obsidian-read-aloud");
  return {
    root,
    binDir: path.join(root, "bin"),
    venvDir: path.join(root, "venv"),
    pythonPath:
      process.platform === "win32"
        ? path.join(root, "venv", "Scripts", "python.exe")
        : path.join(root, "venv", "bin", "python"),
    kokoroDir: path.join(root, "models", "kokoro"),
    modelPath: path.join(root, "models", "kokoro", "kokoro-v1.0.int8.onnx"),
    voicesPath: path.join(root, "models", "kokoro", "voices-v1.0.bin"),
    workerPath: path.join(root, "kokoro_worker.py"),
  };
}

export function getKokoroInstallStatus(): KokoroInstallStatus {
  if (!Platform.isDesktopApp) {
    return {
      installed: false,
      pythonPath: "",
      modelPath: "",
      voicesPath: "",
      workerPath: "",
    };
  }
  const fs = require("fs") as typeof import("fs");
  const p = getCachePaths();
  const installed =
    fs.existsSync(p.pythonPath) &&
    fs.existsSync(p.modelPath) &&
    fs.existsSync(p.voicesPath) &&
    fs.existsSync(p.workerPath);
  return {
    installed,
    pythonPath: p.pythonPath,
    modelPath: p.modelPath,
    voicesPath: p.voicesPath,
    workerPath: p.workerPath,
  };
}

export function detectHardware(): HardwareProfile {
  const platform = process.platform;
  const arch = process.arch;
  const isAppleSilicon = platform === "darwin" && arch === "arm64";
  let hasNvidiaGpu = false;

  if (Platform.isDesktopApp && !isAppleSilicon) {
    try {
      const { execFileSync } = require("child_process") as typeof import("child_process");
      const out = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
        timeout: 2000,
        encoding: "utf8",
      });
      hasNvidiaGpu = Boolean(out && out.trim());
    } catch {
      hasNvidiaGpu = false;
    }
  }

  if (isAppleSilicon) {
    return {
      platform,
      arch,
      isAppleSilicon,
      hasNvidiaGpu,
      recommendedBackend: "mlx-audio",
      summary: "Apple Silicon (Metal/CoreML + ONNX)",
    };
  }
  if (hasNvidiaGpu) {
    return {
      platform,
      arch,
      isAppleSilicon,
      hasNvidiaGpu,
      recommendedBackend: "kokoro-onnx-cuda",
      summary: "NVIDIA GPU (CUDA ONNX)",
    };
  }
  return {
    platform,
    arch,
    isAppleSilicon,
    hasNvidiaGpu,
    recommendedBackend: "kokoro-onnx-cpu",
    summary: `CPU (${platform}/${arch}, int8 quantized ONNX)`,
  };
}

function runProcess(
  command: string,
  args: string[],
  onLog?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process") as typeof import("child_process");
    const child = spawn(command, args, {
      env: buildDesktopEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => onLog?.(d.toString("utf8").trim()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8").trim();
      stderr += s + "\n";
      onLog?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const tmpPath = `${destPath}.tmp`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }

  const arrayBuf = await res.arrayBuffer();
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));
  fs.renameSync(tmpPath, destPath);
}

async function ensureUv(onProgress: (msg: string) => void): Promise<string> {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const resolved = resolveDesktopBinary("uv");
  if (resolved !== "uv" || fs.existsSync(resolved)) {
    return resolved;
  }

  const p = getCachePaths();
  const localUv = path.join(p.binDir, process.platform === "win32" ? "uv.exe" : "uv");
  if (fs.existsSync(localUv)) {
    return localUv;
  }

  onProgress("Installing standalone uv runtime...");
  fs.mkdirSync(p.binDir, { recursive: true });
  if (process.platform === "win32") {
    await runProcess("powershell", [
      "-ExecutionPolicy",
      "ByPass",
      "-c",
      `$env:UV_INSTALL_DIR='${p.binDir}'; irm https://astral.sh/uv/install.ps1 | iex`,
    ]);
  } else {
    await runProcess("sh", [
      "-c",
      `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="${p.binDir}" sh`,
    ]);
  }
  return localUv;
}

export async function installKokoroSelfContained(
  onProgress: (msg: string) => void
): Promise<KokoroInstallStatus> {
  if (!Platform.isDesktopApp) {
    throw new Error("Self-contained Kokoro installer is only supported on desktop.");
  }

  const fs = require("fs") as typeof import("fs");
  const p = getCachePaths();
  const hw = detectHardware();
  onProgress(`Detected hardware: ${hw.summary}`);

  const uvBin = await ensureUv(onProgress);

  if (!fs.existsSync(p.pythonPath)) {
    onProgress("Creating isolated Python 3.12 environment...");
    await runProcess(uvBin, ["venv", "--python", "3.12", p.venvDir]);
  }

  onProgress("Installing Kokoro ONNX runtime...");
  const packages = ["kokoro-onnx", "soundfile"];
  if (hw.hasNvidiaGpu) {
    packages.push("onnxruntime-gpu");
  }
  await runProcess(uvBin, [
    "pip",
    "install",
    "--python",
    p.pythonPath,
    ...packages,
  ]);

  if (!fs.existsSync(p.modelPath)) {
    onProgress("Downloading Kokoro-82M int8 model (~88 MB)...");
    await downloadFile(KOKORO_MODEL_URL, p.modelPath);
  }

  if (!fs.existsSync(p.voicesPath)) {
    onProgress("Downloading Kokoro voice pack (~27 MB)...");
    await downloadFile(KOKORO_VOICES_URL, p.voicesPath);
  }

  onProgress("Writing managed Kokoro worker...");
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.workerPath, KOKORO_WORKER_SCRIPT, "utf8");

  onProgress("Kokoro-82M ready.");
  return getKokoroInstallStatus();
}
