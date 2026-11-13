# Third-party notices

J.A.R.V.I.S. is an unofficial, fan-made personal project. It is not affiliated with or endorsed by Marvel or Disney.

This file lists every third-party library, font, model, sound and code fragment included in or adapted into
this project, with its license and source commit. Entries are added when the item is actually added.

| Item | Source | Version / commit | License | Used for |
|---|---|---|---|---|
| Rajdhani (font) | Indian Type Foundry, via npm `@fontsource/rajdhani` | 5.3.0 | SIL OFL 1.1 | Headings and labels (bundled) |
| Share Tech Mono (font) | Carrois Apostrophe, via npm `@fontsource/share-tech-mono` | 5.3.0 | SIL OFL 1.1 | Numbers and readouts (bundled) |
| React, React DOM | npm `react`, `react-dom` | 18.3.1 | MIT | UI framework (bundled) |
| Tauri | crates.io `tauri` 2.12.5, `tauri-build` 2.7.4; npm `@tauri-apps/api` 2.12.4, `@tauri-apps/cli` 2.12.4 | see versions | Apache-2.0 OR MIT | Desktop shell, IPC (bundled) |
| sysinfo | crates.io `sysinfo` | 0.40.1 | MIT | CPU, memory, disk, network readings (bundled) |
| windows (Microsoft) | crates.io `windows` | 0.62.2 | MIT OR Apache-2.0 | Media controls, HTTPS for news feeds, XML parsing, opening links (bundled; already used by Tauri) |
| serde, serde_json | crates.io | 1.0.229 / 1.0.154 | MIT OR Apache-2.0 | Data passing between Rust and the UI (bundled) |
| Vosk API (libvosk) | github.com/alphacep/vosk-api release v0.3.45, `vosk-win64-0.3.45.zip` (+ its MinGW runtime DLLs) | 0.3.45 | Apache-2.0 | Speech recognition engine (shipped next to the exe) |
| Vosk model small English (India) | alphacephei.com/vosk/models `vosk-model-small-en-in-0.4` | 0.4 | Apache-2.0 | Speech recognition model (models/vosk-model) |
| vosk (Rust bindings) | crates.io `vosk` | 0.3.1 | MIT | Calls libvosk from Rust |
| whisper.cpp + ggml | bundled in crates.io `whisper-rs-sys` 0.15.0 (vendored, see vendor/whisper-rs-sys/VENDORED.md) | as bundled | MIT | Speech recognition engine, compiled from source |
| whisper-rs, whisper-rs-sys | crates.io | 0.16.0 / 0.15.0 | Unlicense | Rust bindings to whisper.cpp |
| Whisper base.en model (ggml) | huggingface.co/ggerganov/whisper.cpp `ggml-base.en.bin`, SHA-256 a03779c8…6c6d002 | base.en | MIT (OpenAI Whisper weights) | Speech recognition model (models/whisper) |
| Kokoro-82M voice model (int8 ONNX) + voices | github.com/thewh1teagle/kokoro-onnx release model-files-v1.0 (`kokoro-v1.0.int8.onnx` SHA-256 6e742170…f6406cb, `voices-v1.0.bin` bca610b8…f1fbf7d); weights from hexgrad/Kokoro-82M | v1.0 | Apache-2.0 | JARVIS voice (British male voices bm_george/lewis/fable/daniel), models/kokoro |
| kokoro-onnx | PyPI | 0.6.1 | MIT | Runs the Kokoro model in the voice helper (sidecar/.venv) |
| onnxruntime | PyPI | 1.31.1 | MIT | Model runtime in the voice helper |
| numpy | PyPI | 2.5.4 | BSD-3-Clause and others | Audio arrays in the voice helper |
| phonemizer | PyPI | 3.6.0 | **GPL-3.0-or-later** | Text-to-pronunciation in the voice helper (separate process only, not linked into JARVIS) |
| espeak-ng (via espeakng-loader 0.2.4, MIT wrapper) | PyPI `espeakng-loader` (bundles espeak-ng.dll + data) | as bundled | **GPL-3.0** | Pronunciation rules for the voice helper (separate process only) |
| Vite, TypeScript, @vitejs/plugin-react | npm | 6.4.6 / 5.9.3 / 4.7.0 | MIT / Apache-2.0 / MIT | Build tools only (not shipped) |

GPL-3.0 components (phonemizer, espeak-ng) run only inside the separate voice helper process (sidecar/), which JARVIS talks to over a text pipe; they are not linked into the JARVIS executable. If JARVIS is ever distributed, ship the helper with its GPL source/notice obligations or swap in a non-GPL phonemiser.

Transitive Rust and npm dependencies keep their own licenses; a full generated list will be added before the first release build.

Reference repositories that were studied but not copied are listed in `docs/github-audit.md`.

## Online services (contacted only when asked)

| Service | Used for | Terms / licence | When it is contacted |
|---|---|---|---|
| Spotify Web API (accounts.spotify.com, api.spotify.com) | Starting the exact track, liked songs, playlists, shuffle, volume. Sign-in is Authorization Code + PKCE with the owner's own Client ID; no client secret. | Spotify Developer Terms | Only when you ask to play or control Spotify |
| YouTube Data API v3 (googleapis.com) | Finding the first video for "play ... on YouTube" | YouTube API Services Terms of Service | Only when you ask to play something on YouTube |
| NewsAPI.org / GNews.io / NewsData.io (whichever key the owner adds) | "News about ..." on any subject | The chosen provider's terms (free tiers are for personal, non-commercial use) | Only when you ask for news on a subject |
| MET Norway api.met.no | Weather | CC BY 4.0 | Only when you ask for the weather |
| OpenStreetMap Nominatim | Finding a place for the weather | ODbL | Only when you name a place |
| Google News search feed (news.google.com/rss) | Current headlines on a subject, and the notes the model answers from for questions about current things | Google News RSS terms (personal, non-commercial use; headlines and source names only) | Only when you ask about something current |
| DuckDuckGo HTML results (html.duckduckgo.com), Wikipedia search API as fallback | Web search for questions about current things; the top pages are then read directly from their own sites | No API or key. Personal use, at most one query every 2 s, honest User-Agent, no attempt to get round a block. DuckDuckGo does not offer this as a supported API, so it may stop working or be refused. Mojeek was tried and dropped: it answers automated clients with a captcha. | Only when a question needs the web (Settings: AUTO / OFF) |
| Wikipedia | Short facts | CC BY-SA 4.0 | Only when you ask who or what something is |

Spotify and YouTube are contacted only when you ask to play something. API keys and the Spotify sign-in are encrypted
with Windows DPAPI in the app's local data folder on this PC; they are never logged and are sent only to their own service.
The awakening sound is synthesised by JARVIS itself; no film audio or actor's voice is included.
