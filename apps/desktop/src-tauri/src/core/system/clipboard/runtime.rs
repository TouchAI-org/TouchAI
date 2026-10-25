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
        build_payload_fragments_from_html_images, extract_html_clipboard_images,
        read_clipboard_html_source_url, should_keep_clipboard_image,
    },
    image::{hash_value, push_unique, split_clipboard_file_paths, ClipboardImageCache},
    payload::{build_snapshot_id, ClipboardPayload, ClipboardPayloadFragment, ClipboardSnapshot},
};

const MAX_HTML_IMAGE_RESOLUTIONS: usize = 20;

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

        //2. 将文本、文件、native 图片和 HTML 图片归一到同一个 payload 语义。
        let fallback_text = text.filter(|value| !value.trim().is_empty());
        let mut html_images = html
            .as_deref()
            .map(|html| extract_html_clipboard_images(html, html_source_url.as_deref()))
            .unwrap_or_default();
        let (file_image_paths, normalized_files) = split_clipboard_file_paths(file_paths);
        let mut normalized_image_paths = Vec::new();
        let mut image_identity_keys = Vec::new();
        let mut fragments = Vec::new();
        let mut html_image_path_by_source: HashMap<String, String> = HashMap::new();

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

        for image in &html_images {
            image_identity_keys.push(format!("html:{}", hash_value(&image.source)));
        }

        //3. watcher 只观察轻量快照；显式粘贴/auto-paste 消费时才解析 HTML 外链图片。
        if mode.should_resolve_external_images() {
            for image in html_images.iter_mut().take(MAX_HTML_IMAGE_RESOLUTIONS) {
                match self
                    .inner
                    .image_cache
                    .resolve_html_image_source(&image.source)
                {
                    Ok(Some((path, _hash))) => {
                        html_image_path_by_source.insert(image.source.clone(), path.clone());
                        image.path = Some(path.clone());
                        push_unique(&mut normalized_image_paths, path);
                    }
                    Ok(None) => {}
                    Err(error) => warn!(
                        "Failed to resolve clipboard HTML image '{}': {}",
                        image.source, error
                    ),
                }
            }
        }

        //4. 文本和 HTML 正文由前端使用现有 DOMPurify/Turndown 归一化；Rust 只附加附件。
        if html.is_some() {
            fragments =
                build_payload_fragments_from_html_images(&html_images, &html_image_path_by_source);
            for file_path in &normalized_files {
                fragments.push(ClipboardPayloadFragment::File {
                    path: file_path.clone(),
                });
            }
        } else if let Some(text) = &fallback_text {
            fragments.insert(0, ClipboardPayloadFragment::Text { text: text.clone() });
            append_payload_attachment_fragments(
                &mut fragments,
                &normalized_image_paths,
                &normalized_files,
            );
        } else {
            append_payload_attachment_fragments(
                &mut fragments,
                &normalized_image_paths,
                &normalized_files,
            );
        }

        let snapshot_content_identity =
            build_snapshot_content_identity(fallback_text.as_deref(), html.as_deref());

        if snapshot_content_identity.is_none()
            && normalized_image_paths.is_empty()
            && normalized_files.is_empty()
            && html_images.is_empty()
            && html.is_none()
        {
            return Ok(None);
        }

        Ok(Some(ClipboardSnapshot {
            snapshot_id: build_snapshot_id(
                snapshot_content_identity.as_deref(),
                &image_identity_keys,
                &normalized_files,
            ),
            observed_at: now_millis(),
            text: fallback_text,
            html,
            html_source_url,
            html_images,
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

fn append_payload_attachment_fragments(
    fragments: &mut Vec<ClipboardPayloadFragment>,
    image_paths: &[String],
    file_paths: &[String],
) {
    for image_path in image_paths {
        fragments.push(ClipboardPayloadFragment::Image {
            path: image_path.clone(),
        });
    }
    for file_path in file_paths {
        fragments.push(ClipboardPayloadFragment::File {
            path: file_path.clone(),
        });
    }
}

fn build_snapshot_content_identity(text: Option<&str>, html: Option<&str>) -> Option<String> {
    // Each part is length-prefixed so a text that contains the separator cannot be mistaken
    // for a different text/html pair. Without this, text "x\nhtml:y" and the pair
    // (text "x", html "y") would hash to the same snapshot id and the renderer would treat
    // the second copy as unchanged.
    match (text, html) {
        (Some(text), Some(html)) => Some(format!(
            "{}:{text}{}:{html}",
            tag("text", text),
            tag("html", html)
        )),
        (Some(text), None) => Some(format!("{}:{text}", tag("text", text))),
        (None, Some(html)) => Some(format!("{}:{html}", tag("html", html))),
        (None, None) => None,
    }
}

/// Length prefix for one identity part, so the boundary is unambiguous.
fn tag(label: &str, value: &str) -> String {
    format!("{label}:{}", value.len())
}

#[cfg(test)]
mod tests {
    use super::{
        append_payload_attachment_fragments, build_snapshot_content_identity,
        next_shortcut_auto_paste_seq, now_millis, ClipboardPayloadFragment, ClipboardRuntimeState,
        ClipboardSnapshot, ClipboardSnapshotReadMode,
    };

    // The runtime decides whether a shortcut press pastes the clipboard. Pasting twice from
    // one press, or pasting something the user copied an hour ago, is worse than not pasting.

    fn snapshot(id: &str, observed_at: u64) -> ClipboardSnapshot {
        ClipboardSnapshot {
            snapshot_id: id.to_string(),
            observed_at,
            text: Some(format!("text-{id}")),
            html: None,
            html_source_url: None,
            html_images: Vec::new(),
            image_paths: Vec::new(),
            file_paths: Vec::new(),
            fragments: Vec::new(),
        }
    }

    #[test]
    fn user_gets_the_first_observation_time_kept_when_the_same_content_is_seen_again() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));

        state.remember_snapshot(snapshot("clip-1", 9_000));

        // Re-reading identical content must not extend the freshness window.
        assert_eq!(
            state.latest_snapshot.expect("a snapshot").observed_at,
            1_000
        );
    }

    #[test]
    fn user_gets_a_new_observation_time_for_different_content() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));

        state.remember_snapshot(snapshot("clip-2", 9_000));

        assert_eq!(
            state.latest_snapshot.expect("a snapshot").observed_at,
            9_000
        );
    }

    #[test]
    fn user_gets_no_snapshot_after_it_is_cleared() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));

        state.clear_snapshot();

        assert!(state.latest_snapshot.is_none());
    }

    #[test]
    fn user_gets_no_auto_paste_without_a_shortcut_press() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));

        // Nothing authorised the paste, so a plain read must not produce one.
        assert!(state
            .consume_shortcut_auto_paste_payload(60_000, 2_000)
            .is_none());
    }

    #[test]
    fn user_gets_the_clipboard_pasted_after_pressing_the_shortcut() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));
        state.authorize_shortcut_auto_paste();

        let payload = state
            .consume_shortcut_auto_paste_payload(60_000, 2_000)
            .expect("a fresh snapshot pastes");

        assert_eq!(payload.snapshot_id, "clip-1");
    }

    #[test]
    fn user_does_not_get_the_same_clipboard_pasted_twice() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));
        state.authorize_shortcut_auto_paste();
        let _ = state.consume_shortcut_auto_paste_payload(60_000, 2_000);

        state.authorize_shortcut_auto_paste();

        // A second press on unchanged content must not paste it again.
        assert!(state
            .consume_shortcut_auto_paste_payload(60_000, 3_000)
            .is_none());
    }

    #[test]
    fn user_gets_the_new_clipboard_pasted_after_copying_something_else() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));
        state.authorize_shortcut_auto_paste();
        let _ = state.consume_shortcut_auto_paste_payload(60_000, 2_000);

        state.remember_snapshot(snapshot("clip-2", 3_000));
        state.authorize_shortcut_auto_paste();

        let payload = state
            .consume_shortcut_auto_paste_payload(60_000, 4_000)
            .expect("new content pastes");

        assert_eq!(payload.snapshot_id, "clip-2");
    }

    #[test]
    fn user_does_not_get_stale_clipboard_pasted() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));
        state.authorize_shortcut_auto_paste();

        // Older than the window the caller allows.
        assert!(state
            .consume_shortcut_auto_paste_payload(500, 5_000)
            .is_none());
    }

    #[test]
    fn user_gets_the_authorisation_spent_after_one_press() {
        let mut state = ClipboardRuntimeState::default();
        state.remember_snapshot(snapshot("clip-1", 1_000));
        state.authorize_shortcut_auto_paste();
        let _ = state.consume_shortcut_auto_paste_payload(60_000, 2_000);

        // The authorisation is one-shot, so a stale read does not silently reuse it.
        assert!(state
            .consume_shortcut_auto_paste_payload(60_000, 2_000)
            .is_none());
    }

    #[test]
    fn user_gets_no_auto_paste_when_the_clipboard_is_empty() {
        let mut state = ClipboardRuntimeState::default();
        state.authorize_shortcut_auto_paste();

        assert!(state
            .consume_shortcut_auto_paste_payload(60_000, 2_000)
            .is_none());
    }

    #[test]
    fn user_gets_external_images_resolved_only_for_an_explicit_read() {
        assert!(ClipboardSnapshotReadMode::ResolveExternalImages.should_resolve_external_images());
        assert!(!ClipboardSnapshotReadMode::Observe.should_resolve_external_images());
    }

    // The snapshot identity decides whether the renderer treats two reads as the same content.
    // HTML has to count, or copying formatted text over plain text of the same words looks
    // unchanged and the new formatting never reaches the prompt.

    #[test]
    fn user_gets_a_distinct_identity_for_plain_text() {
        let plain = build_snapshot_content_identity(Some("hello"), None);
        let rich = build_snapshot_content_identity(None, Some("hello"));

        assert!(plain.is_some());
        assert_ne!(plain, rich, "text and html must not share an identity");
    }

    #[test]
    fn user_gets_a_distinct_identity_for_html_only() {
        let html = build_snapshot_content_identity(None, Some("<b>x</b>"));

        assert!(html.is_some());
        assert_ne!(html, build_snapshot_content_identity(None, None));
    }

    #[test]
    fn user_does_not_get_a_collision_when_the_text_contains_the_separator() {
        // A text that embeds "html:y" must not look like a real text/html pair.
        let forged = build_snapshot_content_identity(Some("x\nhtml:y"), None);
        let real = build_snapshot_content_identity(Some("x"), Some("y"));

        assert_ne!(forged, real, "the identity is ambiguous: {forged:?}");
    }

    #[test]
    fn user_does_not_get_a_collision_when_the_text_embeds_a_length_prefix() {
        let forged = build_snapshot_content_identity(Some("1:a"), None);
        let real = build_snapshot_content_identity(Some("a"), None);

        assert_ne!(forged, real, "the identity is ambiguous: {forged:?}");
    }

    #[test]
    fn user_gets_both_parts_recorded_when_text_and_html_are_present() {
        let both = build_snapshot_content_identity(Some("x"), Some("<b>x</b>"))
            .expect("a pair produces an identity");

        // Both parts must be present and ordered, so a swap is not equal either.
        assert!(both.contains("text"));
        assert!(both.contains("html"));
        assert_ne!(
            both,
            build_snapshot_content_identity(Some("<b>x</b>"), Some("x")).expect("swapped")
        );
    }

    #[test]
    fn user_gets_no_identity_for_an_empty_clipboard() {
        assert_eq!(build_snapshot_content_identity(None, None), None);
    }

    #[test]
    fn user_gets_different_identities_for_same_words_with_different_formatting() {
        let plain = build_snapshot_content_identity(Some("x"), None);
        let rich = build_snapshot_content_identity(Some("x"), Some("<b>x</b>"));

        assert_ne!(plain, rich);
    }

    #[test]
    fn user_gets_a_fragment_for_every_attachment_kind() {
        let mut fragments = Vec::new();

        append_payload_attachment_fragments(
            &mut fragments,
            &["C:/tmp/a.png".to_string()],
            &["C:/tmp/b.txt".to_string()],
        );

        assert_eq!(fragments.len(), 2);
        assert!(matches!(
            &fragments[0],
            ClipboardPayloadFragment::Image { path } if path == "C:/tmp/a.png"
        ));
        assert!(matches!(
            &fragments[1],
            ClipboardPayloadFragment::File { path } if path == "C:/tmp/b.txt"
        ));
    }

    #[test]
    fn user_gets_no_fragment_when_nothing_was_attached() {
        let mut fragments = Vec::new();

        append_payload_attachment_fragments(&mut fragments, &[], &[]);

        assert!(fragments.is_empty());
    }

    #[test]
    fn user_gets_a_new_auto_paste_sequence_for_each_press() {
        let first = next_shortcut_auto_paste_seq();
        let second = next_shortcut_auto_paste_seq();

        // Each press must be distinguishable, so a stale authorisation cannot be reused.
        assert!(second > first, "{second} should exceed {first}");
    }

    #[test]
    fn user_gets_a_wall_clock_time_in_milliseconds() {
        let now = now_millis();

        // Anything after 2020 is above this bound; the value only needs to be a real timestamp.
        assert!(now > 1_577_836_800_000, "unexpected timestamp: {now}");
    }

    #[test]
    fn attachment_only_payloads_still_emit_fragments() {
        let mut fragments = Vec::new();

        append_payload_attachment_fragments(
            &mut fragments,
            &[String::from("D:/clip/image.png")],
            &[String::from("D:/clip/file.pdf")],
        );

        assert_eq!(
            fragments,
            vec![
                ClipboardPayloadFragment::Image {
                    path: String::from("D:/clip/image.png")
                },
                ClipboardPayloadFragment::File {
                    path: String::from("D:/clip/file.pdf")
                },
            ]
        );
    }

    #[test]
    fn snapshot_identity_includes_html_when_plain_text_matches() {
        assert_ne!(
            build_snapshot_content_identity(Some("Docs"), Some("<p>Docs</p>")),
            build_snapshot_content_identity(
                Some("Docs"),
                Some("<p><a href=\"https://example.com\">Docs</a></p>")
            )
        );
    }
}
