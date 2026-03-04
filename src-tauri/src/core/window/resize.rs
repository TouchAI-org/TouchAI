// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 窗口尺寸调整逻辑。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Monitor};

const DEFAULT_ANIMATION_DURATION_MS: u64 = 120;
const ANIMATION_FRAME_INTERVAL_MS: u64 = 16;
const HEIGHT_TOLERANCE: f64 = 1.0;

/// 窗口高度动画状态（按窗口 label 维护递增令牌）。
#[derive(Default)]
struct WindowAnimationState {
    tokens: Mutex<HashMap<String, u64>>,
}

impl WindowAnimationState {
    /// 生成窗口下一次动画令牌。
    fn next_token(&self, window_label: &str) -> u64 {
        let mut tokens = self.tokens.lock().expect("window animation state poisoned");
        let next = tokens
            .get(window_label)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        tokens.insert(window_label.to_string(), next);
        next
    }

    /// 判断令牌是否仍为当前窗口的最新令牌。
    fn is_token_current(&self, window_label: &str, token: u64) -> bool {
        let tokens = self.tokens.lock().expect("window animation state poisoned");
        tokens
            .get(window_label)
            .is_some_and(|current| *current == token)
    }
}

/// 获取全局动画状态单例。
fn window_animation_state() -> &'static WindowAnimationState {
    static STATE: OnceLock<WindowAnimationState> = OnceLock::new();
    STATE.get_or_init(WindowAnimationState::default)
}

/// 按给定上下限裁剪目标高度。
fn clamp_height(target_height: f64, min_height: Option<f64>, max_height: Option<f64>) -> f64 {
    let mut value = target_height;
    if let Some(min) = min_height {
        value = value.max(min);
    }
    if let Some(max) = max_height {
        value = value.min(max);
    }
    value.round()
}

/// 将窗口 y 坐标约束到当前显示器可视范围内。
fn clamp_window_y(y: f64, height: f64, monitor: &Option<Monitor>, scale_factor: f64) -> f64 {
    let Some(monitor) = monitor else {
        return y;
    };

    let monitor_y = f64::from(monitor.position().y) / scale_factor;
    let monitor_height = f64::from(monitor.size().height) / scale_factor;
    let min_y = monitor_y;
    let max_y = monitor_y + monitor_height - height;
    y.max(min_y).min(max_y)
}

/// 应用窗口尺寸，并在需要时同步调整中心位置。
fn apply_window_size(
    window: &tauri::WebviewWindow,
    logical_width: f64,
    logical_height: f64,
    center: bool,
    logical_x: Option<f64>,
    base_logical_y: Option<f64>,
    base_logical_height: f64,
    monitor: &Option<Monitor>,
    scale_factor: f64,
) -> Result<(), String> {
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: logical_width,
            height: logical_height,
        }))
        .map_err(|e| e.to_string())?;

    if center {
        if let (Some(logical_x), Some(base_logical_y)) = (logical_x, base_logical_y) {
            let adjusted_y = clamp_window_y(
                base_logical_y - (logical_height - base_logical_height) / 2.0,
                logical_height,
                monitor,
                scale_factor,
            );
            window
                .set_position(tauri::Position::Logical(tauri::LogicalPosition {
                    x: logical_x,
                    y: adjusted_y,
                }))
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// 调整指定窗口高度，可选居中与动画过渡。
pub async fn resize_window_height(
    app: AppHandle,
    target_height: f64,
    min_height: Option<f64>,
    max_height: Option<f64>,
    center: Option<bool>,
    animate: Option<bool>,
    duration_ms: Option<u64>,
    window_label: Option<String>,
) -> Result<(), String> {
    let label = window_label.unwrap_or_else(|| "main".to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Failed to get window: {}", label))?;

    let clamped_height = clamp_height(target_height, min_height, max_height);
    if clamped_height <= 0.0 {
        return Ok(());
    }

    // 主窗口默认启用“居中 + 动画”，其他窗口默认直接生效。
    let center_window = center.unwrap_or(label == "main");
    let animate_resize = animate.unwrap_or(label == "main");
    let animation_duration_ms = duration_ms.unwrap_or(DEFAULT_ANIMATION_DURATION_MS);

    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let logical_width = f64::from(size.width) / scale_factor;
    let start_height = f64::from(size.height) / scale_factor;

    if (clamped_height - start_height).abs() <= HEIGHT_TOLERANCE {
        return Ok(());
    }

    let (logical_x, base_logical_y, monitor) = if center_window {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let monitor = window.current_monitor().map_err(|e| e.to_string())?;
        (
            Some(f64::from(pos.x) / scale_factor),
            Some(f64::from(pos.y) / scale_factor),
            monitor,
        )
    } else {
        (None, None, None)
    };

    // 关闭动画或变化太小时，走一次性调整分支避免无意义帧循环。
    if !animate_resize || animation_duration_ms == 0 || (clamped_height - start_height).abs() <= 2.0
    {
        apply_window_size(
            &window,
            logical_width,
            clamped_height,
            center_window,
            logical_x,
            base_logical_y,
            start_height,
            &monitor,
            scale_factor,
        )?;
        return Ok(());
    }

    let state = window_animation_state();
    let token = state.next_token(&label);
    let duration = Duration::from_millis(animation_duration_ms);
    let started_at = Instant::now();
    let mut last_applied_height = start_height.round();

    loop {
        // 若有新动画抢占当前窗口，旧动画立即退出。
        if !state.is_token_current(&label, token) {
            return Ok(());
        }

        let elapsed = started_at.elapsed();
        let progress = (elapsed.as_secs_f64() / duration.as_secs_f64()).min(1.0);
        let eased = 1.0 - (1.0 - progress).powi(3);
        let frame_height = (start_height + (clamped_height - start_height) * eased).round();

        // 仅在最后一帧或高度变化超过阈值时应用，减少系统调用频率。
        if progress >= 1.0 || (frame_height - last_applied_height).abs() > HEIGHT_TOLERANCE {
            apply_window_size(
                &window,
                logical_width,
                frame_height,
                center_window,
                logical_x,
                base_logical_y,
                start_height,
                &monitor,
                scale_factor,
            )?;
            last_applied_height = frame_height;
        }

        if progress >= 1.0 {
            break;
        }

        tokio::time::sleep(Duration::from_millis(ANIMATION_FRAME_INTERVAL_MS)).await;
    }

    Ok(())
}
