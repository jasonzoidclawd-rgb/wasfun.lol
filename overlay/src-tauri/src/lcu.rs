use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeagueClientCredentials {
    pub port: u16,
    pub auth_token: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeagueProcessRecord {
    pub command_line: Option<String>,
    pub executable_path: Option<PathBuf>,
}

pub(crate) trait LeagueProcessProvider {
    fn league_processes(&self) -> Vec<LeagueProcessRecord>;
}

pub(crate) struct SysinfoLeagueProcessProvider;

impl LeagueProcessProvider for SysinfoLeagueProcessProvider {
    fn league_processes(&self) -> Vec<LeagueProcessRecord> {
        let sys = sysinfo::System::new_all();
        sys.processes()
            .values()
            .filter(|process| is_league_process_name(&process.name().to_string_lossy()))
            .map(|process| LeagueProcessRecord {
                command_line: Some(
                    process
                        .cmd()
                        .iter()
                        .map(|arg| arg.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
                .filter(|value| !value.trim().is_empty()),
                executable_path: process.exe().map(Path::to_path_buf),
            })
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NormalizedGameflowPhase {
    None,
    Lobby,
    Matchmaking,
    ReadyCheck,
    ChampSelect,
    GameStart,
    InProgress,
    Reconnect,
    WaitingForStats,
    PreEndOfGame,
    EndOfGame,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GameflowState {
    pub raw_phase: Option<String>,
    pub phase: NormalizedGameflowPhase,
    pub live_capture_allowed: bool,
    pub blocks_background_collection: bool,
}

const READONLY_GAMEFLOW_PATHS: [&str; 3] = [
    "/lol-gameflow/v1/gameflow-phase",
    "/lol-gameflow/v1/session",
    "/lol-champ-select/v1/session",
];

pub(crate) fn parse_lockfile_content(content: &str) -> Option<LeagueClientCredentials> {
    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    let port = parts.get(2)?.parse().ok()?;
    let auth_token = parts.get(3)?.trim();
    if auth_token.is_empty() {
        return None;
    }
    Some(LeagueClientCredentials {
        port,
        auth_token: auth_token.to_string(),
    })
}

pub(crate) fn parse_lockfile(path: &Path) -> Option<LeagueClientCredentials> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| parse_lockfile_content(&content))
}

pub(crate) fn parse_command_line_credentials(
    command_line: &str,
) -> Option<LeagueClientCredentials> {
    let tokens = tokenize_command_line(command_line);
    let auth_token = extract_flag_value(&tokens, "--remoting-auth-token")?;
    if auth_token.trim().is_empty() {
        return None;
    }
    let port = extract_flag_value(&tokens, "--app-port")?.parse().ok()?;
    Some(LeagueClientCredentials { port, auth_token })
}

pub(crate) fn parse_log_credentials(log_contents: &str) -> Option<LeagueClientCredentials> {
    parse_command_line_credentials(log_contents).or_else(|| parse_local_auth_url(log_contents))
}

pub(crate) fn discover_credentials_from_directory(path: &Path) -> Option<LeagueClientCredentials> {
    if !path.is_dir() {
        return None;
    }
    parse_lockfile(&path.join("lockfile")).or_else(|| discover_credentials_from_logs(path))
}

pub(crate) fn discover_credentials_with_provider<P: LeagueProcessProvider>(
    provider: &P,
    manual_directories: &[PathBuf],
) -> Option<LeagueClientCredentials> {
    let processes = provider.league_processes();

    processes
        .iter()
        .filter_map(|record| record.command_line.as_deref())
        .find_map(parse_command_line_credentials)
        .or_else(|| {
            processes
                .iter()
                .filter_map(|record| record.executable_path.as_deref())
                .filter_map(executable_directory)
                .find_map(|directory| discover_credentials_from_directory(&directory))
        })
        .or_else(|| {
            manual_directories
                .iter()
                .find_map(|directory| discover_credentials_from_directory(directory))
        })
}

pub(crate) fn discover_lcu_credentials() -> Option<LeagueClientCredentials> {
    discover_credentials_with_provider(&SysinfoLeagueProcessProvider, &default_lcu_directories())
}

pub(crate) fn normalize_gameflow_phase(raw_phase: Option<&str>) -> GameflowState {
    let phase = match raw_phase.unwrap_or("None") {
        "None" => NormalizedGameflowPhase::None,
        "Lobby" => NormalizedGameflowPhase::Lobby,
        "Matchmaking" => NormalizedGameflowPhase::Matchmaking,
        "ReadyCheck" => NormalizedGameflowPhase::ReadyCheck,
        "ChampSelect" => NormalizedGameflowPhase::ChampSelect,
        "GameStart" => NormalizedGameflowPhase::GameStart,
        "InProgress" => NormalizedGameflowPhase::InProgress,
        "Reconnect" => NormalizedGameflowPhase::Reconnect,
        "WaitingForStats" => NormalizedGameflowPhase::WaitingForStats,
        "PreEndOfGame" => NormalizedGameflowPhase::PreEndOfGame,
        "EndOfGame" => NormalizedGameflowPhase::EndOfGame,
        _ => NormalizedGameflowPhase::Unknown,
    };
    let live_capture_allowed = phase == NormalizedGameflowPhase::InProgress;
    let blocks_background_collection = matches!(
        phase,
        NormalizedGameflowPhase::ChampSelect
            | NormalizedGameflowPhase::GameStart
            | NormalizedGameflowPhase::InProgress
            | NormalizedGameflowPhase::Reconnect
            | NormalizedGameflowPhase::WaitingForStats
            | NormalizedGameflowPhase::PreEndOfGame
    );

    GameflowState {
        raw_phase: raw_phase.map(str::to_string),
        phase,
        live_capture_allowed,
        blocks_background_collection,
    }
}

pub(crate) fn is_allowed_gameflow_path(path: &str) -> bool {
    READONLY_GAMEFLOW_PATHS.contains(&path)
}

pub(crate) async fn read_gameflow_state(
    credentials: &LeagueClientCredentials,
) -> Result<GameflowState, String> {
    let phase = get_allowed_lcu_json(credentials, "/lol-gameflow/v1/gameflow-phase").await?;
    Ok(normalize_gameflow_phase(phase.as_str()))
}

pub(crate) async fn get_allowed_lcu_json(
    credentials: &LeagueClientCredentials,
    path: &str,
) -> Result<serde_json::Value, String> {
    if !is_allowed_gameflow_path(path) {
        return Err("LCU path is not allowed for gameflow state".to_string());
    }

    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("https://127.0.0.1:{}{}", credentials.port, path))
        .basic_auth("riot", Some(&credentials.auth_token))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

fn is_league_process_name(name: &str) -> bool {
    let normalized = name.to_lowercase().replace(' ', "");
    normalized.contains("leagueclientux") || normalized.contains("leagueclient")
}

fn default_lcu_directories() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from(
            "/Applications/League of Legends.app/Contents/LoL",
        )]
    }

    #[cfg(target_os = "windows")]
    {
        vec![
            PathBuf::from(r"C:\Riot Games\League of Legends"),
            PathBuf::from(r"D:\Riot Games\League of Legends"),
        ]
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

fn executable_directory(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        Some(path.to_path_buf())
    } else {
        path.parent().map(Path::to_path_buf)
    }
}

fn discover_credentials_from_logs(path: &Path) -> Option<LeagueClientCredentials> {
    let mut candidates = Vec::new();
    for directory in [
        path.join("Logs").join("LeagueClient Logs"),
        path.join("Logs"),
        path.to_path_buf(),
    ] {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if !entry_path.is_file() {
                continue;
            }
            let file_name = entry_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !file_name.contains("leagueclient") && !file_name.ends_with(".log") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            candidates.push((modified, entry_path));
        }
    }

    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    candidates.into_iter().take(8).find_map(|(_, path)| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|contents| parse_log_credentials(&contents))
    })
}

fn tokenize_command_line(command_line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for character in command_line.chars() {
        match character {
            '"' => quoted = !quoted,
            character if character.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            character => current.push(character),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn extract_flag_value(tokens: &[String], flag: &str) -> Option<String> {
    for (index, token) in tokens.iter().enumerate() {
        if token == flag {
            return tokens.get(index + 1).map(|value| trim_quotes(value));
        }
        if let Some(value) = token.strip_prefix(&format!("{flag}=")) {
            return Some(trim_quotes(value));
        }
    }
    None
}

fn trim_quotes(value: &str) -> String {
    value.trim_matches('"').to_string()
}

fn parse_local_auth_url(contents: &str) -> Option<LeagueClientCredentials> {
    for candidate in contents.split("https://riot:").skip(1) {
        let Some((auth_token, rest)) = candidate.split_once("@127.0.0.1:") else {
            continue;
        };
        let port = rest
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok()?;
        if auth_token.is_empty() {
            continue;
        }
        return Some(LeagueClientCredentials {
            port,
            auth_token: auth_token.to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_lcu_lockfile_content() {
        let credentials =
            parse_lockfile_content("LeagueClient:42876:51234:secret-token:https").unwrap();

        assert_eq!(credentials.port, 51234);
        assert_eq!(credentials.auth_token, "secret-token");
    }

    #[test]
    fn rejects_bad_lockfile_content() {
        assert!(parse_lockfile_content("LeagueClient:pid:not-a-port:token:https").is_none());
        assert!(parse_lockfile_content("LeagueClient:42876:51234::https").is_none());
        assert!(parse_lockfile_content("too-short").is_none());
    }

    #[test]
    fn handles_bad_manual_directory_without_panicking() {
        let missing = std::env::temp_dir().join(format!(
            "mayhem-missing-lcu-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        assert!(discover_credentials_from_directory(&missing).is_none());
    }

    #[test]
    fn parses_command_line_token_and_port() {
        let credentials = parse_command_line_credentials(
            r#""C:\Riot Games\League of Legends\LeagueClientUx.exe" --app-port=61001 --remoting-auth-token=cmd-token --locale=en_US"#,
        )
        .unwrap();

        assert_eq!(credentials.port, 61001);
        assert_eq!(credentials.auth_token, "cmd-token");
    }

    #[test]
    fn parses_quoted_command_line_values() {
        let credentials = parse_command_line_credentials(
            r#"LeagueClientUx.exe --remoting-auth-token "quoted token" --app-port "61234""#,
        )
        .unwrap();

        assert_eq!(credentials.port, 61234);
        assert_eq!(credentials.auth_token, "quoted token");
    }

    #[test]
    fn parses_log_fallback_credentials() {
        let credentials = parse_log_credentials(
            "connecting to https://riot:log-token@127.0.0.1:52222/ with local auth",
        )
        .unwrap();

        assert_eq!(credentials.port, 52222);
        assert_eq!(credentials.auth_token, "log-token");
    }

    #[derive(Clone)]
    struct FakeProcessProvider {
        records: Vec<LeagueProcessRecord>,
    }

    impl LeagueProcessProvider for FakeProcessProvider {
        fn league_processes(&self) -> Vec<LeagueProcessRecord> {
            self.records.clone()
        }
    }

    #[test]
    fn process_discovery_prefers_command_line_credentials() {
        let provider = FakeProcessProvider {
            records: vec![LeagueProcessRecord {
                command_line: Some(
                    "LeagueClientUx.exe --app-port=61111 --remoting-auth-token=process-token"
                        .to_string(),
                ),
                executable_path: None,
            }],
        };

        let credentials = discover_credentials_with_provider(&provider, &[]).unwrap();

        assert_eq!(credentials.port, 61111);
        assert_eq!(credentials.auth_token, "process-token");
    }

    #[test]
    fn process_discovery_uses_lockfile_next_to_executable() {
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("LeagueClientUx.exe");
        std::fs::write(&exe, "").unwrap();
        std::fs::write(
            temp.path().join("lockfile"),
            "LeagueClient:7:61333:lockfile-token:https",
        )
        .unwrap();
        let provider = FakeProcessProvider {
            records: vec![LeagueProcessRecord {
                command_line: None,
                executable_path: Some(exe),
            }],
        };

        let credentials = discover_credentials_with_provider(&provider, &[]).unwrap();

        assert_eq!(credentials.port, 61333);
        assert_eq!(credentials.auth_token, "lockfile-token");
    }

    #[test]
    fn process_discovery_uses_log_fallback_near_executable() {
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("LeagueClientUx.exe");
        let logs = temp.path().join("Logs").join("LeagueClient Logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(&exe, "").unwrap();
        std::fs::write(
            logs.join("LeagueClientUx.log"),
            "League started with --app-port=61444 --remoting-auth-token=log-file-token",
        )
        .unwrap();
        let provider = FakeProcessProvider {
            records: vec![LeagueProcessRecord {
                command_line: None,
                executable_path: Some(exe),
            }],
        };

        let credentials = discover_credentials_with_provider(&provider, &[]).unwrap();

        assert_eq!(credentials.port, 61444);
        assert_eq!(credentials.auth_token, "log-file-token");
    }

    #[test]
    fn process_discovery_uses_manual_directory_fallback() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("lockfile"),
            "LeagueClient:7:61555:manual-token:https",
        )
        .unwrap();
        let provider = FakeProcessProvider { records: vec![] };

        let credentials =
            discover_credentials_with_provider(&provider, &[PathBuf::from(temp.path())]).unwrap();

        assert_eq!(credentials.port, 61555);
        assert_eq!(credentials.auth_token, "manual-token");
    }

    #[test]
    fn normalizes_gameflow_phase_for_capture_and_background_collection() {
        let in_progress = normalize_gameflow_phase(Some("InProgress"));
        assert_eq!(in_progress.phase, NormalizedGameflowPhase::InProgress);
        assert!(in_progress.live_capture_allowed);
        assert!(in_progress.blocks_background_collection);

        let champ_select = normalize_gameflow_phase(Some("ChampSelect"));
        assert_eq!(champ_select.phase, NormalizedGameflowPhase::ChampSelect);
        assert!(!champ_select.live_capture_allowed);
        assert!(champ_select.blocks_background_collection);

        let lobby = normalize_gameflow_phase(Some("Lobby"));
        assert_eq!(lobby.phase, NormalizedGameflowPhase::Lobby);
        assert!(!lobby.live_capture_allowed);
        assert!(!lobby.blocks_background_collection);

        let unknown = normalize_gameflow_phase(Some("UnexpectedPhase"));
        assert_eq!(unknown.phase, NormalizedGameflowPhase::Unknown);
        assert!(!unknown.live_capture_allowed);
    }

    #[test]
    fn allows_only_readonly_gameflow_paths_for_new_phase_client() {
        assert!(is_allowed_gameflow_path("/lol-gameflow/v1/gameflow-phase"));
        assert!(is_allowed_gameflow_path("/lol-gameflow/v1/session"));
        assert!(is_allowed_gameflow_path("/lol-champ-select/v1/session"));
        assert!(!is_allowed_gameflow_path(
            "/lol-champ-select/v1/session/choice/1"
        ));
    }
}
