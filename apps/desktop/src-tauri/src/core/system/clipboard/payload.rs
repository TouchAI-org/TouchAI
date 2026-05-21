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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ClipboardSnapshot {
    pub(super) snapshot_id: String,
    pub(super) observed_at: u64,
    pub(super) text: Option<String>,
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
            image_paths: self.image_paths,
            file_paths: self.file_paths,
            fragments: self.fragments,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ClipboardHtmlFragment {
    Text(String),
    ImageSource(String),
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
