// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 搜索窗口尺寸与位置策略。

use std::sync::Mutex;

const DEFAULT_WIDTH: f64 = 750.0;
const DEFAULT_HEIGHT: f64 = 60.0;
const DEFAULT_MIN_HEIGHT: f64 = 60.0;
/// 最小宽度需与 tauri.conf.json 的 minWidth 保持一致。
const DEFAULT_MIN_WIDTH: f64 = 420.0;
/// 程序化 resize 事件与预期尺寸的匹配容差（逻辑像素）。
const RUNTIME_RESIZE_TOLERANCE: f64 = 1.0;

/// 搜索窗口默认尺寸（逻辑像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchWindowDefaults {
    pub width: f64,
    pub height: f64,
}

impl Default for SearchWindowDefaults {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
        }
    }
}

impl SearchWindowDefaults {
    /// 返回经最小值约束后的默认尺寸。
    pub fn clamped(self) -> Self {
        Self {
            width: clamp_width(self.width),
            height: clamp_height(self.height),
        }
    }
}

/// 搜索窗口的逻辑坐标与尺寸。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchWindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl SearchWindowFrame {
    /// 替换尺寸并应用最小值约束，保留原始位置。
    pub fn with_size(mut self, width: f64, height: f64) -> Self {
        self.width = clamp_width(width);
        self.height = clamp_height(height);
        self
    }
}

/// 搜索窗口高度决策模式。
///
/// - Auto：由内容高度驱动，对话内容变化时自动伸缩。
/// - ManualOverride：用户手动拖拽窗口高度后锁定，阻止后续内容驱动的高度调整。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeightMode {
    Auto,
    ManualOverride,
}

/// 搜索窗口状态的只读快照，用于跨线程传递当前窗口尺寸信息。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchWindowStateSnapshot {
    pub defaults: SearchWindowDefaults,
    pub current_width: f64,
    pub current_height: f64,
    pub height_mode: HeightMode,
    pub last_known_frame: Option<SearchWindowFrame>,
}

/// 搜索窗口状态内部数据（非线程安全，由外层 Mutex 保护）。
#[derive(Debug)]
struct SearchWindowStateInner {
    defaults: SearchWindowDefaults,
    current_width: f64,
    current_height: f64,
    height_mode: HeightMode,
    last_known_frame: Option<SearchWindowFrame>,
    /// 程序化 resize 引用计数，>0 时表示正处于动画或系统 resize 中。
    programmatic_resize_depth: usize,
    /// 程序化 resize 的预期目标尺寸，用于区分动画帧事件和用户拖拽事件。
    expected_programmatic_size: Option<(f64, f64)>,
}

impl Default for SearchWindowStateInner {
    fn default() -> Self {
        let defaults = SearchWindowDefaults::default().clamped();
        Self {
            defaults,
            current_width: defaults.width,
            current_height: defaults.height,
            height_mode: HeightMode::Auto,
            last_known_frame: None,
            programmatic_resize_depth: 0,
            expected_programmatic_size: None,
        }
    }
}

fn snapshot_of(inner: &SearchWindowStateInner) -> SearchWindowStateSnapshot {
    SearchWindowStateSnapshot {
        defaults: inner.defaults,
        current_width: inner.current_width,
        current_height: inner.current_height,
        height_mode: inner.height_mode,
        last_known_frame: inner.last_known_frame,
    }
}

/// 搜索窗口尺寸状态机（线程安全）。
///
/// 管理窗口的当前宽高、默认尺寸和高度决策模式。
/// 通过 programmatic_resize_depth 引用计数区分程序化 resize（动画）和用户手动拖拽。
pub struct SearchWindowState {
    inner: Mutex<SearchWindowStateInner>,
}

impl Default for SearchWindowState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(SearchWindowStateInner::default()),
        }
    }
}

impl SearchWindowState {
    /// 返回当前状态的只读快照。
    pub fn snapshot(&self) -> SearchWindowStateSnapshot {
        let inner = self.inner.lock().expect("search window state poisoned");
        snapshot_of(&inner)
    }

    /// 更新默认尺寸。若当前为 Auto 模式则同步更新当前高度；ManualOverride 模式下仅更新宽度。
    pub fn update_defaults(&self, defaults: SearchWindowDefaults) -> SearchWindowDefaults {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        let clamped = defaults.clamped();
        inner.defaults = clamped;
        if inner.height_mode == HeightMode::Auto {
            inner.current_height = clamped.height;
        }
        inner.current_width = clamped.width;
        clamped
    }

    /// 记录一次运行时窗口尺寸变化，返回更新后的高度模式。
    ///
    /// 此方法在每次系统 Resized/Moved 事件中被调用，需要区分三种来源：
    /// 1. 程序化 resize（动画帧）—— 匹配 expected_programmatic_size 时保持 Auto
    /// 2. 用户手动拖拽高度 —— 标记为 ManualOverride
    /// 3. 用户仅拖拽宽度 —— 保持 Auto，但确保高度不低于默认值
    pub fn record_runtime_resize(
        &self,
        frame: SearchWindowFrame,
        allow_height_override: bool,
        allow_shrink: bool,
    ) -> HeightMode {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        let normalized = frame.with_size(frame.width, frame.height);
        let mut next_width = normalized.width;
        let mut next_height = if allow_height_override {
            normalized.height
        } else {
            inner.current_height
        };
        if !allow_shrink {
            next_width = next_width.max(inner.current_width);
            next_height = next_height.max(inner.current_height);
        }

        let width_changed = (next_width - inner.current_width).abs() > RUNTIME_RESIZE_TOLERANCE;
        let height_changed = (next_height - inner.current_height).abs() > RUNTIME_RESIZE_TOLERANCE;
        let matches_expected_programmatic_size =
            inner
                .expected_programmatic_size
                .is_some_and(|(expected_width, expected_height)| {
                    (next_width - expected_width).abs() <= RUNTIME_RESIZE_TOLERANCE
                        && (next_height - expected_height).abs() <= RUNTIME_RESIZE_TOLERANCE
                });

        inner.current_width = next_width;
        inner.current_height = next_height;
        inner.last_known_frame = Some(SearchWindowFrame {
            width: next_width,
            height: next_height,
            ..normalized
        });

        if inner.programmatic_resize_depth > 0 {
            // 匹配预期目标 → 确认为程序化 resize，清除预期。
            if matches_expected_programmatic_size {
                inner.height_mode = HeightMode::Auto;
                inner.expected_programmatic_size = None;
            // 高度变更但不匹配预期 → 用户在动画期间手动拖拽，允许进入 ManualOverride。
            } else if height_changed && allow_height_override {
                inner.height_mode = HeightMode::ManualOverride;
            }
            return inner.height_mode;
        }

        // 守护外的延迟事件：匹配预期尺寸时也确认为 Auto。
        if matches_expected_programmatic_size {
            inner.height_mode = HeightMode::Auto;
            inner.expected_programmatic_size = None;
            return inner.height_mode;
        }

        if height_changed && allow_height_override {
            inner.height_mode = HeightMode::ManualOverride;
        } else if width_changed && inner.height_mode == HeightMode::Auto {
            inner.current_height = inner.current_height.max(inner.defaults.height);
        }

        inner.height_mode
    }

    /// 计算内容驱动的自动高度目标。
    ///
    /// - respect_manual_override 为 true 且当前为 ManualOverride 时返回 None，阻止自动调整。
    /// - 目标高度不低于默认高度，返回值已 clamp。
    pub fn auto_height_target_with_policy(
        &self,
        content_height: f64,
        respect_manual_override: bool,
    ) -> Option<f64> {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        if respect_manual_override && inner.height_mode == HeightMode::ManualOverride {
            return None;
        }

        let target = clamp_height(content_height.max(inner.defaults.height));
        inner.current_height = target;
        inner.height_mode = HeightMode::Auto;
        Some(target)
    }

    /// 直接应用程序化尺寸（动画完成或 reset 后调用），可选更新高度模式。
    pub fn apply_programmatic_size(
        &self,
        width: Option<f64>,
        height: Option<f64>,
        height_mode: Option<HeightMode>,
    ) -> SearchWindowStateSnapshot {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        if let Some(next_width) = width {
            inner.current_width = clamp_width(next_width);
        }
        if let Some(next_height) = height {
            inner.current_height = clamp_height(next_height);
        }
        if let Some(mode) = height_mode {
            inner.height_mode = mode;
        }

        snapshot_of(&inner)
    }

    /// 重置为默认尺寸，清除 ManualOverride 和所有守护状态。
    pub fn reset_to_defaults(&self) -> SearchWindowStateSnapshot {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        inner.current_width = inner.defaults.width;
        inner.current_height = inner.defaults.height;
        inner.height_mode = HeightMode::Auto;
        inner.last_known_frame = None;
        inner.expected_programmatic_size = None;

        snapshot_of(&inner)
    }

    /// 进入程序化 resize 守护区间，引用计数 +1。
    ///
    /// 在动画开始前调用，期间所有 Resized 事件不会被误判为用户操作。
    pub fn begin_programmatic_resize(&self) {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        inner.programmatic_resize_depth = inner.programmatic_resize_depth.saturating_add(1);
    }

    /// 记录程序化 resize 的预期目标尺寸，用于匹配后续事件。
    pub fn note_programmatic_resize_target(&self, width: f64, height: f64) {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        inner.expected_programmatic_size = Some((clamp_width(width), clamp_height(height)));
    }

    /// 退出程序化 resize 守护区间，引用计数 -1。
    pub fn end_programmatic_resize(&self) {
        let mut inner = self.inner.lock().expect("search window state poisoned");
        inner.programmatic_resize_depth = inner.programmatic_resize_depth.saturating_sub(1);
    }
}

/// 将宽度取整并约束到最小值。
pub fn clamp_width(width: f64) -> f64 {
    width.round().max(DEFAULT_MIN_WIDTH)
}

/// 将高度取整并约束到最小值。
pub fn clamp_height(height: f64) -> f64 {
    height.round().max(DEFAULT_MIN_HEIGHT)
}

#[cfg(test)]
mod tests {
    use super::{HeightMode, SearchWindowDefaults, SearchWindowFrame, SearchWindowState};

    fn frame(width: f64, height: f64) -> SearchWindowFrame {
        SearchWindowFrame {
            x: 200.0,
            y: 120.0,
            width,
            height,
        }
    }

    #[test]
    fn auto_height_respects_default_minimum() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 960.0,
            height: 320.0,
        });

        let target = state.auto_height_target_with_policy(180.0, true);

        assert_eq!(target, Some(320.0));
        assert_eq!(state.snapshot().height_mode, HeightMode::Auto);
    }

    #[test]
    fn manual_height_override_blocks_later_auto_height_updates() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 920.0,
            height: 280.0,
        });

        let mode = state.record_runtime_resize(frame(920.0, 540.0), true, true);
        let target = state.auto_height_target_with_policy(360.0, true);

        assert_eq!(mode, HeightMode::ManualOverride);
        assert_eq!(target, None);
        assert_eq!(state.snapshot().current_height, 540.0);
    }

    #[test]
    fn width_only_resize_keeps_auto_height_mode() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 880.0,
            height: 300.0,
        });
        state.apply_programmatic_size(Some(880.0), Some(420.0), Some(HeightMode::Auto));

        let mode = state.record_runtime_resize(frame(1024.0, 420.0), false, true);
        let target = state.auto_height_target_with_policy(390.0, true);

        assert_eq!(mode, HeightMode::Auto);
        assert_eq!(target, Some(390.0));
    }

    #[test]
    fn manual_height_resize_during_programmatic_resize_still_enters_override() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 900.0,
            height: 280.0,
        });

        state.begin_programmatic_resize();
        state.note_programmatic_resize_target(900.0, 360.0);

        let animation_mode = state.record_runtime_resize(frame(900.0, 360.0), true, true);
        let manual_mode = state.record_runtime_resize(frame(900.0, 520.0), true, true);

        state.end_programmatic_resize();

        assert_eq!(animation_mode, HeightMode::Auto);
        assert_eq!(manual_mode, HeightMode::ManualOverride);
        assert_eq!(state.auto_height_target_with_policy(400.0, true), None);
    }

    #[test]
    fn reset_to_defaults_clears_manual_override() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 1000.0,
            height: 340.0,
        });
        state.record_runtime_resize(frame(1080.0, 560.0), true, true);

        let snapshot = state.reset_to_defaults();
        let target = state.auto_height_target_with_policy(380.0, true);

        assert_eq!(snapshot.current_width, 1000.0);
        assert_eq!(snapshot.current_height, 340.0);
        assert_eq!(snapshot.height_mode, HeightMode::Auto);
        assert_eq!(target, Some(380.0));
    }

    #[test]
    fn runtime_resize_does_not_allow_shrinking() {
        let state = SearchWindowState::default();
        state.apply_programmatic_size(Some(980.0), Some(420.0), Some(HeightMode::Auto));

        let mode = state.record_runtime_resize(frame(900.0, 360.0), true, false);
        let snapshot = state.snapshot();

        assert_eq!(mode, HeightMode::Auto);
        assert_eq!(snapshot.current_width, 980.0);
        assert_eq!(snapshot.current_height, 420.0);
    }

    #[test]
    fn idle_runtime_height_resize_does_not_enter_manual_override() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 900.0,
            height: 300.0,
        });

        let mode = state.record_runtime_resize(frame(900.0, 540.0), false, true);

        assert_eq!(mode, HeightMode::Auto);
        assert_eq!(state.snapshot().height_mode, HeightMode::Auto);
    }

    #[test]
    fn runtime_height_resize_without_override_permission_does_not_update_current_height() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 900.0,
            height: 300.0,
        });

        let mode = state.record_runtime_resize(frame(960.0, 540.0), false, false);
        let snapshot = state.snapshot();

        assert_eq!(mode, HeightMode::Auto);
        assert_eq!(snapshot.current_width, 960.0);
        assert_eq!(snapshot.current_height, 300.0);
    }

    #[test]
    fn late_programmatic_resize_event_after_guard_ends_does_not_enter_manual_override() {
        let state = SearchWindowState::default();
        state.update_defaults(SearchWindowDefaults {
            width: 900.0,
            height: 280.0,
        });

        state.begin_programmatic_resize();
        state.note_programmatic_resize_target(900.0, 520.0);
        state.end_programmatic_resize();

        let mode = state.record_runtime_resize(frame(900.0, 520.0), true, false);

        assert_eq!(mode, HeightMode::Auto);
        assert_eq!(state.snapshot().height_mode, HeightMode::Auto);
        assert_eq!(
            state.auto_height_target_with_policy(460.0, true),
            Some(460.0)
        );
    }
}
