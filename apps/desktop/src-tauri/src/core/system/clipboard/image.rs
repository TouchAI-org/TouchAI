// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板图片缓存和文件识别。

use base64::{engine::general_purpose, Engine as _};
use clipboard_rs::{common::RustImage, RustImageData};
use reqwest::{blocking::Client as HttpClient, header::CONTENT_TYPE, Url};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use std::time::Instant;
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
/// 单次消费外链图片的并发上限与总预算。
const MAX_HTML_IMAGE_RESOLUTION_WORKERS: usize = 3;
const HTML_IMAGE_RESOLUTION_TOTAL_BUDGET: Duration = Duration::from_secs(10);

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

    /// 在总预算内、有限并发地解析 HTML 图片引用。
    ///
    /// 返回 `(输入下标, 解析结果)`；超过预算尚未开始的引用直接缺席，
    /// 调用方按缺席跳过即可，不会阻塞文本粘贴。
    pub(super) fn resolve_html_images_with_budget(
        &self,
        sources: &[String],
    ) -> Vec<(usize, Result<Option<(String, u64)>, String>)> {
        if sources.is_empty() {
            return Vec::new();
        }

        let deadline = Instant::now() + HTML_IMAGE_RESOLUTION_TOTAL_BUDGET;
        let next_index = AtomicUsize::new(0);
        let collected = Mutex::new(Vec::with_capacity(sources.len()));
        let worker_count = MAX_HTML_IMAGE_RESOLUTION_WORKERS.min(sources.len());

        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| loop {
                    let index = next_index.fetch_add(1, Ordering::Relaxed);
                    if index >= sources.len() || Instant::now() >= deadline {
                        break;
                    }

                    let result = self.resolve_html_image_source(&sources[index]);
                    if let Ok(mut guard) = collected.lock() {
                        guard.push((index, result));
                    }
                });
            }
        });

        let mut results = collected.into_inner().unwrap_or_default();
        results.sort_by_key(|(index, _)| *index);
        results
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

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    fn decode_error(source: &str) -> String {
        match decode_data_image_source(source) {
            Ok(_) => panic!("expected '{source}' to be refused"),
            Err(error) => error,
        }
    }

    // Clipboard images arrive as data URLs, as file paths, or as raw bytes with an unknown
    // extension. Getting the classification wrong means an image is dropped or, worse, a
    // non-image file is handed to the image pipeline.

    #[test]
    fn user_gets_a_base64_png_decoded_from_a_data_url() {
        let payload = decode_data_image_source("data:image/png;base64,iVBORw0KGgo=")
            .expect("a base64 png decodes");

        assert_eq!(payload.mime_type, "image/png");
        assert_eq!(
            payload.bytes,
            vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[test]
    fn user_gets_the_mime_type_lowercased() {
        let payload =
            decode_data_image_source("data:IMAGE/PNG;base64,AAAA").expect("a data url decodes");

        assert_eq!(payload.mime_type, "image/png");
    }

    #[test]
    fn user_gets_percent_encoded_data_url_bytes_decoded() {
        // A non-base64 data URL carries the bytes percent-encoded.
        let payload = decode_data_image_source("data:image/svg+xml,%3Csvg%3E").expect("decodes");

        assert_eq!(payload.mime_type, "image/svg+xml");
        assert_eq!(payload.bytes, b"<svg>");
    }

    #[test]
    fn user_gets_plain_bytes_kept_in_a_percent_encoded_data_url() {
        let payload = decode_data_image_source("data:image/png,plain").expect("decodes");

        assert_eq!(payload.bytes, b"plain");
    }

    #[test]
    fn user_gets_a_non_image_data_url_refused() {
        assert_eq!(
            decode_error("data:text/plain;base64,AAAA"),
            "data URL is not an image"
        );
    }

    #[test]
    fn user_gets_a_malformed_data_url_refused() {
        assert_eq!(
            decode_error("https://example.com/a.png"),
            "invalid data image URL"
        );
    }

    #[test]
    fn user_gets_a_broken_percent_escape_refused() {
        assert_eq!(
            decode_error("data:image/png,%ZZ"),
            "invalid percent-encoded data URL"
        );
    }

    #[test]
    fn user_gets_a_truncated_percent_escape_refused() {
        assert_eq!(
            decode_error("data:image/png,%4"),
            "invalid percent-encoded data URL"
        );
    }

    #[test]
    fn user_gets_both_hex_cases_decoded() {
        assert_eq!(hex_value(b'0'), Some(0));
        assert_eq!(hex_value(b'9'), Some(9));
        assert_eq!(hex_value(b'a'), Some(10));
        assert_eq!(hex_value(b'f'), Some(15));
        assert_eq!(hex_value(b'A'), Some(10));
        assert_eq!(hex_value(b'F'), Some(15));
        assert_eq!(hex_value(b'g'), None);
        assert_eq!(hex_value(b'/'), None);
    }

    #[test]
    fn user_gets_known_image_extensions_recognised() {
        for path in [
            "a.jpg", "a.jpeg", "a.png", "a.gif", "a.webp", "a.bmp", "a.svg", "a.avif", "A.PNG",
        ] {
            assert!(
                path_has_known_image_extension(path),
                "{path} should be an image"
            );
        }
    }

    #[test]
    fn user_gets_a_non_image_extension_rejected() {
        for path in ["a.txt", "a.pdf", "a.mp4", "a", "a.pngx"] {
            assert!(
                !path_has_known_image_extension(path),
                "{path} should not be an image"
            );
        }
    }

    #[test]
    fn user_gets_a_specific_extension_matched_without_case() {
        assert!(path_has_image_extension("a.SVG", "svg"));
        assert!(!path_has_image_extension("a.png", "svg"));
        assert!(!path_has_image_extension("a", "svg"));
    }

    #[test]
    fn user_gets_a_windows_file_url_reduced_to_a_path() {
        assert_eq!(
            normalize_clipboard_file_path("file:///C:/tmp/a.png"),
            "C:/tmp/a.png"
        );
    }

    #[test]
    fn user_gets_a_posix_file_url_reduced_to_an_absolute_path() {
        assert_eq!(
            normalize_clipboard_file_path("file:///home/u/a.png"),
            "/home/u/a.png"
        );
    }

    #[test]
    fn user_gets_a_file_url_with_a_host_reduced_to_a_path() {
        assert_eq!(
            normalize_clipboard_file_path("file://server/share/a.png"),
            "server/share/a.png"
        );
    }

    #[test]
    fn user_gets_a_plain_path_left_alone() {
        assert_eq!(
            normalize_clipboard_file_path("C:/tmp/a.png"),
            "C:/tmp/a.png"
        );
    }

    #[test]
    fn user_gets_clipboard_paths_split_into_images_and_files() {
        let (images, files) = split_clipboard_file_paths(vec![
            "file:///C:/tmp/a.png".to_string(),
            "file:///C:/tmp/b.txt".to_string(),
            "file:///C:/tmp/c.webp".to_string(),
        ]);

        assert_eq!(
            images,
            vec!["C:/tmp/a.png".to_string(), "C:/tmp/c.webp".to_string()]
        );
        assert_eq!(files, vec!["C:/tmp/b.txt".to_string()]);
    }

    #[test]
    fn user_does_not_get_an_empty_clipboard_path_listed() {
        let (images, files) = split_clipboard_file_paths(vec!["".to_string()]);

        assert!(images.is_empty());
        assert!(files.is_empty());
    }

    #[test]
    fn user_gets_a_root_file_url_kept_as_the_root_path() {
        // "file:///" names the filesystem root, not nothing; it is a file entry, not an image.
        let (images, files) = split_clipboard_file_paths(vec!["file:///".to_string()]);

        assert!(images.is_empty());
        assert_eq!(files, vec!["/".to_string()]);
    }

    #[test]
    fn user_gets_an_image_detected_by_its_content_when_the_extension_is_missing() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("screenshot");
        fs::write(&path, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_a_jpeg_detected_by_its_content() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("photo");
        fs::write(&path, [0xFF, 0xD8, 0xFF, 0xE0]).expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_a_gif_detected_by_its_content() {
        let dir = TempDir::new().expect("temp dir");
        for signature in [b"GIF87a", b"GIF89a"] {
            let path = dir.path().join("anim");
            fs::write(&path, signature).expect("write");
            assert!(is_image_file_path(&target_path_string(&path)));
        }
    }

    #[test]
    fn user_gets_a_bmp_detected_by_its_content() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("bitmap");
        fs::write(&path, b"BM6").expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_a_webp_detected_by_its_content() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("picture");
        let mut header = Vec::from(*b"RIFF");
        header.extend_from_slice(&[0, 0, 0, 0]);
        header.extend_from_slice(b"WEBPVP8 ");
        fs::write(&path, header).expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_an_avif_detected_by_its_brand() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("still");
        let mut header = vec![0, 0, 0, 0x1C];
        header.extend_from_slice(b"ftypavif");
        fs::write(&path, header).expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_an_avif_sequence_brand_detected() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("clip");
        let mut header = vec![0, 0, 0, 0x1C];
        header.extend_from_slice(b"ftypavis");
        fs::write(&path, header).expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_an_svg_detected_by_its_content() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("icon");
        fs::write(&path, b"  <svg xmlns=\"http://www.w3.org/2000/svg\">").expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_gets_an_svg_detected_when_it_starts_with_an_xml_declaration() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("icon");
        fs::write(&path, b"<?xml version=\"1.0\"?><svg>").expect("write");

        assert!(is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_does_not_get_a_text_file_treated_as_an_image() {
        let dir = TempDir::new().expect("temp dir");
        let path = dir.path().join("notes");
        fs::write(&path, b"just some text").expect("write");

        assert!(!is_image_file_path(&target_path_string(&path)));
    }

    #[test]
    fn user_does_not_get_a_missing_file_treated_as_an_image() {
        let dir = TempDir::new().expect("temp dir");

        assert!(!is_image_file_path(&target_path_string(
            &dir.path().join("gone")
        )));
    }

    #[test]
    fn user_gets_the_same_hash_for_the_same_value() {
        assert_eq!(hash_value(&"same"), hash_value(&"same"));
        assert_ne!(hash_value(&"same"), hash_value(&"different"));
    }

    #[test]
    fn user_does_not_get_a_duplicate_added_to_a_list() {
        let mut values = vec!["a".to_string()];

        push_unique(&mut values, "a".to_string());
        push_unique(&mut values, "b".to_string());

        assert_eq!(values, vec!["a".to_string(), "b".to_string()]);
    }
}
