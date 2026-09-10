use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use base64::Engine;
use flate2::read::GzDecoder;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

const PUBLIC_KEY: &str = include_str!("../../../docs/handoffs/fixtures/m4/public-key.txt");
pub const DEFAULT_API_BASE: &str = "https://wasfun.lol";

pub fn hash_game_id(game_id: &str) -> String {
    hex::encode(Sha256::digest(game_id.as_bytes()))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelManifest {
    pub model_version: String,
    pub engine_version: String,
    pub data_version: String,
    pub created_at: String,
    pub config_sha256: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapManifest {
    pub model_version: String,
    pub engine_version: String,
    pub data_version: String,
    #[serde(default)]
    pub created_at: Option<String>,
    pub config_sha256: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Access {
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapResponse {
    pub manifest: BootstrapManifest,
    pub package_url: String,
    pub access: Access,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub kind: String,
    pub game_hash: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GameSessionResponse {
    pub lease: Lease,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSnapshot {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<ModelManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<Lease>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct MemberState {
    api_base: Url,
    client: Client,
    cache_directory: PathBuf,
    snapshot: Mutex<MemberSnapshot>,
}

pub fn resolve_api_base(value: Option<&str>) -> Result<Url, String> {
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_API_BASE);
    Url::parse(raw).map_err(|error| error.to_string())
}

impl MemberState {
    pub fn new(cache_directory: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&cache_directory).map_err(|error| error.to_string())?;
        let api_base_env = std::env::var("MAYHEM_API_BASE").ok();
        let api_base = resolve_api_base(api_base_env.as_deref())?;
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            api_base,
            client,
            cache_directory,
            snapshot: Mutex::new(MemberSnapshot::default()),
        })
    }

    fn disabled(&self, error: String) -> MemberSnapshot {
        let mut current = self
            .snapshot
            .lock()
            .expect("member snapshot mutex poisoned");
        current.enabled = false;
        current.lease = None;
        current.error = Some(error);
        current.clone()
    }

    fn endpoint(&self, path: &str) -> Result<Url, String> {
        self.api_base.join(path).map_err(|error| error.to_string())
    }

    async fn bootstrap(&self) -> Result<MemberSnapshot, String> {
        let response = self
            .client
            .get(self.endpoint("/api/overlay/bootstrap")?)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|error| error.to_string())?;
        let bootstrap = parse_bootstrap_response(status, &body)?;
        let package_url = self.resolve_package_url(&bootstrap.package_url)?;
        let package = self.download_package(&package_url).await?;
        let (manifest, model_config) =
            verify_model_package(&package, &bootstrap.manifest, PUBLIC_KEY)?;
        let cache_path = self
            .cache_directory
            .join(format!("model-{}.json", manifest.model_version));
        std::fs::write(
            cache_path,
            serde_json::to_vec(&model_config).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        Ok(MemberSnapshot {
            enabled: true,
            access_kind: Some(bootstrap.access.kind),
            manifest: Some(manifest),
            model_config: Some(model_config),
            lease: None,
            error: None,
        })
    }

    async fn game_start(&self, game_hash: String) -> Result<MemberSnapshot, String> {
        let response = self
            .client
            .post(self.endpoint("/api/overlay/game-session")?)
            .json(&serde_json::json!({ "gameHash": game_hash }))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|error| error.to_string())?;
        let session = parse_game_session_response(status, &body)?;
        let current = self
            .snapshot
            .lock()
            .map_err(|_| "member snapshot mutex poisoned".to_string())?
            .clone();
        if current.model_config.is_none() || current.manifest.is_none() {
            return Err("verified-model-not-loaded".to_string());
        }
        Ok(MemberSnapshot {
            enabled: true,
            lease: Some(session.lease),
            error: None,
            ..current
        })
    }

    fn resolve_package_url(&self, package_url: &str) -> Result<Url, String> {
        if let Ok(url) = Url::parse(package_url) {
            return Ok(url);
        }
        self.api_base
            .join(package_url)
            .map_err(|error| error.to_string())
    }

    async fn download_package(&self, url: &Url) -> Result<Vec<u8>, String> {
        if url.scheme() == "file" {
            let path = url
                .to_file_path()
                .map_err(|_| "invalid file package URL".to_string())?;
            return std::fs::read(path).map_err(|error| error.to_string());
        }
        self.client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| error.to_string())
    }

    fn store(&self, snapshot: MemberSnapshot) -> MemberSnapshot {
        if let Ok(mut current) = self.snapshot.lock() {
            *current = snapshot.clone();
        }
        snapshot
    }
}

fn api_error(status: u16, body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("overlay-api-{status}"))
}

pub fn parse_bootstrap_response(status: u16, body: &str) -> Result<BootstrapResponse, String> {
    if status != 200 {
        return Err(api_error(status, body));
    }
    serde_json::from_str(body).map_err(|error| format!("invalid-bootstrap-response: {error}"))
}

pub fn parse_game_session_response(status: u16, body: &str) -> Result<GameSessionResponse, String> {
    if status != 200 {
        return Err(api_error(status, body));
    }
    serde_json::from_str(body).map_err(|error| format!("invalid-game-session-response: {error}"))
}

fn canonical_json(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&canonical_value(value)).map_err(|error| error.to_string())
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_value).collect()),
        Value::Object(values) => {
            let sorted = values
                .iter()
                .map(|(key, value)| (key.clone(), canonical_value(value)))
                .collect();
            Value::Object(sorted)
        }
        _ => value.clone(),
    }
}

fn resolve_openssl() -> Result<String, String> {
    for candidate in [
        "/opt/homebrew/bin/openssl",
        "/usr/local/bin/openssl",
        "openssl",
    ] {
        if candidate.starts_with('/') && !Path::new(candidate).is_file() {
            continue;
        }
        if Command::new(candidate)
            .arg("version")
            .output()
            .map(|output| output.status.success() && output.stdout.starts_with(b"OpenSSL 3."))
            .unwrap_or(false)
        {
            return Ok(candidate.to_string());
        }
    }
    Err("OpenSSL 3.x is required for model verification".to_string())
}

fn verify_ed25519(data: &[u8], signature: &[u8], public_key_pem: &str) -> Result<(), String> {
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let public_key_path = directory.path().join("public.pem");
    let data_path = directory.path().join("manifest.bin");
    let signature_path = directory.path().join("signature.bin");
    std::fs::write(&public_key_path, public_key_pem).map_err(|error| error.to_string())?;
    std::fs::write(&data_path, data).map_err(|error| error.to_string())?;
    std::fs::write(&signature_path, signature).map_err(|error| error.to_string())?;
    let output = Command::new(resolve_openssl()?)
        .args(["pkeyutl", "-verify", "-rawin", "-pubin", "-inkey"])
        .arg(public_key_path)
        .arg("-in")
        .arg(data_path)
        .arg("-sigfile")
        .arg(signature_path)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("model-signature-invalid".to_string())
    }
}

pub fn verify_manifest(
    manifest: &ModelManifest,
    config: &Value,
    public_key_pem: &str,
) -> Result<(), String> {
    let config_hash = hex::encode(Sha256::digest(canonical_json(config)?));
    if config_hash != manifest.config_sha256 {
        return Err("model-config-sha256-mismatch".to_string());
    }
    let unsigned = serde_json::json!({
        "modelVersion": manifest.model_version,
        "engineVersion": manifest.engine_version,
        "dataVersion": manifest.data_version,
        "createdAt": manifest.created_at,
        "configSha256": manifest.config_sha256,
    });
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|error| error.to_string())?;
    verify_ed25519(
        &canonical_json(&unsigned)?,
        &signature_bytes,
        public_key_pem,
    )
}

fn tar_string(bytes: &[u8]) -> Result<String, String> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end])
        .map(str::to_string)
        .map_err(|error| error.to_string())
}

fn tar_size(bytes: &[u8]) -> Result<usize, String> {
    let value = tar_string(bytes)?
        .trim()
        .trim_matches('\0')
        .trim()
        .to_string();
    usize::from_str_radix(if value.is_empty() { "0" } else { &value }, 8)
        .map_err(|error| error.to_string())
}

fn model_archive_entries(package: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut tar_bytes = Vec::new();
    GzDecoder::new(package)
        .read_to_end(&mut tar_bytes)
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let mut offset = 0usize;
    while offset + 512 <= tar_bytes.len() {
        let header = &tar_bytes[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let name = tar_string(&header[..100])?;
        let size = tar_size(&header[124..136])?;
        let kind = header[156];
        if kind != 0 && kind != b'0' {
            return Err("model-package-has-non-file-entry".to_string());
        }
        let start = offset + 512;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= tar_bytes.len())
            .ok_or("model-package-entry-is-truncated".to_string())?;
        entries.push((name, tar_bytes[start..end].to_vec()));
        let padded = size
            .checked_add(511)
            .map(|value| value / 512 * 512)
            .ok_or("model-package-entry-is-too-large".to_string())?;
        offset = start
            .checked_add(padded)
            .ok_or("model-package-is-too-large".to_string())?;
    }
    Ok(entries)
}

pub fn verify_model_package(
    package: &[u8],
    expected_manifest: &BootstrapManifest,
    public_key_pem: &str,
) -> Result<(ModelManifest, Value), String> {
    let mut names = BTreeSet::new();
    let mut manifest = None;
    let mut config = None;
    for (path, bytes) in model_archive_entries(package)? {
        if !names.insert(path.clone()) {
            return Err("model-package-has-duplicate-entry".to_string());
        }
        match path.as_str() {
            "manifest.json" => {
                manifest = Some(
                    serde_json::from_slice::<ModelManifest>(&bytes)
                        .map_err(|error| error.to_string())?,
                );
            }
            "model-config.json" => {
                config = Some(
                    serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string())?,
                );
            }
            _ => return Err("model-package-has-unexpected-entry".to_string()),
        }
    }
    if names != BTreeSet::from(["manifest.json".to_string(), "model-config.json".to_string()]) {
        return Err("model-package-must-contain-manifest-and-config".to_string());
    }
    let manifest = manifest.ok_or("model-package-missing-manifest".to_string())?;
    if manifest.model_version != expected_manifest.model_version
        || manifest.engine_version != expected_manifest.engine_version
        || manifest.data_version != expected_manifest.data_version
        || manifest.config_sha256 != expected_manifest.config_sha256
        || manifest.signature != expected_manifest.signature
        || expected_manifest
            .created_at
            .as_ref()
            .is_some_and(|created_at| created_at != &manifest.created_at)
    {
        return Err("model-package-manifest-mismatch".to_string());
    }
    let config = config.ok_or("model-package-missing-config".to_string())?;
    verify_manifest(&manifest, &config, public_key_pem)?;
    Ok((manifest, config))
}

#[tauri::command]
pub async fn member_bootstrap(state: State<'_, MemberState>) -> Result<MemberSnapshot, String> {
    match state.bootstrap().await {
        Ok(snapshot) => Ok(state.store(snapshot)),
        Err(error) => Ok(state.disabled(error)),
    }
}

#[tauri::command]
pub async fn member_game_start(
    state: State<'_, MemberState>,
    game_hash: String,
) -> Result<MemberSnapshot, String> {
    match state.game_start(game_hash).await {
        Ok(snapshot) => Ok(state.store(snapshot)),
        Err(error) => Ok(state.disabled(error)),
    }
}
