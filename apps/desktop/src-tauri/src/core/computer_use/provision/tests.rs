// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::io::Write;
use std::sync::Mutex;

use super::super::manifest::Artifact;
use super::*;

const ENTRY: &str = "cua_driver/bin/cua-driver.exe";

struct FakeFetcher {
    wheel: Vec<u8>,
    failures: Vec<&'static str>,
    restart: bool,
    requests: Mutex<Vec<(String, u64)>>,
}

impl FakeFetcher {
    fn new(wheel: Vec<u8>, failures: Vec<&'static str>) -> Self {
        Self {
            wheel,
            failures,
            restart: false,
            requests: Mutex::new(Vec::new()),
        }
    }

    fn restarting(wheel: Vec<u8>) -> Self {
        Self {
            restart: true,
            ..Self::new(wheel, vec![])
        }
    }

    fn requests(&self) -> Vec<(String, u64)> {
        self.requests.lock().expect("requests").clone()
    }
}

impl WheelFetcher for FakeFetcher {
    async fn fetch(&self, url: &str, offset: u64) -> Result<Fetched, String> {
        self.requests
            .lock()
            .expect("requests")
            .push((url.to_string(), offset));
        if self.failures.iter().any(|fragment| url.contains(fragment)) {
            return Err(format!("simulated failure for {url}"));
        }
        Ok(Fetched {
            bytes: if self.restart {
                self.wheel.clone()
            } else {
                self.wheel[offset as usize..].to_vec()
            },
            restart: self.restart,
        })
    }
}

fn leak(value: impl Into<String>) -> &'static str {
    Box::leak(value.into().into_boxed_str())
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes.as_ref());
    let mut output = String::new();
    for byte in hasher.finalize() {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn wheel_bytes(entry: &str, payload: &[u8]) -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(entry, options).expect("start entry");
        writer.write_all(payload).expect("write entry");
        writer.finish().expect("finish zip");
    }
    buffer.into_inner()
}

fn artifact_for(wheel: &[u8], entry: &str) -> Artifact<'static> {
    Artifact {
        target: leak("test-target"),
        package_path: leak("/packages/aa/bb/cua_driver-test.whl"),
        sha256: leak(hex(wheel)),
        size: wheel.len() as u64,
        entry: leak(entry),
        transport: super::super::manifest::Transport::InProcess,
        binary_sha256: "",
        filename: "",
        helpers: Vec::new(),
    }
}

const MIRRORS: &[&str] = &["https://mirror.one", "https://mirror.two"];

#[tokio::test]
async fn user_given_a_working_release_when_a_candidate_is_only_downloaded_then_keeps_the_active_version(
) {
    let (_directory, layout) = layout();
    write_json(
        &layout.current_pointer(),
        &serde_json::json!({"version": "0.37.0"}),
    )
    .expect("previous version");
    let wheel = wheel_bytes(ENTRY, b"candidate");
    let artifact = artifact_for(&wheel, ENTRY);
    ensure_installed(
        &FakeFetcher::new(wheel, vec![]),
        &layout,
        "0.38.0",
        &artifact,
        MIRRORS,
    )
    .await
    .expect("download candidate");
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(layout.current_pointer()).expect("active record"))
            .expect("record");
    assert_eq!(current["version"], "0.37.0");
}

#[tokio::test]
async fn user_given_a_changed_installed_binary_when_restoring_then_it_is_not_reported_as_verified()
{
    let (_directory, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"verified-driver");
    let artifact = artifact_for(&wheel, ENTRY);
    let installed = ensure_installed(
        &FakeFetcher::new(wheel, vec![]),
        &layout,
        "0.38.0",
        &artifact,
        MIRRORS,
    )
    .await
    .expect("install");
    std::fs::write(installed.binary(), b"modified-driver").expect("simulate corruption");
    assert!(installed_binary(&layout, "0.38.0", &artifact)
        .expect("lookup")
        .is_none());
}

#[tokio::test]
async fn user_given_a_pinned_tar_release_when_installing_then_extracts_only_the_driver() {
    let (_directory, layout) = layout();
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    let payload = b"driver executable";
    let mut header = tar::Header::new_gnu();
    header.set_size(payload.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    builder
        .append_data(&mut header, "agent-desktop.exe", &payload[..])
        .expect("archive");
    let bytes = builder.into_inner().expect("tar").finish().expect("gzip");
    let mut artifact = artifact_for(&bytes, "agent-desktop.exe");
    artifact.package_path = "/release/agent-desktop.tar.gz";
    let installed = ensure_installed(
        &FakeFetcher::new(bytes, vec![]),
        &layout,
        "1.2.0",
        &artifact,
        MIRRORS,
    )
    .await
    .expect("install");
    assert_eq!(std::fs::read(installed.binary()).expect("binary"), payload);
}

fn layout() -> (tempfile::TempDir, InstallLayout) {
    let dir = tempfile::tempdir().expect("temp dir");
    let layout = InstallLayout::new(dir.path().join("computer-use"));
    (dir, layout)
}

#[tokio::test]
async fn user_given_an_old_release_when_a_verified_runtime_is_activated_then_removes_only_obsolete_driver_files(
) {
    let (_temporary, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"working binary");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec![]);
    ensure_installed(&fetcher, &layout, "0.37.0", &artifact, MIRRORS)
        .await
        .expect("old install");
    confirm_install(&layout, "0.37.0", &artifact).expect("old active");
    ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("new download");
    let unrelated = layout.version_dir("notes");
    std::fs::create_dir_all(&unrelated).expect("notes");
    std::fs::write(unrelated.join("keep.txt"), "keep").expect("note");
    assert!(layout.version_dir("0.37.0").exists());
    confirm_install(&layout, "0.38.0", &artifact).expect("new runtime verified");
    assert!(!layout.version_dir("0.37.0").exists());
    assert!(!layout.partial_path("0.37.0").exists());
    assert!(installed_binary(&layout, "0.38.0", &artifact)
        .expect("new binary")
        .is_some());
    assert_eq!(
        std::fs::read_to_string(unrelated.join("keep.txt")).expect("note"),
        "keep"
    );
}

#[tokio::test]
async fn user_given_a_corrupted_candidate_when_activation_fails_then_keeps_the_previous_release() {
    let (_temporary, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"working binary");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec![]);
    ensure_installed(&fetcher, &layout, "0.37.0", &artifact, MIRRORS)
        .await
        .expect("old install");
    confirm_install(&layout, "0.37.0", &artifact).expect("old active");
    let candidate = ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("new download");
    std::fs::write(candidate.binary(), b"corrupt").expect("corrupt candidate");
    assert!(confirm_install(&layout, "0.38.0", &artifact).is_err());
    assert!(installed_binary(&layout, "0.37.0", &artifact)
        .expect("old binary")
        .is_some());
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(layout.current_pointer()).expect("pointer"))
            .expect("json");
    assert_eq!(current["version"], "0.37.0");
}

#[tokio::test]
async fn user_given_an_upgraded_release_when_its_own_install_is_verified_then_activates_it() {
    let (_temporary, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"upgraded binary");
    let artifact = artifact_for(&wheel, ENTRY);
    let installed = ensure_installed(
        &FakeFetcher::new(wheel, vec![]),
        &layout,
        "0.44.0",
        &artifact,
        MIRRORS,
    )
    .await
    .expect("upgraded install");

    confirm_version(&layout, "0.44.0").expect("activate");

    assert_eq!(active_version(&layout).as_deref(), Some("0.44.0"));
    assert_eq!(
        active_install(&layout).expect("active install"),
        Some(("0.44.0".to_string(), installed.binary().to_path_buf()))
    );
}

#[tokio::test]
async fn user_given_a_replaced_upgraded_binary_when_activating_it_then_refuses_to_switch() {
    let (_temporary, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"upgraded binary");
    let artifact = artifact_for(&wheel, ENTRY);
    let installed = ensure_installed(
        &FakeFetcher::new(wheel, vec![]),
        &layout,
        "0.44.0",
        &artifact,
        MIRRORS,
    )
    .await
    .expect("upgraded install");
    std::fs::write(installed.binary(), b"replaced").expect("simulate replacement");

    assert!(confirm_version(&layout, "0.44.0").is_err());
    assert!(active_version(&layout).is_none());
}

#[tokio::test]
async fn user_given_a_corrupt_mirror_when_downloading_then_uses_a_verified_fallback() {
    struct CorruptMirror(Vec<u8>);
    impl WheelFetcher for CorruptMirror {
        async fn fetch(&self, url: &str, _offset: u64) -> Result<Fetched, String> {
            Ok(Fetched {
                bytes: if url.contains("mirror.one") {
                    vec![0; self.0.len()]
                } else {
                    self.0.clone()
                },
                restart: true,
            })
        }
    }
    let (_temporary, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"verified fallback");
    let artifact = artifact_for(&wheel, ENTRY);
    let installed = ensure_installed(&CorruptMirror(wheel), &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("fallback");
    assert_eq!(
        std::fs::read(installed.binary()).expect("binary"),
        b"verified fallback"
    );
}

#[tokio::test]
async fn user_given_a_multi_platform_npm_archive_when_installing_then_receives_only_the_selected_binary_and_helper(
) {
    let (_temporary, layout) = layout();
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    for (name, payload) in [
        ("package/bin/native-linux", b"binary".as_slice()),
        ("package/bin/helper", b"helper".as_slice()),
        ("package/scripts/postinstall.js", b"unwanted".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, name, payload)
            .expect("member");
    }
    let bytes = builder.into_inner().expect("tar").finish().expect("gzip");
    let mut artifact = artifact_for(&bytes, "package/bin/native-linux");
    artifact.package_path = "/agent-desktop/-/agent-desktop-1.2.0.tgz";
    artifact.filename = "agent-desktop";
    artifact.binary_sha256 = leak(hex(b"binary"));
    artifact.helpers = vec![super::super::manifest::Helper {
        entry: "package/bin/helper",
        filename: "helper",
        sha256: leak(hex(b"helper")),
    }];
    let installed = ensure_installed(
        &FakeFetcher::new(bytes, vec![]),
        &layout,
        "1.2.0",
        &artifact,
        MIRRORS,
    )
    .await
    .expect("install");
    assert_eq!(
        installed.binary().file_name().expect("name"),
        "agent-desktop"
    );
    assert_eq!(
        std::fs::read_dir(layout.version_dir("1.2.0"))
            .expect("files")
            .count(),
        3
    );
    std::fs::write(layout.binary_path("1.2.0", "helper"), "corrupt").expect("helper");
    assert!(installed_binary(&layout, "1.2.0", &artifact)
        .expect("verify helper")
        .is_none());
}

#[tokio::test]
async fn installs_the_driver_from_the_first_mirror() {
    let (dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec![]);

    let installed = ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("install");

    match installed {
        Installed::Installed {
            binary,
            binary_sha256,
        } => {
            assert!(binary.is_file());
            assert_eq!(std::fs::read(&binary).expect("binary"), b"driver-bytes");
            assert_eq!(binary_sha256.len(), 64);
        }
        other => panic!("expected a fresh install, got {other:?}"),
    }
    assert!(!layout.current_pointer().exists());
    confirm_install(&layout, "0.38.0", &artifact).expect("activate verified runtime");
    assert!(layout.current_pointer().is_file());
    assert_eq!(fetcher.requests().len(), 1);
    assert!(fetcher.requests()[0].0.starts_with("https://mirror.one/"));
    drop(dir);
}

#[tokio::test]
async fn reuses_an_existing_install_without_touching_the_network() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec![]);

    ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("first install");
    let second = ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("second install");

    assert!(matches!(second, Installed::AlreadyInstalled { .. }));
    assert_eq!(fetcher.requests().len(), 1);
}

#[tokio::test]
async fn falls_back_to_the_next_mirror_when_one_fails() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec!["mirror.one"]);

    ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("install from fallback");

    let urls: Vec<String> = fetcher.requests().into_iter().map(|(url, _)| url).collect();
    assert_eq!(urls.len(), 2);
    assert!(urls[1].starts_with("https://mirror.two/"));
}

#[tokio::test]
async fn reports_every_attempt_when_all_mirrors_fail() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec!["mirror"]);

    let error = ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect_err("all mirrors fail");

    match error {
        ProvisionError::Download { attempts, .. } => assert_eq!(attempts, MIRRORS.len()),
        other => panic!("unexpected error: {other}"),
    }
    assert!(!layout.current_pointer().is_file());
}

#[tokio::test]
async fn refuses_a_wheel_whose_digest_does_not_match_and_drops_it() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let mut artifact = artifact_for(&wheel, ENTRY);
    artifact.sha256 = leak("0".repeat(64));
    let fetcher = FakeFetcher::new(wheel, vec![]);

    let error = ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect_err("digest mismatch");

    assert!(matches!(error, ProvisionError::DigestMismatch { .. }));
    assert!(!layout.partial_path("0.38.0").exists());
    assert!(!layout.current_pointer().is_file());
}

#[tokio::test]
async fn resumes_from_the_bytes_already_on_disk() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel.clone(), vec![]);

    let partial = layout.partial_path("0.38.0");
    std::fs::create_dir_all(partial.parent().expect("parent")).expect("partial dir");
    let split = wheel.len() / 2;
    std::fs::write(&partial, &wheel[..split]).expect("seed partial");

    ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("resumed install");

    assert_eq!(fetcher.requests()[0].1, split as u64);
}

#[tokio::test]
async fn restarts_the_partial_file_when_a_mirror_ignores_the_range_header() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes(ENTRY, b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::restarting(wheel.clone());

    let partial = layout.partial_path("0.38.0");
    std::fs::create_dir_all(partial.parent().expect("parent")).expect("partial dir");
    std::fs::write(&partial, b"truncated-garbage").expect("seed partial");

    ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect("install after restart");

    assert_eq!(
        std::fs::read(layout.binary_path("0.38.0", "cua-driver.exe")).expect("binary"),
        b"driver-bytes"
    );
}

#[tokio::test]
async fn refuses_a_wheel_without_the_driver_entry() {
    let (_dir, layout) = layout();
    let wheel = wheel_bytes("cua_driver/bin/other.exe", b"driver-bytes");
    let artifact = artifact_for(&wheel, ENTRY);
    let fetcher = FakeFetcher::new(wheel, vec![]);

    let error = ensure_installed(&fetcher, &layout, "0.38.0", &artifact, MIRRORS)
        .await
        .expect_err("missing entry");

    assert!(matches!(error, ProvisionError::MissingEntry { .. }));
    assert!(!layout.binary_path("0.38.0", "cua-driver.exe").exists());
}
