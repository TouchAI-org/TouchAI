// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板图片缓存和文件识别。

use base64::{engine::general_purpose, Engine as _};
use clipboard_rs::{common::RustImage, RustImageData};
use reqwest::{blocking::Client as HttpClient, header::CONTENT_TYPE, Url};
use std::{
    collections::hash_map::DefaultHasher,
    fs::{create_dir_all, File},
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::core::system::paths::{app_directory_path, AppDirectory};

const MAX_HTML_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

pub(super) struct ClipboardImageCache {
    image_dir: PathBuf,
    http_client: HttpClient,
}

impl ClipboardImageCache {
    /// 初始化剪贴板图片缓存。
    pub(super) fn initialize() -> Result<Self, String> {
        let image_dir = app_directory_path(AppDirectory::Cache)?.join("clipboard");
        create_dir_all(&image_dir)
            .map_err(|error| format!("Failed to create clipboard cache directory: {error}"))?;
        let http_client = HttpClient::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("TouchAI clipboard image resolver")
            .build()
            .map_err(|error| {
                format!("Failed to initialize clipboard image HTTP client: {error}")
            })?;

        Ok(Self {
            image_dir,
            http_client,
        })
    }

    /// 保存 native 图片数据到剪贴板缓存目录。
    pub(super) fn save_clipboard_image(
        &self,
        image: RustImageData,
    ) -> Result<(String, u64), String> {
        let dynamic_image = image
            .get_dynamic_image()
            .map_err(|error| error.to_string())?;
        let mut hasher = DefaultHasher::new();
        dynamic_image.as_bytes().hash(&mut hasher);
        let image_hash = hasher.finish();

        let target_path = self.image_dir.join(format!("{image_hash}.png"));
        let target_path_str = target_path
            .to_str()
            .ok_or_else(|| "Failed to resolve clipboard image path".to_string())?;
        if !target_path.exists() {
            image
                .save_to_path(target_path_str)
                .map_err(|error| error.to_string())?;
        }

        Ok((target_path_string(&target_path), image_hash))
    }

    /// 将图片文件路径缓存为可复用图片附件路径。
    pub(super) fn save_image_file_path(&self, path: &str) -> Result<(String, u64), String> {
        if path_has_image_extension(path, "svg") || file_has_svg_signature(path) {
            let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
            return self.save_raw_clipboard_image_bytes(&bytes, "svg");
        }

        let image = RustImageData::from_path(path).map_err(|error| error.to_string())?;
        self.save_clipboard_image(image)
    }

    /// 解析 HTML 图片引用并缓存为本地图片路径。
    pub(super) fn resolve_html_image_source(
        &self,
        source: &str,
    ) -> Result<Option<(String, u64)>, String> {
        if source.to_ascii_lowercase().starts_with("data:image/") {
            let data = decode_data_image_source(source)?;
            if data.mime_type == "image/svg+xml" || bytes_start_with_svg(&data.bytes) {
                return self
                    .save_raw_clipboard_image_bytes(&data.bytes, "svg")
                    .map(Some);
            }

            return self.save_clipboard_image_bytes(&data.bytes).map(Some);
        }

        if source.to_ascii_lowercase().starts_with("file://") {
            let path = normalize_clipboard_file_path(source);
            if is_image_file_path(&path) {
                return self.save_image_file_path(&path).map(Some);
            }

            return Ok(None);
        }

        if Path::new(source).is_absolute() && is_image_file_path(source) {
            return self.save_image_file_path(source).map(Some);
        }

        let url = Url::parse(source).map_err(|error| error.to_string())?;
        if !matches!(url.scheme(), "http" | "https") {
            return Ok(None);
        }

        self.download_html_image(url.as_str()).map(Some)
    }

    /// 下载 HTML 外链图片并写入缓存。
    pub(super) fn download_html_image(&self, url: &str) -> Result<(String, u64), String> {
        let mut response = self
            .http_client
            .get(url)
            .send()
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;

        if let Some(content_length) = response.content_length() {
            if content_length > MAX_HTML_IMAGE_BYTES {
                return Err(format!(
                    "clipboard HTML image exceeds size limit: {} bytes",
                    content_length
                ));
            }
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_ascii_lowercase);

        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(MAX_HTML_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_HTML_IMAGE_BYTES {
            return Err("clipboard HTML image exceeds size limit".to_string());
        }

        if content_type.as_deref() == Some("image/svg+xml") || bytes_start_with_svg(&bytes) {
            return self.save_raw_clipboard_image_bytes(&bytes, "svg");
        }

        self.save_clipboard_image_bytes(&bytes)
    }

    /// 将图片字节解码后保存到缓存目录。
    pub(super) fn save_clipboard_image_bytes(&self, bytes: &[u8]) -> Result<(String, u64), String> {
        let image = RustImageData::from_bytes(bytes).map_err(|error| error.to_string())?;
        self.save_clipboard_image(image)
    }

    /// 保存无需解码的原始图片字节。
    pub(super) fn save_raw_clipboard_image_bytes(
        &self,
        bytes: &[u8],
        extension: &str,
    ) -> Result<(String, u64), String> {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        let image_hash = hasher.finish();

        let target_path = self.image_dir.join(format!("{image_hash}.{extension}"));
        if !target_path.exists() {
            std::fs::write(&target_path, bytes).map_err(|error| error.to_string())?;
        }

        Ok((target_path_string(&target_path), image_hash))
    }
}

struct DataImagePayload {
    mime_type: String,
    bytes: Vec<u8>,
}

/// 解码 data:image URL。
fn decode_data_image_source(source: &str) -> Result<DataImagePayload, String> {
    let Some((metadata, data)) = source
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(','))
    else {
        return Err("invalid data image URL".to_string());
    };

    let mut metadata_parts = metadata.split(';');
    let mime_type = metadata_parts
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !mime_type.starts_with("image/") {
        return Err("data URL is not an image".to_string());
    }

    let is_base64 = metadata_parts.any(|part| part.eq_ignore_ascii_case("base64"));
    let bytes = if is_base64 {
        general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|error| error.to_string())?
    } else {
        percent_decode_bytes(data)?
    };

    Ok(DataImagePayload { mime_type, bytes })
}

/// 解码百分号编码字节。
fn percent_decode_bytes(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .copied()
                .and_then(hex_value)
                .ok_or_else(|| "invalid percent-encoded data URL".to_string())?;
            let low = bytes
                .get(index + 2)
                .copied()
                .and_then(hex_value)
                .ok_or_else(|| "invalid percent-encoded data URL".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    Ok(decoded)
}

/// 将十六进制字符转换为数值。
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 计算任意可哈希值的短哈希。
pub(super) fn hash_value<T: Hash>(value: &T) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

/// 向列表追加不重复的值。
pub(super) fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

/// 归一化剪贴板文件路径。
pub(super) fn normalize_clipboard_file_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("file:///") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return rest.to_string();
        }

        return format!("/{}", rest);
    }

    if let Some(rest) = path.strip_prefix("file://") {
        return rest.to_string();
    }

    path.to_string()
}

/// 将剪贴板文件路径拆分为图片和普通文件。
pub(super) fn split_clipboard_file_paths(paths: Vec<String>) -> (Vec<String>, Vec<String>) {
    paths
        .into_iter()
        .map(|path| normalize_clipboard_file_path(&path))
        .filter(|path| !path.is_empty())
        .partition(|path| is_image_file_path(path))
}

/// 判断路径是否指向图片文件。
fn is_image_file_path(path: &str) -> bool {
    if path_has_known_image_extension(path) {
        return true;
    }

    file_has_image_signature(path)
}

/// 判断路径是否有已知图片扩展名。
pub(super) fn path_has_known_image_extension(path: &str) -> bool {
    if let Some(extension) = Path::new(path).extension().and_then(|value| value.to_str()) {
        return matches!(
            extension.to_ascii_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "avif"
        );
    }

    false
}

/// 判断路径是否具有指定扩展名。
fn path_has_image_extension(path: &str, expected_extension: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected_extension))
}

/// 通过文件头判断路径是否是图片。
fn file_has_image_signature(path: &str) -> bool {
    let mut header = [0_u8; 32];
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(read_len) = file.read(&mut header) else {
        return false;
    };
    let header = &header[..read_len];

    header.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
        || header.starts_with(&[0xFF, 0xD8, 0xFF])
        || header.starts_with(b"GIF87a")
        || header.starts_with(b"GIF89a")
        || header.starts_with(b"BM")
        || (header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP")
        || (header.len() >= 12 && &header[4..8] == b"ftyp" && looks_like_avif_brand(header))
        || header_starts_with_svg(header)
}

/// 通过文件头判断路径是否是 SVG。
fn file_has_svg_signature(path: &str) -> bool {
    let mut header = [0_u8; 32];
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(read_len) = file.read(&mut header) else {
        return false;
    };

    header_starts_with_svg(&header[..read_len])
}

/// 判断字节内容是否以 SVG 标记开始。
fn bytes_start_with_svg(bytes: &[u8]) -> bool {
    header_starts_with_svg(&bytes[..bytes.len().min(32)])
}

/// 判断 AVIF 文件头品牌标记。
fn looks_like_avif_brand(header: &[u8]) -> bool {
    let brand_area = &header[8..header.len().min(32)];
    brand_area
        .windows(4)
        .any(|brand| brand == b"avif" || brand == b"avis")
}

/// 判断文件头是否像 SVG。
fn header_starts_with_svg(header: &[u8]) -> bool {
    let text = String::from_utf8_lossy(header);
    let trimmed = text.trim_start();
    trimmed.starts_with("<svg") || trimmed.starts_with("<?xml")
}

/// 将路径转换为前端可消费字符串。
fn target_path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
