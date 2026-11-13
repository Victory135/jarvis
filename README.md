# J.A.R.V.I.S. — a local desktop assistant

An original Iron-Man-style HUD assistant for Windows, built with Tauri 2 + React + TypeScript and Rust.
Everything runs on your own PC: speech recognition, the language model and the voice. Nothing is sent to a cloud AI.

**What it does:** wake word ("Hey Jarvis") and double-clap wake-up, voice and typed commands, local chat
(two small Qwen models), free web search with page reading, news, weather, opening apps and websites,
YouTube and Spotify playback (with your own keys), typing WhatsApp/Gmail messages for you to send.

## Requirements
- Windows 10/11, 64-bit, a processor with AVX2, 16 GB RAM recommended
- Node.js 20+, Rust (stable, MSVC toolchain), Visual Studio Build Tools with C++, CMake, Python 3.11+

## Models (not in this repository — download them into `models/`)
| Folder | File | Source | Licence |
|---|---|---|---|
| `models/llm/` | `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` (quick) and optionally `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (thinking) | Hugging Face (Qwen GGUF releases) | Apache-2.0 |
| `models/llama/` | llama.cpp Windows CPU release (`llama-server.exe` and its DLLs) | github.com/ggml-org/llama.cpp releases | MIT |
| `models/whisper/` | `ggml-base.en.bin` | huggingface.co/ggerganov/whisper.cpp | MIT |
| `models/vosk-model/` | `vosk-model-small-en-in-0.4` | alphacephei.com/vosk/models | Apache-2.0 |
| `models/vosk-lib/` | `vosk-win64-0.3.45` | github.com/alphacep/vosk-api releases | Apache-2.0 |
| `models/kokoro/` | `kokoro-v1.0.int8.onnx`, `voices-v1.0.bin` | github.com/thewh1teagle/kokoro-onnx release model-files-v1.0 | Apache-2.0 |

Full list with versions and checksums: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Build
```
cd sidecar && python -m venv .venv && .venv\Scripts\pip install kokoro-onnx==0.6.1 soundfile
cd ..\apps\desktop
npm install
npx tauri build --no-bundle
```
`apps/desktop/src-tauri/.cargo/config.toml` points `CMAKE` at the CMake inside Visual Studio Build Tools on the author's PC; change that path to yours.
On machines with little memory set `CARGO_BUILD_JOBS=1`. The exe is written to
`apps/desktop/src-tauri/target/release/jarvis-desktop.exe`; copy the Vosk DLLs from `models/vosk-lib` next to it.

## Optional online services
Settings → Connections: your own Spotify Client ID (Premium needed to start tracks), a YouTube Data API key,
and a news API key. Keys are encrypted with Windows DPAPI on your PC and are never stored in this repository.

## Licence
See [LICENSES.md](LICENSES.md). Not affiliated with Marvel or Disney; no film audio, logos or actor voices are used.
