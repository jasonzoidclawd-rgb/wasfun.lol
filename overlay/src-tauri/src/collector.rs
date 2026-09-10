use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::lcu::{discover_lcu_credentials, normalize_gameflow_phase, LeagueClientCredentials};
use crate::sanitize::{sanitize_match, ContributorRound, MatchSource};
use crate::upload_queue::UploadQueue;

pub const DAILY_EXPORT_LIMIT: u16 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameflowPhase {
    None,
    InProgress,
}

impl GameflowPhase {
    fn from_lcu(value: &str) -> Self {
        if normalize_gameflow_phase(Some(value)).blocks_background_collection {
            Self::InProgress
        } else {
            Self::None
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CollectionPolicy {
    pub consented: bool,
    pub paused: bool,
    pub exported_today: u16,
}

impl CollectionPolicy {
    pub fn may_collect(&self, phase: GameflowPhase) -> bool {
        self.consented
            && !self.paused
            && self.exported_today < DAILY_EXPORT_LIMIT
            && phase != GameflowPhase::InProgress
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectorSettings {
    consent: Option<bool>,
    paused: bool,
    export_date: String,
    exported_today: u16,
}

impl Default for CollectorSettings {
    fn default() -> Self {
        Self {
            consent: None,
            paused: false,
            export_date: today(),
            exported_today: 0,
        }
    }
}

impl CollectorSettings {
    fn refresh_day(&mut self) {
        let today = today();
        if self.export_date != today {
            self.export_date = today;
            self.exported_today = 0;
        }
    }

    fn policy(&self) -> CollectionPolicy {
        CollectionPolicy {
            consented: self.consent == Some(true),
            paused: self.paused,
            exported_today: self.exported_today,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorStatus {
    consent: &'static str,
    paused: bool,
    active_game: bool,
    exported_today: u16,
    daily_limit: u16,
    queued_batches: usize,
    last_error: Option<String>,
}

#[derive(Clone, Debug)]
struct CapturedRound {
    round: u8,
    offered_augment_slugs: Vec<String>,
    selected_augment_slug: Option<String>,
    ocr_confidence: f64,
    captured_at_epoch_ms: i64,
}

#[derive(Clone, Debug)]
struct HistoryWork {
    puuid: String,
    source: MatchSource,
}

#[derive(Clone, Debug)]
struct MatchWork {
    game_id: String,
    source: MatchSource,
}

#[derive(Default)]
struct CollectorRuntime {
    contributor_puuid: Option<String>,
    history_frontier: VecDeque<HistoryWork>,
    match_frontier: VecDeque<MatchWork>,
    seen_puuids: HashSet<String>,
    seen_games: HashSet<String>,
    captured_rounds: BTreeMap<u8, CapturedRound>,
    #[cfg(debug_assertions)]
    shape_probed_games: HashSet<String>,
}

impl CollectorRuntime {
    fn enqueue_history(&mut self, puuid: String, source: MatchSource) {
        if self.seen_puuids.insert(puuid.clone()) {
            self.history_frontier
                .push_back(HistoryWork { puuid, source });
        }
    }

    fn enqueue_match(&mut self, game_id: String, source: MatchSource) {
        if self.seen_games.insert(game_id.clone()) {
            self.match_frontier.push_back(MatchWork { game_id, source });
        }
    }
}

pub struct CollectorState {
    settings_path: PathBuf,
    settings: Mutex<CollectorSettings>,
    runtime: tokio::sync::Mutex<CollectorRuntime>,
    queue: UploadQueue,
    active_game: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl CollectorState {
    pub fn new(data_directory: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
        let settings_path = data_directory.join("collector-settings.json");
        let settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let queue = UploadQueue::new(data_directory.join("telemetry-queue"))?;

        Ok(Self {
            settings_path,
            settings: Mutex::new(settings),
            runtime: tokio::sync::Mutex::new(CollectorRuntime::default()),
            queue,
            active_game: AtomicBool::new(false),
            last_error: Mutex::new(None),
        })
    }

    fn status(&self) -> CollectorStatus {
        let mut settings = self
            .settings
            .lock()
            .expect("collector settings mutex poisoned");
        settings.refresh_day();
        CollectorStatus {
            consent: match settings.consent {
                None => "pending",
                Some(true) => "accepted",
                Some(false) => "declined",
            },
            paused: settings.paused,
            active_game: self.active_game.load(Ordering::Relaxed),
            exported_today: settings.exported_today,
            daily_limit: DAILY_EXPORT_LIMIT,
            queued_batches: self.queue.queued_count(),
            last_error: self
                .last_error
                .lock()
                .expect("collector error mutex poisoned")
                .clone(),
        }
    }

    fn consented_and_resumed(&self) -> bool {
        self.settings
            .lock()
            .map(|settings| settings.consent == Some(true) && !settings.paused)
            .unwrap_or(false)
    }

    fn update_settings(&self, update: impl FnOnce(&mut CollectorSettings)) -> Result<(), String> {
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "collector settings mutex poisoned".to_string())?;
        settings.refresh_day();
        update(&mut settings);
        let bytes = serde_json::to_vec(&*settings).map_err(|error| error.to_string())?;
        std::fs::write(&self.settings_path, bytes).map_err(|error| error.to_string())
    }

    fn reserve_export_slot(&self) -> Result<bool, String> {
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "collector settings mutex poisoned".to_string())?;
        settings.refresh_day();
        if settings.exported_today >= DAILY_EXPORT_LIMIT {
            return Ok(false);
        }
        settings.exported_today += 1;
        let bytes = serde_json::to_vec(&*settings).map_err(|error| error.to_string())?;
        std::fs::write(&self.settings_path, bytes).map_err(|error| error.to_string())?;
        Ok(true)
    }

    fn release_export_slot(&self) -> Result<(), String> {
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "collector settings mutex poisoned".to_string())?;
        settings.refresh_day();
        settings.exported_today = settings.exported_today.saturating_sub(1);
        let bytes = serde_json::to_vec(&*settings).map_err(|error| error.to_string())?;
        std::fs::write(&self.settings_path, bytes).map_err(|error| error.to_string())
    }

    fn set_error(&self, error: Option<String>) {
        if let Ok(mut last_error) = self.last_error.lock() {
            *last_error = error;
        }
    }
}

struct LcuClient {
    credentials: LeagueClientCredentials,
    client: reqwest::Client,
}

impl LcuClient {
    fn new(credentials: LeagueClientCredentials) -> Result<Self, String> {
        Ok(Self {
            credentials,
            client: reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .map_err(|error| error.to_string())?,
        })
    }

    async fn get_json(&self, path: &str) -> Result<serde_json::Value, String> {
        self.client
            .get(format!(
                "https://127.0.0.1:{}{}",
                self.credentials.port, path
            ))
            .basic_auth("riot", Some(&self.credentials.auth_token))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())
    }

    async fn gameflow_phase(&self) -> Result<GameflowPhase, String> {
        let phase = self.get_json("/lol-gameflow/v1/gameflow-phase").await?;
        Ok(GameflowPhase::from_lcu(phase.as_str().unwrap_or("None")))
    }

    async fn current_puuid(&self) -> Result<String, String> {
        self.get_json("/lol-summoner/v1/current-summoner")
            .await?
            .get("puuid")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or("current summoner is missing puuid".to_string())
    }

    async fn recent_history(&self, puuid: &str) -> Result<serde_json::Value, String> {
        self.get_json(&format!(
            "/lol-match-history/v1/products/lol/{puuid}/matches?begIndex=0&endIndex=20"
        ))
        .await
    }

    async fn match_detail(&self, game_id: &str) -> Result<serde_json::Value, String> {
        self.get_json(&format!("/lol-match-history/v1/games/{game_id}"))
            .await
    }
}

pub fn resolve_selected_augment(offered: &[String], final_augments: &[String]) -> Option<String> {
    let matching = offered
        .iter()
        .filter(|augment| final_augments.contains(augment))
        .collect::<Vec<_>>();
    (matching.len() == 1).then(|| matching[0].clone())
}

fn normalize_offers(offered_augment_slugs: Vec<String>) -> Result<Vec<String>, String> {
    let mut offered = offered_augment_slugs
        .into_iter()
        .filter(|augment| !augment.is_empty())
        .collect::<Vec<_>>();
    offered.sort();
    offered.dedup();
    if offered.len() != 3 {
        return Err("exactly three distinct offered augments are required".to_string());
    }
    Ok(offered)
}

fn contributor_final_augments(detail: &serde_json::Value, contributor_puuid: &str) -> Vec<String> {
    contributor_participant(detail, contributor_puuid)
        .and_then(|participant| {
            participant
                .get("augmentSlugs")
                .or_else(|| participant.get("augments"))
        })
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect()
}

fn contributor_participant<'a>(
    detail: &'a serde_json::Value,
    contributor_puuid: &str,
) -> Option<&'a serde_json::Value> {
    let participant_id = detail
        .get("participantIdentities")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|identity| identity_puuid(identity) == Some(contributor_puuid))
        .and_then(|identity| identity.get("participantId"))
        .and_then(serde_json::Value::as_u64);

    detail
        .get("participants")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|participant| {
            participant
                .get("participantId")
                .and_then(serde_json::Value::as_u64)
                == participant_id
        })
}

#[cfg(any(debug_assertions, test))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchDetailShapeProbe {
    queue_id: Option<u64>,
    participant_resolved: bool,
    participant_resolution_reason: Option<&'static str>,
    augment_fields: Vec<AugmentFieldShape>,
    resolved_final_augments: Vec<String>,
}

#[cfg(any(debug_assertions, test))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AugmentFieldShape {
    path: String,
    value_kind: &'static str,
    array_length: Option<usize>,
    representative_values: Vec<String>,
}

#[cfg(any(debug_assertions, test))]
const MAX_AUGMENT_FIELDS: usize = 32;
#[cfg(any(debug_assertions, test))]
const MAX_REPRESENTATIVE_VALUES: usize = 8;

#[cfg(any(debug_assertions, test))]
fn augment_value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Array(values)
            if !values.is_empty() && values.iter().all(serde_json::Value::is_string) =>
        {
            "string-array"
        }
        serde_json::Value::Array(values)
            if !values.is_empty() && values.iter().all(serde_json::Value::is_number) =>
        {
            "number-array"
        }
        serde_json::Value::Array(_) => "mixed-array",
        serde_json::Value::Object(_) => "object",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Null => "null",
    }
}

#[cfg(any(debug_assertions, test))]
fn collect_augment_field_shapes(
    value: &serde_json::Value,
    path: &str,
    output: &mut Vec<AugmentFieldShape>,
) {
    if output.len() >= MAX_AUGMENT_FIELDS {
        return;
    }
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if output.len() >= MAX_AUGMENT_FIELDS {
                    return;
                }
                let child_path = format!("{path}.{key}");
                if key.to_ascii_lowercase().contains("augment") {
                    let representative_values = child
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|entry| match entry {
                            serde_json::Value::String(value) => Some(value.clone()),
                            serde_json::Value::Number(value) => Some(value.to_string()),
                            _ => None,
                        })
                        .take(MAX_REPRESENTATIVE_VALUES)
                        .collect();
                    output.push(AugmentFieldShape {
                        path: child_path.clone(),
                        value_kind: augment_value_kind(child),
                        array_length: child.as_array().map(Vec::len),
                        representative_values,
                    });
                }
                collect_augment_field_shapes(child, &child_path, output);
            }
        }
        serde_json::Value::Array(values) => {
            let array_path = format!("{path}[]");
            for child in values {
                if matches!(
                    child,
                    serde_json::Value::Object(_) | serde_json::Value::Array(_)
                ) {
                    collect_augment_field_shapes(child, &array_path, output);
                }
            }
        }
        _ => {}
    }
}

/// Debug-only, privacy-bounded evidence of the real LCU augment field contract.
/// It emits no game ID, PUUID, Riot ID, summoner name, chat, or unrelated stats.
#[cfg(any(debug_assertions, test))]
fn build_match_detail_shape_probe(
    detail: &serde_json::Value,
    contributor_puuid: Option<&str>,
) -> MatchDetailShapeProbe {
    let mut augment_fields = Vec::new();
    let (participant_resolved, participant_resolution_reason) = match contributor_puuid {
        None => (false, Some("contributor-puuid-unavailable")),
        Some(puuid) => match contributor_participant(detail, puuid) {
            Some(participant) => {
                collect_augment_field_shapes(participant, "participant", &mut augment_fields);
                (true, None)
            }
            None => (false, Some("contributor-participant-not-found")),
        },
    };
    MatchDetailShapeProbe {
        queue_id: detail.get("queueId").and_then(serde_json::Value::as_u64),
        participant_resolved,
        participant_resolution_reason,
        augment_fields,
        resolved_final_augments: contributor_puuid
            .map(|puuid| contributor_final_augments(detail, puuid))
            .unwrap_or_default(),
    }
}

#[cfg(any(debug_assertions, test))]
fn prepare_match_detail_shape_probe(
    consented_and_resumed: bool,
    active_game: bool,
    source: MatchSource,
    game_id: &str,
    detail: &serde_json::Value,
    contributor_puuid: Option<&str>,
    probed_games: &mut HashSet<String>,
) -> Option<MatchDetailShapeProbe> {
    if !consented_and_resumed
        || active_game
        || !matches!(source, MatchSource::OwnedHistory)
        || detail.get("queueId").and_then(serde_json::Value::as_u64) != Some(2400)
        || probed_games.contains(game_id)
    {
        return None;
    }
    probed_games.insert(game_id.to_string());
    Some(build_match_detail_shape_probe(detail, contributor_puuid))
}

fn contributor_rounds_for_match(
    detail: &serde_json::Value,
    contributor_puuid: &str,
    captured_rounds: &BTreeMap<u8, CapturedRound>,
) -> Option<Vec<ContributorRound>> {
    let start = detail.get("gameCreation")?.as_i64()?;
    let duration_ms = detail.get("gameDuration")?.as_i64()?.saturating_mul(1_000);
    let end = start.saturating_add(duration_ms);
    let final_augments = contributor_final_augments(detail, contributor_puuid);
    let rounds = captured_rounds
        .values()
        .filter(|round| (start..=end).contains(&round.captured_at_epoch_ms))
        .map(|round| ContributorRound {
            round: round.round,
            offered_augment_slugs: round.offered_augment_slugs.clone(),
            selected_augment_slug: round.selected_augment_slug.clone().or_else(|| {
                resolve_selected_augment(&round.offered_augment_slugs, &final_augments)
            }),
            ocr_confidence: round.ocr_confidence,
        })
        .collect::<Vec<_>>();
    (!rounds.is_empty()).then_some(rounds)
}

pub fn extract_mayhem_match_ids(history: &serde_json::Value) -> Vec<String> {
    history
        .pointer("/games/games")
        .or_else(|| history.get("games"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|game| {
            game.get("queueId")
                .and_then(serde_json::Value::as_u64)
                .map(|queue| queue == 2400)
                .unwrap_or(false)
        })
        .filter_map(|game| game.get("gameId"))
        .filter_map(|game_id| {
            game_id
                .as_str()
                .map(str::to_string)
                .or_else(|| game_id.as_u64().map(|value| value.to_string()))
        })
        .collect()
}

pub fn extract_participant_puuids(detail: &serde_json::Value) -> Vec<String> {
    detail
        .get("participantIdentities")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(identity_puuid)
        .map(str::to_string)
        .collect()
}

fn identity_puuid(identity: &serde_json::Value) -> Option<&str> {
    identity
        .get("puuid")
        .or_else(|| identity.pointer("/player/puuid"))
        .and_then(serde_json::Value::as_str)
}

fn today() -> String {
    chrono::Utc::now().date_naive().to_string()
}

async fn collect_one(state: &CollectorState, client: &LcuClient) -> Result<(), String> {
    let mut runtime = state.runtime.lock().await;
    if !state.consented_and_resumed() {
        return Ok(());
    }
    if active_game_now(state, client).await? {
        return Ok(());
    }
    if runtime.contributor_puuid.is_none() {
        let puuid = client.current_puuid().await?;
        runtime.contributor_puuid = Some(puuid.clone());
        runtime.enqueue_history(puuid, MatchSource::OwnedHistory);
    }

    if let Some(work) = runtime.match_frontier.pop_front() {
        let detail = client.match_detail(&work.game_id).await?;
        if !state.consented_and_resumed() {
            runtime.match_frontier.push_front(work);
            return Ok(());
        }
        if active_game_now(state, client).await? {
            runtime.match_frontier.push_front(work);
            return Ok(());
        }
        #[cfg(debug_assertions)]
        {
            let contributor_puuid = runtime.contributor_puuid.clone();
            if let Some(probe) = prepare_match_detail_shape_probe(
                true,
                false,
                work.source,
                &work.game_id,
                &detail,
                contributor_puuid.as_deref(),
                &mut runtime.shape_probed_games,
            ) {
                if let Ok(serialized) = serde_json::to_string(&probe) {
                    eprintln!("[collector-lcu-shape] {serialized}");
                }
            }
        }
        let participant_puuids = extract_participant_puuids(&detail);
        let contributor_rounds = match (work.source, &runtime.contributor_puuid) {
            (MatchSource::OwnedHistory, Some(puuid)) => {
                contributor_rounds_for_match(&detail, puuid, &runtime.captured_rounds)
            }
            _ => None,
        };
        let safe = sanitize_match(&detail, work.source, contributor_rounds.clone())?;
        if !state.consented_and_resumed() || active_game_now(state, client).await? {
            runtime.match_frontier.push_front(work);
            return Ok(());
        }
        if !state.reserve_export_slot()? {
            return Ok(());
        }
        if let Err(error) = state.queue.enqueue_batch(&[safe]) {
            runtime.match_frontier.push_front(work);
            state.release_export_slot()?;
            return Err(error);
        }
        for puuid in participant_puuids {
            runtime.enqueue_history(puuid, MatchSource::Snowball);
        }
        if contributor_rounds.is_some() {
            runtime.captured_rounds.clear();
        }
        return Ok(());
    }

    if let Some(work) = runtime.history_frontier.pop_front() {
        let history = client.recent_history(&work.puuid).await?;
        if !state.consented_and_resumed() || active_game_now(state, client).await? {
            runtime.history_frontier.push_front(work);
            return Ok(());
        }
        for game_id in extract_mayhem_match_ids(&history) {
            runtime.enqueue_match(game_id, work.source);
        }
    }
    Ok(())
}

async fn active_game_now(state: &CollectorState, client: &LcuClient) -> Result<bool, String> {
    let active = client.gameflow_phase().await? == GameflowPhase::InProgress;
    state.active_game.store(active, Ordering::Relaxed);
    Ok(active)
}

#[tauri::command]
pub fn get_collector_status(state: State<'_, CollectorState>) -> CollectorStatus {
    state.status()
}

#[tauri::command]
pub fn set_collector_consent(
    state: State<'_, CollectorState>,
    accepted: bool,
) -> Result<CollectorStatus, String> {
    state.update_settings(|settings| settings.consent = Some(accepted))?;
    Ok(state.status())
}

#[tauri::command]
pub fn set_collector_paused(
    state: State<'_, CollectorState>,
    paused: bool,
) -> Result<CollectorStatus, String> {
    state.update_settings(|settings| settings.paused = paused)?;
    Ok(state.status())
}

#[tauri::command]
pub async fn record_contributor_round(
    state: State<'_, CollectorState>,
    round: u8,
    offered_augment_slugs: Vec<String>,
    ocr_confidence: f64,
) -> Result<(), String> {
    if !state.consented_and_resumed() {
        return Err("collector consent is required and collection must be resumed".to_string());
    }
    if !(1..=4).contains(&round) {
        return Err("round must be between 1 and 4".to_string());
    }
    let offered = normalize_offers(offered_augment_slugs)?;
    let mut runtime = state.runtime.lock().await;
    runtime.captured_rounds.insert(
        round,
        CapturedRound {
            round,
            offered_augment_slugs: offered,
            selected_augment_slug: None,
            ocr_confidence: ocr_confidence.clamp(0.0, 1.0),
            captured_at_epoch_ms: chrono::Utc::now().timestamp_millis(),
        },
    );
    Ok(())
}

fn confirm_captured_round(
    rounds: &mut BTreeMap<u8, CapturedRound>,
    round: u8,
    selected_augment_slug: String,
) -> Result<(), String> {
    let captured = rounds
        .get_mut(&round)
        .ok_or("captured contributor round not found".to_string())?;
    if !captured
        .offered_augment_slugs
        .contains(&selected_augment_slug)
    {
        return Err("selected augment was not in the captured offer".to_string());
    }
    captured.selected_augment_slug = Some(selected_augment_slug);
    Ok(())
}

#[tauri::command]
pub async fn confirm_contributor_round_selection(
    state: State<'_, CollectorState>,
    round: u8,
    selected_augment_slug: String,
) -> Result<(), String> {
    if !state.consented_and_resumed() {
        return Err("collector consent is required and collection must be resumed".to_string());
    }
    confirm_captured_round(
        &mut state.runtime.lock().await.captured_rounds,
        round,
        selected_augment_slug,
    )
}

#[tauri::command]
pub async fn collector_tick(state: State<'_, CollectorState>) -> Result<CollectorStatus, String> {
    let consented = state
        .settings
        .lock()
        .map(|settings| settings.consent == Some(true))
        .unwrap_or(false);
    if !consented {
        state.active_game.store(false, Ordering::Relaxed);
        state.set_error(None);
        return Ok(state.status());
    }

    let Some(credentials) = discover_lcu_credentials() else {
        state.active_game.store(false, Ordering::Relaxed);
        state.set_error(None);
        return Ok(state.status());
    };
    let result = async {
        let client = LcuClient::new(credentials)?;
        let phase = client.gameflow_phase().await?;
        state
            .active_game
            .store(phase == GameflowPhase::InProgress, Ordering::Relaxed);

        let policy = {
            let mut settings = state
                .settings
                .lock()
                .map_err(|_| "collector settings mutex poisoned".to_string())?;
            settings.refresh_day();
            settings.policy()
        };
        if !policy.paused && phase != GameflowPhase::InProgress {
            if let (Ok(endpoint), Ok(token)) = (
                std::env::var("MAYHEM_TELEMETRY_ENDPOINT"),
                std::env::var("MAYHEM_DEVICE_TOKEN"),
            ) {
                state
                    .queue
                    .upload_due(&endpoint, &token, chrono::Utc::now().timestamp())
                    .await?;
            }
        }

        let collection_phase = client.gameflow_phase().await?;
        state.active_game.store(
            collection_phase == GameflowPhase::InProgress,
            Ordering::Relaxed,
        );
        if policy.may_collect(collection_phase) {
            collect_one(&state, &client).await?;
        }
        Ok::<(), String>(())
    }
    .await;
    state.set_error(result.err());
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_collection_until_the_daily_limit() {
        let policy = CollectionPolicy {
            consented: true,
            paused: false,
            exported_today: DAILY_EXPORT_LIMIT - 1,
        };

        assert!(policy.may_collect(GameflowPhase::None));
    }

    #[test]
    fn rejects_collection_at_the_daily_limit() {
        let policy = CollectionPolicy {
            consented: true,
            paused: false,
            exported_today: DAILY_EXPORT_LIMIT,
        };

        assert!(!policy.may_collect(GameflowPhase::None));
    }

    #[test]
    fn pauses_collection_during_an_active_game() {
        let policy = CollectionPolicy {
            consented: true,
            paused: false,
            exported_today: 0,
        };

        assert!(!policy.may_collect(GameflowPhase::InProgress));
    }

    #[test]
    fn consent_and_manual_pause_are_blocking() {
        let declined = CollectionPolicy {
            consented: false,
            paused: false,
            exported_today: 0,
        };
        let paused = CollectionPolicy {
            consented: true,
            paused: true,
            exported_today: 0,
        };

        assert!(!declined.may_collect(GameflowPhase::None));
        assert!(!paused.may_collect(GameflowPhase::None));
    }

    #[test]
    fn resolves_selected_augment_only_when_unambiguous() {
        let offered = vec![
            "deathtouch".to_string(),
            "big-brain".to_string(),
            "mad-scientist".to_string(),
        ];

        assert_eq!(
            resolve_selected_augment(&offered, &["deathtouch".to_string()]),
            Some("deathtouch".to_string())
        );
        assert_eq!(
            resolve_selected_augment(
                &offered,
                &["deathtouch".to_string(), "big-brain".to_string()]
            ),
            None
        );
        assert_eq!(
            resolve_selected_augment(&offered, &["unrelated".to_string()]),
            None
        );
    }

    #[test]
    fn extracts_only_mayhem_matches_and_snowball_participants() {
        let detail: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/lcu_match_2400.json")).unwrap();
        let history = serde_json::json!({
            "games": {
                "games": [
                    { "gameId": 991240001, "queueId": 2400 },
                    { "gameId": 991420001, "queueId": 420 }
                ]
            }
        });

        assert_eq!(extract_mayhem_match_ids(&history), vec!["991240001"]);
        assert_eq!(
            extract_participant_puuids(&detail),
            vec!["forbidden-puuid-1", "forbidden-puuid-2"]
        );
    }

    #[test]
    fn dev_match_shape_probe_reports_augment_contract_without_identity_data() {
        let detail: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/lcu_match_2400.json")).unwrap();

        let probe = build_match_detail_shape_probe(&detail, Some("forbidden-puuid-1"));
        let serialized = serde_json::to_string(&probe).unwrap();

        assert_eq!(probe.queue_id, Some(2400));
        assert_eq!(probe.augment_fields.len(), 1);
        assert_eq!(probe.augment_fields[0].path, "participant.augmentSlugs");
        assert_eq!(probe.augment_fields[0].value_kind, "string-array");
        assert_eq!(
            probe.augment_fields[0].representative_values,
            vec!["deathtouch", "mad-scientist"]
        );
        assert_eq!(
            probe.resolved_final_augments,
            vec!["deathtouch", "mad-scientist"]
        );
        for forbidden in [
            "forbidden-puuid",
            "Forbidden Summoner",
            "Forbidden Riot",
            "CHAT",
            "summonerName",
            "riotIdGameName",
        ] {
            assert!(!serialized.contains(forbidden), "probe leaked {forbidden}");
        }
    }

    #[test]
    fn shape_probe_emits_nothing_without_explicit_consent() {
        let detail: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/lcu_match_2400.json")).unwrap();
        let mut probed_games = HashSet::new();

        let probe = prepare_match_detail_shape_probe(
            false,
            false,
            MatchSource::OwnedHistory,
            "991240001",
            &detail,
            Some("forbidden-puuid-1"),
            &mut probed_games,
        );

        assert!(probe.is_none());
        assert!(probed_games.is_empty());
    }

    #[test]
    fn augment_shape_discovery_recurses_objects_and_arrays_with_bounded_values() {
        let participant = serde_json::json!({
            "augmentSlugs": ["alpha", "beta"],
            "augmentIds": [101, 102],
            "nested": { "nestedAugments": ["gamma"] },
            "someArray": [
                { "augmentIds": [201, 202] },
                [{ "augmentSlugs": ["delta"] }]
            ],
            "mixedAugments": ["epsilon", 301, null, { "ignored": true }],
            "nullAugment": null,
            "items": [{ "itemIds": [3071, 3111] }],
            "summonerName": "must-not-appear"
        });
        let mut fields = Vec::new();
        collect_augment_field_shapes(&participant, "participant", &mut fields);
        let by_path = fields
            .into_iter()
            .map(|field| (field.path.clone(), field))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(
            by_path["participant.augmentSlugs"].value_kind,
            "string-array"
        );
        assert_eq!(by_path["participant.augmentSlugs"].array_length, Some(2));
        assert_eq!(by_path["participant.augmentIds"].value_kind, "number-array");
        assert_eq!(
            by_path["participant.nested.nestedAugments"].value_kind,
            "string-array"
        );
        assert_eq!(
            by_path["participant.someArray[].augmentIds"].value_kind,
            "number-array"
        );
        assert_eq!(
            by_path["participant.someArray[][].augmentSlugs"].representative_values,
            vec!["delta"]
        );
        assert_eq!(
            by_path["participant.mixedAugments"].value_kind,
            "mixed-array"
        );
        assert_eq!(by_path["participant.mixedAugments"].array_length, Some(4));
        assert_eq!(
            by_path["participant.mixedAugments"].representative_values,
            vec!["epsilon", "301"]
        );
        assert_eq!(by_path["participant.nullAugment"].value_kind, "null");
        assert_eq!(by_path["participant.nullAugment"].array_length, None);
        assert!(!by_path.keys().any(|path| path.contains("item")));
        assert!(!by_path.keys().any(|path| path.contains("summoner")));
    }

    #[test]
    fn numeric_augment_arrays_are_diagnostic_values_not_resolved_slugs() {
        let detail = serde_json::json!({
            "queueId": 2400,
            "participantIdentities": [{ "participantId": 1, "puuid": "self" }],
            "participants": [{ "participantId": 1, "augmentIds": [101, 102] }]
        });
        let probe = build_match_detail_shape_probe(&detail, Some("self"));

        assert!(probe.participant_resolved);
        assert_eq!(probe.augment_fields[0].value_kind, "number-array");
        assert_eq!(probe.augment_fields[0].array_length, Some(2));
        assert_eq!(
            probe.augment_fields[0].representative_values,
            vec!["101", "102"]
        );
        assert!(probe.resolved_final_augments.is_empty());
        assert!(contributor_final_augments(&detail, "self").is_empty());
    }

    #[test]
    fn shape_probe_is_queue_2400_only_one_shot_and_sanitizes_resolution_failure() {
        let mut detail = serde_json::json!({
            "queueId": 420,
            "participantIdentities": [],
            "participants": [],
            "summonerName": "must-not-appear",
            "chat": "must-not-appear"
        });
        let mut probed_games = HashSet::new();
        assert!(prepare_match_detail_shape_probe(
            true,
            false,
            MatchSource::OwnedHistory,
            "game-1",
            &detail,
            None,
            &mut probed_games,
        )
        .is_none());
        assert!(probed_games.is_empty());

        detail["queueId"] = serde_json::json!(2400);
        let first = prepare_match_detail_shape_probe(
            true,
            false,
            MatchSource::OwnedHistory,
            "game-1",
            &detail,
            None,
            &mut probed_games,
        )
        .unwrap();
        assert!(!first.participant_resolved);
        assert_eq!(
            first.participant_resolution_reason,
            Some("contributor-puuid-unavailable")
        );
        let serialized = serde_json::to_string(&first).unwrap();
        assert!(!serialized.contains("game-1"));
        assert!(!serialized.contains("must-not-appear"));

        assert!(prepare_match_detail_shape_probe(
            true,
            false,
            MatchSource::OwnedHistory,
            "game-1",
            &detail,
            None,
            &mut probed_games,
        )
        .is_none());
        assert!(prepare_match_detail_shape_probe(
            true,
            true,
            MatchSource::OwnedHistory,
            "game-2",
            &detail,
            None,
            &mut probed_games,
        )
        .is_none());
        assert!(prepare_match_detail_shape_probe(
            true,
            false,
            MatchSource::Snowball,
            "game-3",
            &detail,
            None,
            &mut probed_games,
        )
        .is_none());
    }

    #[test]
    fn reserves_at_most_one_hundred_export_slots_per_day() {
        let temp = tempfile::tempdir().unwrap();
        let state = CollectorState::new(temp.path().to_path_buf()).unwrap();

        for _ in 0..DAILY_EXPORT_LIMIT {
            assert!(state.reserve_export_slot().unwrap());
        }
        assert!(!state.reserve_export_slot().unwrap());
        state.release_export_slot().unwrap();
        assert!(state.reserve_export_slot().unwrap());
        assert_eq!(state.status().exported_today, DAILY_EXPORT_LIMIT);
    }

    #[test]
    fn classifies_all_active_gameflow_phases_as_blocking() {
        for phase in [
            "ChampSelect",
            "GameStart",
            "InProgress",
            "Reconnect",
            "WaitingForStats",
            "PreEndOfGame",
        ] {
            assert_eq!(GameflowPhase::from_lcu(phase), GameflowPhase::InProgress);
        }
        for phase in ["None", "Lobby", "Matchmaking", "ReadyCheck", "EndOfGame"] {
            assert_eq!(GameflowPhase::from_lcu(phase), GameflowPhase::None);
        }
    }

    #[test]
    fn contributor_round_requires_three_distinct_offers() {
        assert!(normalize_offers(vec![
            "deathtouch".to_string(),
            "big-brain".to_string(),
            "mad-scientist".to_string(),
        ])
        .is_ok());
        assert!(normalize_offers(vec![
            "deathtouch".to_string(),
            "deathtouch".to_string(),
            "deathtouch".to_string(),
        ])
        .is_err());
        assert!(normalize_offers(vec!["deathtouch".to_string()]).is_err());
    }

    #[test]
    fn confirms_only_a_selection_from_the_captured_offer() {
        let mut rounds = BTreeMap::from([(
            2,
            CapturedRound {
                round: 2,
                offered_augment_slugs: vec![
                    "deathtouch".to_string(),
                    "big-brain".to_string(),
                    "mad-scientist".to_string(),
                ],
                selected_augment_slug: None,
                ocr_confidence: 1.0,
                captured_at_epoch_ms: 1,
            },
        )]);

        assert!(confirm_captured_round(&mut rounds, 2, "unrelated".to_string()).is_err());
        confirm_captured_round(&mut rounds, 2, "big-brain".to_string()).unwrap();
        assert_eq!(
            rounds
                .get(&2)
                .and_then(|round| round.selected_augment_slug.as_deref()),
            Some("big-brain")
        );
    }
}
