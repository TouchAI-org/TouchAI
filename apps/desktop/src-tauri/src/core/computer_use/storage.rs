use std::path::{Component, Path, PathBuf};

use tokio::sync::{RwLock, RwLockMappedWriteGuard, RwLockReadGuard, RwLockWriteGuard};

use crate::core::database::{typed::repositories::computer_use, DatabaseRuntime};

use super::{agent_desktop, cua_driver, provision::sha256_file};

const DIRECTORY_KEY: &str = "computer_use.driver_directory";
const CLEANUP_KEY: &str = "computer_use.retired_driver_directories";
const DIRECTORY_NAME: &str = "computer-use-drivers";
const DRIVERS: [&str; 2] = ["cua-driver", "agent-desktop"];

pub struct DriverStorage {
    database: DatabaseRuntime,
    legacy: PathBuf,
    default_base: PathBuf,
    directory: RwLock<Option<PathBuf>>,
}

impl DriverStorage {
    pub fn new(database: DatabaseRuntime, legacy: PathBuf, default_base: PathBuf) -> Self {
        Self {
            database,
            legacy,
            default_base,
            directory: RwLock::new(None),
        }
    }

    pub async fn read(&self) -> Result<RwLockReadGuard<'_, PathBuf>, String> {
        let lease = self.directory.read().await;
        if lease.is_some() {
            return Ok(RwLockReadGuard::map(lease, |value| {
                value.as_ref().expect("initialized")
            }));
        }
        drop(lease);
        let mut directory = self.directory.write().await;
        if directory.is_none() {
            let stored = self.setting(DIRECTORY_KEY).await?;
            let default = self.default_base.join(DIRECTORY_NAME);
            let migrate = stored
                .as_ref()
                .is_none_or(|value| value.is_empty() || Path::new(value) == default);
            let clear_default = migrate && stored.is_some();
            let root = stored
                .filter(|_| !migrate)
                .map(PathBuf::from)
                .unwrap_or(default);
            let legacy = self.legacy.clone();
            let previous = legacy.with_file_name(DIRECTORY_NAME);
            let target = root.clone();
            let mut pending = self.cleanup_roots().await?;
            pending.extend(DRIVERS.iter().map(|name| target.join(name)));
            pending.extend(DRIVERS.iter().map(|name| previous.join(name)));
            pending.push(legacy.clone());
            tauri::async_runtime::spawn_blocking(move || {
                validate_path(&target)?;
                for root in &pending {
                    if let Err(error) = cleanup_removed_installations(root) {
                        log::warn!("Deferred driver cleanup failed: {error}");
                    }
                }
                if migrate {
                    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
                    for name in DRIVERS {
                        migrate_installation(&previous.join(name), &target.join(name))?;
                    }
                    migrate_installation(&legacy, &target.join("cua-driver"))?;
                }
                Ok::<_, String>(())
            })
            .await
            .map_err(|error| error.to_string())??;
            if clear_default {
                computer_use::delete_setting(self.database.pool(), DIRECTORY_KEY)
                    .await
                    .map_err(|error| error.message)?;
            }
            *directory = Some(root);
        }
        drop(directory);
        Ok(RwLockReadGuard::map(self.directory.read().await, |value| {
            value.as_ref().expect("initialized")
        }))
    }

    pub async fn location(&self) -> Result<PathBuf, String> {
        let directory = self.read().await?;
        Ok(self.custom_location(&directory))
    }

    pub async fn relocate(&self, destination: PathBuf) -> Result<PathBuf, String> {
        let destination = if destination.as_os_str().is_empty() {
            self.default_base.clone()
        } else {
            destination
        };
        validate_path(&destination)?;
        let base = parent_directory(&destination);
        let destination = base.join(DIRECTORY_NAME);
        let location = self.custom_location(&destination);
        drop(self.read().await?);
        let mut directory = self.directory.write().await;
        let source = directory
            .as_ref()
            .ok_or("driver storage is unavailable")?
            .clone();
        let target = destination.clone();
        let origin = source.clone();
        let same =
            tauri::async_runtime::spawn_blocking(move || validate_destination(&origin, &target))
                .await
                .map_err(|error| error.to_string())??;
        if same {
            self.persist(&destination, &self.cleanup_roots().await?)
                .await?;
            *directory = Some(destination.clone());
            return Ok(location);
        }
        cua_driver::cancel_all();
        agent_desktop::cancel_all();
        cua_driver::shutdown();
        agent_desktop::shutdown().await?;

        let origin = source.clone();
        let target = destination.clone();
        let mut cleanup = self.cleanup_roots().await?;
        cleanup.extend(DRIVERS.map(|name| source.join(name)));
        cleanup.sort();
        cleanup.dedup();
        let moved = tauri::async_runtime::spawn_blocking(move || stage_drivers(&origin, &target))
            .await
            .map_err(|error| error.to_string())??;
        let saved = self.persist(&destination, &cleanup).await;
        if let Err(error) = saved {
            tauri::async_runtime::spawn_blocking(move || rollback(&moved))
                .await
                .map_err(|task| task.to_string())?;
            return Err(error);
        }
        *directory = Some(destination.clone());
        for name in DRIVERS {
            let retired = source.join(name);
            if let Err(error) =
                tauri::async_runtime::spawn_blocking(move || retire_installation(&retired))
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result)
            {
                log::warn!(
                    "Driver storage moved; old files remain at {}: {error}",
                    source.join(name).display()
                );
            }
        }
        Ok(location)
    }

    fn custom_location(&self, directory: &Path) -> PathBuf {
        if directory == self.default_base.join(DIRECTORY_NAME) {
            PathBuf::new()
        } else {
            parent_directory(directory)
        }
    }

    pub async fn exclusive(&self) -> Result<RwLockMappedWriteGuard<'_, PathBuf>, String> {
        drop(self.read().await?);
        Ok(RwLockWriteGuard::map(
            self.directory.write().await,
            |value| value.as_mut().expect("initialized"),
        ))
    }

    async fn setting(&self, key: &str) -> Result<Option<String>, String> {
        computer_use::get_setting(self.database.pool(), key)
            .await
            .map_err(|error| error.message)
    }

    async fn cleanup_roots(&self) -> Result<Vec<PathBuf>, String> {
        self.setting(CLEANUP_KEY)
            .await?
            .map(|raw| {
                serde_json::from_str(&raw)
                    .map_err(|error| format!("invalid driver cleanup record: {error}"))
            })
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    async fn persist(&self, destination: &Path, cleanup: &[PathBuf]) -> Result<(), String> {
        let cleanup = serde_json::to_string(cleanup).map_err(|error| error.to_string())?;
        let directory = (destination != self.default_base.join(DIRECTORY_NAME))
            .then(|| destination.to_string_lossy().into_owned());
        computer_use::persist_driver_storage(
            self.database.pool(),
            directory.as_deref(),
            &cleanup,
            DIRECTORY_KEY,
            CLEANUP_KEY,
        )
        .await
        .map_err(|error| error.message)
    }
}

fn parent_directory(directory: &Path) -> PathBuf {
    if directory
        .file_name()
        .is_some_and(|name| name == DIRECTORY_NAME)
    {
        if let Some(parent) = directory.parent() {
            return parent.to_path_buf();
        }
    }
    directory.to_path_buf()
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("computer_use_storage_invalid".into());
    }
    for ancestor in path.ancestors() {
        if let Ok(metadata) = std::fs::symlink_metadata(ancestor) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("computer_use_storage_invalid".into());
            }
        }
    }
    Ok(())
}

fn validate_destination(source: &Path, target: &Path) -> Result<bool, String> {
    validate_path(source)?;
    validate_path(target)?;
    let mut created = Vec::new();
    let mut ancestor = Some(target);
    while let Some(path) = ancestor {
        if path.exists() {
            break;
        }
        created.push(path.to_path_buf());
        ancestor = path.parent();
    }
    let outcome = std::fs::create_dir_all(target)
        .map_err(|error| error.to_string())
        .and_then(|()| inspect_destination(source, target));
    if outcome.is_err() {
        for path in created {
            if let Err(error) = std::fs::remove_dir(&path) {
                log::warn!(
                    "Failed to remove unused driver location {}: {error}",
                    path.display()
                );
            }
        }
    }
    outcome
}

fn inspect_destination(source: &Path, target: &Path) -> Result<bool, String> {
    let source = canonical_location(source)?;
    let destination = target.canonicalize().map_err(|error| error.to_string())?;
    if source == destination {
        return Ok(true);
    }
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err("computer_use_storage_invalid".into());
    }
    for name in DRIVERS {
        if target
            .join(name)
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            return Err("computer_use_storage_conflict".into());
        }
    }
    Ok(false)
}

fn canonical_location(path: &Path) -> Result<PathBuf, String> {
    for ancestor in path.ancestors() {
        if ancestor.exists() {
            return Ok(ancestor
                .canonicalize()
                .map_err(|error| error.to_string())?
                .join(
                    path.strip_prefix(ancestor)
                        .map_err(|error| error.to_string())?,
                ));
        }
    }
    Ok(path.to_path_buf())
}

fn stage_drivers(source: &Path, target: &Path) -> Result<Vec<PathBuf>, String> {
    let staging = tempfile::Builder::new()
        .prefix(".touchai-drivers-")
        .tempdir_in(target)
        .map_err(|error| error.to_string())?;
    let mut moved = Vec::new();
    let result = (|| {
        for name in DRIVERS {
            let origin = source.join(name);
            if origin.exists() {
                copy_verified(&origin, &staging.path().join(name))?;
            }
        }
        for name in DRIVERS {
            let staged = staging.path().join(name);
            if !staged.exists() {
                continue;
            }
            let destination = target.join(name);
            if destination.exists() {
                return Err("computer_use_storage_conflict".into());
            }
            std::fs::rename(staged, &destination).map_err(|error| error.to_string())?;
            moved.push(destination);
        }
        Ok(())
    })();
    if let Err(error) = result {
        rollback(&moved);
        return Err(error);
    }
    Ok(moved)
}

fn rollback(paths: &[PathBuf]) {
    for path in paths {
        if let Err(error) = std::fs::remove_dir_all(path) {
            log::warn!("Driver copy rollback failed at {}: {error}", path.display());
        }
    }
}

fn copy_verified(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("computer_use_storage_invalid".into());
    }
    if metadata.is_dir() {
        std::fs::create_dir(destination).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_verified(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        std::fs::copy(source, destination).map_err(|error| error.to_string())?;
        if sha256_file(source).map_err(|error| error.to_string())?
            != sha256_file(destination).map_err(|error| error.to_string())?
        {
            return Err("driver copy verification failed".into());
        }
    } else {
        return Err("computer_use_storage_invalid".into());
    }
    Ok(())
}

fn migrate_installation(legacy: &Path, destination: &Path) -> Result<(), String> {
    if !legacy.exists()
        || std::fs::read_dir(legacy)
            .map_err(|error| error.to_string())?
            .next()
            .is_none()
    {
        return Ok(());
    }
    validate_path(legacy)?;
    validate_path(destination)?;
    if destination.exists() {
        let metadata = std::fs::symlink_metadata(destination).map_err(|error| error.to_string())?;
        let empty = metadata.is_dir()
            && std::fs::read_dir(destination)
                .map_err(|error| error.to_string())?
                .next()
                .is_none();
        if !empty {
            log::info!(
                "Legacy driver at {} left in place: {} already has an installation",
                legacy.display(),
                destination.display()
            );
            return Ok(());
        }
        std::fs::remove_dir(destination).map_err(|error| error.to_string())?;
    }
    let staging = tempfile::Builder::new()
        .prefix(".touchai-legacy-")
        .tempdir_in(destination.parent().ok_or("computer_use_storage_invalid")?)
        .map_err(|error| error.to_string())?;
    let staged = staging.path().join("driver");
    copy_verified(legacy, &staged)?;
    std::fs::rename(staged, destination).map_err(|error| error.to_string())?;
    let retired = legacy.with_extension("removed");
    validate_path(&retired)?;
    std::fs::create_dir_all(&retired).map_err(|error| error.to_string())?;
    let path = retired.join(uuid::Uuid::new_v4().to_string());
    std::fs::rename(legacy, &path).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::remove_dir_all(&path) {
        log::warn!("Legacy driver cleanup deferred: {error}");
    }
    Ok(())
}

pub(super) fn retire_installation(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let removed = root.with_extension("removed");
    std::fs::create_dir_all(&removed)
        .map_err(|error| format!("failed to create driver retirement directory: {error}"))?;
    if std::fs::symlink_metadata(&removed)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("driver retirement directory must not be a symbolic link".into());
    }
    let retired = removed.join(uuid::Uuid::new_v4().to_string());
    std::fs::rename(root, &retired)
        .map_err(|error| format!("failed to retire {}: {error}", root.display()))?;
    if let Err(error) = std::fs::remove_dir_all(&retired) {
        log::info!(
            "Driver files retired at {}; cleanup deferred until next launch: {error}",
            retired.display()
        );
    }
    Ok(())
}

pub(super) fn cleanup_removed_installations(root: &Path) -> Result<(), String> {
    let removed = root.with_extension("removed");
    if !removed.exists() {
        return Ok(());
    }
    if std::fs::symlink_metadata(&removed)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("driver retirement directory must not be a symbolic link".into());
    }
    for entry in std::fs::read_dir(&removed).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
            && uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
        {
            std::fs::remove_dir_all(entry.path()).map_err(|error| {
                format!("failed to clean up {}: {error}", entry.path().display())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
