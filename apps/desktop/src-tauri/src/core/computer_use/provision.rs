// Copyright (c) 2026. 千诚. Licensed under GPL v3.

// Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3.

//! Runtime provisioning of the cua-driver engine.
//!
//! The engine is not embedded in the installer: it is fetched from a PyPI mirror,
//! verified against a pinned digest, and only the driver executable is extracted
//! from the wheel.

use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::manifest::Artifact;

#[derive(Debug)]
pub enum ProvisionError {
    Download { attempts: usize, last: String },
    SizeMismatch { expected: u64, actual: u64 },
    DigestMismatch { expected: String, actual: String },
    MissingEntry { entry: String },
    Io(String),
}

impl std::fmt::Display for ProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Download { attempts, last } => {
                write!(f, "download failed after {attempts} attempts: {last}")
            }
            Self::SizeMismatch { expected, actual } => {
                write!(f, "downloaded {actual} bytes, expected {expected}")
            }
            Self::DigestMismatch { expected, actual } => {
                write!(f, "digest mismatch: expected {expected}, got {actual}")
            }
            Self::MissingEntry { entry } => write!(f, "archive does not contain {entry}"),
            Self::Io(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ProvisionError {}

impl From<std::io::Error> for ProvisionError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Installed {
    AlreadyInstalled {
        binary: PathBuf,
    },
    Installed {
        binary: PathBuf,
        binary_sha256: String,
    },
}

impl Installed {
    pub fn binary(&self) -> &Path {
        match self {
            Self::AlreadyInstalled { binary } | Self::Installed { binary, .. } => binary,
        }
    }
}

pub struct Fetched {
    pub bytes: Vec<u8>,
    /// The server ignored the Range request and sent the whole body again.
    pub restart: bool,
}

/// Byte source for one wheel, from `offset` to the end.
pub trait WheelFetcher {
    fn fetch(
        &self,
        url: &str,
        offset: u64,
    ) -> impl std::future::Future<Output = Result<Fetched, String>>;
}

/// Directories owned by provisioning under the app data root.
pub struct InstallLayout {
    root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct InstallRecord {
    version: String,
    wheel_sha256: String,
    binary_sha256: String,
}

impl InstallLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.root.join(version)
    }

    pub fn binary_path(&self, version: &str, filename: &str) -> PathBuf {
        self.version_dir(version).join(filename)
    }

    pub fn partial_path(&self, version: &str) -> PathBuf {
        self.root
            .join(".partial")
            .join(format!("{version}.whl.part"))
    }

    pub fn record_path(&self, version: &str) -> PathBuf {
        self.version_dir(version).join("install.json")
    }

    pub fn current_pointer(&self) -> PathBuf {
        self.root.join("current.json")
    }
}

pub async fn ensure_installed<F: WheelFetcher>(
    fetcher: &F,
    layout: &InstallLayout,
    version: &str,
    artifact: &Artifact,
    mirrors: &[&str],
) -> Result<Installed, ProvisionError> {
    let binary_name = entry_file_name(artifact.entry)?;
    let binary = layout.binary_path(version, binary_name);

    if is_installed(layout, version, artifact, &binary) {
        return Ok(Installed::AlreadyInstalled { binary });
    }

    let wheel = download(fetcher, layout, version, artifact, mirrors).await?;
    verify_wheel(&wheel, artifact)?;
    extract_entry(&wheel, artifact.entry, &binary)?;

    let binary_sha256 = sha256_file(&binary)?;
    std::fs::create_dir_all(layout.version_dir(version))?;
    write_json(
        &layout.record_path(version),
        &InstallRecord {
            version: version.to_string(),
            wheel_sha256: artifact.sha256.to_string(),
            binary_sha256: binary_sha256.clone(),
        },
    )?;
    write_json(
        &layout.current_pointer(),
        &CurrentPointer {
            version: version.to_string(),
        },
    )?;

    Ok(Installed::Installed {
        binary,
        binary_sha256,
    })
}

fn entry_file_name(entry: &str) -> Result<&str, ProvisionError> {
    entry
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ProvisionError::MissingEntry {
            entry: entry.to_string(),
        })
}

fn is_installed(layout: &InstallLayout, version: &str, artifact: &Artifact, binary: &Path) -> bool {
    if !binary.is_file() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(layout.record_path(version)) else {
        return false;
    };
    let Ok(record) = serde_json::from_str::<InstallRecord>(&raw) else {
        return false;
    };
    if record.version != version || record.wheel_sha256 != artifact.sha256 {
        return false;
    }
    artifact.binary_sha256.is_empty() || record.binary_sha256 == artifact.binary_sha256
}

async fn download<F: WheelFetcher>(
    fetcher: &F,
    layout: &InstallLayout,
    version: &str,
    artifact: &Artifact,
    mirrors: &[&str],
) -> Result<PathBuf, ProvisionError> {
    let partial = layout.partial_path(version);
    if let Some(parent) = partial.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut attempts = 0;
    let mut last_error = String::new();
    for url in candidate_urls(mirrors, artifact) {
        attempts += 1;
        let offset = std::fs::metadata(&partial)
            .map(|meta| meta.len())
            .unwrap_or(0);
        match fetcher.fetch(&url, offset).await {
            Ok(fetched) => {
                if offset > 0 && fetched.bytes.is_empty() {
                    std::fs::remove_file(&partial)?;
                    last_error = "mirror returned no bytes for a resumed request".to_string();
                    continue;
                }
                // Append mode cannot truncate on Windows, so seek explicitly.
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .read(true)
                    .write(true)
                    .open(&partial)?;
                if fetched.restart {
                    file.set_len(0)?;
                } else {
                    file.seek(std::io::SeekFrom::End(0))?;
                }
                file.write_all(&fetched.bytes)?;
                file.sync_all()?;
                return Ok(partial);
            }
            Err(error) => last_error = error,
        }
    }

    Err(ProvisionError::Download {
        attempts,
        last: last_error,
    })
}

fn candidate_urls(mirrors: &[&str], artifact: &Artifact) -> Vec<String> {
    mirrors
        .iter()
        .map(|mirror| format!("{}{}", mirror.trim_end_matches('/'), artifact.package_path))
        .collect()
}

fn verify_wheel(path: &Path, artifact: &Artifact) -> Result<(), ProvisionError> {
    let actual_size = std::fs::metadata(path)?.len();
    if actual_size != artifact.size {
        let _ = std::fs::remove_file(path);
        return Err(ProvisionError::SizeMismatch {
            expected: artifact.size,
            actual: actual_size,
        });
    }
    let actual = sha256_file(path)?;
    if actual != artifact.sha256 {
        let _ = std::fs::remove_file(path);
        return Err(ProvisionError::DigestMismatch {
            expected: artifact.sha256.to_string(),
            actual,
        });
    }
    Ok(())
}

fn extract_entry(wheel: &Path, entry: &str, destination: &Path) -> Result<(), ProvisionError> {
    let file = std::fs::File::open(wheel)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| ProvisionError::Io(error.to_string()))?;
    let mut member = archive
        .by_name(entry)
        .map_err(|_| ProvisionError::MissingEntry {
            entry: entry.to_string(),
        })?;
    let mut buffer = Vec::with_capacity(40 * 1024 * 1024);
    member.read_to_end(&mut buffer)?;

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staging = destination.with_extension("downloading");
    std::fs::write(&staging, &buffer)?;
    std::fs::rename(&staging, destination)?;
    Ok(())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), ProvisionError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staging = path.with_extension("tmp");
    let body =
        serde_json::to_vec_pretty(value).map_err(|error| ProvisionError::Io(error.to_string()))?;
    std::fs::write(&staging, body)?;
    std::fs::rename(&staging, path)?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct CurrentPointer {
    version: String,
}

pub fn sha256_file(path: &Path) -> Result<String, ProvisionError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    Ok(output)
}

#[cfg(test)]
mod tests;
