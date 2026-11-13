use std::path::PathBuf;

fn main() {
    // Vosk: link against the prebuilt libvosk (models/vosk-lib, Apache-2.0) and put its DLLs next to the exe.
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let vosk = manifest.join("../../../models/vosk-lib/vosk-win64-0.3.45");
    if vosk.join("libvosk.lib").exists() {
        println!("cargo:rustc-link-search=native={}", vosk.display());
        // target/<profile>/ is three levels above OUT_DIR (target/<profile>/build/<pkg>/out)
        let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        if let Some(profile_dir) = out.ancestors().nth(3) {
            for dll in ["libvosk.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"] {
                let _ = std::fs::copy(vosk.join(dll), profile_dir.join(dll));
            }
        }
    } else {
        println!("cargo:warning=libvosk not found at {} (run the speech model download first)", vosk.display());
    }
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
