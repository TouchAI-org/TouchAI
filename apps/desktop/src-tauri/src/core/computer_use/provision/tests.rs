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

fn artifact_for(wheel: &[u8], entry: &str) -> Artifact {
    Artifact {
        target: leak("test-target"),
        package_path: leak("/packages/aa/bb/cua_driver-test.whl"),
        sha256: leak(hex(wheel)),
        size: wheel.len() as u64,
        entry: leak(entry),
        transport: super::super::manifest::Transport::InProcess,
        binary_sha256: "",
    }
}

const MIRRORS: &[&str] = &["https://mirror.one", "https://mirror.two"];

fn layout() -> (tempfile::TempDir, InstallLayout) {
    let dir = tempfile::tempdir().expect("temp dir");
    let layout = InstallLayout::new(dir.path().join("computer-use"));
    (dir, layout)
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
