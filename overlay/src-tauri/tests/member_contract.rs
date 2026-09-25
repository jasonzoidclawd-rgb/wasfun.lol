use flate2::{write::GzEncoder, Compression};
use mayhem_oracle_lib::member::{
    hash_game_id, parse_bootstrap_response, parse_game_session_response, resolve_api_base,
    verify_manifest, verify_model_package, BootstrapManifest, DEFAULT_API_BASE,
};
use serde_json::{json, Value};
use std::io::Write;

const PUBLIC_KEY: &str = include_str!("../../../docs/handoffs/fixtures/m4/public-key.txt");
const MANIFEST: &str =
    include_str!("../../../docs/handoffs/fixtures/m4/sample-signed-manifest.json");
const MODEL_CONFIG: &str = include_str!("../../../docs/handoffs/fixtures/m4/model-config.json");

#[test]
fn accepts_the_m4_signature_and_rejects_tampering() {
    let manifest = serde_json::from_str(MANIFEST).unwrap();
    let config: Value = serde_json::from_str(MODEL_CONFIG).unwrap();

    assert!(verify_manifest(&manifest, &config, PUBLIC_KEY).is_ok());

    let mut tampered = config.clone();
    tampered["priorClamp"] = json!([0, 100]);
    assert!(verify_manifest(&manifest, &tampered, PUBLIC_KEY).is_err());
}

fn tar_entry(name: &str, contents: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    let size = format!("{:011o}\0", contents.len());
    header[124..136].copy_from_slice(size.as_bytes());
    header[156] = b'0';
    let mut entry = header.to_vec();
    entry.extend_from_slice(contents);
    entry.resize(512 + contents.len().div_ceil(512) * 512, 0);
    entry
}

fn model_package(config: &Value) -> Vec<u8> {
    let mut archive = Vec::new();
    archive.extend(tar_entry(
        "model-config.json",
        serde_json::to_string(config).unwrap().as_bytes(),
    ));
    archive.extend(tar_entry("manifest.json", MANIFEST.as_bytes()));
    archive.resize(archive.len() + 1024, 0);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&archive).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn verifies_the_complete_signed_model_package_and_rejects_tampered_config() {
    let manifest = serde_json::from_str::<BootstrapManifest>(MANIFEST).unwrap();
    let config = serde_json::from_str::<Value>(MODEL_CONFIG).unwrap();

    let (_, verified_config) =
        verify_model_package(&model_package(&config), &manifest, PUBLIC_KEY).unwrap();
    assert_eq!(verified_config, config);

    let mut tampered = config.clone();
    tampered["priorClamp"] = json!([0, 100]);
    assert!(verify_model_package(&model_package(&tampered), &manifest, PUBLIC_KEY).is_err());
}

#[test]
fn hashes_game_ids_before_they_leave_the_device() {
    assert_eq!(
        hash_game_id("991240001"),
        "e16198ede65335bfda99ff2c117383c75e0d7a83d87abba3b4bd0b7e836fe674"
    );
    assert_ne!(hash_game_id("991240001"), hash_game_id("991240002"));
}

#[test]
fn defaults_member_api_base_to_production_origin() {
    let api_base = resolve_api_base(None).unwrap();

    assert_eq!(DEFAULT_API_BASE, "https://wasfun.lol");
    assert_eq!(api_base.as_str(), "https://wasfun.lol/");
}

#[test]
fn explicit_member_api_base_override_wins() {
    let api_base = resolve_api_base(Some("http://localhost:3000")).unwrap();

    assert_eq!(api_base.as_str(), "http://localhost:3000/");
}

#[test]
fn blank_member_api_base_uses_production_default() {
    let api_base = resolve_api_base(Some("   ")).unwrap();

    assert_eq!(api_base.as_str(), "https://wasfun.lol/");
}

#[test]
fn parses_frozen_bootstrap_and_game_session_contracts() {
    let bootstrap = parse_bootstrap_response(
        200,
        &json!({
            "manifest": serde_json::from_str::<Value>(MANIFEST).unwrap(),
            "packageUrl": "https://models.example/model-decision-v1.tar.gz",
            "access": { "kind": "member" }
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(bootstrap.access.kind, "member");

    let mut transcript_manifest = serde_json::from_str::<Value>(MANIFEST).unwrap();
    transcript_manifest
        .as_object_mut()
        .unwrap()
        .remove("createdAt");
    assert!(parse_bootstrap_response(
        200,
        &json!({
            "manifest": transcript_manifest,
            "packageUrl": "/fixtures/model-decision-v1.tar.gz",
            "access": { "kind": "trial" }
        })
        .to_string(),
    )
    .is_ok());

    let session = parse_game_session_response(
        200,
        &json!({
            "lease": {
                "kind": "trial-lease",
                "gameHash": "abc123",
                "expiresAt": "2026-06-13T12:00:00Z"
            }
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(session.lease.game_hash, "abc123");

    assert_eq!(
        parse_bootstrap_response(401, r#"{"error":"not-signed-in"}"#).unwrap_err(),
        "not-signed-in"
    );
    assert_eq!(
        parse_game_session_response(403, r#"{"error":"no-trial-credits"}"#).unwrap_err(),
        "no-trial-credits"
    );
}
