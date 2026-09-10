#![allow(unexpected_cfgs)] // objc 0.2 macros emit cfg(cargo-clippy) on current rustc.

use image::GenericImageView;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

pub mod calibration;
mod collector;
mod foreground;
mod lcu;
pub mod member;
pub mod ocr;
pub mod overlay_window;
mod sanitize;
pub mod surface_probe;
mod upload_queue;
pub mod window_locator;

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LivePlayerData {
    pub champion: String,
    pub level: u32,
    pub is_dead: bool,
    pub game_time: f64,
    pub game_mode: String,
}

fn parse_live_player_data(
    active: &serde_json::Value,
    players: &[serde_json::Value],
    game_data: &serde_json::Value,
) -> Option<LivePlayerData> {
    let summoner_name = active
        .get("riotId")
        .or_else(|| active.get("summonerName"))
        .and_then(serde_json::Value::as_str)?;
    let me = players.iter().find(|player| {
        player
            .get("riotId")
            .or_else(|| player.get("summonerName"))
            .and_then(serde_json::Value::as_str)
            == Some(summoner_name)
    })?;
    let champion = me
        .get("rawChampionName")
        .and_then(serde_json::Value::as_str)
        .map(|raw| raw.rsplit('_').next().unwrap_or(raw).to_string())
        .unwrap_or_else(|| {
            me.get("championName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string()
        });

    Some(LivePlayerData {
        champion,
        level: active
            .get("level")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1) as u32,
        is_dead: me
            .get("isDead")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        game_time: game_data
            .get("gameTime")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
        game_mode: game_data
            .get("gameMode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn detect_league_client() -> bool {
    lcu::discover_lcu_credentials().is_some()
}

/// Bridge a privacy-safe renderer diagnostic to TERMINAL stderr (not just the
/// WebView console) for controlled retests. Payload is a pre-serialized JSON
/// string of bounded counts/booleans/enums only — never OCR text, names, or
/// account identifiers. The body is compiled out of release builds so production
/// terminals stay silent; the renderer already gates the call on `import.meta.env.DEV`.
#[tauri::command]
fn emit_overlay_diagnostic(marker: String, payload: String) {
    #[cfg(debug_assertions)]
    {
        eprintln!("{} {}", marker, payload);
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (marker, payload);
    }
}

#[tauri::command]
async fn get_game_phase() -> Option<String> {
    let credentials = lcu::discover_lcu_credentials()?;
    lcu::read_gameflow_state(&credentials).await.ok()?.raw_phase
}

#[tauri::command]
async fn get_lcu_gameflow_state() -> Option<lcu::GameflowState> {
    let credentials = lcu::discover_lcu_credentials()?;
    lcu::read_gameflow_state(&credentials).await.ok()
}

#[tauri::command]
async fn get_game_hash() -> Option<String> {
    let credentials = lcu::discover_lcu_credentials()?;
    let url = format!(
        "https://127.0.0.1:{}/lol-gameflow/v1/session",
        credentials.port
    );
    let session: serde_json::Value = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?
        .get(url)
        .basic_auth("riot", Some(&credentials.auth_token))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let game_id = session
        .pointer("/gameData/gameId")
        .or_else(|| session.get("gameId"))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_u64().map(|number| number.to_string()))
        })?;
    Some(member::hash_game_id(&game_id))
}

#[tauri::command]
async fn get_live_player_data() -> Option<LivePlayerData> {
    // A per-request timeout matters here more than on other LCU calls: this
    // command issues three SEQUENTIAL requests inside the main poll loop
    // (src/App.tsx `poll()`), which single-flights itself via a ref guard that
    // only clears in a `finally` after the whole call settles. An unbounded
    // hang on any one request — most likely during a death/respawn transition,
    // when the Live Client Data API can briefly stop responding — would
    // otherwise wedge the poll loop (and therefore playerData/level/round
    // state, and the activeGame gate the geometry probe scheduler consults)
    // permanently, since setInterval re-fires are no-ops while the guard is
    // still held.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;

    // Get active player name
    let active: serde_json::Value = client
        .get("https://127.0.0.1:2999/liveclientdata/activeplayer")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    // Get player list to find champion
    let players: Vec<serde_json::Value> = client
        .get("https://127.0.0.1:2999/liveclientdata/playerlist")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    // Get game data for time and mode
    let game_data: serde_json::Value = client
        .get("https://127.0.0.1:2999/liveclientdata/gamestats")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    parse_live_player_data(&active, &players, &game_data)
}

#[cfg(test)]
mod live_player_tests {
    use super::*;

    fn active(riot_id: &str) -> serde_json::Value {
        serde_json::json!({ "riotId": riot_id, "level": 7 })
    }

    fn player(riot_id: &str, raw_champion_name: &str) -> serde_json::Value {
        serde_json::json!({
            "riotId": riot_id,
            "rawChampionName": raw_champion_name,
            "championName": "localized-name-must-not-win",
            "isDead": false
        })
    }

    fn game() -> serde_json::Value {
        serde_json::json!({ "gameTime": 123.0, "gameMode": "ARAM" })
    }

    fn champion(active: &serde_json::Value, players: &[serde_json::Value]) -> Option<String> {
        parse_live_player_data(active, players, &game()).map(|snapshot| snapshot.champion)
    }

    #[test]
    fn initial_in_game_champion_comes_from_the_active_players_raw_champion_name() {
        assert_eq!(
            champion(
                &active("self#TW"),
                &[player("self#TW", "game_character_displayname_Varus")]
            ),
            Some("Varus".to_string())
        );
    }

    #[test]
    fn aram_reroll_replaces_the_active_players_champion() {
        let active = active("self#TW");
        assert_eq!(
            champion(
                &active,
                &[player("self#TW", "game_character_displayname_Varus")]
            ),
            Some("Varus".to_string())
        );
        assert_eq!(
            champion(
                &active,
                &[player("self#TW", "game_character_displayname_Ashe")]
            ),
            Some("Ashe".to_string())
        );
    }

    #[test]
    fn bench_swap_replaces_the_active_players_champion() {
        let active = active("self#TW");
        assert_eq!(
            champion(
                &active,
                &[player("self#TW", "game_character_displayname_Malphite")]
            ),
            Some("Malphite".to_string())
        );
        assert_eq!(
            champion(
                &active,
                &[player("self#TW", "game_character_displayname_Karthus")]
            ),
            Some("Karthus".to_string())
        );
    }

    #[test]
    fn teammate_champion_swap_does_not_change_the_active_player() {
        let active = active("self#TW");
        let before = [
            player("self#TW", "game_character_displayname_Varus"),
            player("ally#TW", "game_character_displayname_Jinx"),
        ];
        let after = [
            player("self#TW", "game_character_displayname_Varus"),
            player("ally#TW", "game_character_displayname_Sivir"),
        ];
        assert_eq!(champion(&active, &before), Some("Varus".to_string()));
        assert_eq!(champion(&active, &after), Some("Varus".to_string()));
    }

    #[test]
    fn reconnect_resolves_the_current_active_player_from_the_fresh_roster() {
        let active = active("self#TW");
        assert_eq!(champion(&active, &[]), None);
        assert_eq!(
            champion(
                &active,
                &[player("self#TW", "game_character_displayname_Ahri")]
            ),
            Some("Ahri".to_string())
        );
    }

    #[test]
    fn overlay_startup_after_game_start_needs_no_prior_champion_state() {
        assert_eq!(
            champion(
                &active("self#TW"),
                &[player("self#TW", "game_character_displayname_LeeSin")]
            ),
            Some("LeeSin".to_string())
        );
    }

    #[test]
    fn unknown_raw_champion_is_preserved_for_frontend_catalog_fallback() {
        assert_eq!(
            champion(
                &active("self#TW"),
                &[player(
                    "self#TW",
                    "game_character_displayname_FutureChampion"
                )]
            ),
            Some("FutureChampion".to_string())
        );
    }
}

#[cfg(test)]
mod bounded_capture_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::thread;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn bounded_capture_work_executes_off_the_async_runtime_thread() {
        static TEST_CAPTURE_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
        let caller_thread = thread::current().id();

        let worker_thread = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            1,
            Duration::from_millis(250),
            || Ok::<_, String>(thread::current().id()),
        )
        .await
        .expect("bounded capture worker should complete");

        assert_ne!(
            worker_thread, caller_thread,
            "capture and analysis must run on the blocking pool, not the async runtime thread"
        );
    }

    #[tokio::test]
    async fn capture_at_cap_is_refused_until_a_blocking_worker_returns() {
        // Cap of 1 is the exclusive boundary: while the single permit is held by
        // a hung worker the next capture is refused fast, and the channel becomes
        // available again only once that worker truly returns.
        static TEST_CAPTURE_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let started = Instant::now();

        let first = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            1,
            Duration::from_millis(25),
            move || {
                release_receiver.recv().map_err(|error| error.to_string())?;
                Ok::<_, String>("released")
            },
        )
        .await;

        assert_eq!(first, Err(BoundedCaptureError::Timeout));
        assert!(started.elapsed() < Duration::from_millis(500));

        let second = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            1,
            Duration::from_millis(25),
            || Ok::<_, String>("must-not-run"),
        )
        .await;
        assert_eq!(second, Err(BoundedCaptureError::Busy));

        release_sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_millis(500), async {
            while TEST_CAPTURE_IN_FLIGHT.load(std::sync::atomic::Ordering::Acquire) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking capture worker should release its permit");

        let third = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            1,
            Duration::from_millis(25),
            || Ok::<_, String>("next-capture"),
        )
        .await;
        assert_eq!(third, Ok("next-capture"));
    }

    #[tokio::test]
    async fn stuck_capture_must_not_block_a_same_channel_retry() {
        // Regression guard: a single hung capture used to hold the ONLY permit,
        // so every death-round retry returned `capture-busy` -> absent for the
        // whole hang (badges never rendered at levels 11/15). Under a cap > 1 a
        // hung worker must not starve retries beneath the cap; the cap must still
        // bound accumulation; and the channel must recover once workers return.
        static TEST_CAPTURE_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
        const MAX: usize = 2;
        let (release_sender, release_receiver) = std::sync::mpsc::channel::<()>();

        // A hung capture times out on the async side but keeps holding one permit.
        let stuck = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            MAX,
            Duration::from_millis(25),
            move || {
                release_receiver.recv().map_err(|error| error.to_string())?;
                Ok::<_, String>("stuck")
            },
        )
        .await;
        assert_eq!(stuck, Err(BoundedCaptureError::Timeout));

        // A retry beneath the cap still runs -- the fix for the death-round blackout.
        let retry = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            MAX,
            Duration::from_millis(25),
            || Ok::<_, String>("retry-ran"),
        )
        .await;
        assert_eq!(retry, Ok("retry-ran"));

        // Saturate the last slot with a second hung worker; the cap then refuses
        // further captures fast instead of letting them pile up unbounded.
        let (release_sender_2, release_receiver_2) = std::sync::mpsc::channel::<()>();
        let stuck_2 = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            MAX,
            Duration::from_millis(25),
            move || {
                release_receiver_2
                    .recv()
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>("stuck-2")
            },
        )
        .await;
        assert_eq!(stuck_2, Err(BoundedCaptureError::Timeout));

        let refused = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            MAX,
            Duration::from_millis(25),
            || Ok::<_, String>("must-not-run"),
        )
        .await;
        assert_eq!(refused, Err(BoundedCaptureError::Busy));

        // Release both hung workers; their permits free and the channel recovers.
        release_sender.send(()).unwrap();
        release_sender_2.send(()).unwrap();
        tokio::time::timeout(Duration::from_millis(500), async {
            while TEST_CAPTURE_IN_FLIGHT.load(std::sync::atomic::Ordering::Acquire) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("hung capture workers should release their permits");

        let recovered = run_bounded_capture_with_gate(
            &TEST_CAPTURE_IN_FLIGHT,
            MAX,
            Duration::from_millis(25),
            || Ok::<_, String>("recovered"),
        )
        .await;
        assert_eq!(recovered, Ok("recovered"));
    }

    #[tokio::test]
    async fn timed_out_geometry_capture_does_not_starve_ocr_capture() {
        let (release_sender, release_receiver) = std::sync::mpsc::channel();

        let geometry = run_bounded_capture(CaptureChannel::Geometry, move || {
            release_receiver.recv().map_err(|error| error.to_string())?;
            Ok::<_, String>("geometry-released")
        })
        .await;
        assert_eq!(geometry, Err(BoundedCaptureError::Timeout));

        let ocr =
            run_bounded_capture(CaptureChannel::Ocr, || Ok::<_, String>("ocr-captured")).await;
        assert_eq!(ocr, Ok("ocr-captured"));

        release_sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_millis(500), async {
            while native_capture_gate(CaptureChannel::Geometry)
                .load(std::sync::atomic::Ordering::Acquire)
                != 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking geometry worker should eventually release its own permit");
    }

    #[tokio::test]
    async fn timed_out_ocr_capture_does_not_starve_geometry_capture() {
        let (release_sender, release_receiver) = std::sync::mpsc::channel();

        let ocr = run_bounded_capture(CaptureChannel::Ocr, move || {
            release_receiver.recv().map_err(|error| error.to_string())?;
            Ok::<_, String>("ocr-released")
        })
        .await;
        assert_eq!(ocr, Err(BoundedCaptureError::Timeout));

        let geometry = run_bounded_capture(CaptureChannel::Geometry, || {
            Ok::<_, String>("geometry-captured")
        })
        .await;
        assert_eq!(geometry, Ok("geometry-captured"));

        release_sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_millis(500), async {
            while native_capture_gate(CaptureChannel::Ocr)
                .load(std::sync::atomic::Ordering::Acquire)
                != 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking OCR worker should eventually release its own permit");
    }

    #[test]
    fn geometry_command_bounds_capture_and_analysis_as_one_worker() {
        let source = include_str!("lib.rs");
        let command = source
            .rsplit("async fn probe_augment_surface(")
            .next()
            .and_then(|rest| rest.split("// ─── API Probe").next())
            .expect("geometry command source");

        assert!(
            command.contains("move || {")
                && command.contains("capture_and_analyze_surface(probe_seq, captured_at)"),
            "the bounded geometry worker must own both capture and pixel analysis"
        );
        assert!(
            !command.contains("surface_probe::analyze_surface"),
            "pixel analysis must not run synchronously on the async command runtime"
        );
    }
}

#[cfg(test)]
mod bounded_ocr_recognition_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn timed_out_recognition_recovers_below_cap_and_bounds_physical_workers() {
        // OCR recognition is a separate blocking stage after capture. Its async
        // deadline must return without pretending that the blocking worker was
        // cancelled: the physical worker keeps its permit until it really exits.
        static RECOGNITION_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
        static ATTEMPTS_STARTED: AtomicUsize = AtomicUsize::new(0);
        const MAX: usize = 2;
        let deadline = Duration::from_millis(25);
        let (release_first, wait_first) = std::sync::mpsc::channel::<()>();

        let first = tokio::spawn(run_bounded_ocr_recognition_with_gate(
            &RECOGNITION_IN_FLIGHT,
            MAX,
            deadline,
            move || {
                ATTEMPTS_STARTED.fetch_add(1, Ordering::AcqRel);
                wait_first.recv().map_err(|error| error.to_string())?;
                Ok::<_, String>("late-first")
            },
        ));
        while RECOGNITION_IN_FLIGHT.load(Ordering::Acquire) != 1 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            first.await.expect("recognition task should join"),
            Err(BoundedCaptureError::Timeout),
            "an over-deadline OCR recognition must fail the command-side wait"
        );
        assert_eq!(
            RECOGNITION_IN_FLIGHT.load(Ordering::Acquire),
            1,
            "timing out must not release the still-running physical worker's permit"
        );

        // JavaScript invokes sequentially: after the first invocation returns a
        // timeout, its next healthy invocation must run beneath the native cap.
        let healthy =
            run_bounded_ocr_recognition_with_gate(&RECOGNITION_IN_FLIGHT, MAX, deadline, || {
                ATTEMPTS_STARTED.fetch_add(1, Ordering::AcqRel);
                Ok::<_, String>("healthy")
            })
            .await;
        assert_eq!(healthy, Ok("healthy"));
        assert_eq!(RECOGNITION_IN_FLIGHT.load(Ordering::Acquire), 1);

        // A second stuck physical worker fills the cap. Further sequential
        // retries must be refused without spawning or running another closure.
        let (release_second, wait_second) = std::sync::mpsc::channel::<()>();
        let second = tokio::spawn(run_bounded_ocr_recognition_with_gate(
            &RECOGNITION_IN_FLIGHT,
            MAX,
            deadline,
            move || {
                ATTEMPTS_STARTED.fetch_add(1, Ordering::AcqRel);
                wait_second.recv().map_err(|error| error.to_string())?;
                Ok::<_, String>("late-second")
            },
        ));
        while RECOGNITION_IN_FLIGHT.load(Ordering::Acquire) != MAX {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            second.await.expect("recognition task should join"),
            Err(BoundedCaptureError::Timeout)
        );

        let refused =
            run_bounded_ocr_recognition_with_gate(&RECOGNITION_IN_FLIGHT, MAX, deadline, || {
                ATTEMPTS_STARTED.fetch_add(1, Ordering::AcqRel);
                Ok::<_, String>("must-not-run")
            })
            .await;
        assert_eq!(refused, Err(BoundedCaptureError::Busy));
        assert_eq!(
            ATTEMPTS_STARTED.load(Ordering::Acquire),
            3,
            "backpressure must refuse work before a third physical worker starts"
        );

        release_first.send(()).unwrap();
        release_second.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while RECOGNITION_IN_FLIGHT.load(Ordering::Acquire) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("physical OCR workers should eventually release their own permits");
    }

    #[test]
    fn detect_command_routes_card_recognition_through_bounded_worker() {
        let source = include_str!("lib.rs");
        let command = source
            .rsplit("async fn detect_augment_names(")
            .next()
            .and_then(|rest| rest.split("// ─── Geometry Surface Probe").next())
            .expect("detect_augment_names source");
        let recognition = command
            .split("let ocr_start = std::time::Instant::now();")
            .nth(1)
            .and_then(|rest| rest.split("detected.sort_by_key").next())
            .expect("detect_augment_names recognition slice");

        assert!(
            recognition.contains("run_bounded_ocr_recognition")
                && recognition.contains("ocr::read_card_text"),
            "detect_augment_names must route read_card_text through the bounded recognition worker"
        );
        assert!(
            !recognition.contains("tokio::task::spawn_blocking")
                && !recognition.contains("handle.await"),
            "detect_augment_names must not directly spawn and await raw recognition workers"
        );
    }
}

// ─── OCR Types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DetectedAugment {
    pub text: String,
    pub region_index: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrCardDiagnostic {
    pub region_index: usize,
    pub card_rect: Option<calibration::Rect>,
    pub crop: Option<calibration::Rect>,
    pub capture_succeeded: bool,
    pub raw_text: Option<String>,
    pub error: Option<String>,
    pub capture_width: Option<u32>,
    pub capture_height: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrScanResult {
    pub detected: Vec<DetectedAugment>,
    pub diagnostics: Vec<OcrCardDiagnostic>,
    pub capture_attempted: bool,
    pub crop_count: usize,
    /// Screenshot + crop extraction duration for this scan, in milliseconds.
    pub capture_ms: u64,
    /// OCR recognition duration (all cards, run concurrently), in milliseconds.
    pub ocr_ms: u64,
    /// Total native scan duration, in milliseconds.
    pub total_ms: u64,
}

// ─── OCR Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn check_ocr() -> bool {
    ocr::is_available()
}

#[tauri::command]
fn check_screen_capture_available() -> bool {
    let Ok(monitors) = xcap::Monitor::all() else {
        return false;
    };
    let Some(monitor) = monitors.into_iter().next() else {
        return false;
    };

    monitor.capture_image().is_ok()
}

struct MonitorSnapshot {
    monitor: xcap::Monitor,
    info: calibration::MonitorInfo,
}

fn monitor_info_from_xcap(monitor: &xcap::Monitor) -> Result<calibration::MonitorInfo, String> {
    Ok(calibration::MonitorInfo {
        x: monitor
            .x()
            .map_err(|e| format!("Monitor x failed: {}", e))?,
        y: monitor
            .y()
            .map_err(|e| format!("Monitor y failed: {}", e))?,
        width: monitor
            .width()
            .map_err(|e| format!("Monitor width failed: {}", e))?,
        height: monitor
            .height()
            .map_err(|e| format!("Monitor height failed: {}", e))?,
        scale_factor: monitor.scale_factor().unwrap_or(1.0) as f64,
    })
}

fn monitor_snapshots() -> Result<Vec<MonitorSnapshot>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
    let mut snapshots = Vec::with_capacity(monitors.len());

    for monitor in monitors {
        let info = monitor_info_from_xcap(&monitor)?;
        snapshots.push(MonitorSnapshot { monitor, info });
    }

    if snapshots.is_empty() {
        return Err("No monitor found".to_string());
    }

    Ok(snapshots)
}

const NATIVE_CAPTURE_TIMEOUT: Duration = Duration::from_millis(1500);
const OCR_RECOGNITION_TIMEOUT: Duration = Duration::from_millis(1500);
/// Max concurrent native captures per channel. A slow/hung capture keeps its
/// permit until the OS call really returns, so a low cap bounds how many hung
/// blocking workers can accumulate. It MUST be > 1: at a cap of 1 a single hung
/// capture starves every death-round retry, so no frame is ever produced and
/// badges never render at levels 11/15 (they render again once a retry that is
/// admitted beneath the cap captures a frame).
const MAX_CONCURRENT_CAPTURES: usize = 4;
// Each scan recognizes three card regions concurrently. Six permits allow one
// complete later scan to run after all three workers from a timed-out scan keep
// running, while still bounding uncancellable native recognition work.
const MAX_CONCURRENT_OCR_RECOGNITIONS: usize = 6;
static GEOMETRY_CAPTURE_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
static OCR_CAPTURE_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
static OCR_RECOGNITION_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy, Debug)]
enum CaptureChannel {
    Geometry,
    Ocr,
}

fn native_capture_gate(channel: CaptureChannel) -> &'static AtomicUsize {
    match channel {
        CaptureChannel::Geometry => &GEOMETRY_CAPTURE_IN_FLIGHT,
        CaptureChannel::Ocr => &OCR_CAPTURE_IN_FLIGHT,
    }
}

#[derive(Debug, PartialEq)]
enum BoundedCaptureError {
    Busy,
    Timeout,
    Capture(String),
    WorkerFailed,
}

struct CapturePermit {
    in_flight: &'static AtomicUsize,
}

impl CapturePermit {
    /// Admit a capture only while fewer than `max` are already outstanding on
    /// this channel. Retries beneath the cap run concurrently instead of being
    /// refused, so a single hung capture cannot black out the whole channel;
    /// the cap still bounds how many hung workers can pile up.
    fn try_acquire(in_flight: &'static AtomicUsize, max: usize) -> Option<Self> {
        let mut current = in_flight.load(Ordering::Acquire);
        loop {
            if current >= max {
                return None;
            }
            match in_flight.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self { in_flight }),
                Err(actual) => current = actual,
            }
        }
    }
}

impl Drop for CapturePermit {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::Release);
    }
}

async fn run_bounded_capture_with_gate<T, F>(
    in_flight: &'static AtomicUsize,
    max_in_flight: usize,
    timeout: Duration,
    capture: F,
) -> Result<T, BoundedCaptureError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit =
        CapturePermit::try_acquire(in_flight, max_in_flight).ok_or(BoundedCaptureError::Busy)?;
    let worker = tokio::task::spawn_blocking(move || {
        // The permit deliberately lives in the blocking worker: timing out the
        // async wait cannot cancel an OS capture, so the permit is only released
        // when that worker truly returns. The per-channel CAP (not a single
        // permit) still admits retries while one worker is hung, so a slow
        // capture no longer blacks out the channel for the whole hang.
        let _permit = permit;
        capture()
    });

    match tokio::time::timeout(timeout, worker).await {
        Ok(Ok(Ok(captured))) => Ok(captured),
        Ok(Ok(Err(error))) => Err(BoundedCaptureError::Capture(error)),
        Ok(Err(_)) => Err(BoundedCaptureError::WorkerFailed),
        Err(_) => Err(BoundedCaptureError::Timeout),
    }
}

async fn run_bounded_capture<T, F>(
    channel: CaptureChannel,
    capture: F,
) -> Result<T, BoundedCaptureError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_bounded_capture_with_gate(
        native_capture_gate(channel),
        MAX_CONCURRENT_CAPTURES,
        NATIVE_CAPTURE_TIMEOUT,
        capture,
    )
    .await
}

async fn run_bounded_ocr_recognition_with_gate<T, F>(
    in_flight: &'static AtomicUsize,
    max_in_flight: usize,
    timeout: Duration,
    recognize: F,
) -> Result<T, BoundedCaptureError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_bounded_capture_with_gate(in_flight, max_in_flight, timeout, recognize).await
}

async fn run_bounded_ocr_recognition<T, F>(recognize: F) -> Result<T, BoundedCaptureError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_bounded_ocr_recognition_with_gate(
        &OCR_RECOGNITION_IN_FLIGHT,
        MAX_CONCURRENT_OCR_RECOGNITIONS,
        OCR_RECOGNITION_TIMEOUT,
        recognize,
    )
    .await
}

/// True when an enumerated window belongs to the overlay itself. `xcap` gives us
/// only app name/title, so we match the overlay's product identity — a defensive
/// guard on top of the game-window predicate, which already rejects it.
fn is_own_overlay_window(app_name: &str, title: &str) -> bool {
    let overlay = |value: &str| {
        let normalized = value.to_lowercase();
        normalized == "mayhem oracle" || normalized == "mayhem-oracle-overlay"
    };
    overlay(app_name) || overlay(title)
}

fn find_league_window() -> Option<calibration::Rect> {
    let windows = xcap::Window::all().ok()?;
    let mut candidates: Vec<window_locator::WindowCandidate> = Vec::new();

    for window in windows {
        let app_name = window.app_name().unwrap_or_default();
        let title = window.title().unwrap_or_default();
        let (Ok(x), Ok(y), Ok(width), Ok(height)) =
            (window.x(), window.y(), window.width(), window.height())
        else {
            continue;
        };
        candidates.push(window_locator::WindowCandidate {
            is_own_overlay: is_own_overlay_window(&app_name, &title),
            app_name,
            title,
            rect: calibration::Rect {
                x,
                y,
                width,
                height,
            },
            minimized: window.is_minimized().unwrap_or(false),
        });
    }

    window_locator::select_league_window(&candidates)
}

fn selected_monitor_index(
    monitors: &[MonitorSnapshot],
    game_window: Option<&calibration::Rect>,
) -> usize {
    if let Some(window) = game_window {
        if let Some((index, _)) = monitors
            .iter()
            .enumerate()
            .map(|(index, monitor)| (index, calibration::overlap_area(window, &monitor.info)))
            .filter(|(_, overlap)| *overlap > 0)
            .max_by_key(|(_, overlap)| *overlap)
        {
            return index;
        }
    }

    monitors
        .iter()
        .position(|snapshot| snapshot.monitor.is_primary().unwrap_or(false))
        .unwrap_or(0)
}

fn detect_overlay_calibration() -> Result<calibration::OverlayCalibration, String> {
    let monitors = monitor_snapshots()?;
    let game_window = find_league_window();
    let monitor_index = selected_monitor_index(&monitors, game_window.as_ref());

    Ok(calibration::select_viewport(
        &monitors[monitor_index].info,
        game_window.as_ref(),
    ))
}

#[cfg(target_os = "windows")]
fn apply_overlay_window_bounds(
    app: &tauri::AppHandle,
    calibration: &calibration::OverlayCalibration,
) -> Result<(), String> {
    use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, Size};

    let Some(window) = app.get_webview_window("overlay") else {
        eprintln!("[overlay-window] reposition skipped — \"overlay\" window not found");
        return Ok(());
    };

    window
        .set_position(Position::Physical(PhysicalPosition {
            x: calibration.viewport.x,
            y: calibration.viewport.y,
        }))
        .map_err(|e| format!("Overlay position failed: {}", e))?;
    window
        .set_size(Size::Physical(PhysicalSize {
            width: calibration.viewport.width,
            height: calibration.viewport.height,
        }))
        .map_err(|e| format!("Overlay size failed: {}", e))?;

    // Window-lifecycle audit log (fix #7). The single "overlay" window is only
    // ever repositioned/resized here (Windows only); no window is created or
    // destroyed to change modes.
    eprintln!(
        "[overlay-window] repositioned single \"overlay\" window to {},{} {}x{}",
        calibration.viewport.x,
        calibration.viewport.y,
        calibration.viewport.width,
        calibration.viewport.height
    );

    Ok(())
}

#[tauri::command]
fn get_overlay_calibration(
    app: tauri::AppHandle,
) -> Result<calibration::OverlayCalibration, String> {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut calibration = detect_overlay_calibration()?;

    #[cfg(target_os = "windows")]
    {
        apply_overlay_window_bounds(&app, &calibration)?;
        // The overlay window now hugs the viewport, so the webview's CSS box
        // maps onto the viewport rect rather than the monitor.
        calibration.overlay_anchor = calibration.viewport.clone();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &app;

    Ok(calibration)
}

/// Diagnostics for a wholesale screen-capture failure: every card region is
/// flagged `capture_succeeded = false` with the error, and NO crops are
/// produced (`crop_count` stays 0). This is what keeps a capture failure
/// distinguishable from a legitimate scan that captured every region but
/// recognized no augment text (`crop_count == region count`): a capture failure
/// must never be read as a valid zero-card observation.
pub fn capture_failure_diagnostics(
    viewport: &calibration::Rect,
    error: &str,
) -> Vec<OcrCardDiagnostic> {
    calibration::CARD_NAME_REGIONS
        .iter()
        .enumerate()
        .map(|(region_index, region)| {
            let rect = calibration::physical_rect_for_region(region, viewport);
            OcrCardDiagnostic {
                region_index,
                card_rect: Some(rect.clone()),
                crop: Some(rect),
                capture_succeeded: false,
                raw_text: None,
                error: Some(error.to_string()),
                capture_width: None,
                capture_height: None,
            }
        })
        .collect()
}

struct CardCrop {
    region_index: usize,
    image: image::DynamicImage,
}

struct CardCropSet {
    crops: Vec<CardCrop>,
    diagnostics: Vec<OcrCardDiagnostic>,
    capture_attempted: bool,
}

fn capture_card_name_crops() -> Result<CardCropSet, String> {
    let monitors = monitor_snapshots()?;
    let game_window = find_league_window();
    let monitor_index = selected_monitor_index(&monitors, game_window.as_ref());
    let monitor = &monitors[monitor_index];
    let calibration = calibration::select_viewport(&monitor.info, game_window.as_ref());
    let mut diagnostics = Vec::with_capacity(calibration::CARD_NAME_REGIONS.len());
    let screenshot = match monitor.monitor.capture_image() {
        Ok(screenshot) => screenshot,
        Err(error) => {
            // A capture failure is a flagged, crop-less outcome — never a clean
            // zero-card scan (see `capture_failure_diagnostics`).
            let message = format!("Capture failed: {}", error);
            diagnostics.extend(capture_failure_diagnostics(&calibration.viewport, &message));
            return Ok(CardCropSet {
                crops: Vec::new(),
                diagnostics,
                capture_attempted: true,
            });
        }
    };

    let mut crops = Vec::with_capacity(calibration::CARD_NAME_REGIONS.len());

    for (i, region) in calibration::CARD_NAME_REGIONS.iter().enumerate() {
        let logical_rect = calibration::physical_rect_for_region(region, &calibration.viewport);
        let rect = calibration::capture_rect_for_monitor(
            &logical_rect,
            &monitor.info,
            screenshot.width(),
            screenshot.height(),
        );
        let px = rect.x;
        let py = rect.y;

        if px < 0 || py < 0 {
            diagnostics.push(OcrCardDiagnostic {
                region_index: i,
                card_rect: Some(logical_rect.clone()),
                crop: Some(rect),
                capture_succeeded: false,
                raw_text: None,
                error: Some("crop-origin-outside-monitor".to_string()),
                capture_width: Some(screenshot.width()),
                capture_height: Some(screenshot.height()),
            });
            continue;
        }

        let px = px as u32;
        let py = py as u32;
        let pw = rect.width;
        let ph = rect.height;

        if pw == 0 || ph == 0 || px + pw > screenshot.width() || py + ph > screenshot.height() {
            diagnostics.push(OcrCardDiagnostic {
                region_index: i,
                card_rect: Some(logical_rect.clone()),
                crop: Some(rect),
                capture_succeeded: false,
                raw_text: None,
                error: Some("crop-outside-captured-monitor".to_string()),
                capture_width: Some(screenshot.width()),
                capture_height: Some(screenshot.height()),
            });
            continue;
        }

        crops.push(CardCrop {
            region_index: i,
            image: image::DynamicImage::ImageRgba8(screenshot.view(px, py, pw, ph).to_image()),
        });
        diagnostics.push(OcrCardDiagnostic {
            region_index: i,
            card_rect: Some(logical_rect),
            crop: Some(rect),
            capture_succeeded: true,
            raw_text: None,
            error: None,
            capture_width: Some(screenshot.width()),
            capture_height: Some(screenshot.height()),
        });
    }

    Ok(CardCropSet {
        capture_attempted: true,
        crops,
        diagnostics,
    })
}

fn bounded_capture_reason(error: &BoundedCaptureError) -> String {
    match error {
        BoundedCaptureError::Busy => "capture-busy".to_string(),
        BoundedCaptureError::Timeout => "capture-timeout".to_string(),
        BoundedCaptureError::Capture(error) => error.clone(),
        BoundedCaptureError::WorkerFailed => "capture-worker-failed".to_string(),
    }
}

fn bounded_ocr_recognition_reason(error: BoundedCaptureError) -> String {
    match error {
        BoundedCaptureError::Busy => "ocr-recognition-busy".to_string(),
        BoundedCaptureError::Timeout => "ocr-recognition-timeout".to_string(),
        BoundedCaptureError::Capture(error) => error,
        BoundedCaptureError::WorkerFailed => "ocr-recognition-worker-failed".to_string(),
    }
}

#[tauri::command]
async fn detect_augment_names(known_names: Option<Vec<String>>) -> Result<OcrScanResult, String> {
    let scan_start = std::time::Instant::now();
    let capture_start = std::time::Instant::now();
    let crop_set = match run_bounded_capture(CaptureChannel::Ocr, || {
        // Foreground gate runs INSIDE the bounded capture (off the async runtime),
        // exactly as capture_surface_frame does. Its CGWindowList/window-server
        // walk is an unbounded, uncancellable blocking call; on the async runtime
        // it starved the executor that also has to poll the geometry command.
        // Returning the reason as a capture error routes it through the existing
        // error branch below, which reports `capture_attempted: false` for
        // BoundedCaptureError::Capture(_) and carries the reason per region —
        // the same observable outcome as the early return this replaces.
        if !collect_foreground_state().game_window_foreground {
            return Err("actual-game-window-not-foreground".to_string());
        }
        capture_card_name_crops()
    })
    .await
    {
        Ok(crop_set) => crop_set,
        Err(error) => {
            let reason = bounded_capture_reason(&error);
            return Ok(OcrScanResult {
                detected: Vec::new(),
                diagnostics: (0..calibration::CARD_NAME_REGIONS.len())
                    .map(|region_index| OcrCardDiagnostic {
                        region_index,
                        card_rect: None,
                        crop: None,
                        capture_succeeded: false,
                        raw_text: None,
                        error: Some(reason.clone()),
                        capture_width: None,
                        capture_height: None,
                    })
                    .collect(),
                capture_attempted: matches!(
                    error,
                    BoundedCaptureError::Timeout | BoundedCaptureError::WorkerFailed
                ),
                crop_count: 0,
                capture_ms: capture_start.elapsed().as_millis() as u64,
                ocr_ms: 0,
                total_ms: scan_start.elapsed().as_millis() as u64,
            });
        }
    };
    let capture_ms = capture_start.elapsed().as_millis() as u64;
    let capture_attempted = crop_set.capture_attempted;
    let crop_count = crop_set.crops.len();
    let locale = ocr::detect_game_locale();

    // Vision biases language correction toward these names; the Windows
    // backend ignores them (fuzzy matching happens in the frontend).
    let known_names: Arc<Vec<String>> = Arc::new(
        known_names
            .unwrap_or_default()
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect(),
    );

    let ocr_start = std::time::Instant::now();
    let mut workers = tokio::task::JoinSet::new();
    for crop in crop_set.crops {
        let region_index = crop.region_index;
        let known_names = known_names.clone();
        workers.spawn(async move {
            let result = run_bounded_ocr_recognition(move || {
                ocr::read_card_text(&crop.image, locale, &known_names)
            })
            .await;
            (region_index, result)
        });
    }

    let mut diagnostics = crop_set.diagnostics;
    let mut detected = Vec::with_capacity(workers.len());
    while let Some(worker) = workers.join_next().await {
        match worker {
            Ok((region_index, Ok(Some(text)))) => {
                if let Some(diagnostic) = diagnostics
                    .iter_mut()
                    .find(|diagnostic| diagnostic.region_index == region_index)
                {
                    diagnostic.raw_text = Some(text.clone());
                }
                detected.push(DetectedAugment { text, region_index });
            }
            Ok((region_index, Ok(None))) => {
                if let Some(diagnostic) = diagnostics
                    .iter_mut()
                    .find(|diagnostic| diagnostic.region_index == region_index)
                {
                    diagnostic.error = Some("no-text-recognized".to_string());
                }
            }
            Ok((region_index, Err(error))) => {
                if let Some(diagnostic) = diagnostics
                    .iter_mut()
                    .find(|diagnostic| diagnostic.region_index == region_index)
                {
                    diagnostic.error = Some(bounded_ocr_recognition_reason(error));
                }
            }
            Err(error) => {
                let message = format!("ocr-recognition-worker-failed: {}", error);
                for diagnostic in &mut diagnostics {
                    if diagnostic.raw_text.is_none() && diagnostic.error.is_none() {
                        diagnostic.error = Some(message.clone());
                    }
                }
            }
        }
    }
    detected.sort_by_key(|result| result.region_index);
    Ok(OcrScanResult {
        detected,
        diagnostics,
        capture_attempted,
        crop_count,
        capture_ms,
        ocr_ms: ocr_start.elapsed().as_millis() as u64,
        total_ms: scan_start.elapsed().as_millis() as u64,
    })
}

// ─── Geometry Surface Probe (pixel presence/occlusion; NO OCR) ──────────────
// Round-6: presence/occlusion/visual freshness are decided from PIXELS here,
// not OCR. Scheduler health separately owns fail-closed expiry in the frontend.
// This shares the OCR path's monitor/viewport selection but runs cheap CV
// (surface_probe::analyze_surface) instead of the recognizer, so it can run on
// a fast independent cadence while the slow OCR track only supplies identity.

fn absent_surface_observation(
    probe_seq: u64,
    captured_at: f64,
    reason: &str,
    elapsed_ms: u64,
) -> surface_probe::SurfaceObservation {
    surface_probe::SurfaceObservation {
        probe_seq,
        captured_at,
        capture_width: 0,
        capture_height: 0,
        present: false,
        occluded: false,
        confidence: 0.0,
        blue_control: surface_probe::empty_blue_control(),
        cards: (0..calibration::CARD_NAME_REGIONS.len())
            .map(|region_index| surface_probe::CardObservation {
                region_index,
                present: false,
                card_rect: None,
                interior_luma: 0.0,
                interior_std: 0.0,
                frame_contrast: 0.0,
                edge_energy: 0.0,
                structural_score: 0.0,
                fingerprint: String::new(),
            })
            .collect(),
        rejection_reasons: vec![reason.to_string()],
        pre_capture_ms: elapsed_ms,
        capture_ms: 0,
        analysis_ms: 0,
        elapsed_ms,
        // Nothing measured either async-runtime segment on this path, and 0 keeps
        // the field a number (never null) so the JS decomposition attributes the
        // whole command body to the explicit unattributed residual instead.
        dispatch_wait_ms: 0,
        resume_wait_ms: 0,
    }
}

struct SurfaceCapture {
    screenshot: image::RgbaImage,
    monitor_info: calibration::MonitorInfo,
    calibration: calibration::OverlayCalibration,
    pre_capture_ms: u64,
    capture_ms: u64,
}

fn capture_surface_frame() -> Result<SurfaceCapture, String> {
    let start = std::time::Instant::now();
    // Foreground gate runs INSIDE the bounded capture (off the async runtime).
    // Its CGWindowList/window-server walk slows under sustained polling; on the
    // runtime it starved the executor so the capture timeout could not fire and
    // probes wedged >2 s (300 watchdogs / no badges in later games). Bounded here,
    // a slow walk just times out to an absent observation. `pre_capture_ms` below
    // now folds this walk in, so the trace attributes the cost to enumeration.
    if !collect_foreground_state().game_window_foreground {
        return Err("actual-game-window-not-foreground".to_string());
    }
    let monitors = monitor_snapshots()?;
    let game_window = find_league_window();
    let monitor_index = selected_monitor_index(&monitors, game_window.as_ref());
    let monitor = &monitors[monitor_index];
    let calibration = calibration::select_viewport(&monitor.info, game_window.as_ref());
    let capture_started = std::time::Instant::now();
    let pre_capture_ms = start.elapsed().as_millis() as u64;
    let screenshot = monitor
        .monitor
        .capture_image()
        .map_err(|error| format!("capture-failed: {}", error))?;

    Ok(SurfaceCapture {
        screenshot,
        monitor_info: monitor.info.clone(),
        calibration,
        pre_capture_ms,
        capture_ms: capture_started.elapsed().as_millis() as u64,
    })
}

fn capture_and_analyze_surface(
    probe_seq: u64,
    captured_at: f64,
) -> Result<surface_probe::SurfaceObservation, String> {
    let start = std::time::Instant::now();
    let captured = capture_surface_frame()?;
    let pre_capture_ms = captured.pre_capture_ms;
    let capture_ms = captured.capture_ms;
    let screenshot = captured.screenshot;
    let capture_width = screenshot.width();
    let capture_height = screenshot.height();
    // Map the calibrated LOGICAL viewport into capture-pixel space for CV, and
    // keep the LOGICAL name-band rects for chip rendering (same space the OCR
    // path publishes, so rendering geometry is unchanged).
    let viewport_px = calibration::capture_rect_for_monitor(
        &captured.calibration.viewport,
        &captured.monitor_info,
        capture_width,
        capture_height,
    );
    let name_band_rects = [
        calibration::physical_rect_for_region(
            &calibration::CARD_NAME_REGIONS[0],
            &captured.calibration.viewport,
        ),
        calibration::physical_rect_for_region(
            &calibration::CARD_NAME_REGIONS[1],
            &captured.calibration.viewport,
        ),
        calibration::physical_rect_for_region(
            &calibration::CARD_NAME_REGIONS[2],
            &captured.calibration.viewport,
        ),
    ];
    let dynamic = image::DynamicImage::ImageRgba8(screenshot);
    let analysis_started = std::time::Instant::now();
    let mut observation = surface_probe::analyze_surface(
        &dynamic,
        &viewport_px,
        &name_band_rects,
        probe_seq,
        captured_at,
        0,
    );
    observation.pre_capture_ms = pre_capture_ms;
    observation.capture_ms = capture_ms;
    observation.analysis_ms = analysis_started.elapsed().as_millis() as u64;
    observation.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(observation)
}

#[tauri::command]
async fn probe_augment_surface(
    probe_seq: u64,
    captured_at: f64,
) -> Result<surface_probe::SurfaceObservation, String> {
    let start = std::time::Instant::now();
    // The foreground gate runs INSIDE the bounded capture (capture_surface_frame)
    // so its blocking window-server enumeration cannot starve the async runtime;
    // a not-foreground result surfaces as the same absent observation via the
    // error path (reason "actual-game-window-not-foreground").
    // The two measurements below split the previously opaque in-Rust wait
    // (`elapsed_ms − (pre_capture + capture + analysis)`) into two segments with
    // DIFFERENT causes. Read them separately; they are not one "runtime wait":
    //   dispatch — command entry → this blocking closure's body begins. No
    //     SUSPENSION POINT separates `start` from the `spawn_blocking` call in
    //     run_bounded_capture_with_gate. (There ARE two syntactic `.await`s on
    //     the way — awaiting an `async fn` polls it inline within the same poll,
    //     so neither can yield; the first construct that can is the
    //     `timeout(..).await` AFTER the spawn.) Crossing this therefore needs no
    //     async worker: it is BLOCKING-POOL queue latency and should read ~0
    //     (tokio defaults to 512 blocking threads) even under total starvation.
    //   resume   — the closure's body ends → the command is about to return.
    //     Crossing this DOES require an async worker to re-poll the woken
    //     `tokio::time::timeout`, so this is the true starvation signal here.
    // Starvation BEFORE the first poll of this command future is outside
    // `elapsed_ms` altogether (Tauri spawns the future onto the runtime) and
    // lands in the JS-side `transportMs` instead.
    // Both are read off the SAME command-entry clock as `elapsed_ms`, so they are
    // sub-intervals of it and can never sum past it.
    let (observation, closure_end_ms) =
        match run_bounded_capture(CaptureChannel::Geometry, move || {
            let dispatch_wait_ms = start.elapsed().as_millis() as u64;
            let mut observation = capture_and_analyze_surface(probe_seq, captured_at)?;
            observation.dispatch_wait_ms = dispatch_wait_ms;
            let closure_end_ms = start.elapsed().as_millis() as u64;
            Ok::<_, String>((observation, closure_end_ms))
        })
        .await
        {
            Ok(captured) => captured,
            Err(error) => {
                return Ok(absent_surface_observation(
                    probe_seq,
                    captured_at,
                    &bounded_capture_reason(&error),
                    start.elapsed().as_millis() as u64,
                ));
            }
        };
    // `elapsed_ms` MUST measure command entry → return on the success path too,
    // not just the error path. `capture_and_analyze_surface` starts its own
    // timer INSIDE the spawn_blocking closure, so the interval between the
    // command being invoked and the closure actually being scheduled was
    // invisible to it. That blind spot is why a trace whose round trips reached
    // 89 s reported a flat, healthy `nativeElapsedMs` of ~600 ms and three
    // separate investigations concluded the native side was fine. With this,
    // `elapsed_ms − (pre_capture + capture + analysis)` is the in-Rust wait —
    // but do NOT read that residual as one quantity: `dispatch_wait_ms` and
    // `resume_wait_ms` above now split it, and they have different causes (see
    // the block at the top of this function). `roundTripMs − elapsed_ms` is the
    // transport wait, which includes pre-first-poll scheduling, not just IPC.
    let mut observation = observation;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    // Saturating: `closure_end_ms` and `elapsed_ms` are two reads of the same
    // monotonic clock, but truncation to whole milliseconds must never be able to
    // produce a negative (wrapped) duration.
    observation.resume_wait_ms = elapsed_ms.saturating_sub(closure_end_ms);
    observation.elapsed_ms = elapsed_ms;
    Ok(observation)
}

// ─── API Probe (check if augment data available via Live Client) ────────────

#[cfg(debug_assertions)]
#[tauri::command]
async fn probe_augment_api() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("{}", e))?;

    let mut out = String::new();

    // Full game data — search for augment-related fields
    if let Ok(resp) = client
        .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
        .send()
        .await
    {
        if let Ok(text) = resp.text().await {
            let lower = text.to_lowercase();
            if lower.contains("augment") || lower.contains("perk") || lower.contains("mayhem") {
                out.push_str("FOUND augment-related data in allgamedata:\n");
                out.push_str(&text);
            } else {
                out.push_str("allgamedata: no augment fields found\n");
                // Still log full runes section if present (augments might be under runes)
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(active) = json.get("activePlayer") {
                        if let Some(runes) = active.get("fullRunes") {
                            out.push_str("activePlayer.fullRunes:\n");
                            out.push_str(&serde_json::to_string_pretty(runes).unwrap_or_default());
                            out.push('\n');
                        }
                    }
                }
            }
        }
    } else {
        out.push_str("Live Client API not reachable (not in game?)\n");
    }

    Ok(out)
}

#[cfg(not(debug_assertions))]
#[tauri::command]
async fn probe_augment_api() -> Result<String, String> {
    Err("Augment API probe is available in debug builds only.".to_string())
}

// ─── Dock & Settings Commands ───────────────────────────────────────────────

/// Hide app from Dock (accessory mode — no Dock icon, no menu bar)
#[tauri::command]
fn set_dock_visible(visible: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        use cocoa::appkit::NSApplicationActivationPolicy;
        let app: cocoa::base::id = objc::msg_send![objc::class!(NSApplication), sharedApplication];
        let policy = if visible {
            NSApplicationActivationPolicy::NSApplicationActivationPolicyRegular
        } else {
            NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory
        };
        let _: () = objc::msg_send![app, setActivationPolicy: policy];
    }
}

/// Toggle mouse event pass-through on the overlay window
#[tauri::command]
fn set_click_through(app: tauri::AppHandle, ignore: bool) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("overlay") {
            let ns_win_ptr = window.ns_window().unwrap();
            unsafe {
                use cocoa::appkit::NSWindow;
                let ns_win = ns_win_ptr as cocoa::base::id;
                ns_win.setIgnoresMouseEvents_(if ignore {
                    cocoa::base::YES
                } else {
                    cocoa::base::NO
                });
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("overlay") {
            if let Ok(hwnd) = window.hwnd() {
                // `WS_EX_TRANSPARENT` makes the layered window pass mouse input
                // to the game; the always-on tool-window/layered/no-activate
                // bits are re-asserted at the same time.
                overlay_window::apply_overlay_ex_styles(hwnd, ignore);
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (&app, ignore);
}

#[derive(Clone, Default)]
struct FrontmostApplication {
    app_name: Option<String>,
    bundle_identifier: Option<String>,
    process_id: Option<u32>,
    executable_path: Option<String>,
    window_handle: Option<u64>,
}

#[cfg(target_os = "macos")]
unsafe fn ns_string_value(value: cocoa::base::id) -> Option<String> {
    use std::ffi::CStr;

    if value.is_null() {
        return None;
    }
    let ptr = cocoa::foundation::NSString::UTF8String(value);
    if ptr.is_null() {
        return None;
    }
    let value = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
fn running_application(process_id: u32) -> FrontmostApplication {
    unsafe {
        let application: cocoa::base::id = objc::msg_send![
            objc::class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: process_id as i32
        ];
        if application.is_null() {
            return FrontmostApplication::default();
        }

        let app_name: cocoa::base::id = objc::msg_send![application, localizedName];
        let bundle_identifier: cocoa::base::id = objc::msg_send![application, bundleIdentifier];
        let executable_url: cocoa::base::id = objc::msg_send![application, executableURL];
        let executable_path = if executable_url.is_null() {
            None
        } else {
            let path: cocoa::base::id = objc::msg_send![executable_url, path];
            ns_string_value(path)
        };

        FrontmostApplication {
            app_name: ns_string_value(app_name),
            bundle_identifier: ns_string_value(bundle_identifier),
            process_id: Some(process_id),
            executable_path,
            window_handle: None,
        }
    }
}

#[cfg(target_os = "macos")]
fn workspace_frontmost_application() -> FrontmostApplication {
    unsafe {
        let workspace: cocoa::base::id =
            objc::msg_send![objc::class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return FrontmostApplication::default();
        }

        let application: cocoa::base::id = objc::msg_send![workspace, frontmostApplication];
        if application.is_null() {
            return FrontmostApplication::default();
        }

        let process_id: i32 = objc::msg_send![application, processIdentifier];
        if process_id <= 0 {
            return FrontmostApplication::default();
        }
        running_application(process_id as u32)
    }
}

#[cfg(target_os = "macos")]
unsafe fn cf_dictionary_value(
    dictionary: &core_foundation::dictionary::CFDictionary,
    key: &'static str,
) -> *const std::ffi::c_void {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionaryGetValueIfPresent, CFDictionaryRef};
    use core_foundation::string::CFString;

    let key = CFString::from_static_string(key);
    let mut value = std::ptr::null();
    let _ = CFDictionaryGetValueIfPresent(
        dictionary.as_CFTypeRef() as CFDictionaryRef,
        key.as_CFTypeRef() as *const std::ffi::c_void,
        &mut value,
    );
    value
}

#[cfg(target_os = "macos")]
unsafe fn cf_string_dictionary_value(
    dictionary: &core_foundation::dictionary::CFDictionary,
    key: &'static str,
) -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    let value = cf_dictionary_value(dictionary, key);
    (!value.is_null()).then(|| CFString::wrap_under_get_rule(value as CFStringRef).to_string())
}

#[cfg(target_os = "macos")]
unsafe fn cf_i32_dictionary_value(
    dictionary: &core_foundation::dictionary::CFDictionary,
    key: &'static str,
) -> Option<i32> {
    use core_foundation::base::TCFType;
    use core_foundation::number::{CFNumber, CFNumberRef};

    let value = cf_dictionary_value(dictionary, key);
    (!value.is_null())
        .then(|| CFNumber::wrap_under_get_rule(value as CFNumberRef).to_i32())
        .flatten()
}

#[cfg(target_os = "macos")]
unsafe fn cf_f64_dictionary_value(
    dictionary: &core_foundation::dictionary::CFDictionary,
    key: &'static str,
) -> Option<f64> {
    use core_foundation::base::TCFType;
    use core_foundation::number::{CFNumber, CFNumberRef};

    let value = cf_dictionary_value(dictionary, key);
    (!value.is_null())
        .then(|| CFNumber::wrap_under_get_rule(value as CFNumberRef).to_f64())
        .flatten()
}

#[cfg(target_os = "macos")]
unsafe fn cf_window_bounds_size(
    dictionary: &core_foundation::dictionary::CFDictionary,
) -> (f64, f64) {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};

    let value = cf_dictionary_value(dictionary, "kCGWindowBounds");
    if value.is_null() {
        return (0.0, 0.0);
    }
    let bounds =
        CFDictionary::<*const std::ffi::c_void, *const std::ffi::c_void>::wrap_under_get_rule(
            value as CFDictionaryRef,
        );
    (
        cf_f64_dictionary_value(&bounds, "Width").unwrap_or(0.0),
        cf_f64_dictionary_value(&bounds, "Height").unwrap_or(0.0),
    )
}

#[cfg(target_os = "macos")]
#[cfg_attr(not(debug_assertions), allow(dead_code))]
struct ForegroundAnalysis {
    frontmost: FrontmostApplication,
    owner_name: Option<String>,
    window_title: Option<String>,
    game_window_detected: bool,
    workspace: FrontmostApplication,
    /// False when the z-order walk made the NSWorkspace read unnecessary, so a
    /// default `workspace` is a skipped read rather than an empty result.
    workspace_consulted: bool,
    /// Cost of the CGWindowList walk plus per-PID identity resolution. Paired
    /// with the process-scan cost so a slow poll says WHICH half was slow
    /// instead of leaving it to be guessed.
    walk_ms: u64,
    candidates: Vec<foreground::WindowCandidate>,
    verdicts: Vec<&'static str>,
    selected_process_id: Option<u32>,
    effective_process_id: Option<u32>,
    decision_reason: &'static str,
}

/// One complete foreground poll: walk `CGWindowList` front-to-back, resolve
/// every owner PID to its process identity, and pick the z-order authority
/// via `foreground::select_frontmost_window`.
///
/// Grounded rules (2026-07-17, observed live on this machine):
/// - The real game window carries an EMPTY `kCGWindowName`, so game identity
///   comes ONLY from the owner PID's bundle/executable — never the title.
/// - LeagueClientUx's window owner name is "League of Legends"; names cannot
///   distinguish client from game.
/// - A borderless game surface may sit at an elevated window layer; the game
///   process is the only owner that may grant foreground from there.
/// - NSWorkspace.frontmostApplication read off the main thread can freeze
///   indefinitely; it is only a fallback when the walk yields NO candidate.
#[cfg(target_os = "macos")]
fn analyze_foreground(consult_workspace: bool) -> ForegroundAnalysis {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_graphics::window::{
        copy_window_info, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    };
    use std::collections::HashMap;

    let walk_started = std::time::Instant::now();
    let own_process_id = std::process::id();

    let mut candidates: Vec<foreground::WindowCandidate> = Vec::new();
    let mut applications: HashMap<u32, FrontmostApplication> = HashMap::new();

    if let Some(windows) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        0,
    ) {
        for window_ref in windows.get_all_values() {
            if window_ref.is_null() {
                continue;
            }
            let window = unsafe {
                CFDictionary::<*const std::ffi::c_void, *const std::ffi::c_void>::wrap_under_get_rule(
                    window_ref as *const _,
                )
            };
            let process_id = unsafe { cf_i32_dictionary_value(&window, "kCGWindowOwnerPID") }
                .and_then(|value| (value > 0).then_some(value as u32));
            let application = process_id.map(|pid| {
                applications
                    .entry(pid)
                    .or_insert_with(|| running_application(pid))
                    .clone()
            });
            let (width, height) = unsafe { cf_window_bounds_size(&window) };
            let is_own_process = process_id == Some(own_process_id)
                || application
                    .as_ref()
                    .and_then(|app| app.bundle_identifier.as_deref())
                    .is_some_and(|bundle| bundle == "com.mayhem-oracle.overlay");
            let is_game_process = application.as_ref().is_some_and(|app| {
                foreground::is_game_owner(
                    app.bundle_identifier.as_deref(),
                    app.executable_path.as_deref(),
                )
            });
            candidates.push(foreground::WindowCandidate {
                window_number: unsafe { cf_i32_dictionary_value(&window, "kCGWindowNumber") },
                layer: unsafe { cf_i32_dictionary_value(&window, "kCGWindowLayer") },
                alpha: unsafe { cf_f64_dictionary_value(&window, "kCGWindowAlpha") },
                width,
                height,
                process_id,
                owner_name: unsafe { cf_string_dictionary_value(&window, "kCGWindowOwnerName") },
                title: unsafe { cf_string_dictionary_value(&window, "kCGWindowName") },
                is_own_process,
                is_game_process,
            });
        }
    }

    // A window owned by the actual game process (any layer, any size) proves
    // the game surface exists on-screen. Titles are useless here (empty).
    let game_window_detected = candidates.iter().any(|candidate| candidate.is_game_process);

    let selection = foreground::select_frontmost_window(&candidates);
    let selected = selection.selected_index.map(|index| &candidates[index]);
    let selected_process_id = selected.and_then(|candidate| candidate.process_id);

    // Read NSWorkspace only where a consumer below can observe it (see
    // `workspace_read_required`). This is the freeze-prone main-thread-only
    // call, and `collect_foreground_state` reaches it from capture workers too.
    let workspace_consulted = workspace_read_required(selected_process_id, consult_workspace);
    let workspace_application = if workspace_consulted {
        workspace_frontmost_application()
    } else {
        FrontmostApplication::default()
    };

    let effective_process_id =
        foreground::effective_frontmost_pid(selected_process_id, workspace_application.process_id);
    let decision_reason = if selection.selected_index.is_some() {
        selection.reason
    } else if workspace_application.process_id.is_some() {
        "workspace-fallback-no-zorder-candidates"
    } else {
        "no-foreground-evidence"
    };

    let frontmost = match effective_process_id {
        Some(pid) if Some(pid) == selected_process_id => applications
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| running_application(pid)),
        _ => workspace_application.clone(),
    };

    // Owner/title metadata only ever describes the effective front window.
    let (owner_name, window_title) = match selected {
        Some(candidate) if effective_process_id == selected_process_id => (
            candidate
                .owner_name
                .clone()
                .filter(|value| !value.is_empty()),
            candidate.title.clone().filter(|value| !value.is_empty()),
        ),
        _ => (None, None),
    };

    ForegroundAnalysis {
        frontmost,
        owner_name,
        window_title,
        game_window_detected,
        workspace: workspace_application,
        workspace_consulted,
        walk_ms: walk_started.elapsed().as_millis() as u64,
        candidates,
        verdicts: selection.verdicts,
        selected_process_id,
        effective_process_id,
        decision_reason,
    }
}

#[cfg(target_os = "macos")]
fn foreground_window_metadata() -> (FrontmostApplication, Option<String>, Option<String>, bool) {
    let analysis = analyze_foreground(false);
    (
        analysis.frontmost,
        analysis.owner_name,
        analysis.window_title,
        analysis.game_window_detected,
    )
}

#[cfg(all(target_os = "macos", debug_assertions))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundCandidateReport {
    #[serde(flatten)]
    pub window: foreground::WindowCandidate,
    pub verdict: &'static str,
}

#[cfg(all(target_os = "macos", debug_assertions))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundPollDiagnostic {
    pub own_process_id: u32,
    pub workspace_process_id: Option<u32>,
    pub workspace_app_name: Option<String>,
    pub workspace_bundle_identifier: Option<String>,
    pub workspace_executable_path: Option<String>,
    pub candidates: Vec<ForegroundCandidateReport>,
    pub selected_process_id: Option<u32>,
    pub effective_process_id: Option<u32>,
    pub decision_reason: &'static str,
    pub state: foreground::ForegroundState,
    /// Cost attribution for one poll: the window walk, the process-table scan,
    /// and whether that scan was served from the presence cache. Numeric only.
    pub walk_ms: u64,
    pub process_scan_ms: u64,
    pub process_scan_cached: bool,
    pub workspace_consulted: bool,
}

/// DEVELOPMENT-ONLY full dump of one foreground poll: every window candidate
/// with its exclusion verdict, the (possibly stale) NSWorkspace value, the
/// selected z-order authority, and the resulting classification. Compiled
/// out of release builds entirely — production never exposes process/window
/// metadata.
#[cfg(all(target_os = "macos", debug_assertions))]
pub fn foreground_poll_diagnostic() -> ForegroundPollDiagnostic {
    // `true`: the dump's whole diagnostic value is comparing the z-order
    // authority against the REAL NSWorkspace value — that comparison is what
    // identified the stale-frontmost leak. The hot path skips the read; this
    // path must not.
    let analysis = analyze_foreground(true);
    let process_scan_started = std::time::Instant::now();
    let game_running = game_process_running();
    let process_scan_ms = process_scan_started.elapsed().as_millis() as u64;
    let state = foreground::classify_foreground(foreground::ForegroundObservation {
        app_name: analysis.frontmost.app_name.as_deref(),
        bundle_identifier: analysis.frontmost.bundle_identifier.as_deref(),
        owner_name: analysis.owner_name.as_deref(),
        window_title: analysis.window_title.as_deref(),
        executable_path: analysis.frontmost.executable_path.as_deref(),
        window_handle: analysis.frontmost.window_handle,
        game_running,
        game_window_detected: analysis.game_window_detected,
    });
    ForegroundPollDiagnostic {
        own_process_id: std::process::id(),
        workspace_process_id: analysis.workspace.process_id,
        workspace_app_name: analysis.workspace.app_name,
        workspace_bundle_identifier: analysis.workspace.bundle_identifier,
        workspace_executable_path: analysis.workspace.executable_path,
        candidates: analysis
            .candidates
            .into_iter()
            .zip(analysis.verdicts)
            .map(|(window, verdict)| ForegroundCandidateReport { window, verdict })
            .collect(),
        selected_process_id: analysis.selected_process_id,
        effective_process_id: analysis.effective_process_id,
        decision_reason: analysis.decision_reason,
        state,
        walk_ms: analysis.walk_ms,
        workspace_consulted: analysis.workspace_consulted,
        process_scan_ms,
        // A sub-millisecond scan is a cache hit; a real `System::new_all` walk
        // is orders of magnitude slower.
        process_scan_cached: process_scan_ms == 0,
    }
}

#[tauri::command]
fn get_foreground_diagnostic() -> Result<serde_json::Value, String> {
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        return serde_json::to_value(foreground_poll_diagnostic())
            .map_err(|error| error.to_string());
    }
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        Err("foreground diagnostic is development-only".to_string())
    }
}

#[cfg(target_os = "windows")]
fn windows_foreground_metadata() -> (FrontmostApplication, Option<String>, Option<String>, bool) {
    use std::path::Path;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    fn executable_path(process_id: u32) -> Option<String> {
        let process =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
        let mut buffer = [0u16; 32_768];
        let mut length = buffer.len() as u32;
        let result = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .is_ok()
        };
        unsafe {
            let _ = CloseHandle(process);
        }
        result.then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    fn window_title(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
        let mut buffer = [0u16; 1_024];
        let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return (FrontmostApplication::default(), None, None, false);
    }

    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return (
            FrontmostApplication::default(),
            None,
            window_title(hwnd),
            false,
        );
    }

    let executable_path = executable_path(process_id);
    let process_name = executable_path
        .as_deref()
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|name| name.to_str())
        .map(str::to_string);
    let title = window_title(hwnd);
    let game_window_detected = process_name
        .as_deref()
        .is_some_and(|name| foreground::is_actual_game_process(name, executable_path.as_deref()));
    let application = FrontmostApplication {
        app_name: process_name.clone(),
        bundle_identifier: None,
        process_id: Some(process_id),
        executable_path,
        window_handle: Some(hwnd.0 as usize as u64),
    };

    (application, process_name, title, game_window_detected)
}

/// How long a game-process-presence reading stays usable.
///
/// `game_process_running` enumerates the FULL process table
/// (`sysinfo::System::new_all`). At the previous 250 ms foreground cadence that
/// ran four times a second, inline on the IPC/main thread for
/// `get_foreground_state` and on every capture worker for
/// `capture_surface_frame`.
///
/// Caching it is authority-neutral by construction: `classify_foreground` never
/// reads `observation.game_running` when computing `game_window_foreground` —
/// it is copied straight through to the `game_running` diagnostic field — and
/// the visual gate is `gameWindowForeground || previewMode`. A cached positive
/// therefore cannot authorize capture, because an uncached positive cannot
/// either. Presence changes only when the game launches or exits, a
/// minutes-scale event, so 5 s cannot make the diagnostic misleading. Negatives
/// are cached on exactly the same terms; the cache is not asymmetric.
const PROCESS_PRESENCE_TTL: Duration = Duration::from_millis(5_000);

static PROCESS_PRESENCE_CACHE: std::sync::Mutex<Option<(std::time::Instant, bool)>> =
    std::sync::Mutex::new(None);

/// The cached reading, or `None` when a fresh scan is required.
fn cached_process_presence(
    cache: Option<(std::time::Instant, bool)>,
    now: std::time::Instant,
    ttl: Duration,
) -> Option<bool> {
    cache.and_then(|(stamp, value)| (now.duration_since(stamp) < ttl).then_some(value))
}

fn game_process_running() -> bool {
    let cached = {
        let guard = PROCESS_PRESENCE_CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard
    };
    if let Some(value) =
        cached_process_presence(cached, std::time::Instant::now(), PROCESS_PRESENCE_TTL)
    {
        return value;
    }

    // The lock is deliberately NOT held across the enumeration. Concurrent
    // callers (the foreground command on the main thread plus up to
    // MAX_CONCURRENT_CAPTURES workers per channel) would otherwise serialize
    // behind the slowest process-table walk — trading a cheap duplicate scan
    // for exactly the head-of-line blocking this cache exists to remove.
    let system = sysinfo::System::new_all();
    let running = system.processes().values().any(|process| {
        let name = process.name().to_string_lossy();
        let executable_path = process.exe().map(|path| path.to_string_lossy());
        foreground::is_actual_game_process(&name, executable_path.as_deref())
    });

    let mut guard = PROCESS_PRESENCE_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *guard = Some((std::time::Instant::now(), running));
    running
}

/// Whether the NSWorkspace frontmost application has to be read.
///
/// The z-order authority from `CGWindowListCopyWindowInfo` decides whenever any
/// candidate window exists; NSWorkspace is documented (and regression-pinned in
/// `foreground::effective_frontmost_pid`) as a fallback for the no-candidate
/// case only. Reading it unconditionally put a main-thread-only Cocoa call that
/// can freeze indefinitely into every poll AND every capture worker, since
/// `collect_foreground_state` also runs off the main thread inside
/// `capture_surface_frame`. Skipping it when a candidate PID exists is
/// classification-identical: `effective_frontmost_pid` returns the selected PID,
/// `decision_reason` takes the z-order branch, and `frontmost` resolves from the
/// candidate's application entry.
fn workspace_read_required(selected_process_id: Option<u32>, consult_for_diagnostic: bool) -> bool {
    consult_for_diagnostic || selected_process_id.is_none()
}

#[cfg(test)]
mod foreground_poll_cost_tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn cached_process_presence_is_reused_inside_the_ttl() {
        let now = Instant::now();
        let cache = Some((now, true));
        assert_eq!(
            cached_process_presence(
                cache,
                now + Duration::from_millis(4_999),
                PROCESS_PRESENCE_TTL
            ),
            Some(true)
        );
    }

    #[test]
    fn cached_process_presence_expires_after_the_ttl() {
        let now = Instant::now();
        let cache = Some((now, true));
        assert_eq!(
            cached_process_presence(cache, now + PROCESS_PRESENCE_TTL, PROCESS_PRESENCE_TTL),
            None
        );
    }

    #[test]
    fn cached_process_presence_is_absent_before_the_first_scan() {
        assert_eq!(
            cached_process_presence(None, Instant::now(), PROCESS_PRESENCE_TTL),
            None
        );
    }

    #[test]
    fn cached_process_presence_caches_a_negative_identically() {
        // An asymmetric cache (positives only) would let a stale "game running"
        // survive an exit while a "not running" rescanned constantly. Presence
        // authorizes nothing either way, so both directions expire together.
        let now = Instant::now();
        assert_eq!(
            cached_process_presence(Some((now, false)), now, PROCESS_PRESENCE_TTL),
            Some(false)
        );
    }

    #[test]
    fn workspace_read_is_required_when_the_zorder_walk_found_no_candidate() {
        assert!(workspace_read_required(None, false));
    }

    #[test]
    fn workspace_read_is_skipped_when_a_zorder_candidate_owns_the_front_window() {
        assert!(!workspace_read_required(Some(4242), false));
    }

    #[test]
    fn workspace_read_is_always_performed_for_the_dev_diagnostic() {
        // The DEV dump compares the z-order authority against the real
        // NSWorkspace value; that comparison is what pinned the 13:33:54 stale
        // frontmost leak, so the diagnostic must never report a placeholder.
        assert!(workspace_read_required(Some(4242), true));
    }
}

fn collect_foreground_state() -> foreground::ForegroundState {
    #[cfg(target_os = "macos")]
    {
        let (frontmost, owner_name, window_title, game_window_detected) =
            foreground_window_metadata();
        return foreground::classify_foreground(foreground::ForegroundObservation {
            app_name: frontmost.app_name.as_deref(),
            bundle_identifier: frontmost.bundle_identifier.as_deref(),
            owner_name: owner_name.as_deref(),
            window_title: window_title.as_deref(),
            executable_path: frontmost.executable_path.as_deref(),
            window_handle: frontmost.window_handle,
            game_running: game_process_running(),
            game_window_detected,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let (frontmost, owner_name, window_title, game_window_detected) =
            windows_foreground_metadata();
        return foreground::classify_foreground(foreground::ForegroundObservation {
            app_name: frontmost.app_name.as_deref(),
            bundle_identifier: frontmost.bundle_identifier.as_deref(),
            owner_name: owner_name.as_deref(),
            window_title: window_title.as_deref(),
            executable_path: frontmost.executable_path.as_deref(),
            window_handle: frontmost.window_handle,
            game_running: game_process_running(),
            game_window_detected,
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        foreground::ForegroundState::default()
    }
}

/// Returns the native foreground app/window classification used for all visual
/// overlay gates. Game-running and game-window-detected are diagnostics only.
#[tauri::command]
fn get_foreground_state() -> foreground::ForegroundState {
    collect_foreground_state()
}

/// Returns true only when the actual League game process/window is foreground.
#[tauri::command]
fn is_league_foreground() -> bool {
    collect_foreground_state().game_window_foreground
}

/// Open macOS System Settings → Privacy → Screen Recording
#[tauri::command]
fn open_screen_recording_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

// ─── Async-Runtime Heartbeat (dev-only instrument) ──────────────────────────
// Phase 1 proved the geometry probe's lost time sits entirely in the segments
// that need a TOKIO ASYNC-RUNTIME WORKER TO POLL A TASK, and that the build
// carries no instrument that can observe the runtime itself. This heartbeat is
// that instrument: it is an ordinary async task on the SAME runtime the
// `#[tauri::command] async fn`s run on, so the drift of its fixed tick IS the
// scheduling latency of that runtime, measured independently of any capture.
//
// It must be `tauri::async_runtime::spawn` + `tokio::time::sleep`. A thread with
// `std::thread::sleep` would stay perfectly on time while the runtime burned and
// would therefore measure nothing.
//
// Emission is throttled to at most once per second and aggregates the ticks in
// between; the payload is bounded numerics only (privacy-safe, no names, text,
// paths, or account identifiers). Compiled out of release builds, mirroring
// `emit_overlay_diagnostic`.

/// Fixed heartbeat tick. Matches the geometry probe cadence so the drift is read
/// on the same scale as the work it competes with.
#[cfg(debug_assertions)]
const HEARTBEAT_TICK_MS: u64 = 250;
/// Aggregation window — one emission per second, never one line per tick.
#[cfg(debug_assertions)]
const HEARTBEAT_REPORT_MS: u64 = 1000;

#[cfg(debug_assertions)]
fn spawn_async_runtime_heartbeat() {
    tauri::async_runtime::spawn(async move {
        let mut window_started = std::time::Instant::now();
        let mut last_tick = window_started;
        let mut ticks: u64 = 0;
        let mut max_drift_ms: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(HEARTBEAT_TICK_MS)).await;
            let now = std::time::Instant::now();
            // Saturating throughout: this loop must never panic and never block.
            let observed_ms = now.duration_since(last_tick).as_millis() as u64;
            last_tick = now;
            let last_drift_ms = observed_ms.saturating_sub(HEARTBEAT_TICK_MS);
            max_drift_ms = max_drift_ms.max(last_drift_ms);
            ticks = ticks.saturating_add(1);

            let elapsed_ms = now.duration_since(window_started).as_millis() as u64;
            if elapsed_ms >= HEARTBEAT_REPORT_MS {
                eprintln!(
                    "[async-runtime-heartbeat] {{\"intervalMs\":{},\"ticks\":{},\
                     \"expectedTicks\":{},\"maxDriftMs\":{},\"lastDriftMs\":{},\
                     \"elapsedMs\":{}}}",
                    HEARTBEAT_TICK_MS,
                    ticks,
                    elapsed_ms / HEARTBEAT_TICK_MS,
                    max_drift_ms,
                    last_drift_ms,
                    elapsed_ms
                );
                window_started = now;
                ticks = 0;
                max_drift_ms = 0;
            }
        }
    });
}

#[cfg(not(debug_assertions))]
fn spawn_async_runtime_heartbeat() {}

// ─── App Entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Per-Monitor DPI Awareness V2 must be set before any window/monitor
    // geometry is read so xcap and the overlay window agree on physical pixels
    // across mixed-DPI monitors (100–200% scaling). No-op on non-Windows.
    #[cfg(target_os = "windows")]
    overlay_window::set_process_dpi_aware_v2();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_league_client,
            emit_overlay_diagnostic,
            get_game_phase,
            get_lcu_gameflow_state,
            get_game_hash,
            get_live_player_data,
            check_ocr,
            check_screen_capture_available,
            detect_augment_names,
            probe_augment_surface,
            get_overlay_calibration,
            probe_augment_api,
            set_dock_visible,
            set_click_through,
            open_screen_recording_settings,
            get_foreground_state,
            get_foreground_diagnostic,
            is_league_foreground,
            collector::get_collector_status,
            collector::set_collector_consent,
            collector::set_collector_paused,
            collector::record_contributor_round,
            collector::confirm_contributor_round_selection,
            collector::collector_tick,
            member::member_bootstrap,
            member::member_game_start,
        ])
        .setup(|app| {
            use tauri::Manager;

            let collector_state = collector::CollectorState::new(app.path().app_data_dir()?)
                .map_err(std::io::Error::other)?;
            app.manage(collector_state);
            let member_state = member::MemberState::new(app.path().app_data_dir()?.join("member-models"))
                .map_err(std::io::Error::other)?;
            app.manage(member_state);

            // Dev-only async-runtime starvation instrument (see above). No-op in
            // release builds.
            spawn_async_runtime_heartbeat();

            // ─── System Tray Icon ──────────────────────────────────────
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;

                let quit_item = MenuItem::with_id(app, "quit", "Exit Mayhem Oracle", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&quit_item])?;

                let mut tray_builder = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Mayhem Oracle\n⌘Q disabled — right-click to exit\nOr ⌘⌥⎋ → Force Quit")
                    .on_menu_event(|app, event| {
                        if event.id.as_ref() == "quit" {
                            app.exit(0);
                        }
                    });

                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }

                tray_builder.build(app)?;
            }

            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let window = app.get_webview_window("overlay")
                    .expect("overlay window not found");

                let ns_win_ptr = window.ns_window().unwrap();

                // Hide from Dock — make this a pure background overlay
                unsafe {
                    use cocoa::appkit::NSApplicationActivationPolicy;
                    let app_ptr: cocoa::base::id = objc::msg_send![objc::class!(NSApplication), sharedApplication];
                    let _: () = objc::msg_send![app_ptr, setActivationPolicy: NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory];
                }

                // Initial setup — overlay covering full screen
                unsafe {
                    use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
                    let ns_win = ns_win_ptr as cocoa::base::id;

                    // Cover the full screen without native fullscreen
                    let main_screen: cocoa::base::id = msg_send![objc::class!(NSScreen), mainScreen];
                    let frame: cocoa::foundation::NSRect = msg_send![main_screen, frame];
                    ns_win.setFrame_display_(frame, cocoa::base::YES);

                    // 2147483639 = INT32_MAX - 8; 10 above League fullscreen level (2147483629)
                    // Required for true macOS fullscreen — borderless windowed only needs 1500
                    ns_win.setLevel_(2147483639);
                    ns_win.setCollectionBehavior_(
                        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                    );
                    ns_win.setIgnoresMouseEvents_(cocoa::base::YES);
                    ns_win.setHidesOnDeactivate_(cocoa::base::NO);
                }

                // Window-lifecycle audit log (fix #7). There is exactly ONE native
                // overlay window: created here from tauri.conf.json and NEVER
                // repositioned, hidden, or destroyed at runtime on macOS. All
                // calibration/collector/badge/debug surfaces are React components
                // inside this single window, so "duplicate" panels or "ghost"
                // badges can only be DOM state, never extra native windows. The
                // window ignores mouse events natively → fully click-through.
                eprintln!(
                    "[overlay-window] created single native window \"overlay\" \
                     (macOS full-screen, level=2147483639, ignoresMouseEvents=YES, \
                     never repositioned/hidden/destroyed at runtime)"
                );

                // Re-assert level every 5s — game windows can temporarily jump above us
                // during mode switches. Fetches ns_window fresh on main thread each time
                // to avoid retaining a stale raw pointer across the thread boundary.
                let win = app.get_webview_window("overlay").unwrap();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let win_ref = win.clone();
                        let _ = win.run_on_main_thread(move || {
                            if let Ok(ptr) = win_ref.ns_window() {
                                unsafe {
                                    use cocoa::appkit::NSWindow;
                                    let ns_win = ptr as cocoa::base::id;
                                    ns_win.setLevel_(2147483639);
                                    let _: () = objc::msg_send![ns_win, orderFrontRegardless];
                                }
                            }
                        });
                    }
                });

            }

            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let window = app
                    .get_webview_window("overlay")
                    .expect("overlay window not found");

                // Assert the transparent / click-through / non-activating /
                // tool-window styles once at startup, then set the initial
                // z-order from the current foreground owner.
                if let Ok(hwnd) = window.hwnd() {
                    overlay_window::apply_overlay_ex_styles(hwnd, true);
                    overlay_window::apply_overlay_topmost(
                        hwnd,
                        collect_foreground_state().game_window_foreground,
                    );
                }

                // Window-lifecycle audit log (fix #7). Exactly ONE native
                // overlay window: created from tauri.conf.json, only ever
                // restyled/repositioned here and in apply_overlay_window_bounds,
                // never created or destroyed at runtime. The single window is
                // click-through (WS_EX_TRANSPARENT) and never activates
                // (WS_EX_NOACTIVATE), so it cannot steal League input.
                eprintln!(
                    "[overlay-window] created single native window \"overlay\" \
                     (Windows layered, click-through, no-activate, tool-window; \
                     topmost only while League is foreground)"
                );

                // Re-assert styles and follow the foreground owner's z-order.
                // WebView2 can reset extended styles, and dropping HWND_TOPMOST
                // when League is not foreground keeps the overlay from floating
                // over unrelated applications after an Alt+Tab. Handle work runs
                // on the main thread, mirroring the macOS re-assert loop.
                let win = window.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let game_foreground = collect_foreground_state().game_window_foreground;
                    let win_ref = win.clone();
                    let _ = win.run_on_main_thread(move || {
                        if let Ok(hwnd) = win_ref.hwnd() {
                            overlay_window::apply_overlay_ex_styles(hwnd, true);
                            overlay_window::apply_overlay_topmost(hwnd, game_foreground);
                        }
                    });
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
