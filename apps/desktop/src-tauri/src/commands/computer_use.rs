// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 电脑操作原生命令。
//!
//! 命令层只做参数透传与执行 id 绑定；下载、加载、调用与取消都在
//! `core::computer_use` 里完成，避免生命周期管理散落到 Tauri 入口。

use serde_json::Value;

use crate::core::computer_use::{driver, http::HttpWheelFetcher, manifest};
use crate::core::system::paths::{app_directory_path, AppDirectory};

const USER_AGENT: &str = concat!("TouchAI/", env!("CARGO_PKG_VERSION"));

/// 当前驱动状态：是否已安装、版本、ABI、运行时元数据。
#[tauri::command]
pub fn computer_use_status() -> driver::DriverStatus {
    driver::status()
}

/// 下载（如需要）并加载驱动运行时。重复调用是幂等的。
#[tauri::command]
pub async fn computer_use_prepare() -> Result<driver::DriverStatus, String> {
    let root = app_directory_path(AppDirectory::ComputerUse)?;
    let fetcher = HttpWheelFetcher::new(USER_AGENT)?;
    driver::ensure_ready(root, &fetcher, manifest::current_target()).await
}

/// 调用一个驱动工具。`execution_id` 由调用方生成，用于取消。
#[tauri::command]
pub async fn computer_use_invoke(
    execution_id: String,
    tool: String,
    arguments: Value,
) -> Result<Value, String> {
    let pending = driver::invoke(&tool, &arguments)?;
    driver::bind_execution(&execution_id, pending.id)?;
    let outcome = pending.receiver.await;
    driver::release_execution(&execution_id);

    let envelope = outcome.map_err(|_| "computer use call was cancelled".to_string())?;
    envelope.map_err(|error| error.to_string())
}

/// 取消一次在途调用；返回是否找到并发出取消信号。
#[tauri::command]
pub fn computer_use_cancel(execution_id: String) -> bool {
    driver::cancel_execution(&execution_id)
}

/// 把设置页的选项下发给驱动（截图边长、操作光标）。
#[tauri::command]
pub async fn computer_use_apply_settings(
    max_image_dimension: Option<u32>,
    cursor_visible: Option<bool>,
) -> Result<Vec<String>, String> {
    Ok(driver::apply_settings(max_image_dimension, cursor_visible).await)
}

/// 开启或关闭轨迹录制；轨迹写到应用缓存目录。
#[tauri::command]
pub async fn computer_use_set_recording(enabled: bool) -> Result<bool, String> {
    let dir = crate::core::system::paths::app_directory_path(AppDirectory::Cache)?
        .join("computer-use-trajectories");
    driver::set_recording(enabled, &dir).await?;
    Ok(true)
}

/// 检查镜像上是否有更新的驱动版本。
#[tauri::command]
pub async fn computer_use_check_update() -> driver::UpdateInfo {
    match HttpWheelFetcher::new(USER_AGENT) {
        Ok(fetcher) => driver::check_update(&fetcher).await,
        Err(error) => driver::UpdateInfo {
            current: manifest::MANIFEST.version.to_string(),
            latest: None,
            update_available: false,
            error: Some(error),
        },
    }
}

/// 卸载驱动：释放运行时并删除已安装的全部版本。
#[tauri::command]
pub fn computer_use_remove() -> Result<bool, String> {
    let root = app_directory_path(AppDirectory::ComputerUse)?;
    driver::remove_installed(&root)?;
    Ok(true)
}

/// 释放运行时。会话结束或用户关闭电脑操作时调用。
#[tauri::command]
pub fn computer_use_shutdown() {
    driver::shutdown();
}
