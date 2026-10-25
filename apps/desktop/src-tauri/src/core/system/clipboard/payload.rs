// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板 payload 和快照类型。

use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPayload {
    pub snapshot_id: String,
    pub observed_at: u64,
    pub text: Option<String>,
    pub html: Option<String>,
    pub html_source_url: Option<String>,
    pub html_images: Vec<ClipboardHtmlImage>,
    pub image_paths: Vec<String>,
    pub file_paths: Vec<String>,
    pub fragments: Vec<ClipboardPayloadFragment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ClipboardPayloadFragment {
    Text { text: String },
    Image { path: String },
    File { path: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardHtmlImage {
    pub source: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ClipboardSnapshot {
    pub(super) snapshot_id: String,
    pub(super) observed_at: u64,
    pub(super) text: Option<String>,
    pub(super) html: Option<String>,
    pub(super) html_source_url: Option<String>,
    pub(super) html_images: Vec<ClipboardHtmlImage>,
    pub(super) image_paths: Vec<String>,
    pub(super) file_paths: Vec<String>,
    pub(super) fragments: Vec<ClipboardPayloadFragment>,
}

impl ClipboardSnapshot {
    /// 将内部快照转换为前端可序列化 payload。
    pub(super) fn into_payload(self) -> ClipboardPayload {
        ClipboardPayload {
            snapshot_id: self.snapshot_id,
            observed_at: self.observed_at,
            text: self.text,
            html: self.html,
            html_source_url: self.html_source_url,
            html_images: self.html_images,
            image_paths: self.image_paths,
            file_paths: self.file_paths,
            fragments: self.fragments,
        }
    }
}

/// 基于标准化内容生成剪贴板快照 ID。
pub(super) fn build_snapshot_id(
    text: Option<&str>,
    image_identity_keys: &[String],
    file_paths: &[String],
) -> String {
    let mut hasher = DefaultHasher::new();

    text.hash(&mut hasher);
    image_identity_keys.hash(&mut hasher);
    file_paths.hash(&mut hasher);

    format!("clip-{:#016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The snapshot id is how the frontend decides whether the clipboard changed since it last
    // looked. A collision means a paste silently reuses stale content, so the id has to depend
    // on everything the user could have copied.

    fn snapshot_id(text: Option<&str>, images: &[String], files: &[String]) -> String {
        build_snapshot_id(text, images, files)
    }

    #[test]
    fn user_gets_a_stable_id_for_the_same_content() {
        let first = snapshot_id(Some("hello"), &[], &[]);
        let second = snapshot_id(Some("hello"), &[], &[]);

        assert_eq!(first, second);
    }

    #[test]
    fn user_gets_a_new_id_when_the_text_changes() {
        assert_ne!(
            snapshot_id(Some("hello"), &[], &[]),
            snapshot_id(Some("hello!"), &[], &[])
        );
    }

    #[test]
    fn user_gets_a_new_id_when_an_image_is_added() {
        assert_ne!(
            snapshot_id(Some("hello"), &[], &[]),
            snapshot_id(Some("hello"), &["image-1".to_string()], &[])
        );
    }

    #[test]
    fn user_gets_a_new_id_when_a_file_is_added() {
        assert_ne!(
            snapshot_id(Some("hello"), &[], &[]),
            snapshot_id(Some("hello"), &[], &["C:/tmp/a.txt".to_string()])
        );
    }

    #[test]
    fn user_gets_different_ids_for_text_only_and_empty_clipboard() {
        // A text clipboard and an empty clipboard must not look alike to the renderer.
        assert_ne!(snapshot_id(Some(""), &[], &[]), snapshot_id(None, &[], &[]));
    }

    #[test]
    fn user_gets_an_id_that_is_safe_to_compare_as_a_string() {
        let id = snapshot_id(Some("hello"), &[], &[]);

        // The shape is clip-0x<hex>; the renderer treats it as an opaque string, so only the
        // prefix and the character set matter.
        let hex = id
            .strip_prefix("clip-0x")
            .unwrap_or_else(|| panic!("unexpected id shape: {id}"));
        assert!(!hex.is_empty(), "the id carried no digest: {id}");
        assert!(
            hex.chars().all(|c| c.is_ascii_hexdigit()),
            "unexpected id shape: {id}"
        );
    }

    #[test]
    fn user_gets_the_snapshot_exposed_as_the_payload_the_frontend_reads() {
        let snapshot = ClipboardSnapshot {
            snapshot_id: "clip-00000000000000ff".to_string(),
            observed_at: 1_700_000_000,
            text: Some("hello".to_string()),
            html: Some("<b>hello</b>".to_string()),
            html_source_url: Some("https://example.com".to_string()),
            html_images: vec![ClipboardHtmlImage {
                source: "https://example.com/a.png".to_string(),
                path: Some("C:/tmp/a.png".to_string()),
            }],
            image_paths: vec!["C:/tmp/b.png".to_string()],
            file_paths: vec!["C:/tmp/c.txt".to_string()],
            fragments: vec![ClipboardPayloadFragment::Text {
                text: "hello".to_string(),
            }],
        };

        let payload = snapshot.into_payload();

        assert_eq!(payload.snapshot_id, "clip-00000000000000ff");
        assert_eq!(payload.observed_at, 1_700_000_000);
        assert_eq!(payload.text.as_deref(), Some("hello"));
        assert_eq!(payload.html.as_deref(), Some("<b>hello</b>"));
        assert_eq!(
            payload.html_source_url.as_deref(),
            Some("https://example.com")
        );
        assert_eq!(payload.html_images.len(), 1);
        assert_eq!(payload.image_paths, vec!["C:/tmp/b.png".to_string()]);
        assert_eq!(payload.file_paths, vec!["C:/tmp/c.txt".to_string()]);
        assert_eq!(payload.fragments.len(), 1);
    }
}
