# Vendored whisper-rs-sys 0.15.0 (MIT / Unlicense, see upstream)

Copied unchanged from crates.io except `src/bindings.rs`: three compile-time layout checks for the C library's
`FILE` / `fpos_t` structs were removed. The bundled bindings were generated on Linux (glibc), so those checks fail on
Windows (MSVC). JARVIS never uses those types. Everything else, including the whisper.cpp sources, is unmodified.
Remove this vendored copy once upstream ships Windows-compatible bundled bindings, or once libclang is available
to generate bindings at build time.

Second change in `src/bindings.rs`: C enum typedefs (types that have `<type>_*` constants) are `c_int` instead of
`c_uint`. MSVC treats C enums as signed `int`, which is what bindgen emits on Windows and what whisper-rs expects
there; the Linux-generated file had `c_uint`. Values are unchanged (all fit in i32).
- `build.rs`: also re-runs when `src/bindings.rs` changes.

JARVIS change (2026-11-11): build.rs sets /O2 and GGML_AVX2/FMA/F16C explicitly on Windows; without it the MSVC build came out unoptimised.
