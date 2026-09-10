//! Pure League game-window selection, shared by every platform.
//!
//! `lib.rs::find_league_window` enumerates on-screen windows through `xcap`
//! (cross-platform, read-only) and hands the reduced candidates here. Keeping
//! the selection logic pure makes the launcher-vs-game, overlay-self, minimized
//! and too-small rejections testable without a live desktop.

use crate::calibration::Rect;
use crate::foreground::is_actual_game_window;

/// The smallest window we will ever treat as the game viewport. The League
/// launcher/client and stray helper windows fall below this; a real game
/// surface is always at least 640×480.
pub const MIN_GAME_WINDOW_WIDTH: u32 = 640;
pub const MIN_GAME_WINDOW_HEIGHT: u32 = 480;

/// One on-screen window reduced to the fields selection needs.
#[derive(Clone, Debug)]
pub struct WindowCandidate {
    pub app_name: String,
    pub title: String,
    pub rect: Rect,
    pub minimized: bool,
    /// True when this window belongs to the overlay's own process — it must
    /// never be selected as the game window.
    pub is_own_overlay: bool,
}

/// Reasons a candidate is not the game window (index-aligned diagnostics).
pub const REASON_MINIMIZED: &str = "minimized";
pub const REASON_OWN_OVERLAY: &str = "own-overlay";
pub const REASON_NOT_GAME_WINDOW: &str = "not-game-window";
pub const REASON_TOO_SMALL: &str = "too-small";
pub const REASON_SELECTED: &str = "selected";

fn rejection(candidate: &WindowCandidate) -> Option<&'static str> {
    if candidate.minimized {
        return Some(REASON_MINIMIZED);
    }
    if candidate.is_own_overlay {
        return Some(REASON_OWN_OVERLAY);
    }
    if !is_actual_game_window(&candidate.app_name, &candidate.title) {
        // The League launcher/LeagueClientUx window is rejected here: its title
        // is not the "(TM) Client" game title `is_actual_game_window` requires.
        return Some(REASON_NOT_GAME_WINDOW);
    }
    if candidate.rect.width < MIN_GAME_WINDOW_WIDTH
        || candidate.rect.height < MIN_GAME_WINDOW_HEIGHT
    {
        return Some(REASON_TOO_SMALL);
    }
    None
}

/// Pick the largest eligible game window. Returns `None` when no candidate is
/// the actual game surface. Ties break toward the first candidate (stable).
pub fn select_league_window(candidates: &[WindowCandidate]) -> Option<Rect> {
    candidates
        .iter()
        .filter(|candidate| rejection(candidate).is_none())
        .max_by_key(|candidate| candidate.rect.width as u64 * candidate.rect.height as u64)
        .map(|candidate| candidate.rect.clone())
}

/// Per-candidate verdicts, index-aligned, for development diagnostics.
pub fn selection_verdicts(candidates: &[WindowCandidate]) -> Vec<&'static str> {
    let winner = select_league_window(candidates);
    candidates
        .iter()
        .map(|candidate| match rejection(candidate) {
            Some(reason) => reason,
            None if Some(&candidate.rect) == winner.as_ref() => REASON_SELECTED,
            // Eligible but out-competed on area.
            None => "behind-selection",
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn game(width: u32, height: u32) -> WindowCandidate {
        WindowCandidate {
            app_name: "League of Legends".to_string(),
            title: "League of Legends (TM) Client".to_string(),
            rect: rect(0, 0, width, height),
            minimized: false,
            is_own_overlay: false,
        }
    }

    #[test]
    fn selects_the_actual_game_window() {
        let selected = select_league_window(&[game(1920, 1080)]);
        assert_eq!(selected, Some(rect(0, 0, 1920, 1080)));
    }

    #[test]
    fn rejects_the_league_launcher_client_window() {
        // LeagueClientUx presents as "League of Legends" but its title is not
        // the game's "(TM) Client" — it must be rejected, leaving no selection.
        let launcher = WindowCandidate {
            title: "League of Legends".to_string(),
            ..game(1024, 576)
        };
        assert_eq!(select_league_window(&[launcher]), None);
    }

    #[test]
    fn never_selects_the_overlays_own_window() {
        let own = WindowCandidate {
            app_name: "Mayhem Oracle".to_string(),
            title: "Mayhem Oracle".to_string(),
            is_own_overlay: true,
            ..game(1920, 1080)
        };
        assert_eq!(select_league_window(&[own]), None);
    }

    #[test]
    fn rejects_a_minimized_game_window() {
        let minimized = WindowCandidate {
            minimized: true,
            ..game(1920, 1080)
        };
        assert_eq!(select_league_window(&[minimized]), None);
    }

    #[test]
    fn rejects_a_too_small_window() {
        assert_eq!(select_league_window(&[game(320, 240)]), None);
        // Exactly at the floor is accepted.
        assert_eq!(
            select_league_window(&[game(640, 480)]),
            Some(rect(0, 0, 640, 480))
        );
    }

    #[test]
    fn picks_the_largest_when_several_game_windows_exist() {
        let small = WindowCandidate {
            rect: rect(0, 0, 1280, 720),
            ..game(1280, 720)
        };
        let large = WindowCandidate {
            rect: rect(100, 100, 2560, 1440),
            ..game(2560, 1440)
        };
        assert_eq!(
            select_league_window(&[small, large]),
            Some(rect(100, 100, 2560, 1440))
        );
    }

    #[test]
    fn ignores_the_launcher_and_overlay_while_selecting_the_game() {
        let launcher = WindowCandidate {
            title: "League of Legends".to_string(),
            ..game(1024, 576)
        };
        let overlay = WindowCandidate {
            is_own_overlay: true,
            ..game(3840, 2160)
        };
        let candidates = vec![launcher, overlay, game(1920, 1080)];
        assert_eq!(
            select_league_window(&candidates),
            Some(rect(0, 0, 1920, 1080))
        );
        let verdicts = selection_verdicts(&candidates);
        assert_eq!(verdicts[0], REASON_NOT_GAME_WINDOW);
        assert_eq!(verdicts[1], REASON_OWN_OVERLAY);
        assert_eq!(verdicts[2], REASON_SELECTED);
    }
}
