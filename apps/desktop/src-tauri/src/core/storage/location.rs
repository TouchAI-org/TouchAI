use super::{files, path_key, MAX_ENTRIES};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(crate) const DIRECTORIES: [&str; 6] =
    ["data", "cache", "logs", "assets", "computer-use", "skills"];
const CONFIG: &str = "data-location.json";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocationConfig {
    active: Option<PathBuf>,
    pending: Option<PathBuf>,
    notice: Option<String>,
    previous: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationInfo {
    current_path: PathBuf,
    pending_path: Option<PathBuf>,
    notice: Option<String>,
    previous_path: Option<PathBuf>,
}

pub struct DataLocationRuntime {
    base: PathBuf,
    current: PathBuf,
    config: Mutex<LocationConfig>,
    _lock: File,
}

fn read_config(base: &Path) -> Result<LocationConfig, String> {
    let path = base.join(CONFIG);
    files::validate_path(&path)?;
    match fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LocationConfig::default()),
        Ok(metadata) if metadata.len() <= 65_536 => {
            serde_json::from_reader(File::open(path).map_err(|_| "storage_io_failed")?)
                .map_err(|_| "storage_invalid_path".into())
        }
        _ => Err("storage_invalid_path".into()),
    }
}

fn write_config(base: &Path, config: &LocationConfig) -> Result<(), String> {
    files::validate_path(base)?;
    let mut temporary = tempfile::NamedTempFile::new_in(base).map_err(|_| "storage_io_failed")?;
    serde_json::to_writer(&mut temporary, config).map_err(|_| "storage_io_failed")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "storage_io_failed")?;
    let committed = temporary
        .persist(base.join(CONFIG))
        .map_err(|_| "storage_io_failed")?;
    committed.sync_all().map_err(|_| "storage_io_failed")?;
    sync_directory(base)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "storage_io_failed")?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn validate_destination(source: &Path, target: &Path) -> Result<(), String> {
    files::validate_path(target)?;
    let source_key = path_key(source);
    let target_key = path_key(target);
    if source_key == target_key
        || source_key.starts_with(&format!("{target_key}/"))
        || target_key.starts_with(&format!("{source_key}/"))
    {
        return Err("storage_move_overlap".into());
    }
    let parent = target.parent().ok_or("storage_invalid_path")?;
    if !parent.is_dir() {
        return Err("storage_invalid_path".into());
    }
    if target.exists()
        && (!target.is_dir()
            || fs::read_dir(target)
                .map_err(|_| "storage_io_failed")?
                .next()
                .is_some())
    {
        return Err("storage_move_not_empty".into());
    }
    Ok(())
}

fn source_files(source: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for directory in DIRECTORIES {
        paths.extend(files::walk_entries(
            &source.join(directory),
            MAX_ENTRIES.saturating_sub(paths.len()),
            true,
        )?);
    }
    Ok(paths)
}

fn check_space(paths: &[PathBuf], target: &Path) -> Result<(), String> {
    let mut required = 32_u64 * 1024 * 1024;
    for path in paths {
        required = required
            .checked_add(fs::metadata(path).map_err(|_| "storage_io_failed")?.len())
            .ok_or("storage_insufficient_space")?;
    }
    if files::available_space(target.parent().ok_or("storage_invalid_path")?)?
        < required.saturating_mul(2)
    {
        return Err("storage_insufficient_space".into());
    }
    Ok(())
}

impl DataLocationRuntime {
    pub async fn initialize(base: PathBuf) -> Result<Self, String> {
        let logical_base = base.clone();
        let base = files::resolve_platform_path(&base)?;
        fs::create_dir_all(&base).map_err(|_| "storage_io_failed")?;
        let lock_path = base.join("data-location.lock");
        files::validate_path(&lock_path)?;
        let lock = File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|_| "storage_io_failed")?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock)
                    if tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(std::fs::TryLockError::WouldBlock) => return Err("storage_busy".into()),
                Err(_) => return Err("storage_io_failed".into()),
            }
        }
        let mut config = read_config(&base)?;
        if config.previous.is_some() && config.notice.is_none() {
            config.notice = Some("storage_move_cleanup_pending".into());
        }
        let source = config.active.clone().unwrap_or_else(|| base.clone());
        files::validate_path(&source)?;
        if config.active.is_some() && !source.join("data/touchai.db").is_file() {
            return Err("storage_move_source_missing".into());
        }
        if let Some(target) = config.pending.take() {
            let logical_source = config.active.as_ref().unwrap_or(&logical_base).clone();
            match relocate(&base, &source, &logical_source, &target, &mut config).await {
                Ok(()) => {}
                Err(error) => {
                    config.notice = Some(if config.active.as_ref() == Some(&target) {
                        "storage_move_cleanup_pending".into()
                    } else {
                        error
                    });
                    write_config(&base, &config)?;
                }
            }
        }
        let current = config.active.clone().unwrap_or(logical_base);
        Ok(Self {
            base,
            current,
            config: Mutex::new(config),
            _lock: lock,
        })
    }

    pub fn current(&self) -> &Path {
        &self.current
    }

    pub fn relocated(&self) -> bool {
        self.config
            .lock()
            .map(|config| config.active.is_some())
            .unwrap_or(true)
    }

    pub fn info(&self) -> Result<DataLocationInfo, String> {
        let config = self.config.lock().map_err(|_| "storage_io_failed")?;
        Ok(DataLocationInfo {
            current_path: self.current.clone(),
            pending_path: config.pending.clone(),
            notice: config.notice.clone(),
            previous_path: config.previous.clone(),
        })
    }

    pub fn schedule(&self, target: PathBuf) -> Result<DataLocationInfo, String> {
        let target = files::resolve_platform_path(&target)?;
        let source = files::resolve_platform_path(&self.current)?;
        validate_destination(&source, &target)?;
        let paths = source_files(&source)?;
        check_space(&paths, &target)?;
        let mut config = self.config.lock().map_err(|_| "storage_io_failed")?;
        let next = LocationConfig {
            pending: Some(target),
            notice: None,
            ..config.clone()
        };
        write_config(&self.base, &next)?;
        *config = next;
        drop(config);
        self.info()
    }

    pub fn cancel(&self) -> Result<DataLocationInfo, String> {
        let mut config = self.config.lock().map_err(|_| "storage_io_failed")?;
        let next = LocationConfig {
            pending: None,
            ..config.clone()
        };
        write_config(&self.base, &next)?;
        *config = next;
        drop(config);
        self.info()
    }
}

struct CopiedFile {
    path: PathBuf,
    identity: files::FileIdentity,
    hash: String,
}

async fn relocate(
    base: &Path,
    source: &Path,
    logical_source: &Path,
    target: &Path,
    config: &mut LocationConfig,
) -> Result<(), String> {
    validate_destination(source, target)?;
    let source_owned = source.to_path_buf();
    let target_owned = target.to_path_buf();
    let (staging, copied, mut directories) = tokio::task::spawn_blocking(move || {
        let paths = source_files(&source_owned)?;
        check_space(&paths, &target_owned)?;
        if !source_owned.join("data/touchai.db").is_file() {
            return Err("storage_move_source_missing".into());
        }
        let staging = tempfile::Builder::new()
            .prefix(".touchai-move-")
            .tempdir_in(target_owned.parent().ok_or("storage_invalid_path")?)
            .map_err(|_| "storage_io_failed")?;
        let mut copied = Vec::new();
        let mut directories = Vec::new();
        let mut aliases = std::collections::HashMap::<files::FileIdentity, PathBuf>::new();
        for path in paths {
            let relative = path
                .strip_prefix(&source_owned)
                .map_err(|_| "storage_invalid_path")?;
            let destination = staging.path().join(relative);
            if fs::symlink_metadata(&path)
                .map_err(|_| "storage_io_failed")?
                .is_dir()
            {
                fs::create_dir_all(&destination).map_err(|_| "storage_io_failed")?;
                directories.push(path);
                continue;
            }
            fs::create_dir_all(destination.parent().ok_or("storage_invalid_path")?)
                .map_err(|_| "storage_io_failed")?;
            let identity = files::physical_file(&path)?
                .identity
                .ok_or("storage_invalid_path")?;
            if let Some(peer) = aliases.get(&identity) {
                if fs::hard_link(peer, &destination).is_ok() {
                    copied.push(CopiedFile {
                        path,
                        identity,
                        hash: files::sha256_file(peer)?,
                    });
                    continue;
                }
            }
            let mut input = files::open_owned(&source_owned, &path)?;
            let mut output = File::options()
                .create_new(true)
                .write(true)
                .open(&destination)
                .map_err(|_| "storage_io_failed")?;
            std::io::copy(&mut input, &mut output).map_err(|_| "storage_io_failed")?;
            output.flush().map_err(|_| "storage_io_failed")?;
            output.sync_all().map_err(|_| "storage_io_failed")?;
            let hash = files::sha256_file(&path)?;
            if files::sha256_file(&destination)? != hash
                || files::physical_file(&path)?.identity.as_ref() != Some(&identity)
            {
                return Err("storage_io_failed".into());
            }
            let metadata = fs::metadata(&path).map_err(|_| "storage_io_failed")?;
            output
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(metadata.modified().map_err(|_| "storage_io_failed")?),
                )
                .map_err(|_| "storage_io_failed")?;
            drop(output);
            fs::set_permissions(&destination, metadata.permissions())
                .map_err(|_| "storage_io_failed")?;
            aliases.insert(identity.clone(), destination);
            copied.push(CopiedFile {
                path,
                identity,
                hash,
            });
        }
        for copied in &copied {
            if files::physical_file(&copied.path)?.identity.as_ref() != Some(&copied.identity)
                || files::sha256_file(&copied.path)? != copied.hash
            {
                return Err("storage_busy".into());
            }
        }
        for directory in directories.iter().rev() {
            sync_directory(
                &staging.path().join(
                    directory
                        .strip_prefix(&source_owned)
                        .map_err(|_| "storage_invalid_path")?,
                ),
            )?;
        }
        sync_directory(staging.path())?;
        Ok::<_, String>((staging, copied, directories))
    })
    .await
    .map_err(|_| "storage_io_failed")??;

    crate::core::database::remap_storage_paths(
        &staging.path().join("data/touchai.db"),
        source,
        target,
    )
    .await?;
    if path_key(source) != path_key(logical_source) {
        crate::core::database::remap_storage_paths(
            &staging.path().join("data/touchai.db"),
            logical_source,
            target,
        )
        .await?;
    }
    let copied = tokio::task::spawn_blocking(move || {
        for file in &copied {
            if files::physical_file(&file.path)?.identity.as_ref() != Some(&file.identity)
                || files::sha256_file(&file.path)? != file.hash
            {
                return Err("storage_busy".into());
            }
        }
        Ok::<_, String>(copied)
    })
    .await
    .map_err(|_| "storage_io_failed")??;
    files::validate_path(target)?;
    if target.exists() {
        fs::remove_dir(target).map_err(|_| "storage_move_not_empty")?;
    }
    fs::rename(staging.path(), target).map_err(|_| "storage_io_failed")?;
    sync_directory(target.parent().ok_or("storage_invalid_path")?)?;
    let next = LocationConfig {
        active: Some(target.to_path_buf()),
        pending: None,
        notice: None,
        previous: Some(source.to_path_buf()),
    };
    if let Err(error) = write_config(base, &next) {
        let committed = read_config(base)?;
        if committed.active.as_deref() == Some(target) {
            *config = committed;
        }
        return Err(error);
    }
    *config = next;
    let source_owned = source.to_path_buf();
    let cleanup = tokio::task::spawn_blocking(move || {
        let mut failed = false;
        for copied in copied {
            let result = files::sha256_file(&copied.path).and_then(|hash| {
                if hash != copied.hash {
                    return Err("storage_io_failed".into());
                }
                files::remove_owned(&source_owned, &copied.path, &copied.identity)
            });
            if result.is_err() {
                failed = true;
            }
        }
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            if files::validate_path(&directory).is_err()
                || !directory.starts_with(&source_owned)
                || directory == source_owned
            {
                failed = true;
                continue;
            }
            if fs::remove_dir(&directory).is_err() {
                failed = true;
            }
        }
        failed
    })
    .await
    .map_err(|_| "storage_io_failed")?;
    if cleanup {
        config.notice = Some("storage_move_cleanup_pending".into());
    } else {
        config.previous = None;
    }
    write_config(base, config)?;
    Ok(())
}

#[cfg(test)]
mod tests;
