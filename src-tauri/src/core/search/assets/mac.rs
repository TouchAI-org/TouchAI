// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! macOS 图标与图片缩略图提取。
//!
//! 文件/应用/文件夹图标走 NSWorkspace（通过 file_icon_provider 封装），
//! 图片缩略图直接用 image crate 解码并按比例缩放。

use std::path::Path;

use file_icon_provider::get_file_icon;
use image::GenericImageView;

use super::{
    cache::thumbnail_jpeg_quality,
    codec::{encode_rgba_to_jpeg_data_url, encode_rgba_to_png_data_url},
};

/// 获取路径对应的 macOS 系统图标。
pub(super) fn file_icon_data_url(path: &str, size: u32) -> Result<Option<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let size = size.clamp(16, 256) as u16;
    let icon = match get_file_icon(Path::new(trimmed), size) {
        Ok(icon) => icon,
        Err(error) => return Err(format!("Failed to get macOS file icon: {}", error)),
    };

    encode_rgba_to_png_data_url(icon.width, icon.height, icon.pixels).map(Some)
}

/// 获取图片内容缩略图。
pub(super) fn image_thumbnail_data_url(path: &str, size: u32) -> Result<Option<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let size = size.clamp(24, 256);
    let image = image::open(trimmed).map_err(|error| {
        format!(
            "Failed to open image for macOS thumbnail '{}': {}",
            trimmed, error
        )
    })?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let thumbnail = image.thumbnail(size, size).to_rgba8();
    encode_rgba_to_jpeg_data_url(
        thumbnail.width(),
        thumbnail.height(),
        thumbnail.as_raw(),
        thumbnail_jpeg_quality(),
    )
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::image_thumbnail_data_url;
    use std::path::Path;

    #[test]
    fn image_thumbnail_returns_none_for_blank_path() {
        assert!(image_thumbnail_data_url("   ", 56).unwrap().is_none());
    }

    #[test]
    fn image_thumbnail_returns_error_for_missing_path() {
        let missing = "/tmp/touchai-missing-thumbnail-input.png";
        if Path::new(missing).exists() {
            return;
        }

        assert!(image_thumbnail_data_url(missing, 56).is_err());
    }
}
