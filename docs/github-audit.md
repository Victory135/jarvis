# GitHub reuse audit — HUD reference repositories

Audited 2026-11-09. Each repo was shallow-cloned into an isolated temp folder. **Nothing was installed or run**:
no `npm install` and no scripts. Vulnerability counts come from `npm audit --package-lock-only` against each
repo's own lockfile.

## Summary

| Repo | Commit (pinned) | Real license | Data | Stack | Decision |
|---|---|---|---|---|---|
| Davood121/jenman | `5a19ab9a` (2026-07-27) | **MIT** (LICENSE file, © 2025 Shaik Davood) | **Simulated**: CPU/RAM/power use `Math.random()` drift, canned replies | React + Vite + shadcn (Replit template) | Visual reference. Port small pieces only, with notice |
| jonnysmillie/astro-sci-fi-ui | `1a529d5f` (2026-10-23) | **MIT** (© 2026 Sci-Fi UI contributors) | Mostly real/demo; calls Open-Meteo, OSM/Carto tiles, Google Fonts, TF.js CDN | Astro + React islands | Port HUD primitives (corners, frame, reticle, scanlines, radar, tokens), with notice |
| phillwarren/jarvis-hud | `6a85b108` (2026-06-24) | **None** (no LICENSE; `Cargo.toml license = ""`) → all rights reserved | **Real** telemetry via Rust `sysinfo` | **Tauri 2** + React (closest to our stack) | **Study only. Copy no code.** |
| ehteshambuildagents/jarvis | `3109e655` (2026-09-25) | **Unclear**: LICENSE file is empty (2 bytes), GitHub says NOASSERTION; README claims MIT. Upstream `adewaskar/jarvis` is MIT | Real voice/vision; cloud-dependent | React + Three.js + Node bridge | Study only. If anything is ported, take it from MIT upstream `adewaskar/jarvis` |
| forcetrainer/nexus-ui | `12168299` (2026-01-25) | **PolyForm Noncommercial 1.0.0** | Demo data (16 `Math.random` uses) | React component lib | **Excluded** |

## Findings per repo

### Davood121/jenman — MIT
- `artifacts/jarvis/src/hooks/use-jarvis-system.ts` fakes CPU, memory, power and agent load with random walks,
  and picks replies at random from a fixed list. This breaks blueprint rules UI-03 and UI-05, so none of this logic can be reused.
- Heavy Replit/shadcn scaffold (~45 Radix packages, Replit vite plugins). Only `AiCore.tsx`, `SystemPanel.tsx` and
  `TopBar.tsx` are of visual interest.
- No lockfile, so no vulnerability audit was possible. The api-server build lists `@sentry/profiling-node` only as an
  esbuild external, not active telemetry.
- **Use:** geometry/visual ideas for the reactor; any copied file keeps the MIT notice.

### jonnysmillie/astro-sci-fi-ui — MIT
- Clean, documented primitives: `HudCorners`, `HudFrame`, `HudReticle`, `HudTicker`, `Scanlines`, `Radar`,
  `styles/tokens.css`. They are `.astro` files, so they need porting to React. Don't import the Astro app.
- External network: Google Fonts (Orbitron, Share Tech Mono), Open-Meteo, OSM/Carto/OpenTopoMap tiles, YouTube embed,
  TensorFlow.js + COCO-SSD from Google CDN. **None of these will be carried over.** Fonts will be bundled locally.
- Lockfile audit: 19 vulnerabilities (2 critical, 14 high). They're in its own dependency tree; we won't inherit them because we
  install nothing from it.

### phillwarren/jarvis-hud — NO LICENSE
- The best architectural match: Tauri 2, `sysinfo` 0.32 for real CPU/RAM/disk, tray icon, autostart plugin, boot
  sequence, reactor, radial gauges.
- **No license means no permission to copy.** We can learn the approach (sysinfo crate, tray, autostart) and write
  our own implementation.
- Security issue we must not repeat: `open_target(target)` runs `cmd /C start "" <target>` with an arbitrary
  string from the UI (command-injection risk). `power_action` can shut down with no delay. Our tools will use
  allowlisted IDs per blueprint section 10.
- Calls Notion API with a token from `.env` / a text file in the config dir. Our version stores secrets in Windows Credential Manager.
- Lockfile audit: 8 vulnerabilities (5 high).

### ehteshambuildagents/jarvis — license unclear
- Most advanced visuals (Three.js scene, particles, post-processing, MediaPipe hand gestures).
- **Not local-first:** depends on Anthropic cloud API + Claude Agent SDK, ElevenLabs, Picovoice Porcupine (needs a
  proprietary AccessKey). This conflicts with blueprint rules 6–8. Kokoro-js (local TTS) is worth noting as an
  optional voice later.
- Bridge server binds `127.0.0.1` (good). Ships Kevin MacLeod music under CC-BY 4.0 (attribution required).
- Three.js + post-processing is likely too heavy for Intel HD 520. The blueprint also says Three.js is allowed only after profiling.
- Lockfile audit: 15 vulnerabilities (2 critical, 8 high).

### forcetrainer/nexus-ui — PolyForm Noncommercial
- Nice widgets (Gauge, RadarScan, Waveform, Sparkline), but the license forbids commercial use. **Excluded entirely** so
  JARVIS stays free to distribute.

## Decision

1. **Write the HUD ourselves** in React + TypeScript + SVG/Canvas, with original geometry and assets.
2. **May port, with MIT notice:** small HUD primitives from astro-sci-fi-ui, plus reactor ideas from jenman. Every
   ported file gets a header comment naming the source repo, commit SHA and license, and an entry in
   `THIRD_PARTY_NOTICES.md`.
3. **Study only:** phillwarren/jarvis-hud (Tauri + sysinfo + tray pattern) and ehteshambuildagents/jarvis.
4. **Exclude:** nexus-ui.
5. Our own dependencies get a fresh `npm audit` / `cargo audit` once the project is set up. The lockfile
   counts above are informational only.

## Our telemetry plan (replaces the simulated data)
- CPU / RAM / disk / network throughput: Rust `sysinfo` crate (MIT), our own Tauri commands, sampled every 1–2 s with a stale marker.
- Battery: Windows `GetSystemPowerStatus`.
- Wi-Fi / Bluetooth state: Windows APIs (read-only first), with an honest "unavailable" state.
- Microphone waveform: Web Audio `AnalyserNode` (aggregate levels only, nothing recorded).
