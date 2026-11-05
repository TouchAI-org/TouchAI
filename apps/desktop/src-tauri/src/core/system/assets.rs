// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用资源下载与管理。

use log::{error, info, warn};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::core::system::paths::{app_directory_path, AppDirectory};

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

/// 字体文件名
const FONT_FILENAME: &str = "SourceHanSerifSC-VF.ttf.woff2";
const FONT_EXPECTED_SIZE_BYTES: u64 = 21_600_852;
const FONT_EXPECTED_SHA256: &str =
    "95bee5840bd5bcc68ada7d9c32fbf40af38a7dadeb77bfae4dd26d85b131ce20";

/// CDN 地址列表（按优先级排序）
const FONT_CDN_URLS: &[&str] = &[
    "https://s4.zstatic.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2",
    "https://cdn.jsdelivr.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2",
    "https://jsd.onmicrosoft.cn/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2",
];

/// 下载超时要覆盖完整的 21.6 MB 响应体读取，而不只是建立连接。
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const DOWNLOAD_CONNECT_TIMEOUT_SECS: u64 = 15;

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
    is_valid_font_file_with(font_path, FONT_EXPECTED_SIZE_BYTES, FONT_EXPECTED_SHA256).await
}

/// 与 [`is_valid_font_file`] 相同，但期望值由调用方提供。
/// 这样校验分支可以用小体积数据覆盖，无需在仓库中存放真实字体。
async fn is_valid_font_file_with(
    font_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<bool, String> {
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

    if metadata.len() != expected_size {
        warn!(
            "Ignoring invalid cached font '{}': expected {} bytes, found {} bytes",
            font_path.display(),
            expected_size,
            metadata.len()
        );
        return Ok(false);
    }

    let data = fs::read(&font_path)
        .await
        .map_err(|e| format!("Failed to read cached font '{}': {e}", font_path.display()))?;
    match validate_font_data(&data, expected_size, expected_sha256) {
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

fn validate_font_data(
    data: &[u8],
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    if data.len() as u64 != expected_size {
        return Err(format!(
            "expected {} bytes, found {} bytes",
            expected_size,
            data.len()
        ));
    }

    let actual_hash = sha256_hex(data);
    if actual_hash != expected_sha256 {
        return Err(format!(
            "expected sha256 {}, found {}",
            expected_sha256, actual_hash
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
        .connect_timeout(std::time::Duration::from_secs(
            DOWNLOAD_CONNECT_TIMEOUT_SECS,
        ))
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
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
    try_download_from_cdns_with(
        FONT_CDN_URLS,
        FONT_EXPECTED_SIZE_BYTES,
        FONT_EXPECTED_SHA256,
        |url| async move { download_from_url(&url).await },
    )
    .await
}

async fn try_download_from_cdns_with<F, Fut>(
    urls: &[&str],
    expected_size: u64,
    expected_sha256: &str,
    mut download: F,
) -> Result<Vec<u8>, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    for url in urls {
        match download((*url).to_string()).await {
            Ok(data) => match validate_font_data(&data, expected_size, expected_sha256) {
                Ok(()) => return Ok(data),
                Err(error) => warn!("Invalid font from {}: {}", url, error),
            },
            Err(e) => {
                warn!("Failed to download from {}: {}", url, e);
            }
        }
    }

    Err("No CDN supplied a valid font in this round".to_string())
}

/// 保存字体文件到本地
async fn save_font(data: &[u8]) -> Result<(), String> {
    validate_font_data(data, FONT_EXPECTED_SIZE_BYTES, FONT_EXPECTED_SHA256)?;
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
    use super::sha256_hex;
    use super::{
        is_valid_font_file, is_valid_font_file_with, replace_font_file,
        try_download_from_cdns_with, validate_font_data, DOWNLOAD_CONNECT_TIMEOUT_SECS,
        DOWNLOAD_TIMEOUT_SECS, FONT_CDN_URLS, FONT_FILENAME, MAX_RETRY_ROUNDS,
    };
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
    async fn valid_font_cache_is_accepted() {
        let root = tempdir().expect("tempdir");
        let font_dir = root.path().join("assets").join("font");
        fs::create_dir_all(&font_dir)
            .await
            .expect("create font dir");
        let font_path = font_dir.join(FONT_FILENAME);
        let data = b"synthetic font bytes";
        fs::write(&font_path, data).await.expect("write font");
        let expected_sha256 = sha256_hex(data);

        assert!(
            is_valid_font_file_with(&font_path, data.len() as u64, &expected_sha256)
                .await
                .expect("valid font cache check")
        );
    }

    #[test]
    fn same_size_font_with_wrong_hash_is_rejected() {
        let original = vec![7_u8; 64];
        let mutated = vec![8_u8; 64];
        let expected_sha256 = sha256_hex(&original);

        let error = validate_font_data(&mutated, mutated.len() as u64, &expected_sha256)
            .expect_err("mutated font should fail hash check");

        assert!(error.contains("expected sha256"));
    }

    #[test]
    fn wrong_size_font_data_is_rejected() {
        let data = vec![7_u8; 63];
        let expected_sha256 = sha256_hex(&data);

        let error = validate_font_data(&data, 64, &expected_sha256)
            .expect_err("short font should fail size check");

        assert!(error.contains("expected 64 bytes"));
    }

    /// 常量与上游产物的比对需要真实 21 MB 字体，不适合放进仓库或 CI。
    /// 升级 `FONT_CDN_URLS` 的字体版本时请手动核对：
    ///
    /// ```text
    /// curl -fsSL -o /tmp/font.tgz \
    ///   "https://registry.npmjs.org/@fontpkg/source-han-serif-sc-vf/-/source-han-serif-sc-vf-<version>.tgz"
    /// tar -xzf /tmp/font.tgz -C /tmp
    /// sha256sum /tmp/package/SourceHanSerifSC-VF.ttf.woff2
    /// stat -c%s /tmp/package/SourceHanSerifSC-VF.ttf.woff2
    /// ```
    #[test]
    fn user_gets_a_download_window_long_enough_for_the_full_font_body() {
        assert!(
            DOWNLOAD_TIMEOUT_SECS >= 90,
            "the 21.6 MB font can take over a minute on a slow CDN"
        );
        assert!(
            DOWNLOAD_CONNECT_TIMEOUT_SECS < DOWNLOAD_TIMEOUT_SECS,
            "connection setup must fail before the whole-body deadline"
        );
    }

    #[test]
    fn user_does_not_wait_through_unbounded_retry_rounds() {
        assert!(
            (2..=3).contains(&MAX_RETRY_ROUNDS),
            "retries should survive a transient failure without blocking startup for many minutes"
        );
        assert!(
            MAX_RETRY_ROUNDS * FONT_CDN_URLS.len() >= 6,
            "the app should still try every CDN fallback in each round"
        );
    }

    #[test]
    fn user_gets_a_reachable_cdn_after_the_expired_certificate_mirror() {
        assert!(
            FONT_CDN_URLS
                .iter()
                .any(|url| url.starts_with("https://s4.zstatic.net/")),
            "the directly reachable Chinese mirror must stay in the fallback list"
        );
        assert!(
            FONT_CDN_URLS
                .iter()
                .any(|url| url.starts_with("https://cdn.jsdelivr.net/")),
            "jsDelivr is the secondary fallback when the Chinese mirrors fail"
        );
        assert!(
            FONT_CDN_URLS.iter().all(|url| url.starts_with("https://")),
            "font downloads must use TLS"
        );
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

    #[tokio::test]
    async fn user_gets_valid_font_from_second_cdn_when_first_returns_wrong_hash() {
        let valid = b"expected font";
        let expected_hash = sha256_hex(valid);

        let downloaded = try_download_from_cdns_with(
            &["first", "second"],
            valid.len() as u64,
            &expected_hash,
            |url| async move {
                match url.as_str() {
                    "first" => Ok(b"incorrectfont".to_vec()),
                    "second" => Ok(b"expected font".to_vec()),
                    _ => unreachable!("unexpected CDN"),
                }
            },
        )
        .await
        .expect("second CDN supplies the valid font");

        assert_eq!(downloaded, valid);
    }

    #[tokio::test]
    async fn user_gets_an_error_when_every_cdn_returns_invalid_font_bytes() {
        let valid = b"expected font";
        let expected_hash = sha256_hex(valid);

        let result = try_download_from_cdns_with(
            &["first", "second"],
            valid.len() as u64,
            &expected_hash,
            |_url| async { Ok(b"invalid".to_vec()) },
        )
        .await;

        assert!(result.is_err());
    }
}
