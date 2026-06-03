// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用资源下载与管理。

use log::{error, info, warn};
use sha2::{Digest, Sha256};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::core::system::paths::{app_directory_path, AppDirectory};

/// 字体文件名
const FONT_FILENAME: &str = "SourceHanSerifSC-VF.ttf.woff2";
const FONT_EXPECTED_SIZE_BYTES: u64 = 21_600_852;
const FONT_EXPECTED_SHA256: &str =
    "95bee5840bd5bcc68ada7d9c32fbf40af38a7dadeb77bfae4dd26d85b131ce20";

/// CDN 地址列表（按优先级排序）
const FONT_CDN_URLS: &[&str] = &[
    "https://jsd.onmicrosoft.cn/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2",
    "https://s4.zstatic.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2",
];

/// 下载超时时间（秒）
const DOWNLOAD_TIMEOUT_SECS: u64 = 30;

/// 最大重试轮次（每轮会尝试所有 CDN）
const MAX_RETRY_ROUNDS: usize = 2;

/// 获取字体文件路径
fn get_font_path() -> Result<PathBuf, String> {
    let font_dir = app_directory_path(AppDirectory::AssetsFont)?;
    Ok(font_dir.join(FONT_FILENAME))
}

/// 检查字体文件是否已存在
async fn font_exists() -> Result<bool, String> {
    let font_path = get_font_path()?;
    is_valid_font_file(&font_path).await
}

async fn is_valid_font_file(font_path: &Path) -> Result<bool, String> {
    let metadata = match fs::metadata(&font_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to read font metadata '{}': {error}",
                font_path.display()
            ));
        }
    };

    if metadata.len() != FONT_EXPECTED_SIZE_BYTES {
        warn!(
            "Ignoring invalid cached font '{}': expected {} bytes, found {} bytes",
            font_path.display(),
            FONT_EXPECTED_SIZE_BYTES,
            metadata.len()
        );
        return Ok(false);
    }

    let data = fs::read(&font_path)
        .await
        .map_err(|e| format!("Failed to read cached font '{}': {e}", font_path.display()))?;
    match validate_font_data(&data) {
        Ok(()) => Ok(true),
        Err(error) => {
            warn!(
                "Ignoring invalid cached font '{}': {}",
                font_path.display(),
                error
            );
            Ok(false)
        }
    }
}

fn validate_font_data(data: &[u8]) -> Result<(), String> {
    if data.len() as u64 != FONT_EXPECTED_SIZE_BYTES {
        return Err(format!(
            "expected {} bytes, found {} bytes",
            FONT_EXPECTED_SIZE_BYTES,
            data.len()
        ));
    }

    let actual_hash = format!("{:x}", Sha256::digest(data));
    if actual_hash != FONT_EXPECTED_SHA256 {
        return Err(format!(
            "expected sha256 {}, found {}",
            FONT_EXPECTED_SHA256, actual_hash
        ));
    }

    Ok(())
}

#[cfg(windows)]
async fn replace_font_file(source_path: &Path, font_path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let source_wide = wide_path(source_path);
    let font_wide = wide_path(font_path);

    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(font_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| format!("Failed to replace font file: {e}"))
}

#[cfg(not(windows))]
async fn replace_font_file(source_path: &Path, font_path: &Path) -> Result<(), String> {
    fs::rename(source_path, font_path)
        .await
        .map_err(|e| format!("Failed to replace font file: {}", e))
}

/// 从指定 URL 下载文件
async fn download_from_url(url: &str) -> Result<Vec<u8>, String> {
    info!("Attempting to download font from: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    info!("Successfully downloaded {} bytes from {}", bytes.len(), url);
    Ok(bytes.to_vec())
}

/// 尝试从所有 CDN 下载字体（单轮）
async fn try_download_from_cdns() -> Result<Vec<u8>, String> {
    for url in FONT_CDN_URLS {
        match download_from_url(url).await {
            Ok(data) => return Ok(data),
            Err(e) => {
                warn!("Failed to download from {}: {}", url, e);
            }
        }
    }

    Err("All CDN sources failed in this round".to_string())
}

/// 保存字体文件到本地
async fn save_font(data: &[u8]) -> Result<(), String> {
    validate_font_data(data)?;
    let font_path = get_font_path()?;
    let temp_font_path = font_path.with_file_name(format!("{FONT_FILENAME}.tmp"));

    if let Some(parent) = font_path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| {
            format!(
                "Failed to create font directory '{}': {e}",
                parent.display()
            )
        })?;
    }

    {
        let mut file = fs::File::create(&temp_font_path)
            .await
            .map_err(|e| format!("Failed to create temporary font file: {}", e))?;

        file.write_all(data)
            .await
            .map_err(|e| format!("Failed to write temporary font file: {}", e))?;

        file.flush()
            .await
            .map_err(|e| format!("Failed to flush temporary font file: {}", e))?;
    }

    replace_font_file(&temp_font_path, &font_path).await?;

    info!("Font saved to: {}", font_path.display());
    Ok(())
}

/// 下载字体文件（带重试机制）
///
/// 下载逻辑：
/// 1. 每轮尝试所有 CDN（按优先级）
/// 2. 如果所有 CDN 都失败，进入下一轮重试
/// 3. 最多重试 MAX_RETRY_ROUNDS 轮
async fn download_font_with_retry() -> Result<(), String> {
    for round in 1..=MAX_RETRY_ROUNDS {
        info!("Download attempt round {}/{}", round, MAX_RETRY_ROUNDS);

        match try_download_from_cdns().await {
            Ok(data) => {
                save_font(&data).await?;
                return Ok(());
            }
            Err(e) => {
                if round < MAX_RETRY_ROUNDS {
                    warn!("Round {} failed: {}, retrying...", round, e);
                } else {
                    error!("All {} rounds failed: {}", MAX_RETRY_ROUNDS, e);
                }
            }
        }
    }

    Err(format!(
        "Font download failed after {} retry rounds",
        MAX_RETRY_ROUNDS
    ))
}

/// 初始化字体资源
///
/// 如果字体文件不存在，则自动下载。
/// 下载成功后会发送 `font:ready` 事件通知前端。
/// 下载失败会返回错误，但不会阻止应用启动。
pub async fn initialize_font(app_handle: tauri::AppHandle) -> Result<(), String> {
    // 检查字体是否已存在
    if font_exists().await? {
        info!("Font already exists, notifying frontend");
        // 字体已存在，立即通知前端
        let _ = app_handle.emit("font:ready", ());
        return Ok(());
    }

    info!("Font not found, starting download...");
    match download_font_with_retry().await {
        Ok(_) => {
            info!("Font download completed, notifying frontend");
            // 下载成功，通知前端
            let _ = app_handle.emit("font:ready", ());
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_valid_font_file, replace_font_file, validate_font_data, FONT_EXPECTED_SHA256,
        FONT_FILENAME,
    };
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;
    use tokio::fs;

    #[tokio::test]
    async fn missing_font_cache_is_not_valid() {
        let root = tempdir().expect("tempdir");
        let font_path = root.path().join(FONT_FILENAME);

        assert!(!is_valid_font_file(&font_path)
            .await
            .expect("missing font cache check"));
    }

    #[tokio::test]
    async fn existing_short_font_cache_is_not_valid() {
        let root = tempdir().expect("tempdir");
        let font_dir = root.path().join("assets").join("font");
        fs::create_dir_all(&font_dir)
            .await
            .expect("create font dir");
        let font_path = font_dir.join(FONT_FILENAME);
        fs::write(&font_path, b"not a font")
            .await
            .expect("write invalid font");

        assert!(!is_valid_font_file(&font_path)
            .await
            .expect("font cache check"));
    }

    #[tokio::test]
    async fn bundled_font_cache_is_valid() {
        let font_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../assets/font")
            .join(FONT_FILENAME);

        assert!(is_valid_font_file(&font_path)
            .await
            .expect("bundled font cache check"));
    }

    #[test]
    fn valid_font_hash_matches_expected_constant() {
        let font_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../assets/font")
            .join(FONT_FILENAME);
        let data = std::fs::read(font_path).expect("read bundled font");
        let actual_hash = format!("{:x}", Sha256::digest(&data));

        assert_eq!(actual_hash, FONT_EXPECTED_SHA256);
        validate_font_data(&data).expect("validate bundled font data");
    }

    #[test]
    fn same_size_font_with_wrong_hash_is_rejected() {
        let font_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../assets/font")
            .join(FONT_FILENAME);
        let mut data = std::fs::read(font_path).expect("read bundled font");
        let last_byte = data.last_mut().expect("font has data");
        *last_byte = last_byte.wrapping_add(1);

        let error = validate_font_data(&data).expect_err("mutated font should fail hash check");

        assert!(error.contains("expected sha256"));
    }

    #[tokio::test]
    async fn replace_font_file_keeps_existing_font_when_source_is_missing() {
        let root = tempdir().expect("tempdir");
        let source_path = root.path().join("missing-font.tmp");
        let font_path = root.path().join(FONT_FILENAME);
        fs::write(&font_path, b"existing font")
            .await
            .expect("write existing font");

        let error = replace_font_file(&source_path, &font_path)
            .await
            .expect_err("missing source should fail");

        assert!(error.contains("Failed to replace font file"));
        assert_eq!(
            fs::read(&font_path).await.expect("read existing font"),
            b"existing font"
        );
    }

    #[tokio::test]
    async fn replace_font_file_commits_new_font_over_existing_font() {
        let root = tempdir().expect("tempdir");
        let source_path = root.path().join("font.tmp");
        let font_path = root.path().join(FONT_FILENAME);
        fs::write(&source_path, b"new font")
            .await
            .expect("write replacement font");
        fs::write(&font_path, b"existing font")
            .await
            .expect("write existing font");

        replace_font_file(&source_path, &font_path)
            .await
            .expect("replace font");

        assert_eq!(
            fs::read(&font_path).await.expect("read replaced font"),
            b"new font"
        );
        assert!(!fs::try_exists(&source_path)
            .await
            .expect("check source path"));
    }
}
