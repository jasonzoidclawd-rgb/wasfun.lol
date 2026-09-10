//! Overlay window behavior.
//!
//! The overlay must be a transparent, click-through, non-activating surface that
//! sits above the League game window while League is the foreground owner, and
//! must NOT remain globally topmost over unrelated applications when the user
//! switches away. macOS achieves this with cocoa window levels + collection
//! behavior (see `lib.rs` setup); this module is the Windows equivalent, plus
//! the pure policy math both platforms' tests exercise.
//!
//! The bit-flag math and the topmost policy are platform-agnostic and unit
//! tested on every host. The actual Win32 calls live behind
//! `#[cfg(target_os = "windows")]` and are the only non-portable surface.

/// Win32 `WS_EX_*` extended-style bits the overlay cares about. Declared here as
/// plain `u32` so the policy is testable without the `windows` crate; the
/// `#[cfg(windows)]` code below asserts these equal the crate's constants.
pub mod ex_style {
    pub const TOPMOST: u32 = 0x0000_0008;
    pub const TRANSPARENT: u32 = 0x0000_0020;
    pub const TOOLWINDOW: u32 = 0x0000_0080;
    pub const LAYERED: u32 = 0x0008_0000;
    pub const NOACTIVATE: u32 = 0x0800_0000;
}

/// Extended styles the overlay always asserts, independent of click-through:
/// - `TOOLWINDOW`  — kept out of the Alt+Tab switcher and taskbar navigation;
/// - `LAYERED`     — required for per-pixel transparency compositing;
/// - `NOACTIVATE`  — the overlay never takes focus or steals activation.
const ALWAYS_ON: u32 = ex_style::TOOLWINDOW | ex_style::LAYERED | ex_style::NOACTIVATE;

/// Compute the overlay's extended window style from its current `base` style.
///
/// The always-on bits are OR-ed in every time (WebView2 can reset them). The
/// `TRANSPARENT` bit — which makes the window pass mouse input through to the
/// game — is set when `click_through` is true and cleared when false, so the
/// same function drives both the initial styling and `set_click_through`
/// toggles. No other bits the caller already had are disturbed.
pub fn overlay_ex_style(base: u32, click_through: bool) -> u32 {
    let with_always_on = base | ALWAYS_ON;
    if click_through {
        with_always_on | ex_style::TRANSPARENT
    } else {
        with_always_on & !ex_style::TRANSPARENT
    }
}

/// Whether the overlay should currently be the topmost window.
///
/// It is topmost ONLY while the League game window is the foreground owner, so
/// it never floats over unrelated applications after an Alt+Tab. Content
/// visibility (which badges to draw) is owned by the frontend; this governs the
/// native z-order alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Topmost {
    Topmost,
    NotTopmost,
}

pub fn overlay_topmost(game_window_foreground: bool) -> Topmost {
    if game_window_foreground {
        Topmost::Topmost
    } else {
        Topmost::NotTopmost
    }
}

// ─── Windows application (narrow, non-portable) ──────────────────────────────

#[cfg(target_os = "windows")]
pub use windows_impl::{apply_overlay_ex_styles, apply_overlay_topmost, set_process_dpi_aware_v2};

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{ex_style, overlay_ex_style, overlay_topmost, Topmost};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST,
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WINDOW_EX_STYLE,
    };

    /// Compile-time proof the portable bit constants match the `windows` crate,
    /// so the pure policy tests actually describe the applied styles.
    const _: () = {
        assert!(ex_style::TRANSPARENT == WINDOW_EX_STYLE_TRANSPARENT);
        assert!(ex_style::NOACTIVATE == WINDOW_EX_STYLE_NOACTIVATE);
        assert!(ex_style::TOOLWINDOW == WINDOW_EX_STYLE_TOOLWINDOW);
        assert!(ex_style::LAYERED == WINDOW_EX_STYLE_LAYERED);
    };
    // The crate exports these as `WINDOW_EX_STYLE(u32)`; pull the raw bits for
    // the const assertion above.
    const WINDOW_EX_STYLE_TRANSPARENT: u32 =
        windows::Win32::UI::WindowsAndMessaging::WS_EX_TRANSPARENT.0;
    const WINDOW_EX_STYLE_NOACTIVATE: u32 =
        windows::Win32::UI::WindowsAndMessaging::WS_EX_NOACTIVATE.0;
    const WINDOW_EX_STYLE_TOOLWINDOW: u32 =
        windows::Win32::UI::WindowsAndMessaging::WS_EX_TOOLWINDOW.0;
    const WINDOW_EX_STYLE_LAYERED: u32 = windows::Win32::UI::WindowsAndMessaging::WS_EX_LAYERED.0;

    /// Make the process per-monitor-DPI-aware (V2) before any window geometry is
    /// read. Called first thing in `run()`; if the OS already set awareness
    /// (e.g. a manifest), this is a harmless no-op that returns an error we
    /// ignore.
    pub fn set_process_dpi_aware_v2() {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }

    /// Apply the overlay's extended styles to `hwnd`, toggling click-through.
    pub fn apply_overlay_ex_styles(hwnd: HWND, click_through: bool) {
        unsafe {
            let base = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let next = overlay_ex_style(base, click_through);
            if next != base {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
            }
        }
    }

    /// Set the overlay's z-order per the foreground policy, never activating it.
    pub fn apply_overlay_topmost(hwnd: HWND, game_window_foreground: bool) {
        let insert_after = match overlay_topmost(game_window_foreground) {
            Topmost::Topmost => HWND_TOPMOST,
            Topmost::NotTopmost => HWND_NOTOPMOST,
        };
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(insert_after),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ex_style, overlay_ex_style, overlay_topmost, Topmost};

    #[test]
    fn always_on_bits_are_present_regardless_of_click_through() {
        for click_through in [true, false] {
            let style = overlay_ex_style(0, click_through);
            assert_ne!(
                style & ex_style::TOOLWINDOW,
                0,
                "tool-window kept out of Alt+Tab"
            );
            assert_ne!(
                style & ex_style::LAYERED,
                0,
                "layered required for transparency"
            );
            assert_ne!(style & ex_style::NOACTIVATE, 0, "overlay never activates");
        }
    }

    #[test]
    fn click_through_sets_the_transparent_bit_only_when_enabled() {
        assert_ne!(overlay_ex_style(0, true) & ex_style::TRANSPARENT, 0);
        assert_eq!(overlay_ex_style(0, false) & ex_style::TRANSPARENT, 0);
    }

    #[test]
    fn toggling_click_through_off_clears_a_previously_set_transparent_bit() {
        let on = overlay_ex_style(0, true);
        assert_ne!(on & ex_style::TRANSPARENT, 0);
        // Feed the click-through style back in with click_through=false: the
        // transparent bit must clear while the always-on bits stay.
        let off = overlay_ex_style(on, false);
        assert_eq!(off & ex_style::TRANSPARENT, 0);
        assert_ne!(off & ex_style::NOACTIVATE, 0);
        assert_ne!(off & ex_style::TOOLWINDOW, 0);
    }

    #[test]
    fn unrelated_pre_existing_bits_are_preserved() {
        // A caller-owned bit outside our set (e.g. WS_EX_CLIENTEDGE 0x200).
        let foreign = 0x0000_0200u32;
        let style = overlay_ex_style(foreign, true);
        assert_ne!(style & foreign, 0, "foreign style bits must survive");
    }

    #[test]
    fn overlay_is_topmost_only_when_league_is_foreground() {
        assert_eq!(overlay_topmost(true), Topmost::Topmost);
        assert_eq!(overlay_topmost(false), Topmost::NotTopmost);
    }
}
