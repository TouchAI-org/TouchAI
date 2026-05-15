// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 窗口尺寸调整逻辑。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, LogicalUnit, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime,
    WebviewWindow, Window, WindowSizeConstraints,
};

use super::search::bounds::{clamp_height, clamp_width, HeightMode, SearchWindowFrame};

const DEFAULT_ANIMATION_DURATION_MS: u64 = 180;
const ANIMATION_FRAME_INTERVAL_MS: u64 = 16;
const HEIGHT_TOLERANCE: f64 = 1.0;

/// 最大化窗口跳过内容驱动的 resize，避免撑满屏幕时被自动高度覆盖。
fn is_content_driven_resize_allowed<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
    Ok(!window.is_maximized().map_err(|e| e.to_string())?)
}

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
fn apply_window_size<R: Runtime>(
    window: &WebviewWindow<R>,
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

/// 设置窗口最小尺寸（逻辑像素）。
fn apply_window_min_size<R: Runtime>(
    window: &WebviewWindow<R>,
    logical_width: f64,
    logical_height: f64,
) -> Result<(), String> {
    window
        .set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize {
            width: clamp_width(logical_width),
            height: clamp_height(logical_height),
        })))
        .map_err(|error| format!("Failed to set search window min size: {}", error))
}

/// set_size_constraints 是全量替换，max_height 为 None 时部分平台会清除整个约束（含 min_height）。
/// 因此 max_height 必须始终提供值，"不限制"时用足够大的默认值代替 None。
const DEFAULT_MAX_HEIGHT_UNCONSTRAINED: f64 = 2000.0;

/// 设置窗口尺寸约束（最小宽高 + 可选最大高度）。
fn apply_window_resize_constraints<R: Runtime>(
    window: &WebviewWindow<R>,
    min_width: f64,
    min_height: f64,
    max_height: Option<f64>,
) -> Result<(), String> {
    window
        .set_size_constraints(WindowSizeConstraints {
            min_width: Some(LogicalUnit::new(clamp_width(min_width)).into()),
            min_height: Some(LogicalUnit::new(clamp_height(min_height)).into()),
            max_width: None,
            max_height: Some(
                LogicalUnit::new(clamp_height(
                    max_height.unwrap_or(DEFAULT_MAX_HEIGHT_UNCONSTRAINED),
                ))
                .into(),
            ),
        })
        .map_err(|error| format!("Failed to set search window size constraints: {}", error))
}

/// 物理坐标转逻辑坐标。
fn logical_frame_from_physical(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale_factor: f64,
) -> SearchWindowFrame {
    SearchWindowFrame {
        x: f64::from(position.x) / scale_factor,
        y: f64::from(position.y) / scale_factor,
        width: f64::from(size.width) / scale_factor,
        height: f64::from(size.height) / scale_factor,
    }
}

/// 记录用户在运行时对搜索窗口的手动 resize/move。
pub fn record_search_window_runtime_resize<R: Runtime>(
    app_handle: &AppHandle<R>,
    window: &Window<R>,
) -> Result<HeightMode, String> {
    let runtime = app_handle
        .try_state::<crate::core::window::search::surface::SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    if window.is_maximized().map_err(|e| e.to_string())? {
        return Ok(runtime.window_state().snapshot().height_mode);
    }

    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(runtime.window_state().record_runtime_resize(
        logical_frame_from_physical(position, size, scale_factor),
        runtime.should_allow_height_override(),
        false,
    ))
}

/// 动态设置搜索窗口的最小/最大高度约束。
pub fn set_search_window_min_size<R: Runtime>(
    app_handle: &AppHandle<R>,
    min_width: f64,
    min_height: f64,
    max_height: Option<f64>,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    apply_window_resize_constraints(&window, min_width, min_height, max_height)
}

/// 将搜索窗口尺寸重置为当前默认值，并清空手动高度 override。
pub fn reset_search_window_to_defaults<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let runtime = window
        .app_handle()
        .try_state::<crate::core::window::search::surface::SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let snapshot = runtime.window_state().reset_to_defaults();
    let result: Result<(), String> = (|| {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window
                .unmaximize()
                .map_err(|e| format!("Failed to exit maximized: {}", e))?;

            // `unmaximize` 在 Windows 上有动画延迟，需轮询等待状态变更。
            for _ in 0..8 {
                if !window.is_maximized().map_err(|e| e.to_string())? {
                    break;
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        }
        let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
        let monitor = window.current_monitor().map_err(|e| e.to_string())?;
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let logical_frame = logical_frame_from_physical(
            position,
            window.outer_size().map_err(|e| e.to_string())?,
            scale_factor,
        );
        runtime.window_state().begin_programmatic_resize();
        runtime.window_state().note_programmatic_resize_target(
            logical_frame.width,
            logical_frame.height,
            snapshot.current_width,
            snapshot.current_height,
        );
        apply_window_min_size(window, snapshot.current_width, snapshot.current_height)?;

        apply_window_size(
            window,
            snapshot.current_width,
            snapshot.current_height,
            true,
            Some(logical_frame.x),
            Some(logical_frame.y),
            snapshot.current_height,
            &monitor,
            scale_factor,
        )?;
        window
            .center()
            .map_err(|e| format!("Failed to center search window: {}", e))?;
        runtime.window_state().apply_programmatic_size(
            Some(snapshot.current_width),
            Some(snapshot.current_height),
            Some(HeightMode::Auto),
        );
        Ok(())
    })();
    runtime.window_state().end_programmatic_resize();
    result?;
    Ok(())
}

/// 调整当前调用窗口的高度。
///
/// 约定：
/// - 动画策略统一在 Rust 侧执行；
/// - 前端可通过 `center` 显式控制是否垂直居中，未传时按窗口类型使用默认策略；
/// - `main` 窗口默认启用居中 + 动画，其他窗口默认直接调整。
pub async fn resize_window_height<R: Runtime>(
    window: WebviewWindow<R>,
    target_height: f64,
    center: Option<bool>,
    animate: Option<bool>,
    respect_manual_override: Option<bool>,
) -> Result<(), String> {
    let label = window.label().to_string();
    if !is_content_driven_resize_allowed(&window)? {
        return Ok(());
    }

    let search_window_runtime = if label == "main" {
        Some(
            window
                .app_handle()
                .try_state::<crate::core::window::search::surface::SearchWindowRuntime>()
                .ok_or_else(|| "Search window runtime is not initialized".to_string())?,
        )
    } else {
        None
    };

    let clamped_height = if let Some(runtime) = search_window_runtime.as_ref() {
        let Some(target_height) = runtime
            .window_state()
            .auto_height_target_with_policy(target_height, respect_manual_override.unwrap_or(true))
        else {
            return Ok(());
        };
        target_height
    } else {
        clamp_height(target_height)
    };
    if clamped_height <= 0.0 {
        return Ok(());
    }

    // 居中策略允许前端显式覆盖，默认值仍由后端保证一致性。
    let center_window = center.unwrap_or(label == "main");
    let animate_resize = animate.unwrap_or(label == "main");
    let animation_duration_ms = DEFAULT_ANIMATION_DURATION_MS;

    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let logical_width = f64::from(size.width) / scale_factor;
    let start_height = f64::from(size.height) / scale_factor;
    if search_window_runtime.is_some() {
        apply_window_min_size(&window, logical_width, clamped_height)?;
    }

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

    // 关闭动画或变化太小时，走一次性调整分支，避免无意义帧循环。
    if !animate_resize || animation_duration_ms == 0 || (clamped_height - start_height).abs() <= 2.0
    {
        let result: Result<(), String> = if let Some(runtime) = search_window_runtime.as_ref() {
            runtime.window_state().begin_programmatic_resize();
            runtime.window_state().note_programmatic_resize_target(
                logical_width,
                start_height,
                logical_width,
                clamped_height,
            );
            let result: Result<(), String> = (|| {
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
                runtime.window_state().apply_programmatic_size(
                    Some(logical_width),
                    Some(clamped_height),
                    Some(HeightMode::Auto),
                );
                Ok(())
            })();
            runtime.window_state().end_programmatic_resize();
            result
        } else {
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
            )
        };
        result?;
        return Ok(());
    }

    // 为每个窗口维护一个“最新动画令牌”：
    // 新请求到来会让旧动画自动失效，避免并发动画互相覆盖造成跳帧。
    let state = window_animation_state();
    let token = state.next_token(&label);
    let duration = Duration::from_millis(animation_duration_ms);
    let started_at = Instant::now();
    let mut last_applied_height = start_height.round();

    if let Some(runtime) = search_window_runtime.as_ref() {
        runtime.window_state().begin_programmatic_resize();
        runtime.window_state().note_programmatic_resize_target(
            logical_width,
            start_height,
            logical_width,
            clamped_height,
        );
    }
    let animation_result: Result<(), String> = async {
        loop {
            // 若有新动画抢占当前窗口，旧动画立即退出。
            if !state.is_token_current(&label, token) {
                return Ok(());
            }

            // 使用 ease-out cubic：开始快、结束慢，收尾更平滑。
            let elapsed = started_at.elapsed();
            let progress = (elapsed.as_secs_f64() / duration.as_secs_f64()).min(1.0);
            let eased = 1.0 - (1.0 - progress).powi(3);
            let frame_height = (start_height + (clamped_height - start_height) * eased).round();

            // 仅在最后一帧或高度变化超过阈值时应用，减少系统调用频率。
            if progress >= 1.0 || (frame_height - last_applied_height).abs() > HEIGHT_TOLERANCE {
                if !is_content_driven_resize_allowed(&window)? {
                    return Ok(());
                }
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

        if !is_content_driven_resize_allowed(&window)? {
            return Ok(());
        }
        if let Some(runtime) = search_window_runtime.as_ref() {
            runtime.window_state().apply_programmatic_size(
                Some(logical_width),
                Some(clamped_height),
                Some(HeightMode::Auto),
            );
        }
        Ok(())
    }
    .await;
    if let Some(runtime) = search_window_runtime.as_ref() {
        runtime.window_state().end_programmatic_resize();
    }
    animation_result?;

    Ok(())
}
