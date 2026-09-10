//! Development probe: prints one full foreground poll diagnostic as JSON —
//! every CGWindowList candidate with its exclusion verdict, the NSWorkspace
//! value, the selected z-order authority, and the final classification.
//!
//! Run with: cargo run --example foreground_probe
//! Cargo examples are never part of a shipped artifact.

fn main() {
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        let diagnostic = mayhem_oracle_lib::foreground_poll_diagnostic();
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnostic).expect("serialize diagnostic")
        );
    }
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    eprintln!("foreground_probe is macOS debug-only");
}
