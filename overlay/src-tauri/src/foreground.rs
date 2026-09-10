use serde::{Deserialize, Serialize};

pub const LEAGUE_GAME_BUNDLE_ID: &str = "com.riotgames.LeagueofLegends.GameClient";
pub const LEAGUE_CLIENT_UX_BUNDLE_ID: &str = "com.riotgames.LeagueofLegends.LeagueClientUx";
pub const RIOT_CLIENT_BUNDLE_ID: &str = "com.riotgames.RiotGames.RiotClient";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundState {
    pub game_window_foreground: bool,
    pub league_client_foreground: bool,
    pub riot_client_foreground: bool,
    /// DIAGNOSTIC ONLY, and bounded-stale by design: this is served from a 5 s
    /// presence cache (`PROCESS_PRESENCE_TTL`) because enumerating the process
    /// table on every poll was the dominant cost of the foreground path.
    /// `classify_foreground` deliberately does NOT read it when computing
    /// `game_window_foreground`, and the visual gate is
    /// `gameWindowForeground || previewMode`, so this value authorizes nothing —
    /// which is precisely what makes caching it safe. Do not promote it into an
    /// authority without removing the cache first.
    pub game_running: bool,
    pub game_window_detected: bool,
    pub foreground_app_name: Option<String>,
    pub foreground_bundle_identifier: Option<String>,
    pub foreground_owner_name: Option<String>,
    pub foreground_window_title: Option<String>,
    pub foreground_executable_path: Option<String>,
    pub foreground_window_handle: Option<u64>,
}

pub struct ForegroundObservation<'a> {
    pub app_name: Option<&'a str>,
    pub bundle_identifier: Option<&'a str>,
    pub owner_name: Option<&'a str>,
    pub window_title: Option<&'a str>,
    pub executable_path: Option<&'a str>,
    pub window_handle: Option<u64>,
    pub game_running: bool,
    pub game_window_detected: bool,
}

pub fn classify_foreground(observation: ForegroundObservation<'_>) -> ForegroundState {
    let app_name = observation.app_name.map(normalize_identity);
    let game_bundle = observation
        .bundle_identifier
        .is_some_and(|bundle| bundle.eq_ignore_ascii_case(LEAGUE_GAME_BUNDLE_ID));
    let riot_client_bundle = observation
        .bundle_identifier
        .is_some_and(|bundle| bundle.eq_ignore_ascii_case(RIOT_CLIENT_BUNDLE_ID));
    let league_client_ux_bundle = observation
        .bundle_identifier
        .is_some_and(|bundle| bundle.eq_ignore_ascii_case(LEAGUE_CLIENT_UX_BUNDLE_ID));
    let riot_client_app = app_name.as_deref() == Some("riotclient");
    let league_client_ux_app = app_name.as_deref() == Some("leagueclientux");
    // When the OS gives us an executable path, it is authoritative. A generic
    // "League of Legends" application name must not override a known client
    // executable during the postgame/client transition.
    let game_process = observation
        .executable_path
        .map(|path| is_actual_game_process("", Some(path)))
        .unwrap_or_else(|| {
            observation
                .app_name
                .is_some_and(|name| is_actual_game_process(name, None))
        });
    let riot_client_process = observation
        .executable_path
        .map(|path| is_riot_client_process("", Some(path)))
        .unwrap_or_else(|| {
            observation
                .app_name
                .is_some_and(|name| is_riot_client_process(name, None))
        });
    let league_client_ux_process = observation
        .executable_path
        .map(|path| is_league_client_ux_process("", Some(path)))
        .unwrap_or_else(|| {
            observation
                .app_name
                .is_some_and(|name| is_league_client_ux_process(name, None))
        });
    let game_window = observation
        .owner_name
        .zip(observation.window_title)
        .is_some_and(|(owner, title)| is_actual_game_window(owner, title));
    let riot_client_window = observation
        .owner_name
        .is_some_and(|owner| normalize_identity(owner) == "riotclient");
    let league_client_foreground = league_client_ux_bundle
        || league_client_ux_app
        || league_client_ux_process
        || riot_client_bundle
        || riot_client_app
        || riot_client_process
        || riot_client_window;

    ForegroundState {
        game_window_foreground: (game_bundle || game_window || game_process)
            && !riot_client_bundle
            && !league_client_ux_bundle
            && !riot_client_app
            && !league_client_ux_app
            && !riot_client_window
            && !riot_client_process
            && !league_client_ux_process,
        league_client_foreground,
        riot_client_foreground: riot_client_bundle
            || riot_client_app
            || riot_client_process
            || riot_client_window,
        game_running: observation.game_running,
        game_window_detected: observation.game_window_detected,
        foreground_app_name: observation.app_name.map(str::to_string),
        foreground_bundle_identifier: observation.bundle_identifier.map(str::to_string),
        foreground_owner_name: observation.owner_name.map(str::to_string),
        foreground_window_title: observation.window_title.map(str::to_string),
        foreground_executable_path: observation.executable_path.map(str::to_string),
        foreground_window_handle: observation.window_handle,
    }
}

/// Effective frontmost PID on macOS.
///
/// `NSWorkspace.frontmostApplication` read outside the main thread can return
/// a value that is seconds STALE — or frozen indefinitely (observed: it kept
/// reporting the game process 18s+ after Terminal took focus, and in the
/// 18:53 retest the inverse froze every surface off during a live game). The
/// z-order authority from `CGWindowList` is always fresh and thread-safe, so
/// it decides whenever a candidate window exists; the workspace value is only
/// a fallback when the window list yields NO candidate at all. A cached
/// NSWorkspace result must never override fresher CGWindowList evidence.
pub fn effective_frontmost_pid(
    zorder_authority_pid: Option<u32>,
    workspace_frontmost_pid: Option<u32>,
) -> Option<u32> {
    zorder_authority_pid.or(workspace_frontmost_pid)
}

/// One on-screen window from the front-to-back `CGWindowList` walk, reduced
/// to the fields the selector needs. `is_game_process` must come from the
/// owner PID's process identity (bundle identifier / executable path) — NEVER
/// from the window title or owner name: the real macOS game window has an
/// EMPTY title (observed live), and LeagueClientUx's window owner name is
/// "League of Legends", indistinguishable from the game's "League Of Legends"
/// after normalization.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCandidate {
    pub window_number: Option<i32>,
    pub layer: Option<i32>,
    pub alpha: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub process_id: Option<u32>,
    pub owner_name: Option<String>,
    pub title: Option<String>,
    pub is_own_process: bool,
    pub is_game_process: bool,
}

pub struct ZOrderSelection {
    pub selected_index: Option<usize>,
    /// One verdict per candidate, index-aligned: "selected" or the exclusion
    /// reason.
    pub verdicts: Vec<&'static str>,
    pub reason: &'static str,
}

fn candidate_exclusion(candidate: &WindowCandidate) -> Option<&'static str> {
    if candidate.is_own_process {
        // The overlay's own windows sit at level 2147483639 on every Space
        // (observed) — always first in the walk, never the authority.
        return Some("own-process");
    }
    if candidate.process_id.is_none() {
        return Some("no-owner-pid");
    }
    if candidate.alpha.is_some_and(|alpha| alpha < 0.01) {
        return Some("transparent");
    }
    if candidate.width < 2.0 || candidate.height < 2.0 {
        // The live game keeps a degenerate 1x2 helper window (observed);
        // zero-area surfaces are never what the user is looking at.
        return Some("zero-area");
    }
    match candidate.layer {
        Some(0) => None,
        // A fullscreen/borderless game surface may sit at an elevated window
        // level (covering the menu bar). The game process is the ONLY owner
        // allowed to grant foreground from a non-zero layer; everything else
        // up there is system chrome (menu-bar/status items at 25, menubar at
        // 24, Window Server cursor, Dock, notifications, tooltips).
        _ if candidate.is_game_process => None,
        _ => Some("non-app-layer"),
    }
}

/// Walk candidates front-to-back and pick the first app-level window: the
/// topmost layer-0 window, or the game's own surface at any layer. Returns
/// index-aligned verdicts for the development diagnostic.
pub fn select_frontmost_window(candidates: &[WindowCandidate]) -> ZOrderSelection {
    let mut selected_index = None;
    let mut verdicts = Vec::with_capacity(candidates.len());
    for (index, candidate) in candidates.iter().enumerate() {
        if selected_index.is_some() {
            verdicts.push("behind-selection");
            continue;
        }
        match candidate_exclusion(candidate) {
            Some(reason) => verdicts.push(reason),
            None => {
                selected_index = Some(index);
                verdicts.push("selected");
            }
        }
    }
    let reason = match selected_index {
        Some(index) if candidates[index].layer != Some(0) => "zorder-game-window-elevated-layer",
        Some(index) if candidates[index].is_game_process => "zorder-game-window",
        Some(_) => "zorder-topmost-app-window",
        None => "no-zorder-candidates",
    };
    ZOrderSelection {
        selected_index,
        verdicts,
        reason,
    }
}

/// Process-identity game check for window OWNERS: bundle identifier or
/// executable path only. Display/owner names are ambiguous between the game
/// and LeagueClientUx (observed) and must not grant game identity here.
pub fn is_game_owner(bundle_identifier: Option<&str>, executable_path: Option<&str>) -> bool {
    bundle_identifier.is_some_and(|bundle| bundle.eq_ignore_ascii_case(LEAGUE_GAME_BUNDLE_ID))
        || executable_path.is_some_and(|path| is_actual_game_process("", Some(path)))
}

pub fn is_actual_game_window(owner_name: &str, title: &str) -> bool {
    let owner = normalize_identity(owner_name);
    let title = normalize_identity(title);

    (owner == "leagueoflegends" || owner == "leagueoflegendsgameclient")
        && title.contains("leagueoflegends")
        && title.contains("client")
        && !title.contains("leagueclientux")
}

pub fn is_actual_game_process(name: &str, executable_path: Option<&str>) -> bool {
    if let Some(path) = executable_path {
        let path = path.replace('\\', "/").to_lowercase();
        return path.contains("/game/leagueoflegends.app/contents/macos/leagueoflegends")
            || path.ends_with("/game/league of legends.exe");
    }

    let normalized_name = normalize_identity(name);
    normalized_name == "leagueoflegends" || normalized_name == "leagueoflegendsexe"
}

pub fn is_riot_client_process(name: &str, executable_path: Option<&str>) -> bool {
    if let Some(path) = executable_path {
        let path = path.replace('\\', "/").to_lowercase();
        return path.contains("/riot client.app/contents/macos/riotclient")
            || path.ends_with("/riotclientservices.exe");
    }

    let normalized_name = normalize_identity(name);
    normalized_name == "riotclientservices" || normalized_name == "riotclientservicesexe"
}

pub fn is_league_client_ux_process(name: &str, executable_path: Option<&str>) -> bool {
    if let Some(path) = executable_path {
        let path = path.replace('\\', "/").to_lowercase();
        return path.contains("/leagueclientux.app/contents/macos/leagueclientux")
            || path.ends_with("/leagueclientux.exe");
    }

    let normalized_name = normalize_identity(name);
    normalized_name == "leagueclientux" || normalized_name == "leagueclientuxexe"
}

fn normalize_identity(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        classify_foreground, effective_frontmost_pid, is_actual_game_process,
        is_actual_game_window, is_game_owner, is_league_client_ux_process, is_riot_client_process,
        select_frontmost_window, ForegroundObservation, WindowCandidate,
        LEAGUE_CLIENT_UX_BUNDLE_ID, LEAGUE_GAME_BUNDLE_ID, RIOT_CLIENT_BUNDLE_ID,
    };

    fn candidate(layer: i32, pid: u32, owner: &str, width: f64, height: f64) -> WindowCandidate {
        WindowCandidate {
            window_number: None,
            layer: Some(layer),
            alpha: Some(1.0),
            width,
            height,
            process_id: Some(pid),
            owner_name: Some(owner.to_string()),
            title: None,
            is_own_process: false,
            is_game_process: false,
        }
    }

    /// The observed 2026-07-17 desktop walk, verbatim shape: overlay window
    /// (own, level 2147483639), Window Server cursor, menu-bar status items
    /// at layer 25 (including a "Riot Client" status item), the menubar at
    /// 24, then layer-0 app windows front-to-back.
    fn observed_desktop_walk() -> Vec<WindowCandidate> {
        let own = WindowCandidate {
            is_own_process: true,
            ..candidate(2147483639, 999, "mayhem-oracle-overlay", 1280.0, 720.0)
        };
        let game_small = WindowCandidate {
            is_game_process: true,
            ..candidate(0, 1427, "League Of Legends", 260.0, 265.0)
        };
        let game_degenerate = WindowCandidate {
            is_game_process: true,
            ..candidate(0, 1427, "League Of Legends", 1.0, 2.0)
        };
        vec![
            own,
            candidate(2147483630, 160, "Window Server", 12.0, 25.0),
            candidate(25, 67610, "Riot Client", 38.0, 24.0),
            candidate(25, 511, "控制中心", 38.0, 24.0),
            candidate(24, 160, "Window Server", 1280.0, 24.0),
            candidate(0, 482, "終端機", 1278.0, 665.0),
            candidate(0, 436, "Safari", 1280.0, 695.0),
            candidate(0, 78208, "League of Legends", 1024.0, 576.0), // LeagueClientUx
            game_small,
            game_degenerate,
        ]
    }

    #[test]
    fn own_overlay_window_is_never_the_foreground_authority() {
        let walk = observed_desktop_walk();
        let selection = select_frontmost_window(&walk);
        assert_eq!(selection.verdicts[0], "own-process");
        // Terminal (first layer-0 non-own window) is the authority.
        assert_eq!(selection.selected_index, Some(5));
        assert_eq!(walk[5].process_id, Some(482));
        assert_eq!(selection.reason, "zorder-topmost-app-window");
    }

    #[test]
    fn status_items_and_system_chrome_are_never_the_authority() {
        let selection = select_frontmost_window(&observed_desktop_walk());
        // Cursor, Riot Client status item, Control Center, menubar.
        assert_eq!(selection.verdicts[1], "non-app-layer");
        assert_eq!(selection.verdicts[2], "non-app-layer");
        assert_eq!(selection.verdicts[3], "non-app-layer");
        assert_eq!(selection.verdicts[4], "non-app-layer");
    }

    #[test]
    fn terminal_topmost_with_game_running_behind_selects_terminal() {
        // Required outcome 3: gameRunning=true in the background + Terminal
        // topmost → the selector returns Terminal and classification stays
        // false end-to-end.
        let walk = observed_desktop_walk();
        let selection = select_frontmost_window(&walk);
        let selected = &walk[selection.selected_index.expect("authority")];
        assert_eq!(selected.process_id, Some(482));

        let state = classify_foreground(ForegroundObservation {
            app_name: Some("終端機"),
            bundle_identifier: Some("com.apple.Terminal"),
            owner_name: selected.owner_name.as_deref(),
            window_title: None,
            executable_path: Some(
                "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
            ),
            window_handle: None,
            game_running: true,
            game_window_detected: true,
        });
        assert!(!state.game_window_foreground);
    }

    #[test]
    fn fullscreen_game_window_with_empty_title_is_the_authority_at_any_layer() {
        // Required outcome 4: the real game window carries an EMPTY title
        // (observed) and a borderless surface may sit at an elevated layer to
        // cover the menu bar. Both shapes must select the game.
        for layer in [0, 25, 101, 2147483629] {
            let game = WindowCandidate {
                is_game_process: true,
                title: Some(String::new()),
                ..candidate(layer, 1427, "League Of Legends", 1280.0, 720.0)
            };
            let walk = vec![game, candidate(0, 482, "終端機", 1278.0, 665.0)];
            let selection = select_frontmost_window(&walk);
            assert_eq!(selection.selected_index, Some(0), "layer {layer}");

            let state = classify_foreground(ForegroundObservation {
                app_name: Some("League Of Legends"),
                bundle_identifier: Some(LEAGUE_GAME_BUNDLE_ID),
                owner_name: Some("League Of Legends"),
                window_title: None,
                executable_path: Some(
                    "/Applications/League of Legends.app/Contents/LoL/Game/LeagueofLegends.app/Contents/MacOS/LeagueofLegends",
                ),
                window_handle: None,
                game_running: true,
                game_window_detected: true,
            });
            assert!(state.game_window_foreground, "layer {layer}");
        }
    }

    #[test]
    fn elevated_layer_grants_nothing_to_non_game_processes() {
        // Only the game process may claim foreground from a non-zero layer;
        // a non-game window up there (tooltip, notification, shield) is
        // skipped and the next layer-0 app decides.
        let walk = vec![
            candidate(101, 9000, "SomePopup", 400.0, 300.0),
            candidate(0, 482, "終端機", 1278.0, 665.0),
        ];
        let selection = select_frontmost_window(&walk);
        assert_eq!(selection.verdicts[0], "non-app-layer");
        assert_eq!(selection.selected_index, Some(1));
    }

    #[test]
    fn transparent_and_degenerate_windows_are_excluded() {
        let transparent = WindowCandidate {
            alpha: Some(0.0),
            ..candidate(0, 7000, "GhostApp", 800.0, 600.0)
        };
        let degenerate = WindowCandidate {
            is_game_process: true,
            ..candidate(0, 1427, "League Of Legends", 1.0, 2.0)
        };
        let walk = vec![
            transparent,
            degenerate,
            candidate(0, 482, "終端機", 1278.0, 665.0),
        ];
        let selection = select_frontmost_window(&walk);
        assert_eq!(selection.verdicts[0], "transparent");
        assert_eq!(selection.verdicts[1], "zero-area");
        assert_eq!(selection.selected_index, Some(2));
    }

    #[test]
    fn game_identity_comes_from_process_metadata_never_from_names() {
        // LeagueClientUx's window owner name is "League of Legends"
        // (observed) — indistinguishable from the game by name. Only bundle
        // or executable evidence may grant game identity.
        assert!(is_game_owner(Some(LEAGUE_GAME_BUNDLE_ID), None));
        assert!(is_game_owner(
            None,
            Some("/Applications/League of Legends.app/Contents/LoL/Game/LeagueofLegends.app/Contents/MacOS/LeagueofLegends"),
        ));
        assert!(!is_game_owner(
            Some("com.riotgames.LeagueofLegends.LeagueClientUx"),
            Some("/Applications/League of Legends.app/Contents/LoL/League of Legends.app/Contents/MacOS/LeagueClientUx"),
        ));
        assert!(!is_game_owner(None, None));
    }

    #[test]
    fn workspace_never_overrides_fresher_zorder_evidence() {
        // Required outcome 12: a (possibly frozen) NSWorkspace value claiming
        // the game must lose to a fresh z-order authority — in BOTH
        // directions.
        let walk = observed_desktop_walk();
        let selection = select_frontmost_window(&walk);
        let zorder = walk[selection.selected_index.unwrap()].process_id;
        assert_eq!(effective_frontmost_pid(zorder, Some(1427)), Some(482));
        assert_eq!(effective_frontmost_pid(Some(1427), Some(482)), Some(1427));
        // Workspace only decides when the walk yields nothing at all.
        assert_eq!(effective_frontmost_pid(None, Some(1427)), Some(1427));
    }

    fn observation<'a>(
        app_name: &'a str,
        bundle_identifier: &'a str,
        owner_name: &'a str,
        window_title: &'a str,
        game_running: bool,
    ) -> ForegroundObservation<'a> {
        ForegroundObservation {
            app_name: Some(app_name),
            bundle_identifier: Some(bundle_identifier),
            owner_name: Some(owner_name),
            window_title: Some(window_title),
            executable_path: None,
            window_handle: None,
            game_running,
            game_window_detected: game_running,
        }
    }

    #[test]
    fn actual_game_bundle_is_the_only_league_bundle_that_grants_focus() {
        let state = classify_foreground(observation(
            "League Of Legends",
            LEAGUE_GAME_BUNDLE_ID,
            "League Of Legends",
            "League of Legends (TM) Client",
            true,
        ));

        assert!(state.game_window_foreground);
        assert!(!state.riot_client_foreground);
        assert!(!state.league_client_foreground);
    }

    #[test]
    fn fullscreen_game_bundle_grants_focus_without_a_regular_window() {
        let state = classify_foreground(ForegroundObservation {
            app_name: Some("League Of Legends"),
            bundle_identifier: Some(LEAGUE_GAME_BUNDLE_ID),
            owner_name: None,
            window_title: None,
            executable_path: None,
            window_handle: None,
            game_running: true,
            game_window_detected: false,
        });

        assert!(state.game_window_foreground);
        assert!(!state.riot_client_foreground);
        assert!(!state.game_window_detected);
    }

    #[test]
    fn league_client_ux_is_not_the_game_foreground() {
        let state = classify_foreground(observation(
            "League of Legends",
            "com.riotgames.LeagueofLegends.LeagueClientUx",
            "League of Legends",
            "",
            true,
        ));

        assert!(!state.game_window_foreground);
        assert!(!state.riot_client_foreground);
        assert!(state.league_client_foreground);
        assert!(state.game_running);
    }

    #[test]
    fn riot_client_is_never_game_foreground_even_when_game_is_running() {
        let state = classify_foreground(observation(
            "Riot Client",
            RIOT_CLIENT_BUNDLE_ID,
            "Riot Client",
            "Riot Client",
            true,
        ));

        assert!(!state.game_window_foreground);
        assert!(state.riot_client_foreground);
        assert!(state.game_running);
    }

    #[test]
    fn unrelated_frontmost_apps_are_not_game_foreground() {
        for (name, bundle) in [
            ("Finder", "com.apple.finder"),
            ("Safari", "com.apple.Safari"),
            ("Terminal", "com.apple.Terminal"),
        ] {
            let state = classify_foreground(observation(name, bundle, name, name, true));
            assert!(!state.game_window_foreground, "{name} must stay hidden");
            assert!(!state.riot_client_foreground, "{name} is not Riot Client");
        }
    }

    #[test]
    fn zorder_topmost_window_overrides_a_stale_workspace_frontmost() {
        // Regression pin for the 13:33:54 leak: NSWorkspace kept returning the
        // game PID while Terminal's window was in front. The z-order topmost
        // layer-0 window is the authority whenever one exists.
        let game_pid = Some(4242);
        let terminal_pid = Some(7001);
        assert_eq!(
            effective_frontmost_pid(terminal_pid, game_pid),
            terminal_pid
        );
        assert_eq!(effective_frontmost_pid(game_pid, terminal_pid), game_pid);
    }

    #[test]
    fn workspace_frontmost_is_only_a_fallback_for_fullscreen_surfaces() {
        // A fullscreen Metal game owns no layer-0 CG window; only then does
        // the (possibly stale) workspace value decide.
        assert_eq!(effective_frontmost_pid(None, Some(4242)), Some(4242));
        assert_eq!(effective_frontmost_pid(None, None), None);
    }

    #[test]
    fn stale_game_process_metadata_never_survives_a_desktop_frontmost() {
        // End-to-end: once the z-order authority swaps the observation to the
        // desktop app, game_running=true alone must never keep surfaces
        // visible — for every desktop/client app we classify.
        for (name, bundle) in [
            ("Terminal", "com.apple.Terminal"),
            ("Finder", "com.apple.finder"),
            ("Safari", "com.apple.Safari"),
            ("Riot Client", RIOT_CLIENT_BUNDLE_ID),
            ("League Client UX", LEAGUE_CLIENT_UX_BUNDLE_ID),
        ] {
            let state = classify_foreground(ForegroundObservation {
                app_name: Some(name),
                bundle_identifier: Some(bundle),
                owner_name: Some(name),
                window_title: Some(name),
                executable_path: None,
                window_handle: None,
                game_running: true,
                game_window_detected: true,
            });
            assert!(
                !state.game_window_foreground,
                "{name} in front must hide every overlay surface",
            );
        }
    }

    #[test]
    fn game_window_title_can_confirm_game_when_bundle_metadata_is_missing() {
        assert!(is_actual_game_window(
            "League Of Legends",
            "League of Legends (TM) Client",
        ));
        assert!(!is_actual_game_window("League of Legends", ""));
    }

    #[test]
    fn game_process_detection_does_not_accept_the_client_process() {
        assert!(is_actual_game_process("LeagueofLegends", None));
        assert!(is_actual_game_process(
            "unknown",
            Some("/Applications/League of Legends.app/Contents/LoL/Game/LeagueofLegends.app/Contents/MacOS/LeagueofLegends"),
        ));
        assert!(!is_actual_game_process("LeagueClientUx", None));
        assert!(is_actual_game_process(
            "unknown",
            Some(r"C:\Riot Games\League of Legends\Game\League of Legends.exe"),
        ));
        assert!(!is_actual_game_process(
            "unknown",
            Some(r"C:\Riot Games\League of Legends\LeagueClientUx.exe"),
        ));
        assert!(!is_actual_game_process(
            "League Of Legends",
            Some(r"C:\Riot Games\League of Legends\LeagueClientUx.exe"),
        ));
        assert!(is_riot_client_process(
            "unknown",
            Some(r"C:\Riot Games\Riot Client\RiotClientServices.exe"),
        ));
        assert!(is_league_client_ux_process(
            "unknown",
            Some(r"C:\Riot Games\League of Legends\LeagueClientUx.exe"),
        ));
        assert!(is_riot_client_process(
            "Riot Client",
            Some("/Applications/Riot Client.app/Contents/MacOS/RiotClient"),
        ));
        assert!(is_league_client_ux_process(
            "League Of Legends",
            Some(
                "/Applications/League of Legends.app/Contents/LoL/LeagueClientUx.app/Contents/MacOS/LeagueClientUx",
            ),
        ));
    }

    #[test]
    fn known_client_executable_overrides_a_generic_league_app_name() {
        let state = classify_foreground(ForegroundObservation {
            app_name: Some("League Of Legends"),
            bundle_identifier: None,
            owner_name: Some("League Of Legends"),
            window_title: Some("League of Legends (TM) Client"),
            executable_path: Some(
                "/Applications/League of Legends.app/Contents/LoL/LeagueClientUx.app/Contents/MacOS/LeagueClientUx",
            ),
            window_handle: None,
            game_running: true,
            game_window_detected: true,
        });

        assert!(!state.game_window_foreground);
        assert!(state.league_client_foreground);
    }

    #[test]
    fn known_non_game_bundle_overrides_misleading_window_metadata() {
        let state = classify_foreground(observation(
            "Riot Client",
            RIOT_CLIENT_BUNDLE_ID,
            "League Of Legends",
            "League of Legends (TM) Client",
            true,
        ));
        assert!(!state.game_window_foreground);

        let state = classify_foreground(observation(
            "Riot Client",
            LEAGUE_GAME_BUNDLE_ID,
            "League Of Legends",
            "League of Legends (TM) Client",
            true,
        ));
        assert!(!state.game_window_foreground);
        assert!(state.riot_client_foreground);

        let state = classify_foreground(observation(
            "Riot Client",
            LEAGUE_GAME_BUNDLE_ID,
            "Riot Client",
            "Riot Client",
            true,
        ));
        assert!(!state.game_window_foreground);

        let state = classify_foreground(observation(
            "League Client UX",
            LEAGUE_CLIENT_UX_BUNDLE_ID,
            "League Of Legends",
            "League of Legends (TM) Client",
            true,
        ));
        assert!(!state.game_window_foreground);
    }
}
