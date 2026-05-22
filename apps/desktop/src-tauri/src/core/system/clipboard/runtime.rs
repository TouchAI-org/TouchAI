// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板运行时。

use clipboard_rs::{
    Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
    ContentFormat, WatcherShutdown,
};
use log::warn;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    html::{
        build_payload_fragments_from_html, build_payload_text, extract_html_clipboard_fragments,
        read_clipboard_html_source_url, should_keep_clipboard_image,
    },
    image::{hash_value, push_unique, split_clipboard_file_paths, ClipboardImageCache},
    payload::{
        build_snapshot_id, ClipboardHtmlFragment, ClipboardPayload, ClipboardPayloadFragment,
        ClipboardSnapshot,
    },
};

#[derive(Default)]
struct ClipboardRuntimeState {
    latest_snapshot: Option<ClipboardSnapshot>,
    pending_shortcut_auto_paste_seq: Option<u64>,
    last_auto_pasted_snapshot_id: Option<String>,
}

impl ClipboardRuntimeState {
    /// 记录最新剪贴板快照，并保留同内容首次观察时间。
    fn remember_snapshot(&mut self, mut snapshot: ClipboardSnapshot) {
        if let Some(current) = &self.latest_snapshot {
            if current.snapshot_id == snapshot.snapshot_id {
                snapshot.observed_at = current.observed_at;
            }
        }

        self.latest_snapshot = Some(snapshot);
    }

    /// 清空当前剪贴板快照。
    fn clear_snapshot(&mut self) {
        self.latest_snapshot = None;
    }

    /// 授权下一次由全局快捷键触发的 auto-paste。
    fn authorize_shortcut_auto_paste(&mut self) {
        self.pending_shortcut_auto_paste_seq = Some(next_shortcut_auto_paste_seq());
    }

    /// 消费符合快捷键授权、新鲜度和去重条件的 auto-paste payload。
    fn consume_shortcut_auto_paste_payload(
        &mut self,
        max_age_ms: u64,
        now_ms: u64,
    ) -> Option<ClipboardPayload> {
        //1. 先消费一次性快捷键授权：没有授权说明不是本轮全局快捷键唤起，直接拒绝。
        let _shortcut_auto_paste_seq = self.pending_shortcut_auto_paste_seq.take()?;
        let snapshot = self.latest_snapshot.clone()?;

        //2. 使用首次观察时间判断新鲜度，避免同内容反复读取时延长 auto-paste 窗口。
        if now_ms.saturating_sub(snapshot.observed_at) > max_age_ms {
            return None;
        }

        //3. Rust 层先记录 snapshotId，防止同一份剪贴板内容被重复 auto-paste。
        if self.last_auto_pasted_snapshot_id.as_deref() == Some(snapshot.snapshot_id.as_str()) {
            return None;
        }

        self.last_auto_pasted_snapshot_id = Some(snapshot.snapshot_id.clone());
        Some(snapshot.into_payload())
    }
}

#[derive(Clone)]
pub struct ClipboardRuntime {
    inner: Arc<ClipboardRuntimeInner>,
}

struct ClipboardRuntimeInner {
    state: Mutex<ClipboardRuntimeState>,
    context: Mutex<ClipboardContext>,
    image_cache: ClipboardImageCache,
    watcher_shutdown: Mutex<Option<WatcherShutdown>>,
}

struct ClipboardRuntimeWatcher {
    runtime: ClipboardRuntime,
}

#[derive(Clone, Copy)]
enum ClipboardSnapshotReadMode {
    Observe,
    ResolveExternalImages,
}

impl ClipboardSnapshotReadMode {
    /// 判断本次读取是否需要解析 HTML 中的外部图片。
    fn should_resolve_external_images(self) -> bool {
        matches!(self, Self::ResolveExternalImages)
    }
}

impl ClipboardRuntime {
    /// 初始化剪贴板运行时、缓存目录和系统 watcher。
    pub fn initialize() -> Result<Self, String> {
        let image_cache = ClipboardImageCache::initialize()?;

        let runtime =
            Self {
                inner: Arc::new(ClipboardRuntimeInner {
                    state: Mutex::new(ClipboardRuntimeState::default()),
                    context: Mutex::new(ClipboardContext::new().map_err(|error| {
                        format!("Failed to initialize clipboard context: {error}")
                    })?),
                    image_cache,
                    watcher_shutdown: Mutex::new(None),
                }),
            };

        runtime.refresh_latest_snapshot(ClipboardSnapshotReadMode::Observe)?;
        runtime.start_watcher()?;
        Ok(runtime)
    }

    /// 读取当前系统剪贴板并返回标准化 payload。
    pub fn read_clipboard_payload(&self) -> Result<Option<ClipboardPayload>, String> {
        self.refresh_latest_snapshot(ClipboardSnapshotReadMode::ResolveExternalImages)?;

        Ok(self
            .inner
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .latest_snapshot
            .clone()
            .map(ClipboardSnapshot::into_payload))
    }

    /// 消费一次由快捷键唤起窗口授权的 auto-paste payload。
    pub fn consume_shortcut_auto_paste_payload(
        &self,
        max_age_ms: u64,
    ) -> Result<Option<ClipboardPayload>, String> {
        self.refresh_latest_snapshot(ClipboardSnapshotReadMode::ResolveExternalImages)?;

        Ok(self
            .inner
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .consume_shortcut_auto_paste_payload(max_age_ms, now_millis()))
    }

    /// 将文本写入系统剪贴板并刷新内部快照。
    pub fn write_text(&self, text: String) -> Result<(), String> {
        self.inner
            .context
            .lock()
            .map_err(|error| error.to_string())?
            .set_text(text)
            .map_err(|error| error.to_string())?;
        self.refresh_latest_snapshot(ClipboardSnapshotReadMode::Observe)?;
        Ok(())
    }

    /// 授权下一次窗口 focus 尝试快捷键 auto-paste。
    pub fn authorize_shortcut_auto_paste(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.authorize_shortcut_auto_paste();
        }
    }

    /// 启动系统剪贴板 watcher。
    fn start_watcher(&self) -> Result<(), String> {
        let mut watcher_shutdown = self
            .inner
            .watcher_shutdown
            .lock()
            .map_err(|error| error.to_string())?;
        if watcher_shutdown.is_some() {
            return Ok(());
        }

        let mut watcher = ClipboardWatcherContext::new()
            .map_err(|error| format!("Failed to initialize clipboard watcher: {error}"))?;
        let shutdown = watcher
            .add_handler(ClipboardRuntimeWatcher {
                runtime: self.clone(),
            })
            .get_shutdown_channel();
        *watcher_shutdown = Some(shutdown);

        thread::spawn(move || {
            watcher.start_watch();
        });

        Ok(())
    }

    /// 从系统剪贴板刷新最新快照。
    fn refresh_latest_snapshot(&self, mode: ClipboardSnapshotReadMode) -> Result<(), String> {
        let next_snapshot = self.read_snapshot_from_system(mode)?;
        let mut state = self.inner.state.lock().map_err(|error| error.to_string())?;

        if let Some(snapshot) = next_snapshot {
            state.remember_snapshot(snapshot);
        } else {
            state.clear_snapshot();
        }

        Ok(())
    }

    /// 从系统剪贴板读取并归一化一份快照。
    fn read_snapshot_from_system(
        &self,
        mode: ClipboardSnapshotReadMode,
    ) -> Result<Option<ClipboardSnapshot>, String> {
        //1. 一次性读出系统剪贴板原始通道，后续解析不再长时间持有 clipboard 锁。
        let (text, html, html_source_url, image, file_paths) = {
            let context = self
                .inner
                .context
                .lock()
                .map_err(|error| error.to_string())?;

            let text = if context.has(ContentFormat::Text) {
                Some(context.get_text().map_err(|error| error.to_string())?)
            } else {
                None
            };

            let has_html = context.has(ContentFormat::Html);
            let html = if has_html {
                Some(context.get_html().map_err(|error| error.to_string())?)
            } else {
                None
            };
            let html_source_url = if has_html {
                read_clipboard_html_source_url(&context)
            } else {
                None
            };

            let file_paths = if context.has(ContentFormat::Files) {
                context.get_files().map_err(|error| error.to_string())?
            } else {
                Vec::new()
            };

            let image = if context.has(ContentFormat::Image)
                && should_keep_clipboard_image(
                    text.as_deref(),
                    html.as_deref(),
                    !file_paths.is_empty(),
                ) {
                Some(context.get_image().map_err(|error| error.to_string())?)
            } else {
                None
            };

            (text, html, html_source_url, image, file_paths)
        };

        //2. 将文本、文件、native 图片和 HTML 片段归一到同一个 payload 语义。
        let fallback_text = text.filter(|value| !value.trim().is_empty());
        let html_fragments = html
            .as_deref()
            .map(|html| extract_html_clipboard_fragments(html, html_source_url.as_deref()))
            .unwrap_or_default();
        let html_image_sources = html_fragments
            .iter()
            .filter_map(|fragment| match fragment {
                ClipboardHtmlFragment::ImageSource(source) => Some(source.clone()),
                ClipboardHtmlFragment::Text(_) => None,
            })
            .collect::<Vec<_>>();
        let (file_image_paths, normalized_files) = split_clipboard_file_paths(file_paths);
        let mut normalized_image_paths = Vec::new();
        let mut image_identity_keys = Vec::new();
        let mut fragments = Vec::new();
        let mut html_image_path_by_source: HashMap<&str, String> = HashMap::new();

        for image_path in file_image_paths {
            image_identity_keys.push(format!("file:{image_path}"));
            match self.inner.image_cache.save_image_file_path(&image_path) {
                Ok((cached_path, _hash)) => push_unique(&mut normalized_image_paths, cached_path),
                Err(error) => {
                    warn!(
                        "Failed to cache clipboard image file '{}': {}",
                        image_path, error
                    );
                    push_unique(&mut normalized_image_paths, image_path);
                }
            }
        }

        if let Some(image) = image {
            let (path, hash) = self.inner.image_cache.save_clipboard_image(image)?;
            image_identity_keys.push(format!("native:{hash}"));
            push_unique(&mut normalized_image_paths, path);
        }

        for source in &html_image_sources {
            image_identity_keys.push(format!("html:{}", hash_value(source)));
        }

        //3. watcher 只观察轻量快照；显式粘贴/auto-paste 消费时才解析 HTML 外链图片。
        if mode.should_resolve_external_images() {
            for source in &html_image_sources {
                match self.inner.image_cache.resolve_html_image_source(source) {
                    Ok(Some((path, _hash))) => {
                        html_image_path_by_source.insert(source.as_str(), path.clone());
                        push_unique(&mut normalized_image_paths, path);
                    }
                    Ok(None) => {}
                    Err(error) => warn!(
                        "Failed to resolve clipboard HTML image '{}': {}",
                        source, error
                    ),
                }
            }
        }

        //4. 优先保留 HTML 的 text/image 顺序；无 HTML 结构时再回退为文本后接附件。
        if !html_fragments.is_empty() {
            fragments =
                build_payload_fragments_from_html(&html_fragments, &html_image_path_by_source);
            for file_path in &normalized_files {
                fragments.push(ClipboardPayloadFragment::File {
                    path: file_path.clone(),
                });
            }
        } else if let Some(text) = &fallback_text {
            fragments.insert(0, ClipboardPayloadFragment::Text { text: text.clone() });
            for image_path in &normalized_image_paths {
                fragments.push(ClipboardPayloadFragment::Image {
                    path: image_path.clone(),
                });
            }
            for file_path in &normalized_files {
                fragments.push(ClipboardPayloadFragment::File {
                    path: file_path.clone(),
                });
            }
        }

        let normalized_text = if !html_fragments.is_empty() {
            build_payload_text(&fragments)
        } else {
            fallback_text
        };

        if normalized_text.is_none()
            && normalized_image_paths.is_empty()
            && normalized_files.is_empty()
            && html_image_sources.is_empty()
        {
            return Ok(None);
        }

        Ok(Some(ClipboardSnapshot {
            snapshot_id: build_snapshot_id(
                normalized_text.as_deref(),
                &image_identity_keys,
                &normalized_files,
            ),
            observed_at: now_millis(),
            text: normalized_text,
            image_paths: normalized_image_paths,
            file_paths: normalized_files,
            fragments,
        }))
    }
}

impl ClipboardHandler for ClipboardRuntimeWatcher {
    /// 响应系统剪贴板变化并刷新轻量快照。
    fn on_clipboard_change(&mut self) {
        if let Err(error) = self
            .runtime
            .refresh_latest_snapshot(ClipboardSnapshotReadMode::Observe)
        {
            warn!(
                "Failed to refresh clipboard snapshot after change: {}",
                error
            );
        }
    }
}

/// 生成下一次快捷键 auto-paste 授权序号。
fn next_shortcut_auto_paste_seq() -> u64 {
    static NEXT_SHORTCUT_AUTO_PASTE_SEQ: AtomicU64 = AtomicU64::new(1);
    NEXT_SHORTCUT_AUTO_PASTE_SEQ.fetch_add(1, Ordering::Relaxed)
}

/// 返回当前毫秒时间戳。
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
