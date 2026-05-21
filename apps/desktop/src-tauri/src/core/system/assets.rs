// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用资源下载与管理。

use log::{error, info, warn};
use std::path::PathBuf;
use tauri::Emitter;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::core::system::paths::{app_directory_path, AppDirectory};

/// 字体文件名
const FONT_FILENAME: &str = "SourceHanSerifSC-VF.ttf.woff2";

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
    Ok(font_path.exists())
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
    let font_path = get_font_path()?;

    let mut file = fs::File::create(&font_path)
        .await
        .map_err(|e| format!("Failed to create font file: {}", e))?;

    file.write_all(data)
        .await
        .map_err(|e| format!("Failed to write font file: {}", e))?;

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush font file: {}", e))?;

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
