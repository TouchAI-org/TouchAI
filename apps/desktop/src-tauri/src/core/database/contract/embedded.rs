// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 基于 Tauri 原生 EmbeddedAssets 的数据库契约内联资产。

use std::path::PathBuf;

use tauri::utils::assets::{AssetKey, EmbeddedAssets};

static DATABASE_ASSETS: EmbeddedAssets = include!(concat!(env!("OUT_DIR"), "/database-assets.rs"));

pub(super) fn read_text(segments: &[&str]) -> Option<String> {
    let key = asset_key_from_segments(segments);
    let bytes = DATABASE_ASSETS.get(&key)?;
    String::from_utf8(bytes.into_owned()).ok()
}

fn asset_key_from_segments(segments: &[&str]) -> AssetKey {
    let path = segments.iter().fold(PathBuf::new(), |mut path, segment| {
        path.push(segment);
        path
    });
    AssetKey::from(path)
}
