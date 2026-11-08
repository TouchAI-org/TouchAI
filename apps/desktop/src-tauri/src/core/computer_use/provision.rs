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

    async fn sources(&self, mirrors: &[&str], package_path: &str) -> Vec<String> {
        mirrors
            .iter()
            .map(|mirror| format!("{}{}", mirror.trim_end_matches('/'), package_path))
            .collect()
    }
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
    artifact: &Artifact<'_>,
    mirrors: &[&str],
) -> Result<Installed, ProvisionError> {
    let binary_name = binary_name(artifact)?;
    let binary = layout.binary_path(version, binary_name);

    if is_installed(layout, version, artifact, &binary) {
        return Ok(Installed::AlreadyInstalled { binary });
    }

    let wheel = download(fetcher, layout, version, artifact, mirrors).await?;
    verify_wheel(&wheel, artifact)?;
    if artifact.package_path.ends_with(".tar.gz") || artifact.package_path.ends_with(".tgz") {
        extract_tar_entry(&wheel, artifact.entry, &binary)?;
        for helper in &artifact.helpers {
            let destination = layout.binary_path(version, checked_filename(helper.filename)?);
            extract_tar_entry(&wheel, helper.entry, &destination)?;
            verify_binary(&destination, helper.sha256)?;
        }
    } else {
        extract_entry(&wheel, artifact.entry, &binary)?;
    }

    let binary_sha256 = sha256_file(&binary)?;
    verify_binary(&binary, artifact.binary_sha256)?;
    std::fs::create_dir_all(layout.version_dir(version))?;
    write_json(
        &layout.record_path(version),
        &InstallRecord {
            version: version.to_string(),
            wheel_sha256: artifact.sha256.to_string(),
            binary_sha256: binary_sha256.clone(),
        },
    )?;
    Ok(Installed::Installed {
        binary,
        binary_sha256,
    })
}

fn checked_filename(filename: &str) -> Result<&str, ProvisionError> {
    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains(['/', '\\', ':'])
    {
        return Err(ProvisionError::Io("invalid driver file name".into()));
    }
    Ok(filename)
}

fn binary_name<'artifact>(
    artifact: &'artifact Artifact<'_>,
) -> Result<&'artifact str, ProvisionError> {
    checked_filename(if artifact.filename.is_empty() {
        entry_file_name(artifact.entry)?
    } else {
        artifact.filename
    })
}

fn verify_binary(path: &Path, expected: &str) -> Result<(), ProvisionError> {
    if expected.is_empty() {
        return Ok(());
    }
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(ProvisionError::DigestMismatch {
            expected: expected.into(),
            actual,
        });
    }
    Ok(())
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

pub fn installed_binary(
    layout: &InstallLayout,
    version: &str,
    artifact: &Artifact<'_>,
) -> Result<Option<PathBuf>, ProvisionError> {
    let binary = layout.binary_path(version, binary_name(artifact)?);
    Ok(is_installed(layout, version, artifact, &binary).then_some(binary))
}

fn is_installed(
    layout: &InstallLayout,
    version: &str,
    artifact: &Artifact<'_>,
    binary: &Path,
) -> bool {
    if !binary.is_file() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(layout.record_path(version)) else {
        return false;
    };
    let Ok(record) = serde_json::from_str::<InstallRecord>(&raw) else {
        return false;
    };
    if record.version != version
        || (record.wheel_sha256 != artifact.sha256 && artifact.binary_sha256.is_empty())
    {
        return false;
    }
    (artifact.binary_sha256.is_empty() || record.binary_sha256 == artifact.binary_sha256)
        && sha256_file(binary).is_ok_and(|actual| actual == record.binary_sha256)
        && artifact.helpers.iter().all(|helper| {
            checked_filename(helper.filename).is_ok()
                && verify_binary(&layout.binary_path(version, helper.filename), helper.sha256)
                    .is_ok()
        })
}

pub fn confirm_install(
    layout: &InstallLayout,
    version: &str,
    artifact: &Artifact<'_>,
) -> Result<(), ProvisionError> {
    if installed_binary(layout, version, artifact)?.is_none() {
        return Err(ProvisionError::Io(
            "driver changed before activation".into(),
        ));
    }
    write_json(
        &layout.current_pointer(),
        &CurrentPointer {
            version: version.into(),
        },
    )?;
    if let Err(error) = prune_versions(layout, version) {
        log::warn!("Driver {version} is active; obsolete files will be retried on the next activation: {error}");
    }
    Ok(())
}

pub fn prune_versions(layout: &InstallLayout, version: &str) -> Result<(), ProvisionError> {
    let current =
        semver::Version::parse(version).map_err(|error| ProvisionError::Io(error.to_string()))?;
    let retired = layout.root.join(".retired");
    if retired.exists() {
        if std::fs::symlink_metadata(&retired)?
            .file_type()
            .is_symlink()
        {
            return Err(ProvisionError::Io(
                "retired directory is a symbolic link".into(),
            ));
        }
        for entry in std::fs::read_dir(&retired)? {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
            {
                std::fs::remove_dir_all(entry.path())?;
            }
        }
    }
    for entry in std::fs::read_dir(&layout.root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(candidate) = semver::Version::parse(&name) else {
            continue;
        };
        if candidate >= current {
            continue;
        }
        let record = std::fs::read(layout.record_path(&name))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<InstallRecord>(&bytes).ok());
        if record.as_ref().is_none_or(|record| record.version != name) {
            continue;
        }
        std::fs::create_dir_all(&retired)?;
        let target = retired.join(uuid::Uuid::new_v4().to_string());
        std::fs::rename(entry.path(), &target)?;
        if let Err(error) = std::fs::remove_dir_all(&target) {
            log::warn!(
                "Old driver files retained for cleanup at {}: {error}",
                target.display()
            );
        }
    }
    let partial = layout.root.join(".partial");
    if partial.is_dir()
        && !std::fs::symlink_metadata(&partial)?
            .file_type()
            .is_symlink()
    {
        for entry in std::fs::read_dir(partial)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let obsolete = name
                .strip_suffix(".whl.part")
                .and_then(|value| semver::Version::parse(value).ok())
                .is_some_and(|candidate| candidate < current);
            if obsolete && entry.file_type()?.is_file() {
                std::fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

async fn download<F: WheelFetcher>(
    fetcher: &F,
    layout: &InstallLayout,
    version: &str,
    artifact: &Artifact<'_>,
    mirrors: &[&str],
) -> Result<PathBuf, ProvisionError> {
    let partial = layout.partial_path(version);
    if std::fs::metadata(&partial).is_ok_and(|metadata| metadata.len() == artifact.size)
        && verify_wheel(&partial, artifact).is_ok()
    {
        return Ok(partial);
    }
    if let Some(parent) = partial.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut attempts = 0;
    let mut last_error = String::new();
    let mut integrity_error = None;
    for url in fetcher.sources(mirrors, artifact.package_path).await {
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
                drop(file);
                match verify_wheel(&partial, artifact) {
                    Ok(()) => return Ok(partial),
                    Err(error) => {
                        log::warn!("Rejected driver archive from {url}: {error}");
                        integrity_error = Some(error);
                    }
                }
            }
            Err(error) => last_error = error,
        }
    }

    if let Some(error) = integrity_error {
        return Err(error);
    }
    Err(ProvisionError::Download {
        attempts,
        last: last_error,
    })
}

fn verify_wheel(path: &Path, artifact: &Artifact<'_>) -> Result<(), ProvisionError> {
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

fn extract_tar_entry(
    archive: &Path,
    entry: &str,
    destination: &Path,
) -> Result<(), ProvisionError> {
    let decoder = flate2::read::GzDecoder::new(std::fs::File::open(archive)?);
    let mut archive = tar::Archive::new(decoder);
    for member in archive.entries()? {
        let mut member = member?;
        if member.path()?.as_ref() != Path::new(entry) || !member.header().entry_type().is_file() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let staging = destination.with_extension("downloading");
        member.unpack(&staging)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(staging, destination)?;
        return Ok(());
    }
    Err(ProvisionError::MissingEntry {
        entry: entry.to_string(),
    })
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
